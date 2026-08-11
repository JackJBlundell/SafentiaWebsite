// ============================================================================
// usageCounters - transactional maintenance of organisations/{orgId}/usage
// (Phase 3 brief 5.2).
//
// The usage node is the fast, display-and-limits summary the console and the
// limit checks (inviteLimits) read; the underlying records (orgMembers,
// customers, the notification ledger) stay the source of truth. Each helper
// transacts on ONE counter child, so concurrent business operations (two
// invitations accepted at once, say) cannot lose an increment, and an absent
// node - an org founded before the counters existed - reads as 0 rather than
// failing. Deltas clamp at zero: a decrement can never drive a counter
// negative, however the history drifted before the backfill ran.
//
// Best-effort BY DESIGN: a counter is bookkeeping, not the operation. A failed
// adjustment must never fail the business op that called it (the membership or
// customer write has already committed by then), so every helper swallows and
// logs rather than throwing - the backfill script re-derives the truth.
// ============================================================================

import { db } from '../admin';
import type { EnvPaths } from './paths';
import type { Logger } from './logging';

/** The counter children this module maintains under the org's usage node. */
type UsageCounter = 'staffCount' | 'customerCount';

/**
 * Apply a delta to one usage counter, transactionally and clamped at zero.
 * Absence is first-class: a missing child (or whole usage node) is treated as 0
 * before the delta, so the first adjustment for a pre-counter org just works.
 */
async function adjustCounter(
  env: EnvPaths,
  orgId: string,
  counter: UsageCounter,
  delta: number,
  logger: Logger,
): Promise<void> {
  try {
    await db
      .ref(`${env.db.orgUsage(orgId)}/${counter}`)
      .transaction((current: number | null) =>
        Math.max(0, (typeof current === 'number' ? current : 0) + delta),
      );
  } catch (caught) {
    // Best-effort: the calling business op has already succeeded, so a counter
    // failure is logged loudly and swallowed, never rethrown.
    logger.warn('Usage counter adjustment failed; counter may drift', {
      orgId,
      counter,
      delta,
      reason: caught instanceof Error ? caught.message : String(caught),
    });
  }
}

/** Staff seats: +1 on a staff invitation acceptance, -1/+1 on archive/reinstate. */
export async function adjustStaffCount(
  env: EnvPaths,
  orgId: string,
  delta: number,
  logger: Logger,
): Promise<void> {
  return adjustCounter(env, orgId, 'staffCount', delta, logger);
}

/** Customers: +1 on create/restore, -1 on archive (manual or contract sweep). */
export async function adjustCustomerCount(
  env: EnvPaths,
  orgId: string,
  delta: number,
  logger: Logger,
): Promise<void> {
  return adjustCounter(env, orgId, 'customerCount', delta, logger);
}

/**
 * Mirror the month's notification total onto the usage node. DISPLAY ONLY: the
 * per-month ledger (ops/notificationCounts) remains the enforcement truth the
 * quota gate transacts on; this is an absolute SET of the value that gate just
 * committed, so month rollover needs no handling here - the first send of a new
 * month writes that month's count (1) over the stale previous-month figure.
 * Best-effort for the same reason as the counters above.
 */
export async function mirrorNotificationsThisMonth(
  env: EnvPaths,
  orgId: string,
  total: number,
  logger: Logger,
): Promise<void> {
  try {
    await db
      .ref(`${env.db.orgUsage(orgId)}/notificationsThisMonth`)
      .set(total);
  } catch (caught) {
    logger.warn('Notification usage mirror failed; display may lag the ledger', {
      orgId,
      reason: caught instanceof Error ? caught.message : String(caught),
    });
  }
}
