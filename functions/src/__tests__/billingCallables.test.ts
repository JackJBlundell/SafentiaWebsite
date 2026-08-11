// ============================================================================
// Billing callables - the PURE decision logic (plan sections 3.2, 3.3, 9).
//
// lib/billing.ts holds every money-shaped decision the management callables
// make without Stripe in the room: which direction a plan change moves
// (upgrade = immediate + prorated, downgrade = scheduled at period end), when
// an abandoned onboarding attempt may be resumed, where a subscription's
// period ends, and how a Stripe invoice maps onto the InvoiceSummary
// contract. The callables' input validators (claims-vs-orgId, limit clamping,
// boolean strictness) are pinned here too - they are exported precisely so
// these tests can drive them without App Check or claims plumbing.
// ============================================================================

// The callable modules import the admin seam at module load; stub it so this
// suite stays pure (no firebase-admin initialisation) - only the exported
// validators and lib/billing helpers are exercised.
jest.mock('../admin', () => ({ db: {}, auth: {} }));

import type Stripe from 'stripe';
import {
  SELF_SERVE_PLAN_IDS,
  isRestartableStatus,
  isSelfServePlanId,
  planRank,
  isUpgrade,
  isResumableOnboardingAttempt,
  needsPendingPaymentSecret,
  periodEndMs,
  toInvoiceSummary,
} from '../lib/billing';
import { parseChangeSubscriptionInput } from '../functions/changeSubscription';
import { onboardingOrgName } from '../functions/createSubscription';
import {
  nextOnboardingForDetails,
  parseOnboardingDetails,
} from '../functions/saveOnboardingDetails';
import { parseCancelSubscriptionInput } from '../functions/cancelSubscription';
import { parseResubscribeInput } from '../functions/resubscribe';
import { parseCreateCardUpdateIntentInput } from '../functions/createCardUpdateIntent';
import { parseListInvoicesInput } from '../functions/listInvoices';
import type { Plan, UserOnboarding } from '../shared/types';

/** A minimal plan doc with a given ladder position. */
function planWithOrder(order: number | undefined): Plan {
  return {
    name: 'X',
    stripePriceId: 'price_x',
    priceMonthlyPence: 100,
    currency: 'gbp',
    features: { branding: false, emailTemplates: false, prioritySupport: false },
    limits: {
      orgStaff: 1,
      customers: 1,
      notificationsPerMonth: 1,
      assessmentTemplates: 1,
    },
    ...(order !== undefined ? { order } : { order: undefined as unknown as number }),
  } as Plan;
}

// ----------------------------------------------------------------------------
// Plan ranking - upgrade vs downgrade (plan 3.2)
// ----------------------------------------------------------------------------

describe('plan ranking', () => {
  test('the ladder is bronze < silver < gold and doubles as the id allow-list', () => {
    expect(SELF_SERVE_PLAN_IDS).toEqual(['bronze', 'silver', 'gold']);
    expect(isSelfServePlanId('silver')).toBe(true);
    expect(isSelfServePlanId('platinum')).toBe(false);
    expect(isSelfServePlanId(1)).toBe(false);
  });

  test('the plan doc order field is the ranking truth when present', () => {
    // Docs deliberately inverted vs the literal ladder: order wins.
    expect(planRank('bronze', planWithOrder(9))).toBe(9);
    expect(
      isUpgrade('gold', planWithOrder(0), 'bronze', planWithOrder(9)),
    ).toBe(true);
  });

  test('missing docs fall back to the literal ladder', () => {
    expect(planRank('bronze', null)).toBe(0);
    expect(planRank('gold', null)).toBe(2);
    expect(isUpgrade('bronze', null, 'gold', null)).toBe(true);
    expect(isUpgrade('gold', null, 'silver', null)).toBe(false);
  });

  test('an equal rank lands on the DOWNGRADE path - the direction that charges nothing today', () => {
    expect(
      isUpgrade('bronze', planWithOrder(1), 'gold', planWithOrder(1)),
    ).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Onboarding resume (createSubscription, plan 3.1.8)
// ----------------------------------------------------------------------------

describe('isResumableOnboardingAttempt', () => {
  const attempt: UserOnboarding = {
    step: 'payment',
    planId: 'bronze',
    orgName: 'Acme',
    stripeCustomerId: 'cus_1',
    subscriptionId: 'sub_1',
    createdAt: 1,
  };

  test('resumes only when the requested plan matches the recorded attempt', () => {
    expect(isResumableOnboardingAttempt(attempt, 'bronze')).toBe(true);
    // A re-pick of a different tier must NEVER hand back the old secret - it
    // would charge the abandoned tier's price.
    expect(isResumableOnboardingAttempt(attempt, 'gold')).toBe(false);
  });

  test('never resumes without both Stripe objects or without a record at all', () => {
    expect(isResumableOnboardingAttempt(null, 'bronze')).toBe(false);
    expect(
      isResumableOnboardingAttempt(
        { ...attempt, subscriptionId: undefined },
        'bronze',
      ),
    ).toBe(false);
    expect(
      isResumableOnboardingAttempt(
        { ...attempt, stripeCustomerId: undefined },
        'bronze',
      ),
    ).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Period boundary (item-level current_period_end on the pinned API version)
// ----------------------------------------------------------------------------

describe('periodEndMs', () => {
  const subWithItems = (
    ...ends: (number | undefined)[]
  ): Stripe.Subscription =>
    ({
      items: { data: ends.map((end) => ({ current_period_end: end })) },
    }) as unknown as Stripe.Subscription;

  test('returns the LATEST item period end in ms epoch', () => {
    expect(periodEndMs(subWithItems(1_700_000_000, 1_800_000_000))).toBe(
      1_800_000_000_000,
    );
  });

  test('null for a subscription with no readable period - the caller must refuse to act', () => {
    expect(periodEndMs(subWithItems())).toBeNull();
    expect(periodEndMs(subWithItems(undefined))).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Invoice mapping (plan section 9)
// ----------------------------------------------------------------------------

describe('toInvoiceSummary', () => {
  const invoice = (overrides: Record<string, unknown>): Stripe.Invoice =>
    ({
      id: 'in_1',
      number: 'SAF-0001',
      created: 1_700_000_000,
      total: 4900,
      currency: 'gbp',
      status: 'paid',
      hosted_invoice_url: 'https://stripe/hosted',
      invoice_pdf: 'https://stripe/pdf',
      ...overrides,
    }) as unknown as Stripe.Invoice;

  test('maps a finalised invoice onto the full contract shape', () => {
    expect(toInvoiceSummary(invoice({}))).toEqual({
      id: 'in_1',
      number: 'SAF-0001',
      created: 1_700_000_000_000, // seconds -> ms
      amountPence: 4900,
      currency: 'gbp',
      status: 'paid',
      hostedInvoiceUrl: 'https://stripe/hosted',
      pdfUrl: 'https://stripe/pdf',
    });
  });

  test('drafts are dropped (null) - never part of billing history', () => {
    expect(toInvoiceSummary(invoice({ status: 'draft' }))).toBeNull();
    expect(toInvoiceSummary(invoice({ status: null }))).toBeNull();
  });

  test('a missing number falls back to the id and absent links are omitted', () => {
    const summary = toInvoiceSummary(
      invoice({ number: null, hosted_invoice_url: null, invoice_pdf: null }),
    );
    expect(summary).toMatchObject({ number: 'in_1' });
    expect(summary).not.toHaveProperty('hostedInvoiceUrl');
    expect(summary).not.toHaveProperty('pdfUrl');
  });
});

// ----------------------------------------------------------------------------
// Input validators - claims-vs-orgId, clamping, boolean strictness
// ----------------------------------------------------------------------------

describe('management callable input validators', () => {
  const ORG = 'org-mine';

  test('every validator rejects an orgId that is not the claims-bound org', () => {
    expect(() =>
      parseChangeSubscriptionInput({ orgId: 'org-other', planId: 'gold' }, ORG),
    ).toThrow(/your own organisation/i);
    expect(() =>
      parseResubscribeInput({ orgId: 'org-other', planId: 'gold' }, ORG),
    ).toThrow(/your own organisation/i);
    expect(() =>
      parseCancelSubscriptionInput({ orgId: 'org-other' }, ORG),
    ).toThrow(/your own organisation/i);
    expect(() =>
      parseCreateCardUpdateIntentInput({ orgId: 'org-other' }, ORG),
    ).toThrow(/your own organisation/i);
    expect(() =>
      parseListInvoicesInput({ orgId: 'org-other' }, ORG),
    ).toThrow(/your own organisation/i);
  });

  test('changeSubscription accepts only the self-serve tier ids', () => {
    expect(
      parseChangeSubscriptionInput({ orgId: ORG, planId: 'silver' }, ORG),
    ).toEqual({ planId: 'silver', preview: false });
    // preview must be LITERALLY true to quote; anything else is a real change.
    expect(
      parseChangeSubscriptionInput(
        { orgId: ORG, planId: 'gold', preview: true },
        ORG,
      ),
    ).toEqual({ planId: 'gold', preview: true });
    expect(() =>
      parseChangeSubscriptionInput({ orgId: ORG, planId: 'platinum' }, ORG),
    ).toThrow(/bronze, silver or gold/i);
  });

  test('resubscribe accepts only the self-serve tier ids', () => {
    expect(parseResubscribeInput({ orgId: ORG, planId: 'bronze' }, ORG)).toEqual(
      { planId: 'bronze' },
    );
    expect(() =>
      parseResubscribeInput({ orgId: ORG, planId: 'platinum' }, ORG),
    ).toThrow(/bronze, silver or gold/i);
    expect(() =>
      parseResubscribeInput({ orgId: ORG }, ORG),
    ).toThrow(/bronze, silver or gold/i);
  });

  test('getBillingState offers a payment secret for every finishable state, never for canceled', () => {
    // The SEV-1 reactivation path: unpaid (suspended) and past_due orgs can
    // pay the open invoice from the Billing tab...
    expect(needsPendingPaymentSecret({ status: 'unpaid' })).toBe(true);
    expect(needsPendingPaymentSecret({ status: 'past_due' })).toBe(true);
    expect(needsPendingPaymentSecret({ status: 'incomplete' })).toBe(true);
    expect(
      needsPendingPaymentSecret({ status: 'active', paymentState: 'action_required' }),
    ).toBe(true);
    // ...while a healthy subscription asks Stripe for nothing, and a canceled
    // one is routed to resubscribe instead of a dead subscription's invoice.
    expect(needsPendingPaymentSecret({ status: 'active' })).toBe(false);
    expect(needsPendingPaymentSecret({ status: 'canceled' })).toBe(false);
  });

  test('isRestartableStatus admits exactly the dead statuses resubscribe requires', () => {
    // The restart set and the change/cancel guard are the SAME predicate, so
    // an org can never be told both "restart" and "change your plan".
    expect(isRestartableStatus('canceled')).toBe(true);
    expect(isRestartableStatus('incomplete')).toBe(true);
    for (const live of ['active', 'trialing', 'past_due', 'unpaid', undefined]) {
      expect(isRestartableStatus(live)).toBe(false);
    }
  });

  test('cancelSubscription treats resume as a strict boolean, defaulting false', () => {
    expect(parseCancelSubscriptionInput({ orgId: ORG }, ORG)).toEqual({
      resume: false,
    });
    expect(
      parseCancelSubscriptionInput({ orgId: ORG, resume: true }, ORG),
    ).toEqual({ resume: true });
    expect(() =>
      parseCancelSubscriptionInput({ orgId: ORG, resume: 'yes' }, ORG),
    ).toThrow(/true or false/i);
  });

  test('listInvoices clamps the page size and rejects non-integer limits', () => {
    expect(parseListInvoicesInput({ orgId: ORG }, ORG)).toEqual({ limit: 12 });
    expect(parseListInvoicesInput({ orgId: ORG, limit: 1000 }, ORG)).toEqual({
      limit: 24,
    });
    expect(
      parseListInvoicesInput(
        { orgId: ORG, limit: 5, startingAfter: 'in_9' },
        ORG,
      ),
    ).toEqual({ limit: 5, startingAfter: 'in_9' });
    for (const bad of [0, -1, 2.5, 'ten']) {
      expect(() =>
        parseListInvoicesInput({ orgId: ORG, limit: bad }, ORG),
      ).toThrow(/whole number/i);
    }
  });
});

// ----------------------------------------------------------------------------
// saveOnboardingDetails - the pre-plan details step (restructured §3.1)
// ----------------------------------------------------------------------------

describe('parseOnboardingDetails', () => {
  it('accepts the full OrgContact-vocabulary shape, dropping nothing', () => {
    expect(
      parseOnboardingDetails({
        name: 'Acme Fire Safety',
        address: '1 King Street, Manchester, M2 6AW',
        phone: '0161 496 0000',
        website: 'acmefire.co.uk',
      }),
    ).toEqual({
      name: 'Acme Fire Safety',
      address: '1 King Street, Manchester, M2 6AW',
      phone: '0161 496 0000',
      website: 'acmefire.co.uk',
    });
  });

  it('stores only the fields actually given', () => {
    expect(parseOnboardingDetails({ name: 'Acme' })).toEqual({ name: 'Acme' });
    // Blank optionals vanish rather than storing empty strings.
    expect(parseOnboardingDetails({ name: 'Acme', phone: '  ' })).toEqual({
      name: 'Acme',
    });
  });

  it('rejects a missing, too-short or too-long name', () => {
    expect(() => parseOnboardingDetails({})).toThrow();
    expect(() => parseOnboardingDetails({ name: 'A' })).toThrow(/too short/);
    expect(() => parseOnboardingDetails({ name: 'x'.repeat(101) })).toThrow();
  });

  it('rejects unknown fields rather than dropping them', () => {
    expect(() =>
      parseOnboardingDetails({ name: 'Acme', city: 'Manchester' }),
    ).toThrow(/Unknown details field: city/);
  });
});

describe('nextOnboardingForDetails', () => {
  const details = { name: 'Acme Fire Safety', phone: '0161 496 0000' };

  it('creates a fresh node at step plan when none exists', () => {
    expect(nextOnboardingForDetails(null, details, 'test', 1000)).toEqual({
      step: 'plan',
      orgName: 'Acme Fire Safety',
      orgDetails: details,
      createdAt: 1000,
    });
  });

  it("updates a 'plan' journey in place, keeping its createdAt", () => {
    const existing: UserOnboarding = {
      step: 'plan',
      orgName: 'Old Name',
      orgDetails: { name: 'Old Name' },
      createdAt: 5,
    };
    expect(nextOnboardingForDetails(existing, details, 'test', 1000)).toEqual({
      step: 'plan',
      orgName: 'Acme Fire Safety',
      orgDetails: details,
      createdAt: 5,
    });
  });

  it('preserves a payment in flight: step and Stripe fields survive an edit', () => {
    const existing: UserOnboarding = {
      step: 'payment',
      planId: 'silver',
      orgName: 'Old Name',
      env: 'test',
      stripeCustomerId: 'cus_1',
      subscriptionId: 'sub_1',
      attemptNonce: 'nonce-1',
      createdAt: 5,
    };
    expect(nextOnboardingForDetails(existing, details, 'test', 1000)).toEqual({
      step: 'payment',
      planId: 'silver',
      orgName: 'Acme Fire Safety',
      orgDetails: details,
      env: 'test',
      stripeCustomerId: 'cus_1',
      subscriptionId: 'sub_1',
      attemptNonce: 'nonce-1',
      createdAt: 5,
    });
  });

  it('drops the Stripe fields of a payment minted in the OTHER mode (mode flip self-heals)', () => {
    const existing: UserOnboarding = {
      step: 'payment',
      planId: 'silver',
      orgName: 'Old Name',
      env: 'live',
      stripeCustomerId: 'cus_live',
      subscriptionId: 'sub_live',
      attemptNonce: 'nonce-live',
      createdAt: 5,
    };
    expect(nextOnboardingForDetails(existing, details, 'test', 1000)).toEqual({
      step: 'plan',
      orgName: 'Acme Fire Safety',
      orgDetails: details,
      createdAt: 5,
    });
  });

  it("replaces a finished ('done') journey afresh rather than dragging its fields along", () => {
    const existing: UserOnboarding = {
      step: 'done',
      planId: 'gold',
      orgId: 'org-old',
      subscriptionId: 'sub_old',
      createdAt: 5,
      completedAt: 6,
    };
    expect(nextOnboardingForDetails(existing, details, 'test', 1000)).toEqual({
      step: 'plan',
      orgName: 'Acme Fire Safety',
      orgDetails: details,
      createdAt: 1000,
    });
  });
});

describe('onboardingOrgName (createSubscription reads the node, not the request)', () => {
  it('prefers orgDetails.name, falls back to the legacy orgName', () => {
    expect(
      onboardingOrgName({
        step: 'plan',
        orgName: 'Legacy',
        orgDetails: { name: 'Acme Fire Safety' },
        createdAt: 1,
      }),
    ).toBe('Acme Fire Safety');
    expect(
      onboardingOrgName({ step: 'plan', orgName: 'Legacy', createdAt: 1 }),
    ).toBe('Legacy');
  });

  it('refuses calmly when no details have been saved', () => {
    expect(() => onboardingOrgName(null)).toThrow(/Tell us about your organisation/);
    expect(() =>
      onboardingOrgName({ step: 'plan', createdAt: 1 }),
    ).toThrow(/Tell us about your organisation/);
  });
});
