// ============================================================================
// entitlements - the pure plan → entitlement resolution for Phase 3 billing.
//
// The single answer to "what may this organisation do?", shared verbatim by the
// console's UI gating (useEntitlements) and every server-side enforcement point
// (invite/customer/notification/template limits, branding resolution). Pure by
// design: no imports beyond the mirrored types contract, no I/O, so the client
// renders EXACTLY the gate the server enforces (ragDerivation precedent - see
// scripts/verify-schema-mirror.sh). Neither side hard-codes a number.
//
// Two invariants carried from Phase 1 (plan §1.2 / §3.5 / §6.3):
//
//   1. GRANDFATHER RULE - missing plan (or missing subscription) resolves to
//      unlimited / all features ON. Operator-created organisations pre-date
//      billing entirely; a safety-compliance tool must never lock a tenant out
//      because the billing data hasn't been seeded yet. This is the same
//      "absent ⇒ unlimited" default lib/inviteLimits established (story 1023).
//
//   2. NEVER DEGRADE OVER A CARD HICCUP - past_due / action_required keep FULL
//      plan entitlements while the dunning grace window is OPEN. Only a
//      subscription that is not (or no longer) paying - unpaid / canceled
//      (Stripe has given up or the org cancelled), incomplete (a restarted
//      subscription whose first payment has not yet confirmed - see
//      resubscribe), or past_due with its 14-day grace window EXPIRED (the
//      graceUntil deadline the webhook stamped has passed) - drops to the
//      zero-create floor, and even then the policy is block-new-creates only:
//      reads and in-flight safety work stay available. Grace expiry is judged
//      against a caller-supplied `now` so the module stays pure (no Date.now
//      inside - the client passes render time, the server passes call time).
//
// The -1 sentinel means UNLIMITED throughout, matching PlanLimits (§5.3).
// ============================================================================

import type { OrgSubscription, Plan, PlanLimits } from '../../types';

/** A plan's feature-flag keys, so gates are spelled once and typo-proof. */
export type PlanFeature = keyof Plan['features'];

/** Resolved numeric ceilings for one organisation. -1 = unlimited. */
export interface EffectiveLimits {
  orgStaff: number;
  customers: number;
  notificationsPerMonth: number;
  assessmentTemplates: number;
}

/** Everything an enforcement point or UI gate needs, in one resolved value. */
export interface Entitlements {
  limits: EffectiveLimits;
  features: { branding: boolean; emailTemplates: boolean; prioritySupport: boolean };
  /** True when the subscription is terminally dead (unpaid/canceled) and the
   *  org is on the zero-create floor - the UI shows the reactivation banner. */
  suspended: boolean;
}

/** Every limit unlimited - the grandfather fallback (no plan / no billing). */
export const UNLIMITED_LIMITS: EffectiveLimits = Object.freeze({
  orgStaff: -1,
  customers: -1,
  notificationsPerMonth: -1,
  assessmentTemplates: -1,
});

/**
 * The zero-create floor for suspended/unsubscribed organisations (§6.3): every
 * countable create blocks, but NOTHING is deleted or hidden - existing data
 * stays fully readable and in-flight safety work continues. Zero (not -1!)
 * because "current + 1 <= 0" can never pass.
 */
export const SUSPENDED_LIMITS: EffectiveLimits = Object.freeze({
  orgStaff: 0,
  customers: 0,
  notificationsPerMonth: 0,
  assessmentTemplates: 0,
});

/**
 * A plan's numeric ceilings, defensively resolved. Missing plan ⇒ UNLIMITED
 * (grandfather rule, header invariant 1). A plan whose limits block is absent
 * or partially populated resolves each missing limit to unlimited too - the
 * documented "any missing link ⇒ unlimited" chain from lib/inviteLimits, so a
 * half-seeded catalogue can never lock anyone out.
 */
export function resolveLimits(plan: Plan | undefined | null): EffectiveLimits {
  if (!plan) {
    return UNLIMITED_LIMITS;
  }
  const limits: Partial<PlanLimits> | undefined = plan.limits;
  const resolve = (value: number | undefined): number =>
    typeof value === 'number' ? value : -1;
  return {
    orgStaff: resolve(limits?.orgStaff),
    customers: resolve(limits?.customers),
    notificationsPerMonth: resolve(limits?.notificationsPerMonth),
    assessmentTemplates: resolve(limits?.assessmentTemplates),
  };
}

/**
 * Is a feature on for this plan? Missing plan ⇒ TRUE: the grandfather rule
 * applies to features exactly as it does to limits - an operator-created org
 * with no billing data keeps branding and email templates it may already be
 * using, rather than having them silently stripped the day billing ships.
 * A plan without a features block resolves each flag to false: a seeded plan
 * states its features explicitly, so absence there means "not included".
 */
export function hasFeature(
  plan: Plan | undefined | null,
  feature: PlanFeature,
): boolean {
  if (!plan) {
    return true;
  }
  return plan.features?.[feature] === true;
}

/**
 * The -1-aware limit check: is `current + 1` still within `limit`? Pure and
 * boolean (no throwing) so both the UI ("disable the button?") and the server
 * (which wraps a false into its structured resource-exhausted error) share the
 * same arithmetic. -1 = unlimited always passes; 0 (the suspended floor) never
 * passes.
 */
export function isWithinLimit(limit: number, current: number): boolean {
  if (limit === -1) {
    return true;
  }
  return current + 1 <= limit;
}

/**
 * The one word-of-truth predicate for "this organisation is not entitled",
 * shared by effectiveEntitlements, the Stripe webhook's member-readable
 * profile.suspended mirror and the Billing tab's restart gating:
 *
 * - unpaid / canceled - terminally dead (§3.5 "suspended" semantics).
 * - incomplete - an org-attached subscription that has NEVER been paid for.
 *   Before the resubscribe path existed no org could hold this status (a
 *   first-subscribe org is only provisioned once active); now a restarted
 *   subscription sits incomplete until its first payment confirms, and it must
 *   NOT be entitled - otherwise cancelling and endlessly re-creating unpaid
 *   subscriptions would keep an org entitled for free.
 */
export function isSuspendedStatus(
  status: OrgSubscription['status'],
): boolean {
  return status === 'unpaid' || status === 'canceled' || status === 'incomplete';
}

/**
 * Has the dunning grace window closed without payment? True only for the exact
 * past_due dunning shape the webhook writes - `paymentState:'past_due'` with a
 * `graceUntil` deadline - once that deadline has passed. This is the grace
 * ENFORCEMENT (§3.5): Stripe's own retry-exhaustion eventually flips `status`
 * to unpaid, but that timing belongs to a dashboard setting; the 14-day promise
 * the banner and the payment-failed email make is honoured here, so an org
 * whose card keeps failing suspends when we said it would, not when Stripe
 * gives up. `now` is the caller's clock (pure module - no Date.now inside).
 */
export function isGraceExpired(
  subscription: OrgSubscription,
  now: number,
): boolean {
  return (
    subscription.paymentState === 'past_due' &&
    typeof subscription.graceUntil === 'number' &&
    subscription.graceUntil < now
  );
}

/**
 * The full resolution an enforcement point calls (§3.5/§6.3 state machine):
 *
 * - No subscription at all ⇒ unlimited + all features (grandfather rule).
 * - status unpaid/canceled/incomplete ⇒ SUSPENDED: zero-create limits,
 *   features off (isSuspendedStatus above - the meaning of those statuses,
 *   not a status of its own).
 * - past_due with an EXPIRED grace window (isGraceExpired above) ⇒ SUSPENDED
 *   too: the 14-day grace the org was promised has run out unpaid, and waiting
 *   for Stripe's retry-exhaustion to flip the status would leave `graceUntil`
 *   decorative.
 * - Everything else - active, trialing, and crucially past_due /
 *   action_required while the dunning grace window is open - keeps FULL plan
 *   entitlements (header invariant 2).
 *
 * `now` is threaded in by the caller (server: call time; client: render time)
 * so this module stays pure and both sides judge expiry with the same
 * arithmetic. A client whose clock disagrees with the server merely renders
 * the wrong gate momentarily - the server's check remains the boundary.
 */
export function effectiveEntitlements(
  subscription: OrgSubscription | undefined,
  plan: Plan | undefined,
  now: number,
): Entitlements {
  if (!subscription) {
    // Grandfathered organisation: billing has never touched it.
    return {
      limits: UNLIMITED_LIMITS,
      features: { branding: true, emailTemplates: true, prioritySupport: true },
      suspended: false,
    };
  }

  if (isSuspendedStatus(subscription.status) || isGraceExpired(subscription, now)) {
    return {
      limits: SUSPENDED_LIMITS,
      features: { branding: false, emailTemplates: false, prioritySupport: false },
      suspended: true,
    };
  }

  return {
    limits: resolveLimits(plan),
    features: {
      branding: hasFeature(plan, 'branding'),
      emailTemplates: hasFeature(plan, 'emailTemplates'),
      prioritySupport: hasFeature(plan, 'prioritySupport'),
    },
    suspended: false,
  };
}
