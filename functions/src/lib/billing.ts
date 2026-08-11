// ============================================================================
// Billing decision helpers (Phase 3, plan sections 3.2 and 9).
//
// The PURE pieces of the billing callables live here so they are unit-testable
// without Stripe or firebase-admin: which direction a plan change moves
// (upgrade vs downgrade decides immediate-with-proration vs scheduled at
// period end), where a subscription's current period ends, and how a Stripe
// invoice maps onto the client-facing InvoiceSummary contract. Every import is
// type-only, so jest consumers never construct an SDK client or touch admin
// initialisation.
// ============================================================================

import type Stripe from 'stripe';
import type {
  InvoiceSummary,
  OrgSubscription,
  Plan,
  UserOnboarding,
} from '../shared/types';

// ============================================================================
// Plan ranking (upgrade vs downgrade)
// ============================================================================

/** The self-serve tiers, in ascending order. This array is both the planId
 *  allow-list and the fallback ranking, so the two can never disagree. */
export const SELF_SERVE_PLAN_IDS = ['bronze', 'silver', 'gold'] as const;
export type SelfServePlanId = (typeof SELF_SERVE_PLAN_IDS)[number];

/** True when a value is one of the self-serve plan ids. */
export function isSelfServePlanId(value: unknown): value is SelfServePlanId {
  return (
    typeof value === 'string' &&
    (SELF_SERVE_PLAN_IDS as readonly string[]).includes(value)
  );
}

/**
 * Rank a plan for the upgrade/downgrade decision. The plan document's own
 * `order` field is the truth (plan section 5.3 - the display order doubles as
 * the tier ladder); when the doc is missing or predates the field, the literal
 * bronze < silver < gold ranking stands in, so the decision never depends on a
 * seed having run.
 */
export function planRank(planId: SelfServePlanId, plan: Plan | null): number {
  if (plan && typeof plan.order === 'number' && Number.isFinite(plan.order)) {
    return plan.order;
  }
  return SELF_SERVE_PLAN_IDS.indexOf(planId);
}

/**
 * True when the change moves UP the tier ladder - applied immediately with
 * proration. False means down - scheduled for period end. An equal rank (two
 * plan docs misconfigured with the same order) deliberately lands on the
 * downgrade path: scheduling at period end charges nothing today, so it is the
 * safe way to be wrong.
 */
export function isUpgrade(
  currentPlanId: SelfServePlanId,
  currentPlan: Plan | null,
  targetPlanId: SelfServePlanId,
  targetPlan: Plan | null,
): boolean {
  return planRank(targetPlanId, targetPlan) > planRank(currentPlanId, currentPlan);
}

// ============================================================================
// Dead-subscription statuses (SEV-1 fix: resubscribe + management guards)
// ============================================================================

/**
 * True when the mirrored status means the subscription is DEAD and the only
 * way forward is the resubscribe flow: 'canceled' (Stripe subscriptions cannot
 * be revived) or 'incomplete' (a restarted subscription whose first payment
 * never confirmed - retriable through the same flow; note mapStatus collapses
 * Stripe's incomplete_expired into 'incomplete' too). changeSubscription and
 * cancelSubscription refuse these statuses - acting on a dead subscription
 * reaches Stripe against an immutable object and fails raw - and resubscribe
 * REQUIRES one of them, so the two sets can never overlap.
 */
export function isRestartableStatus(status: string | undefined): boolean {
  return status === 'canceled' || status === 'incomplete';
}

/**
 * Should getBillingState offer the admin a Payment Element secret for a
 * payment they can finish RIGHT NOW? True for a 3DS challenge
 * (action_required), an unpaid first invoice ('incomplete' - a restarted
 * subscription), a dunning retry ('past_due') and - the SEV-1 reactivation
 * path - a suspended subscription's outstanding invoice ('unpaid').
 * Deliberately FALSE for 'canceled': a dead subscription's invoice must never
 * be paid - the way back from canceled is the resubscribe flow. The caller
 * still verifies against Stripe that the latest invoice is genuinely OPEN
 * before returning a secret; this predicate only decides whether to ask.
 */
export function needsPendingPaymentSecret(
  subscription: Pick<OrgSubscription, 'status' | 'paymentState'>,
): boolean {
  return (
    subscription.paymentState === 'action_required' ||
    subscription.status === 'incomplete' ||
    subscription.status === 'past_due' ||
    subscription.status === 'unpaid'
  );
}

/** What a subscription's OPEN latest invoice offers the Billing tab: the
 *  Payment Element client secret to settle it right now, and - when Stripe has
 *  a dunning retry scheduled - the ms-epoch instant of the next automatic
 *  collection attempt. */
export interface PendingPayment {
  clientSecret?: string;
  nextPaymentAttempt?: number;
}

/**
 * Map a subscription's expanded latest invoice onto the pending-payment facts
 * getBillingState returns. Anything but a genuinely OPEN invoice yields {} -
 * a settled or voided invoice has nothing to pay and no retry to speak of, and
 * an unexpanded (string) invoice carries neither fact. Each field is present
 * only when Stripe actually supplied it: the confirmation secret while the
 * invoice awaits payment, next_payment_attempt only while the smart-retry
 * schedule still has an attempt to come.
 */
export function pendingPaymentFromInvoice(
  invoice: Stripe.Invoice | string | null | undefined,
): PendingPayment {
  if (!invoice || typeof invoice === 'string' || invoice.status !== 'open') {
    return {};
  }
  const pending: PendingPayment = {};
  const secret = invoice.confirmation_secret?.client_secret;
  if (secret) {
    pending.clientSecret = secret;
  }
  if (
    typeof invoice.next_payment_attempt === 'number' &&
    Number.isFinite(invoice.next_payment_attempt)
  ) {
    pending.nextPaymentAttempt = invoice.next_payment_attempt * 1000;
  }
  return pending;
}

// ============================================================================
// Onboarding resume (createSubscription, plan 3.1.8)
// ============================================================================

/**
 * True when an existing onboarding attempt can be RESUMED for the requested
 * tier: the record must already name both Stripe objects AND be for the SAME
 * plan the caller just picked. A re-pick of a different tier must never
 * resume - handing back the old subscription's client secret would charge the
 * abandoned tier's price - so it falls through to a fresh create (the Stripe
 * idempotency key includes the planId, so a new tier mints a new subscription
 * and the abandoned incomplete one expires on Stripe's side).
 *
 * The caller still confirms the resumed subscription is genuinely 'incomplete'
 * against the live Stripe object - this predicate only decides whether the
 * attempt is worth retrieving.
 */
export function isResumableOnboardingAttempt(
  onboarding: UserOnboarding | null,
  requestedPlanId: string,
): onboarding is UserOnboarding & {
  subscriptionId: string;
  stripeCustomerId: string;
} {
  return Boolean(
    onboarding?.subscriptionId &&
      onboarding.stripeCustomerId &&
      onboarding.planId === requestedPlanId,
  );
}

// ============================================================================
// Subscription period boundary
// ============================================================================

/**
 * The ms-epoch instant the subscription's current billing period ends.
 * stripe@22 (basil-era API versions) carries `current_period_end` on the
 * subscription ITEMS rather than the subscription root; the latest end across
 * items is the billing boundary. Null when the subscription carries no items -
 * a malformed record the caller should refuse to act on.
 */
export function periodEndMs(subscription: Stripe.Subscription): number | null {
  const ends = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((end): end is number => typeof end === 'number' && Number.isFinite(end));
  if (ends.length === 0) {
    return null;
  }
  return Math.max(...ends) * 1000;
}

// ============================================================================
// Invoice mapping (plan section 9, listInvoices)
// ============================================================================

/** The statuses the InvoiceSummary contract admits - everything a customer
 *  should see in their billing history. */
const INVOICE_SUMMARY_STATUSES = [
  'paid',
  'open',
  'void',
  'uncollectible',
] as const satisfies readonly InvoiceSummary['status'][];

/**
 * Map one Stripe invoice onto the client contract, or null when it should not
 * appear at all: a `draft` invoice is not yet finalised (no number, no hosted
 * page, and Stripe may still delete it), so it is never part of the billing
 * history the org admin reads.
 *
 * amountPence is the invoice `total` - the post-discount amount the invoice
 * actually billed - rather than `amount_due`, which nets off customer-balance
 * credit and so under-reports what the invoice was for.
 */
export function toInvoiceSummary(invoice: Stripe.Invoice): InvoiceSummary | null {
  const status = invoice.status;
  if (!status || !(INVOICE_SUMMARY_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  return {
    id: invoice.id,
    // Finalised invoices always carry a number; the id stands in defensively so
    // the required field can never be an empty string.
    number: invoice.number ?? invoice.id,
    created: invoice.created * 1000,
    amountPence: invoice.total,
    currency: invoice.currency,
    status: status as InvoiceSummary['status'],
    ...(invoice.hosted_invoice_url
      ? { hostedInvoiceUrl: invoice.hosted_invoice_url }
      : {}),
    ...(invoice.invoice_pdf ? { pdfUrl: invoice.invoice_pdf } : {}),
  };
}
