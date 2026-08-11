// ============================================================================
// entitlements unit tests - the contract-critical facts of the Phase 3 pure
// entitlements module (billing plan §1.2/§3.5/§6.3) without any I/O: the
// grandfather fallbacks, the -1 unlimited sentinel, the suspended zero-create
// floor, the dunning grace window keeping entitlements unchanged, and the
// feature flags. This module is mirrored (verify-schema-mirror.sh), so these
// tests protect the console's UI gating and the server enforcement together.
// ============================================================================

import {
  effectiveEntitlements,
  hasFeature,
  isGraceExpired,
  isSuspendedStatus,
  isWithinLimit,
  resolveLimits,
  SUSPENDED_LIMITS,
  UNLIMITED_LIMITS,
} from '../lib/entitlements';
import type { OrgSubscription, Plan } from '../shared/types';

/** A fixed caller clock: the module is pure and takes `now` as an argument,
 *  so the tests pin it rather than racing Date.now(). */
const NOW = 1_754_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A representative seeded plan (silver-shaped): finite limits, some features.
const silver: Plan = {
  name: 'Silver',
  stripePriceId: 'price_silver_test',
  priceMonthlyPence: 12900,
  currency: 'gbp',
  features: { branding: true, emailTemplates: true, prioritySupport: false },
  limits: {
    orgStaff: 10,
    customers: 50,
    notificationsPerMonth: 1000,
    assessmentTemplates: 5,
  },
  order: 2,
};

// A gold-shaped plan exercising the -1 unlimited sentinel in stored data.
const gold: Plan = {
  name: 'Gold',
  stripePriceId: 'price_gold_test',
  priceMonthlyPence: 29900,
  currency: 'gbp',
  features: { branding: true, emailTemplates: true, prioritySupport: true },
  limits: {
    orgStaff: -1,
    customers: -1,
    notificationsPerMonth: 5000,
    assessmentTemplates: -1,
  },
  order: 3,
};

describe('resolveLimits', () => {
  it('returns the plan limits verbatim, including -1 sentinels', () => {
    expect(resolveLimits(silver)).toEqual({
      orgStaff: 10,
      customers: 50,
      notificationsPerMonth: 1000,
      assessmentTemplates: 5,
    });
    expect(resolveLimits(gold).orgStaff).toBe(-1);
    expect(resolveLimits(gold).notificationsPerMonth).toBe(5000);
  });

  it('grandfathers a missing plan to unlimited everything', () => {
    expect(resolveLimits(undefined)).toEqual(UNLIMITED_LIMITS);
    expect(resolveLimits(null)).toEqual(UNLIMITED_LIMITS);
    expect(UNLIMITED_LIMITS.orgStaff).toBe(-1);
  });

  it('resolves a missing or partial limits block to unlimited per limit', () => {
    // A half-seeded plan must never lock anyone out (inviteLimits precedent).
    const bare = { ...silver, limits: undefined } as unknown as Plan;
    expect(resolveLimits(bare)).toEqual(UNLIMITED_LIMITS);

    const partial = {
      ...silver,
      limits: { orgStaff: 3 },
    } as unknown as Plan;
    const resolved = resolveLimits(partial);
    expect(resolved.orgStaff).toBe(3);
    expect(resolved.customers).toBe(-1);
    expect(resolved.assessmentTemplates).toBe(-1);
  });
});

describe('hasFeature', () => {
  it('reads the plan flags for a seeded plan', () => {
    expect(hasFeature(silver, 'branding')).toBe(true);
    expect(hasFeature(silver, 'prioritySupport')).toBe(false);
    expect(hasFeature(gold, 'prioritySupport')).toBe(true);
  });

  it('grandfathers a missing plan to ALL features on', () => {
    // Operator-created orgs may already be using branding; billing shipping
    // must not silently strip it.
    expect(hasFeature(undefined, 'branding')).toBe(true);
    expect(hasFeature(null, 'emailTemplates')).toBe(true);
  });

  it('treats an absent flag on a seeded plan as not included', () => {
    const noFlags = { ...silver, features: undefined } as unknown as Plan;
    expect(hasFeature(noFlags, 'branding')).toBe(false);
  });
});

describe('isWithinLimit (-1 aware)', () => {
  it('-1 is unlimited: always within', () => {
    expect(isWithinLimit(-1, 0)).toBe(true);
    expect(isWithinLimit(-1, 1_000_000)).toBe(true);
  });

  it('checks current + 1 against a finite limit', () => {
    expect(isWithinLimit(3, 2)).toBe(true); // third seat fits a limit of 3
    expect(isWithinLimit(3, 3)).toBe(false); // fourth does not
  });

  it('zero (the suspended floor) never admits a create', () => {
    expect(isWithinLimit(0, 0)).toBe(false);
  });
});

describe('effectiveEntitlements', () => {
  const activeSub: OrgSubscription = {
    planId: 'silver',
    status: 'active',
    stripeCustomerId: 'cus_x',
  };

  it('missing subscription entirely → unlimited grandfather', () => {
    const e = effectiveEntitlements(undefined, undefined, NOW);
    expect(e.limits).toEqual(UNLIMITED_LIMITS);
    expect(e.features).toEqual({
      branding: true,
      emailTemplates: true,
      prioritySupport: true,
    });
    expect(e.suspended).toBe(false);
  });

  it('active subscription → plan limits and features', () => {
    const e = effectiveEntitlements(activeSub, silver, NOW);
    expect(e.limits.orgStaff).toBe(10);
    expect(e.features.prioritySupport).toBe(false);
    expect(e.suspended).toBe(false);
  });

  it('an OPEN dunning grace window (past_due, graceUntil ahead) leaves entitlements UNCHANGED', () => {
    // §3.5: never degrade a live safety-compliance tool over a card hiccup.
    const graced: OrgSubscription = {
      ...activeSub,
      status: 'past_due',
      paymentState: 'past_due',
      graceUntil: NOW + 14 * DAY_MS,
    };
    expect(effectiveEntitlements(graced, silver, NOW)).toEqual(
      effectiveEntitlements(activeSub, silver, NOW),
    );

    const actionRequired: OrgSubscription = {
      ...activeSub,
      paymentState: 'action_required',
    };
    expect(effectiveEntitlements(actionRequired, silver, NOW)).toEqual(
      effectiveEntitlements(activeSub, silver, NOW),
    );
  });

  it('an EXPIRED grace window (graceUntil behind now) drops to the suspended floor', () => {
    // The grace ENFORCEMENT (§3.5): the 14-day promise is honoured here, not
    // left to Stripe's retry-exhaustion timing.
    const expired: OrgSubscription = {
      ...activeSub,
      status: 'past_due',
      paymentState: 'past_due',
      graceUntil: NOW - 1,
    };
    const e = effectiveEntitlements(expired, silver, NOW);
    expect(e.suspended).toBe(true);
    expect(e.limits).toEqual(SUSPENDED_LIMITS);
    expect(e.features.branding).toBe(false);
  });

  it('isGraceExpired requires the exact dunning shape AND a passed deadline', () => {
    const dunning: OrgSubscription = {
      ...activeSub,
      status: 'past_due',
      paymentState: 'past_due',
      graceUntil: NOW,
    };
    // Boundary: the deadline moment itself is still within grace.
    expect(isGraceExpired(dunning, NOW)).toBe(false);
    expect(isGraceExpired(dunning, NOW + 1)).toBe(true);
    // Cleared or never-opened dunning never expires, whatever the clock says.
    expect(isGraceExpired(activeSub, NOW + 365 * DAY_MS)).toBe(false);
    // action_required carries no grace window (§3.5), and a stray graceUntil
    // without paymentState past_due does not suspend.
    expect(
      isGraceExpired(
        { ...activeSub, paymentState: 'action_required', graceUntil: NOW - 1 },
        NOW,
      ),
    ).toBe(false);
    expect(isGraceExpired({ ...activeSub, graceUntil: NOW - 1 }, NOW)).toBe(false);
  });

  it('unpaid → suspended zero-create floor, features off, reads-intact semantics', () => {
    const e = effectiveEntitlements({ ...activeSub, status: 'unpaid' }, silver, NOW);
    expect(e.suspended).toBe(true);
    expect(e.limits).toEqual(SUSPENDED_LIMITS);
    expect(e.features.branding).toBe(false);
    // The floor blocks creates via the same -1-aware check the server uses.
    expect(isWithinLimit(e.limits.customers, 0)).toBe(false);
  });

  it('canceled → suspended zero-create floor', () => {
    const e = effectiveEntitlements({ ...activeSub, status: 'canceled' }, gold, NOW);
    expect(e.suspended).toBe(true);
    expect(e.limits).toEqual(SUSPENDED_LIMITS);
  });

  it('incomplete (a restarted subscription awaiting first payment) → suspended floor', () => {
    // Otherwise a cancelled org could resubscribe without ever paying and be
    // entitled for the ~23h Stripe keeps the incomplete subscription alive.
    const e = effectiveEntitlements({ ...activeSub, status: 'incomplete' }, silver, NOW);
    expect(e.suspended).toBe(true);
    expect(e.limits).toEqual(SUSPENDED_LIMITS);
  });

  it('isSuspendedStatus is the single vocabulary the webhook mirror shares', () => {
    expect(isSuspendedStatus('unpaid')).toBe(true);
    expect(isSuspendedStatus('canceled')).toBe(true);
    expect(isSuspendedStatus('incomplete')).toBe(true);
    expect(isSuspendedStatus('active')).toBe(false);
    expect(isSuspendedStatus('trialing')).toBe(false);
    expect(isSuspendedStatus('past_due')).toBe(false);
    expect(isSuspendedStatus(undefined)).toBe(false);
  });

  it('subscription block present but no status (pre-billing planId) → grandfathered plan entitlements', () => {
    // An operator-set planId without any Stripe lifecycle is not suspended.
    const e = effectiveEntitlements({ planId: 'silver' }, silver, NOW);
    expect(e.suspended).toBe(false);
    expect(e.limits.customers).toBe(50);
  });
});
