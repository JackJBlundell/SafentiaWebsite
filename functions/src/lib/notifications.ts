// ============================================================================
// sendNotification - internal helper (brief 4.5 #9). NOT a callable.
//
// One place produces a notification, so every Function notifies consistently:
//   1. Write the in-app record under /notifications/{uid} (env-scoped, so a test
//      user's notifications stay in /test).
//   2. Dispatch FCM best-effort - if the recipient has no registered device token
//      we skip cleanly; a missing push must never fail the calling Function, since
//      the in-app record is the source of truth and the push is a convenience.
//   3. Increment the per-org notification ledger for the month, the quota
//      accounting Phase 3 will enforce (we account now, enforce later).
//
// PII discipline (brief 18.4): the notification body is authored copy, and we log
// only the type and recipient uid, never the message contents or any email.
// ============================================================================

import { db } from '../admin';
import { getMessaging } from 'firebase-admin/messaging';
import { paths } from './paths';
import type { EnvPaths } from './paths';
import { resolveNotificationLimit } from './notificationLimits';
import { mirrorNotificationsThisMonth } from './usageCounters';
import type { Logger } from './logging';
import type { Notification } from '../shared/types';

/** The input a caller supplies; the timestamp-bearing record is built here. */
export interface NotificationInput {
  type: string;
  title: string;
  body: string;
  /** Optional deep link, e.g. firerite://job/{id}, opened on tap. */
  link?: string;
}

/** The YYYY-MM ledger bucket for "now", in UTC so months align across regions.
 *  Exported so the usage backfill script buckets by the SAME key. */
export function currentLedgerMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Read a user's registered FCM device tokens. We store them under a per-user node
 * the mobile app writes on sign-in; absence is a first-class, normal case (the
 * web has no push, a fresh user has no device yet). Returns an empty list rather
 * than throwing so the caller's "skip cleanly" path is the default.
 */
async function getDeviceTokens(env: EnvPaths, uid: string): Promise<string[]> {
  // Device tokens live alongside the user's notifications subtree, under a fixed
  // child the app owns. Reading the map and taking its keys avoids assuming any
  // particular token-count.
  // The mobile app registers tokens under `<notifications>/<uid>/devices/<token>`
  // (see app src/notifications/tokens.ts), so we must read the SAME child here -
  // a mismatch would silently deliver zero pushes.
  const snap = await db
    .ref(env.db.notifications(uid))
    .parent! // /notifications
    .child(uid)
    .child('devices')
    .get();
  if (!snap.exists()) {
    return [];
  }
  const value = snap.val();
  if (!value || typeof value !== 'object') {
    return [];
  }
  // We store `{ [token]: true }`; the keys are the tokens.
  return Object.keys(value);
}

/**
 * Send a notification to one user. Best-effort FCM, guaranteed in-app record and
 * ledger increment. Never throws on push failure; a thrown error here would
 * wrongly fail an otherwise-successful business operation (e.g. createJob).
 */
export async function sendNotification(
  env: EnvPaths,
  orgId: string,
  recipientUid: string,
  input: NotificationInput,
  logger: Logger,
): Promise<void> {
  const month = currentLedgerMonth();

  // 0. Quota gate (ENFORCED - the "enforce later" the ledger comment promised).
  // If the org's plan sets a monthly notification cap and it has been reached,
  // skip this notification entirely. Best-effort by design: the calling business
  // op (e.g. createJob) still succeeds; the recipient simply does not receive this
  // one convenience notification. The per-month counter is advanced inside a
  // single transaction, so concurrent sends cannot overshoot the cap and an
  // over-cap send ABORTS (no increment, committed === false). No plan cap set =>
  // unlimited: the counter still advances - the month's total must stay true for
  // every org, capped or not, because the usage mirror below displays it - but
  // it can never abort.
  const monthlyLimit = await resolveNotificationLimit(env, orgId);
  const counterRef = db.ref(paths.ops.notificationCount(env.env, orgId, month));
  const tx = await counterRef.transaction((current: number | null) => {
    const next = (current ?? 0) + 1;
    return monthlyLimit !== undefined && next > monthlyLimit ? undefined : next;
  });
  if (!tx.committed) {
    logger.warn('Monthly notification quota reached; skipping notification', {
      orgId,
      type: input.type,
      limit: monthlyLimit,
    });
    return;
  }

  // Mirror the total the transaction just committed onto the org's usage node
  // (Phase 3 brief 5.2). DISPLAY ONLY - the month-keyed ledger counter above
  // stays the enforcement truth; setting the committed value means the first
  // send of a new month naturally overwrites last month's stale figure. The
  // helper is best-effort, so a mirror failure never fails the notification.
  await mirrorNotificationsThisMonth(
    env,
    orgId,
    tx.snapshot.val() as number,
    logger,
  );

  const record: Notification = {
    type: input.type,
    title: input.title,
    body: input.body,
    ...(input.link ? { link: input.link } : {}),
  };

  // 1. In-app record (the source of truth). push() gives a sortable key.
  const ref = db.ref(env.db.notifications(recipientUid)).push();
  await ref.set(record);

  // 3. Ledger accounting: the per-entry audit trail, kept alongside the fast
  // counter above. One entry per notification (push) keeps it append-friendly and
  // lets later reporting sum the month without a counter race.
  await db
    .ref(env.db.notificationLedger(orgId, month))
    .push({ uid: recipientUid, type: input.type, at: Date.now() });

  // 2. FCM best-effort. Wrapped so any messaging failure is logged and swallowed.
  let tokens: string[] = [];
  try {
    tokens = await getDeviceTokens(env, recipientUid);
  } catch (caught) {
    logger.warn('Could not read device tokens; skipping push', {
      recipientUid,
      reason: caught instanceof Error ? caught.message : String(caught),
    });
    return;
  }

  if (tokens.length === 0) {
    // Entirely normal: no device registered. The in-app record already landed.
    logger.info('No device tokens for recipient; in-app notification only', {
      recipientUid,
      type: input.type,
    });
    return;
  }

  try {
    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: input.title, body: input.body },
      data: input.link ? { link: input.link } : {},
      // ANDROID PRESENTATION AND DELIVERY.
      //
      // Without this block the message goes out at FCM's NORMAL priority, which
      // Doze is free to hold until the device next wakes - and a device in a van
      // between sites is the exact case. Everything this app pushes is something
      // a person is waiting on: a job assigned to them, an auditor asking for
      // more information against a deadline, remedial work falling due. `high`
      // is what those warrant; nothing here is marketing.
      //
      // The channel is named explicitly rather than left to the manifest default
      // so the two ends are visible together: the app creates `safentia_alerts`
      // at IMPORTANCE_HIGH on startup (MainApplication.kt), and a message that
      // named a channel the app has not created would be posted silently into a
      // fallback instead.
      android: {
        priority: 'high',
        notification: {
          channelId: 'safentia_alerts',
          // The status-bar mark and its tint. Named here as well as in the
          // manifest because a message-level value is what survives if the
          // manifest defaults are ever dropped, and neither costs anything.
          icon: 'ic_notification',
          color: '#D9C554',
        },
      },
      // iOS is unchanged in behaviour and stated only so the two platforms read
      // side by side: alerts are user-visible, so they must not be sent as
      // background content.
      apns: {
        headers: { 'apns-priority': '10' },
      },
    });
    // The FAILURE CODES are logged, not just the counts.
    //
    // Without them a failed send is undiagnosable from the outside: the codes
    // were previously read only to decide which tokens to prune and were then
    // discarded, so a run of failures looked identical whether the token was
    // dead, the payload was rejected, or the project's APNs credentials were
    // missing - three faults with completely different fixes. Distinct codes
    // only (there is one per device and they repeat), and never the tokens
    // themselves, which are credentials.
    const failureCodes =
      response.failureCount > 0
        ? [
            ...new Set(
              response.responses
                .filter((r) => r.error)
                .map((r) => r.error?.code ?? 'unknown'),
            ),
          ]
        : [];
    logger.info('Push dispatched', {
      recipientUid,
      type: input.type,
      deviceCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      ...(failureCodes.length > 0 ? { failureCodes } : {}),
    });

    // Prune tokens FCM reports as permanently invalid so a dead device does not
    // accumulate failures on every future send. `response.responses` is aligned
    // with `tokens` by index, so we map each failure code back to its token.
    // Transient errors (e.g. messaging/internal-error) are left in place.
    if (response.failureCount > 0) {
      const staleTokens = response.responses.reduce<string[]>(
        (acc, result, index) => {
          const code = result.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-argument'
          ) {
            acc.push(tokens[index]);
          }
          return acc;
        },
        [],
      );
      if (staleTokens.length > 0) {
        try {
          const devicesRef = db
            .ref(env.db.notifications(recipientUid))
            .parent! // /notifications
            .child(recipientUid)
            .child('devices');
          await Promise.all(
            staleTokens.map((token) => devicesRef.child(token).remove()),
          );
          logger.info('Pruned stale device tokens', {
            recipientUid,
            type: input.type,
            prunedCount: staleTokens.length,
          });
        } catch (pruneError) {
          // Pruning is housekeeping; failing to remove a token must not bubble up.
          logger.warn('Could not prune stale device tokens', {
            recipientUid,
            reason:
              pruneError instanceof Error
                ? pruneError.message
                : String(pruneError),
          });
        }
      }
    }
  } catch (caught) {
    // Best-effort: a push failure (expired tokens, FCM outage) must not bubble up.
    logger.warn('Push dispatch failed; in-app notification stands', {
      recipientUid,
      type: input.type,
      reason: caught instanceof Error ? caught.message : String(caught),
    });
  }
}
