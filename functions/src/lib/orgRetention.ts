// ============================================================================
// Organisation data-retention policy - the PURE decisions (DECISIONS §8).
//
// A cancelled organisation's data is kept for 12 months, then deleted. That
// promise is expressed in three tiny, side-effect-free pieces so they can be
// unit-tested in isolation and shared verbatim by everything that has to agree
// on the same arithmetic:
//
//   - the Stripe webhook, which STAMPS `subscription.retentionUntil` at final
//     cancellation (now + ORG_RETENTION_MS) and CLEARS it on resubscribe;
//   - the nightly `cleanupExpiredOrgs` sweep, which selects orgs whose clock has
//     ELAPSED and (behind an explicit env flag) reaps them; and
//   - the operator immediate-delete script, which ignores the clock entirely.
//
// No I/O, no Date.now inside: the caller threads `now` in, exactly as the
// entitlements module does, so server call-time and any test clock judge expiry
// with identical arithmetic.
// ============================================================================

import type { Environment, Organisation, OrgSubscription } from '../shared/types';

/** The retention window: 12 months, expressed as 365 days to sidestep
 *  month-length ambiguity (the same convention as the finance-feed and
 *  email-log retention in cleanupBilling). */
export const ORG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Has a cancelled org's 12-month retention clock run out? True ONLY when
 * `retentionUntil` is a real number strictly in the past. An absent or
 * non-numeric clock returns false - the OPPOSITE default to the billing-marker
 * sweeps: those delete bookkeeping rows that cannot prove their age, but this
 * gate guards a DESTRUCTIVE whole-org deletion, so "cannot prove it is elapsed"
 * must mean "do NOT reap". Only an explicit, stamped, past deadline authorises
 * deletion.
 */
export function retentionElapsed(
  subscription: OrgSubscription | null | undefined,
  now: number,
): boolean {
  const until = subscription?.retentionUntil;
  return typeof until === 'number' && until < now;
}

/**
 * From a page of `{orgId: Organisation}`, the orgIds whose retention clock has
 * elapsed - the sweep's delete candidates. Pure and total: a malformed org
 * record (no subscription, no clock) is simply not selected, so a data fault
 * can never widen the blast radius. `limit`, when given, caps the returned list
 * so the sweep can bound how many orgs it reaps in a single nightly run
 * regardless of backlog size (deterministic order: input key order).
 */
export function selectExpiredOrgs(
  orgs: Record<string, Organisation | null | undefined>,
  now: number,
  limit?: number,
): string[] {
  const expired = Object.entries(orgs)
    .filter(([, org]) => retentionElapsed(org?.subscription, now))
    .map(([orgId]) => orgId);
  return typeof limit === 'number' ? expired.slice(0, limit) : expired;
}

/**
 * Is post-retention DELETION armed for this env? The nightly sweep defaults to
 * REPORT-ONLY: it always logs which orgs it WOULD reap, but only performs the
 * destructive deletion when `FIRERITE_ENABLE_RETENTION_DELETION` is set to the
 * exact string `'true'`. Any other value (unset, '', 'false', '1', 'yes')
 * leaves the sweep in its safe dry-run posture - an operator must make an
 * explicit, unambiguous choice to arm automated whole-org deletion. Pure: the
 * raw env value is passed in so the gate is testable without touching
 * process.env.
 */
export function retentionDeletionEnabled(flag: string | undefined): boolean {
  return flag === 'true';
}

/** The env var that arms automated post-retention deletion (see above). Named
 *  once here so the sweep and the docs cannot drift on the spelling. */
export const RETENTION_DELETION_FLAG = 'FIRERITE_ENABLE_RETENTION_DELETION';

/** Cap on orgs reaped per nightly sweep run, bounding the blast radius of any
 *  single night: a larger backlog drains across successive runs. */
export const RETENTION_DELETE_BATCH = 25;

/** The env roots the sweep walks - live first so a shared backlog reaps
 *  production before test. */
export const RETENTION_ENVIRONMENTS: Environment[] = ['live', 'test'];
