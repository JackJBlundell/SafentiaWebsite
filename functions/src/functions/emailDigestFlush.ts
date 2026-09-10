// ============================================================================
// emailDigestFlush (scheduled) - the other half of the bundling seam
// (EMAIL_BUNDLING_PLAN.md section 4.3).
//
// lib/emailDigest decides that a send WAITS; this is what makes waiting end.
// Once a morning it walks every pending bundle and turns each one into exactly
// one email: "40 buildings need a fire risk assessment review" instead of forty
// separate messages to the same admin.
//
// WHY 08:15. The morning sweeps run 07:00 (contract ends, job diary), 07:30
// (FRA reviews) and 07:45 (deadlines), and each of them queues rather than
// sends. 08:15 is half an hour after the last of them starts, so everything a
// sweep queued flushes the SAME morning rather than sitting until tomorrow -
// which is the whole difference between a digest and a delay. The margin is
// deliberate headroom, not a guess: if a sweep ever overruns it, its items
// simply flush the next day (nothing is lost), and the sweeps log their own
// duration so the squeeze is visible before it becomes a problem.
//
// WHY THE INFLIGHT DANCE. Delivery is not transactional: between "these items
// are mine" and "the provider accepted them" the process can die. Doing it
// naively either loses a morning of reminders (delete first, crash, nothing to
// resend) or sends them twice (send first, crash, resend tomorrow). So the
// items are MOVED - in a single multi-path update, which RTDB applies
// atomically - out of `items` and into `inflight/{flushId}`, and that node is
// deleted only after the send has been attempted. A run that dies mid-flush
// leaves its claim standing; the next run finds an inflight batch older than an
// hour, folds it back in and delivers it. Nothing is lost, and nothing is sent
// twice inside a run.
//
// WHY THE SLOT IS CLAIMED FIRST. The day slot (lib/emailDigest claimDaySlot) is
// the guarantee - at most one email of a kind per address per UK day - and the
// flush honours it exactly as the send sites do. Claiming BEFORE the move is
// what makes a crash between the two harmless: the slot is burned for today and
// the items are still sitting in `items`, so they flush tomorrow, one day late
// but whole. Claiming after the move would strand items in an inflight node for
// a send that never happens. A slot already taken means an email of this kind
// reached this person today - the bundle is LEFT ALONE for tomorrow. That is
// the collapse rule working, not a failure.
//
// A BUNDLE OF ONE IS NOT A DIGEST. One queued item renders through the kind's
// ORDINARY template with the values the send site computed at the time, so the
// recipient sees precisely the email they see today. Most orgs are small and
// most bundles hold one item; for them this whole mechanism must be invisible.
//
// FAILURE POSTURE, matching the sweeps it serves: every bundle is wrapped, and
// one org's malformed data can never abort the sweep for everybody else. A
// bundle that throws keeps its items (in inflight) and is retried tomorrow.
// A bundle the PROVIDER refused puts its items back on the queue and tries
// again every morning until it succeeds or the items pass MAX_BUNDLE_AGE_MS,
// so an outage at 08:15 costs a day rather than a morning's fire-risk-
// assessment reminders - however many mornings the outage lasts.
// ============================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { EMAIL_KINDS } from '../lib/emailKindCatalogue';
import { loadKindConfig, sendKindEmail } from '../lib/templatedEmail';
import { renderTemplate } from '../lib/emailVariableEngine';
import { claimDaySlot, decodeQueuedEmail } from '../lib/emailDigest';
import { ops } from '../lib/paths';
import { ukDay } from '../lib/ukCalendar';
import { WEB_ORIGIN } from '../lib/webOrigin';
import type { KindConfig } from '../lib/templatedEmail';
import type { EmailTemplateShape } from '../lib/emailVariableEngine';
import type { QueuedEmail, StoredQueuedEmail } from '../lib/emailDigest';
import type { Logger } from '../lib/logging';
import type { EmailKindId, Environment } from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/**
 * How old an inflight batch must be before this run treats it as abandoned.
 * One hour is far longer than any flush can plausibly take (the whole sweep is
 * a handful of reads and one email per bundle) and far shorter than the daily
 * cadence, so a batch is either obviously live or obviously dead - never
 * ambiguous. A younger batch belongs to a run that may still be sending, and
 * stealing its items would double-send them.
 */
const INFLIGHT_STALE_MS = 60 * 60 * 1000;

/**
 * How long a queued item may go undelivered before it is given up on.
 *
 * This, not a retry count, is what bounds a failing bundle. A provider refusal
 * is ambiguous at this layer - lib/email returns the same false for "this
 * address bounced", "Resend returned 500", "the request timed out" and "no API
 * key is mounted" - so counting failed mornings would discard on an OUTAGE, and
 * would do it to every bundle on the platform simultaneously. Age cannot be
 * confused that way: seven days of failure is a genuinely dead address or a
 * genuinely broken configuration, and either deserves an operator rather than
 * another attempt.
 *
 * It doubles as the retention guard the bundles need in their own right: a
 * pending bundle holds a real recipient address, and seven days is the outer
 * limit of how long this feature may keep one (brief 18.4 data minimisation).
 */
const MAX_BUNDLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One batch of items a flush has claimed but not yet finished sending. */
interface InflightBatch {
  at?: number;
  items?: Record<string, StoredQueuedEmail>;
}

/** The stored shape of one (recipient, kind) bundle - lib/emailDigest writes it. */
interface Bundle {
  /** The address, held only while the bundle is pending (brief 18.4). */
  to?: string;
  /** The cap counter, advanced by transaction at queue time. */
  count?: number;
  /** Sends counted rather than stored once the bundle hit MAX_BUNDLE_ITEMS. */
  dropped?: number;
  items?: Record<string, StoredQueuedEmail>;
  inflight?: Record<string, InflightBatch>;
}

/** Corrupt or missing timestamps sort first rather than poisoning the order. */
function queuedAt(item: StoredQueuedEmail): number {
  return typeof item.at === 'number' ? item.at : 0;
}

/**
 * One item's line in a digest when its send site did not supply one.
 *
 * Rendering the item through the kind's EFFECTIVE SINGLE TEMPLATE - the org's
 * own copy when it has authored some, the built-in default otherwise - and
 * taking the subject and preheader means every kind bundles usefully from the
 * day the seam ships, in the org's own words, before a single send site has
 * been sharpened to describe itself in one line.
 */
function fallbackDigestRow(
  item: QueuedEmail,
  singleTemplate: EmailTemplateShape,
): { label: string; value: string } {
  const rendered = renderTemplate(
    singleTemplate,
    item.variables,
    'send',
    item.kindRows,
    item.kindLink,
  );
  return { label: rendered.subject, value: rendered.preheader ?? '' };
}

/**
 * Turn one claimed batch into one email. Returns whether the provider accepted
 * it. Never decides WHETHER to send - that is settled before the items are
 * moved - only how the send should read.
 */
async function sendBundleEmail(
  args: {
    kind: EmailKindId;
    env: Environment;
    orgId: string;
    to: string;
    /** Oldest first: a digest reads in the order things happened. */
    items: StoredQueuedEmail[];
    dropped: number;
    config: KindConfig;
  },
  logger: Logger,
): Promise<boolean> {
  const { kind, env, orgId, to, dropped, config } = args;
  const def = EMAIL_KINDS[kind];
  // ====
  // The one crossing from stored to renderable, for the whole batch. Items are
  // held in their STORED form everywhere else in this sweep - moved into
  // inflight, restored to the queue on a refusal - so that what goes back on
  // the queue goes back byte for byte as it was written. Only rendering needs
  // the real, dotted variable names, and only here.
  // ====
  const items = args.items.map(decodeQueuedEmail);

  /** One stored item, sent exactly as its send site would have sent it. */
  const sendAlone = (item: QueuedEmail): Promise<boolean> =>
    sendKindEmail(
      {
        kind,
        env,
        orgId,
        to,
        variables: item.variables,
        brand: item.brand,
        kindLink: item.kindLink,
        kindRows: item.kindRows,
        config,
      },
      logger,
    );

  // ====
  // A quiet day must look exactly like today. No variant, no bundledCount: the
  // ordinary template, the item's own variables, rows and link - byte for byte
  // the email the send site would have dispatched at the time.
  // ====
  if (items.length === 1) {
    return await sendAlone(items[0]);
  }

  const digest = def.digest;
  if (digest === undefined) {
    // ====
    // Unreachable by construction - lib/emailDigest refuses to bundle a kind
    // with no digest block, so items of such a kind cannot exist here. If the
    // catalogue is ever edited out from under a queue, send the most recent
    // item rather than throwing (which would strand the batch) or dropping the
    // lot (which would swallow a safety reminder). Loud, because it means the
    // catalogue and the queue disagree.
    // ====
    logger.error('Bundled kind has no digest block; sending the latest item alone', {
      kind,
      orgId,
      items: items.length,
    });
    return await sendAlone(items[items.length - 1]);
  }

  const count = items.length;
  const [noun, plural] = digest.noun;
  // The org's own single-template copy is what the fallback rows speak in, so
  // resolve it once for the whole batch rather than per row.
  const singleTemplate = config.template ?? def.defaultTemplate;

  return await sendKindEmail(
    {
      kind,
      env,
      orgId,
      to,
      variables: {
        // orgEmailBrand builds every sender's brand from the org profile, so
        // the brand name stored with the item IS the organisation's name - no
        // extra read to say who the digest is from.
        'org.name': items[0].brand?.name ?? '',
        'digest.count': String(count),
        'digest.countPhrase': `${count} ${count === 1 ? noun : plural}`,
        // Nothing is ever silently truncated: when the cap counted sends it
        // could not store, the copy owns up to it.
        'digest.moreNote':
          dropped > 0 ? `…and ${dropped} more are not listed here.` : '',
      },
      // The colours the events actually happened under, taken from the first
      // item rather than re-read now.
      brand: items[0].brand,
      // A digest cannot deep-link one item, so the kind declares a list-level
      // destination and the flush prefixes the origin (the catalogue is a pure
      // mirrored module and must not import it).
      kindLink: `${WEB_ORIGIN}${digest.ctaPath}`,
      kindRows: items.map(
        (item) => item.digestRow ?? fallbackDigestRow(item, singleTemplate),
      ),
      config,
      variant: 'digest',
      bundledCount: count,
    },
    logger,
  );
}

export const emailDigestFlush = onSchedule(
  {
    // 08:15 UK: thirty minutes after deadlineReminders (07:45), the last of the
    // morning sweeps, so every sweep's queued items flush the same morning.
    schedule: '15 8 * * *',
    timeZone: 'Europe/London',
    region: REGION,
    // Without the secret mounted every send degrades to a logged intent
    // (lib/email) - the bundles still drain, which is the correct behaviour:
    // holding them for a missing configuration would only pile up tomorrow.
    secrets: EMAIL_PROVIDER_SECRETS,
  },
  async () => {
    const logger = createLogger({ fn: 'emailDigestFlush' });
    const today = ukDay(Date.now());

    let bundlesFlushed = 0;
    let emailsSent = 0;
    let itemsBundled = 0;
    let itemsDropped = 0;
    let bundlesDeferred = 0;
    let bundlesRecovered = 0;
    let bundlesInflight = 0;
    let bundlesRequeued = 0;

    for (const env of ENVIRONMENTS) {
      // ONE read per env of the whole pending tree:
      // { orgId: { hash: { kindId: Bundle } } }. The tree is small by
      // construction - it holds only what has not yet been delivered - and
      // reading it whole is what keeps this sweep a handful of reads however
      // many orgs there are.
      const snap = await db.ref(ops.emailBundles(env)).get();
      if (!snap.exists()) {
        continue;
      }
      const byOrg = snap.val() as Record<
        string,
        Record<string, Record<string, Bundle>>
      >;

      // One config read per (org, kind), reused across every recipient of that
      // kind - the established sweep pattern. Scoped INSIDE the env loop
      // because the same orgId exists in both roots with its own settings.
      const configs = new Map<string, KindConfig>();

      for (const [orgId, byRecipient] of Object.entries(byOrg)) {
        for (const [hash, byKind] of Object.entries(byRecipient ?? {})) {
          for (const [kindId, bundle] of Object.entries(byKind ?? {})) {
            try {
              if (!(kindId in EMAIL_KINDS)) {
                // A kind retired from the catalogue while items were queued.
                // There is no copy left to render them with; leave them for an
                // operator rather than guess.
                logger.warn('Pending bundle for an unknown email kind; skipped', {
                  orgId,
                  kind: kindId,
                });
                continue;
              }
              const kind = kindId as EmailKindId;
              const bundlePath = ops.emailBundle(env, orgId, hash, kind);
              const now = Date.now();

              // ====
              // 1. Inflight first. A batch older than an hour is a previous run
              // that died between claiming its items and sending them, so its
              // items rejoin this morning's send. A younger batch may still be
              // in flight: touch nothing, take nothing, come back tomorrow.
              // ====
              const staleFlushIds: string[] = [];
              let liveInflight = false;
              for (const [priorId, batch] of Object.entries(bundle.inflight ?? {})) {
                const at = typeof batch?.at === 'number' ? batch.at : 0;
                if (now - at > INFLIGHT_STALE_MS) {
                  staleFlushIds.push(priorId);
                } else {
                  liveInflight = true;
                }
              }
              if (liveInflight) {
                bundlesInflight += 1;
                logger.info('Bundle has a recent inflight batch; left for the next run', {
                  orgId,
                  kind,
                });
                continue;
              }

              // The items this run would take: what is queued now, plus
              // whatever a dead run left behind. Recovered ids came out of
              // this same `items` node, so they cannot collide with it.
              const moving: Record<string, StoredQueuedEmail> = {
                ...(bundle.items ?? {}),
              };
              for (const staleId of staleFlushIds) {
                Object.assign(moving, bundle.inflight?.[staleId]?.items ?? {});
              }
              const items = Object.values(moving)
                .filter((item): item is StoredQueuedEmail => typeof item === 'object' && item !== null)
                .sort((a, b) => queuedAt(a) - queuedAt(b));

              // ====
              // 2. Nothing to send. Sweep up a stray address or counter left by
              // an interrupted write so the tree does not accumulate empty
              // bundles holding real addresses (brief 18.4 - a pending address
              // is held only while there is something to send it).
              // ====
              if (items.length === 0) {
                // ====
                // RE-READ before deleting. The tree was snapshotted once at the
                // top of the run, and this branch is the NORMAL residue of a
                // successful flush ({to} with no items), so it runs for most
                // bundles every morning - while sends are still arriving. A
                // send site that queued between the snapshot and now has
                // written {to, count, items/x}, and nulling `to` from the stale
                // view would strand that item for ever: nothing else carries
                // the address, so every later run would find items with no
                // recipient and skip them. One extra read on a path that
                // deletes is worth far more than one saved.
                // ====
                const fresh = (
                  await db.ref(bundlePath).get()
                ).val() as Bundle | null;
                const stillEmpty =
                  fresh === null ||
                  Object.keys(fresh.items ?? {}).length === 0;
                const strays: Record<string, unknown> = {};
                if (stillEmpty && fresh?.to !== undefined) {
                  strays[`${bundlePath}/to`] = null;
                }
                if (stillEmpty && fresh?.count !== undefined) {
                  strays[`${bundlePath}/count`] = null;
                }
                if (stillEmpty && fresh?.dropped !== undefined) {
                  strays[`${bundlePath}/dropped`] = null;
                }
                // Stale inflight is ours to clear either way: it was already
                // an hour old when this run started.
                for (const staleId of staleFlushIds) {
                  strays[`${bundlePath}/inflight/${staleId}`] = null;
                }
                if (Object.keys(strays).length > 0) {
                  await db.ref().update(strays);
                }
                continue;
              }

              const to = typeof bundle.to === 'string' ? bundle.to.trim() : '';
              if (to === '') {
                // appendToBundle writes `to` and the item in one update, so a
                // bundle with items and no address is corruption, not a race.
                // Nothing here can recover the address - the items deliberately
                // do not carry it - so leave them untouched and say so.
                logger.error('Bundle has items but no recipient address; left in place', {
                  orgId,
                  kind,
                  items: items.length,
                });
                continue;
              }

              // ====
              // 3a. The org's toggle, read BEFORE the day is claimed. An admin
              // who switched this kind off after these items were queued has
              // said they do not want them; sendKindEmail would refuse them
              // anyway, but refusing them down there looks like a delivery
              // failure and would keep the bundle alive for a week before the
              // age guard cleared it, burning a day slot every morning on the
              // way. Discard them here instead, quietly - it is a choice, not a
              // fault - and leave the day unclaimed so an `immediate` sibling
              // kind is unaffected.
              // ====
              const configKey = `${orgId}:${kind}`;
              let config = configs.get(configKey);
              if (config === undefined) {
                config = await loadKindConfig(env, orgId, kind, logger);
                configs.set(configKey, config);
              }
              if (!config.enabled) {
                logger.info(
                  'Email kind switched off since these were queued; bundle discarded',
                  { orgId, kind, items: items.length },
                );
                const discard: Record<string, unknown> = {
                  [`${bundlePath}/to`]: null,
                  [`${bundlePath}/count`]: null,
                  [`${bundlePath}/dropped`]: null,
                };
                for (const itemId of Object.keys(moving)) {
                  discard[`${bundlePath}/items/${itemId}`] = null;
                }
                for (const staleId of staleFlushIds) {
                  discard[`${bundlePath}/inflight/${staleId}`] = null;
                }
                await db.ref().update(discard);
                itemsDropped += items.length;
                continue;
              }

              // ====
              // 3b. Claim the day. Taken already means an email of this kind
              // reached this address today (a collapse kind sent immediately,
              // or an earlier run delivered this very bundle). Leave everything
              // exactly as it is - including any stale inflight, which is still
              // stale tomorrow - and flush it then.
              // ====
              const claimed = await claimDaySlot(env, orgId, hash, kind, today);
              if (!claimed) {
                bundlesDeferred += 1;
                logger.info('Day slot already taken; bundle held for tomorrow', {
                  orgId,
                  kind,
                  items: items.length,
                });
                continue;
              }

              // ====
              // 4. The atomic move. One multi-path update writes the claim and
              // clears everything it claimed, so there is no instant in which
              // the items exist twice or not at all. The item keys are nulled
              // INDIVIDUALLY rather than wholesale: an item appended between
              // the read above and this write is not one of ours, and nulling
              // the parent would delete an email nobody had sent.
              //
              // `count` is DECREMENTED by what we took, not nulled, for exactly
              // the same reason: nulling it would erase the increment of an item
              // that arrived after the snapshot and survived the move, leaving
              // the bundle under-counted for ever. That counter is what
              // lib/emailDigest reads as "is this bundle empty" to keep a
              // collapse kind from starving its own bundle, and what enforces
              // the 200 cap - an under-count breaks both. Clamped at zero and
              // applied by transaction so a concurrent append cannot be lost.
              // ====
              const dropped = typeof bundle.dropped === 'number' ? bundle.dropped : 0;
              const flushId = db.ref(`${bundlePath}/inflight`).push().key as string;
              const move: Record<string, unknown> = {
                [`${bundlePath}/inflight/${flushId}`]: { at: now, items: moving },
                [`${bundlePath}/dropped`]: null,
              };
              for (const itemId of Object.keys(moving)) {
                move[`${bundlePath}/items/${itemId}`] = null;
              }
              for (const staleId of staleFlushIds) {
                move[`${bundlePath}/inflight/${staleId}`] = null;
              }
              await db.ref().update(move);
              const takenCount = Object.keys(moving).length;
              await db
                .ref(`${bundlePath}/count`)
                .transaction((current: number | null) =>
                  Math.max(0, (current ?? takenCount) - takenCount),
                );
              if (staleFlushIds.length > 0) {
                bundlesRecovered += 1;
              }

              // ====
              // 5. Render and send. The config was resolved at 3a, once per
              // (org, kind), whatever the recipient count.
              // ====
              const delivered = await sendBundleEmail(
                { kind, env, orgId, to, items, dropped, config },
                logger,
              );

              // ====
              // 6. Release the claim.
              //
              // Delivered: the batch is done, the inflight node goes.
              //
              // NOT delivered: the items go BACK on the queue and are tried
              // again tomorrow. This is deliberately NOT a small retry budget.
              // lib/email returns the same false for "this address bounced",
              // "Resend returned 500", "the request timed out" and "no API key
              // is mounted" - so a rule that discards after N failed mornings
              // discards on a PROVIDER OUTAGE, and it does so for every bundle
              // on the platform at once. The sweeps that filled these bundles
              // are exact-day matchers: a building that hit its 30-day review
              // mark on Monday is never reconsidered, so a discarded item is
              // that notice gone for good. Two bad mornings must not be able to
              // do that.
              //
              // What bounds the retry instead is AGE. An item older than
              // MAX_BUNDLE_AGE_MS has stopped being news - and, just as much to
              // the point, the bundle is holding a real address for longer than
              // this feature has any business holding one (brief 18.4). Then,
              // and only then, it is discarded with an ERROR naming it.
              //
              // `count` is restored by transaction rather than assignment
              // because a send site may have appended while we were sending,
              // and that item's increment must not be overwritten.
              //
              // Only a CRASH leaves the batch in `inflight`, which is precisely
              // what the hour-stale recovery above exists for.
              // ====
              const inflightPath = `${bundlePath}/inflight/${flushId}`;
              if (delivered) {
                await db.ref(inflightPath).remove();
                emailsSent += 1;
                itemsDropped += dropped;
              } else {
                const oldestAt = queuedAt(items[0]);
                const expired =
                  oldestAt > 0 && now - oldestAt > MAX_BUNDLE_AGE_MS;
                if (expired) {
                  logger.error(
                    'Bundle undeliverable for too long; items discarded',
                    {
                      orgId,
                      kind,
                      items: items.length,
                      oldestAgeDays: Math.floor((now - oldestAt) / 86_400_000),
                    },
                  );
                  await db.ref(inflightPath).remove();
                  itemsDropped += dropped + items.length;
                } else {
                  logger.warn('Bundle send failed; items requeued for tomorrow', {
                    orgId,
                    kind,
                    items: items.length,
                  });
                  const restore: Record<string, unknown> = {
                    [inflightPath]: null,
                  };
                  for (const [itemId, item] of Object.entries(moving)) {
                    restore[`${bundlePath}/items/${itemId}`] = item;
                  }
                  if (dropped > 0) {
                    restore[`${bundlePath}/dropped`] = dropped;
                  }
                  await db.ref().update(restore);
                  await db
                    .ref(`${bundlePath}/count`)
                    .transaction(
                      (current: number | null) => (current ?? 0) + items.length,
                    );
                  bundlesRequeued += 1;
                }
              }

              bundlesFlushed += 1;
              itemsBundled += items.length;
            } catch (error) {
              // One org's bad data must never cost every other org its morning.
              // Whatever failed, the items are either still queued or still in
              // an inflight batch, so tomorrow's run picks them up.
              logger.warn('Bundle flush failed; left for the next run', {
                env,
                orgId,
                kind: kindId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }
    }

    // The saving, in one line: bundles flushed against items bundled is how
    // many emails were NOT sent this morning.
    logger.info('Email digests flushed', {
      bundles: bundlesFlushed,
      emailsSent,
      itemsBundled,
      itemsDroppedByCap: itemsDropped,
      bundlesDeferred,
      bundlesRecovered,
      bundlesInflight,
      // Non-zero on consecutive mornings means the provider, not the data:
      // check EMAIL_PROVIDER_API_KEY before anything else.
      bundlesRequeued,
    });
  },
);
