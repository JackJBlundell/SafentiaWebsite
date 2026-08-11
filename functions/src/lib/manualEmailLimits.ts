// ============================================================================
// Manual-email daily metering (Phase 3 assessment H3, the spam-relay fix).
//
// The per-user rate limit (lib/rateLimit) slows a single caller down; this cap
// bounds what a whole ORGANISATION can push through sendManualEmail in a day,
// because every message leaves from the platform's verified sending domain and
// the resource being protected is that domain's reputation. The counter charges
// the RECIPIENT count (post-dedupe - only addresses actually dispatched to), so
// fifty one-recipient sends and one fifty-recipient send spend the same.
//
// The counter lives under the server-only ops namespace, keyed by UTC calendar
// day (`ops/manualEmailCounts/{env}/{orgId}/{yyyyMmDd}`): rules default-deny it,
// no client can read or reset it, and a new day is simply a new key - no sweep
// is needed for the cap to reset. A single atomic transaction both reads and
// advances the day's total (lib/notifications' quota idiom), so concurrent
// sends cannot race past the cap, and an over-cap charge ABORTS the transaction
// (no write) and is rejected with the structured `resource-exhausted` error the
// client already maps.
// ============================================================================

import { db } from '../admin';
import { paths } from './paths';
import { fail } from './errors';
import type { Environment } from '../shared/types';

/**
 * At most this many manual-email recipients per organisation per UTC day. An
 * org-wide announcement to a large staff-plus-contacts list (a few 50-recipient
 * batches) fits comfortably under it; a spam run - thousands of arbitrary
 * external addresses through the verified domain - does not.
 */
export const MANUAL_EMAIL_DAILY_CAP = 200;

/** The counter's UTC calendar-day key (yyyyMmDd), e.g. 20260810. */
export function utcDayKey(nowMs: number): string {
  const d = new Date(nowMs);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}${mm}${dd}`;
}

/**
 * Charge `recipientCount` against the org's daily allowance, or reject. Called
 * BEFORE any email is dispatched, and the charge is ALL-OR-NOTHING: a request
 * that would cross the cap sends to nobody, rather than to "however many fitted".
 * Partial delivery would force the admin to work out who received the message
 * and re-send to the remainder minus them - an error-prone job the server
 * cannot help with (addresses are redacted in results by design). Refusing the
 * whole batch is simpler and honest: fix the list or wait for the reset, then
 * send once.
 *
 * `nowMs` is injectable so the day boundary is deterministically testable;
 * production passes Date.now().
 */
export async function chargeManualEmailQuota(
  env: Environment,
  orgId: string,
  recipientCount: number,
  nowMs: number = Date.now(),
): Promise<void> {
  if (recipientCount <= 0) {
    // Nothing will be dispatched, so nothing is charged (and no counter node
    // is minted for a send that resolved to zero deliverable recipients).
    return;
  }
  const ref = db.ref(paths.ops.manualEmailCount(env, orgId, utcDayKey(nowMs)));
  const tx = await ref.transaction((current: number | null) => {
    const next = (current ?? 0) + recipientCount;
    // Over the cap: abort (undefined) so nothing is written and `committed`
    // comes back false - the day's total only ever reflects emails that were
    // actually cleared for dispatch.
    return next > MANUAL_EMAIL_DAILY_CAP ? undefined : next;
  });
  if (!tx.committed) {
    throw fail.resourceExhausted(
      `Your organisation has reached its daily limit of ${MANUAL_EMAIL_DAILY_CAP} manual email recipients. ` +
        'Nothing from this send was dispatched. The limit resets at midnight UTC - please try again then.',
      { limit: MANUAL_EMAIL_DAILY_CAP, requested: recipientCount },
    );
  }
}
