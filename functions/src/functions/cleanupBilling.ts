// ============================================================================
// cleanupBilling (scheduled) - billing bookkeeping retention (Phase 3, plan
// sections 4.3 and 5.5).
//
// Two server-only billing ledgers grow without bound unless swept:
//
//   1. ops/stripeEvents/{env}/{eventId} - webhook claim-before-act markers.
//      A DONE marker is the idempotency record against late Stripe retries;
//      Stripe stops retrying long before 30 days, so done-markers older than
//      that are dead weight and are deleted. PROCESSING markers are never
//      touched here: a fresh one belongs to a running invocation, a failed
//      one is released (deleted) by the webhook itself, and a STALE one (a
//      crashed invocation's orphan) is reclaimed in place by claimStripeEvent
//      on the next Stripe retry - reclaim is that path's job, not this
//      sweep's, so the marker is preserved as the event's attempt record.
//
//   2. platform/financeEvents/{env}/{pushId} - the super-admin billing
//      activity feed, kept to 12 months (365 days) per plan section 5.5.
//
//   3. {env}/emailLog/{orgId}/{entryId} - the per-org email send log (lib/
//      email appends one entry per dispatch attempt, recipients redacted).
//      Kept to 12 months, same posture as the finance feed: old sends have
//      no operational value and the log is PII-minimised, not PII-free. The
//      org list bounds the walk; each org's read is the same bounded
//      expired-only page (.indexOn sentAt exists at {env}/emailLog/$orgId).
//
// All trees are env-nested, so the sweep walks both envs. Each read is
// BOUNDED: an orderByChild(timestamp).endAt(cutoff).limitToFirst(batch) query
// pulls only already-expired entries, never the whole node - a backlog larger
// than one batch drains across successive nightly runs. Entries the timestamp
// query returns with a MISSING/non-numeric timestamp (RTDB orders null before
// numbers, so endAt includes them) cannot prove they are within retention and
// are deleted too - the cleanupLeads rule.
// ============================================================================

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { forEnv, ops, platform } from '../lib/paths';
import type { StripeEventClaim } from '../lib/stripe';
import type { EmailLogEntry, Environment, FinanceEvent } from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** Done-markers older than this are swept (plan 4.3: 30 days). */
export const STRIPE_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Finance-feed entries older than this are swept (plan 5.5: 12 months,
 *  expressed as 365 days to sidestep month-length ambiguity). */
export const FINANCE_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** Per-org email-log entries older than this are swept (12 months, same
 *  365-day convention as the finance feed). */
export const EMAIL_LOG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** Per-env, per-tree read bound; a larger backlog drains over nightly runs. */
const SWEEP_BATCH = 1000;

/**
 * Which claim markers from one bounded query page are deletable: DONE and
 * expired (or carrying no provable receivedAt). Processing claims survive
 * this sweep however old - a stale one is claimStripeEvent's reclaim to make,
 * not ours to delete (see header). Pure, unit-tested.
 */
export function expiredStripeEventIds(
  events: Record<string, StripeEventClaim | null | undefined>,
  cutoff: number,
): string[] {
  return Object.entries(events)
    .filter(([, claim]) => {
      if (claim?.status !== 'done') {
        return false;
      }
      const receivedAt = claim.receivedAt;
      return typeof receivedAt !== 'number' || receivedAt <= cutoff;
    })
    .map(([eventId]) => eventId);
}

/**
 * Which finance-feed entries from one bounded query page are deletable:
 * older than retention, or carrying no provable timestamp. Pure, unit-tested.
 */
export function expiredFinanceEventIds(
  events: Record<string, FinanceEvent | null | undefined>,
  cutoff: number,
): string[] {
  return Object.entries(events)
    .filter(([, event]) => {
      const at = event?.at;
      return typeof at !== 'number' || at <= cutoff;
    })
    .map(([eventId]) => eventId);
}

/**
 * Which per-org email-log entries from one bounded query page are deletable:
 * older than retention, or carrying no provable sentAt. Pure, unit-tested.
 */
export function expiredEmailLogEntryIds(
  entries: Record<string, EmailLogEntry | null | undefined>,
  cutoff: number,
): string[] {
  return Object.entries(entries)
    .filter(([, entry]) => {
      const sentAt = entry?.sentAt;
      return typeof sentAt !== 'number' || sentAt <= cutoff;
    })
    .map(([entryId]) => entryId);
}

export const cleanupBilling = onSchedule(
  {
    schedule: '45 3 * * *',
    timeZone: 'Europe/London',
    region: REGION,
  },
  async () => {
    const logger = createLogger({ fn: 'cleanupBilling' });
    const { db } = await import('../admin');
    const now = Date.now();

    for (const env of ENVIRONMENTS) {
      const removals: Record<string, null> = {};

      // ====
      // Stripe webhook claim markers: bounded page of expired-by-receivedAt
      // entries, of which only status:'done' actually go.
      // ====
      const eventCutoff = now - STRIPE_EVENT_RETENTION_MS;
      const eventsSnap = await db
        .ref(ops.stripeEvents(env))
        .orderByChild('receivedAt')
        .endAt(eventCutoff)
        .limitToFirst(SWEEP_BATCH)
        .get();
      const claims =
        (eventsSnap.val() as Record<string, StripeEventClaim> | null) ?? {};
      const doneExpired = expiredStripeEventIds(claims, eventCutoff);
      for (const eventId of doneExpired) {
        removals[ops.stripeEvent(env, eventId)] = null;
      }

      // ====
      // Finance feed: bounded page of expired-by-at entries, all deletable.
      // ====
      const financeCutoff = now - FINANCE_EVENT_RETENTION_MS;
      const financeSnap = await db
        .ref(platform.financeEvents(env))
        .orderByChild('at')
        .endAt(financeCutoff)
        .limitToFirst(SWEEP_BATCH)
        .get();
      const feed =
        (financeSnap.val() as Record<string, FinanceEvent> | null) ?? {};
      const feedExpired = expiredFinanceEventIds(feed, financeCutoff);
      for (const eventId of feedExpired) {
        removals[platform.financeEvent(env, eventId)] = null;
      }

      // ====
      // Per-org email log: bounded expired-only page per org, all deletable.
      // The organisations root bounds the walk (linear in org count, the
      // deadlineReminders scale posture).
      // ====
      const emailCutoff = now - EMAIL_LOG_RETENTION_MS;
      const envPaths = forEnv(env);
      const orgsSnap = await db.ref(envPaths.db.organisationsRoot()).get();
      const orgIds = Object.keys(orgsSnap.val() ?? {});
      let emailLogRemoved = 0;
      for (const orgId of orgIds) {
        const logSnap = await db
          .ref(envPaths.db.emailLog(orgId))
          .orderByChild('sentAt')
          .endAt(emailCutoff)
          .limitToFirst(SWEEP_BATCH)
          .get();
        const entries =
          (logSnap.val() as Record<string, EmailLogEntry> | null) ?? {};
        const logExpired = expiredEmailLogEntryIds(entries, emailCutoff);
        for (const entryId of logExpired) {
          removals[envPaths.db.emailLogEntry(orgId, entryId)] = null;
        }
        emailLogRemoved += logExpired.length;
      }

      const removed = Object.keys(removals).length;
      if (removed > 0) {
        await db.ref().update(removals);
      }
      logger.info('Billing retention sweep complete', {
        env,
        stripeEventMarkersRemoved: doneExpired.length,
        financeEventsRemoved: feedExpired.length,
        emailLogEntriesRemoved: emailLogRemoved,
      });
    }
  },
);
