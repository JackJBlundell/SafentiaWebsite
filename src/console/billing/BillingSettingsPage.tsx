// ============================================================================
// BillingSettingsPage - Settings > Billing (Phase 3 §3.2-§3.5, §7): the one
// place an org admin sees and changes their subscription.
//
// Five cards: current plan, change plan, cancel/resume, payment method,
// invoice history. Every mutation goes through the billing callables and every
// fact on screen comes from RTDB (via useEntitlements) or listInvoices - the
// client never talks to the Stripe API. Card and payment confirmation use
// Stripe's Payment Element inside the shared dialog shell; Stripe.js arrives
// ONLY via loadStripeForEnv (dynamic import, SSG-safe), and a null resolution
// renders a calm not-configured notice instead of a broken control.
//
// An organisation without a stripeSubscriptionId is operator-managed: the page
// says so in one card and renders nothing billing-mutating - there is no
// self-serve subscription to change, cancel or pay for.
//
// Server behaviour the copy reflects (§3.2/§3.3/§3.4): upgrades apply
// immediately with a prorated charge; downgrades land at period end via a
// subscription schedule; cancel is period-end only with resume until the date;
// a card update is finalised by the webhook, so the paymentMethod block on
// screen can lag the successful confirm by a moment - the copy says so rather
// than pretending the write was instant.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import type { Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { platform } from '../../paths';
import type {
  CancelSubscriptionRequest,
  CancelSubscriptionResponse,
  ChangeSubscriptionRequest,
  ChangeSubscriptionResponse,
  CreateCardUpdateIntentRequest,
  CreateCardUpdateIntentResponse,
  Environment,
  GetBillingStateRequest,
  GetBillingStateResponse,
  InvoiceSummary,
  ListInvoicesRequest,
  ListInvoicesResponse,
  OrgSubscription,
  OrgUsage,
  Plan,
  ResubscribeRequest,
  ResubscribeResponse,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { Skeleton } from '../ui/Skeleton';
import { useCallable } from '../ui/useCallable';
import { EmailsDialog } from '../emails/EmailsDialog';
import { formatDate, formatDateShort } from '../customers/shared';
import { useEntitlements } from './useEntitlements';
import { loadStripeForEnv } from './stripeClient';
import { formatMonthlyPrice, sortPlans } from './SubscribePlanPage';
import styles from './BillingSettingsPage.module.css';

/** Pence to a two-place pounds amount for tables and charges: invoices and
 *  proration deltas read as money, so "£49.00", never "£49". */
export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** Invoice status as a word (never colour alone). Stripe's vocabulary said in
 *  plain English; 'uncollectible' is Stripe's writing-off state. */
export const INVOICE_STATUS_LABELS: Record<InvoiceSummary['status'], string> = {
  paid: 'Paid',
  open: 'Awaiting payment',
  void: 'Void',
  uncollectible: 'Written off',
};

/** "visa" → "Visa" for the payment-method line. Stripe brands arrive
 *  lower-cased; anything unrecognised still reads acceptably capitalised. */
function brandLabel(brand: string): string {
  if (brand.length === 0) return 'Card';
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

export function BillingSettingsPage() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const env: Environment = paths?.env ?? 'live';

  const { subscription, plan, usage, loading } = useEntitlements();

  // The full catalogue, for the change-plan matrix and for naming a pending
  // downgrade target. Authed-read platform data, same read as the subscribe
  // matrix.
  const plansQuery = useRtdbQuery<Record<string, Plan> | null>({
    key: keys.platformPlans(env),
    path: platform.plans(env),
    enabled: Boolean(paths),
  });
  const plans = useMemo(() => sortPlans(plansQuery.data), [plansQuery.data]);

  // One Stripe.js load for the whole page; null = not configured, and the
  // payment-method card degrades to a calm notice instead of a dialog.
  const [stripe, setStripe] = useState<Stripe | null | 'loading'>('loading');
  useEffect(() => {
    let cancelled = false;
    loadStripeForEnv(env).then((resolved) => {
      if (!cancelled) setStripe(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [env]);

  // A payment left needing action (3DS, a failed confirm): getBillingState
  // surfaces the pending client secret so the admin can finish it here.
  const billingState = useCallable<GetBillingStateRequest, GetBillingStateResponse>(
    'getBillingState',
  );
  const [pendingSecret, setPendingSecret] = useState<string | null>(null);
  // Stripe's scheduled dunning retry (ms epoch), when the open invoice has
  // one - lets the past_due copy say WHEN the card will be tried again.
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const selfServe = Boolean(subscription?.stripeSubscriptionId);
  useEffect(() => {
    if (!selfServe || !orgId) return;
    let cancelled = false;
    void billingState.call({ orgId }).then((response) => {
      if (cancelled || !response) return;
      if (response.pendingPaymentClientSecret) {
        setPendingSecret(response.pendingPaymentClientSecret);
      }
      setNextRetryAt(response.nextPaymentAttempt ?? null);
    });
    return () => {
      cancelled = true;
    };
    // Mount-per-subscription only: the callable handle is stable, and re-asking
    // on every render would hammer the function for a rarely-set field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfServe, orgId]);

  // A fresh read of the pending-payment facts, for the pay-now follow-on after
  // a card update: the secret and retry date must be re-fetched (a race may
  // have settled the invoice), and the page state keeps step with the answer.
  const refreshPendingPayment = async (): Promise<GetBillingStateResponse | null> => {
    const response = await billingState.call({ orgId });
    if (!response) return null;
    setPendingSecret(response.pendingPaymentClientSecret ?? null);
    setNextRetryAt(response.nextPaymentAttempt ?? null);
    return response;
  };

  if (loading) {
    return (
      <>
        <PageHeader title="Billing" lede="Your plan, payment method and invoices." />
        <div className={styles.sections} aria-hidden="true">
          <Skeleton height="8rem" />
          <Skeleton height="8rem" />
        </div>
      </>
    );
  }

  // Operator-managed organisation: one honest card, nothing mutating.
  if (!selfServe) {
    return (
      <>
        <PageHeader title="Billing" lede="Your plan, payment method and invoices." />
        <Card>
          <CardHeader title="Subscription" />
          <p className={styles.note}>
            Your organisation&apos;s subscription is managed by Safentia. If you
            have a question about your plan or billing, please contact us.
          </p>
        </Card>
      </>
    );
  }

  // A dead subscription (canceled, or an incomplete restart still awaiting its
  // first payment - the SEV-1 way back): the management cards are meaningless
  // against a dead Stripe object, so the page swaps to the restart experience.
  // The invoice history stays - it is the org's record either way.
  if (
    subscription?.status === 'canceled' ||
    subscription?.status === 'incomplete'
  ) {
    return (
      <>
        <PageHeader title="Billing" lede="Your plan, payment method and invoices." />
        <div className={styles.sections}>
          <RestartCard orgId={orgId} plans={plans} stripe={stripe} />
          <InvoicesCard orgId={orgId} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Billing" lede="Your plan, payment method and invoices." />
      <div className={styles.sections}>
        <CurrentPlanCard
          subscription={subscription}
          plan={plan}
          plansById={plansQuery.data ?? null}
        />
        <ChangePlanCard
          orgId={orgId}
          subscription={subscription}
          currentPlan={plan}
          plans={plans}
          usage={usage}
        />
        <CancelCard orgId={orgId} subscription={subscription} />
        <PaymentMethodCard
          orgId={orgId}
          subscription={subscription}
          stripe={stripe}
          pendingSecret={pendingSecret}
          onPendingSettled={() => setPendingSecret(null)}
        />
        <InvoicesCard orgId={orgId} />
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------
// Current plan - what the organisation is on, and every dated fact about
// where it is heading: renewal, a pending downgrade, a scheduled end, and the
// dunning states (§3.5) said plainly.
// ----------------------------------------------------------------------------

function CurrentPlanCard({
  subscription,
  plan,
  plansById,
}: {
  subscription: OrgSubscription | undefined;
  plan: Plan | undefined;
  plansById: Record<string, Plan> | null;
}) {
  const periodEnd = subscription?.currentPeriodEnd;
  const pendingPlanId = subscription?.pendingPlanId;
  const pendingPlanName = pendingPlanId
    ? (plansById?.[pendingPlanId]?.name ?? pendingPlanId)
    : null;

  return (
    <Card>
      <CardHeader title="Current plan" />
      <div className={styles.cardBody}>
        {plan ? (
          <p className={styles.planLine}>
            <span className={styles.planName}>{plan.name}</span>{' '}
            <span className={styles.planPrice}>
              {formatMonthlyPrice(plan.priceMonthlyPence)} per month, excluding VAT
            </span>
          </p>
        ) : (
          <p className={styles.note}>Your plan details are loading.</p>
        )}

        {subscription?.cancelAtPeriodEnd && periodEnd ? (
          <p className={styles.note}>
            Your subscription ends on {formatDate(periodEnd)}. You can resume it
            below at any time before then.
          </p>
        ) : periodEnd && subscription?.status !== 'unpaid' ? (
          // A suspended (unpaid) subscription is not renewing - the honest
          // line for it is the suspension notice below, not a renewal date.
          <p className={styles.note}>Renews on {formatDate(periodEnd)}.</p>
        ) : null}

        {pendingPlanName && periodEnd && (
          <p className={styles.note}>
            Changes to {pendingPlanName} on {formatDate(periodEnd)}.
          </p>
        )}

        {subscription?.status === 'unpaid' && (
          <p className={styles.warning} role="status">
            Your payment could not be collected, so your subscription is paused
            and creating new work is blocked. Pay your outstanding invoice from
            the payment method section below to put everything back as it was -
            all of your existing data is untouched.
          </p>
        )}

        {subscription?.status !== 'unpaid' &&
          subscription?.paymentState === 'past_due' && (
          <p className={styles.warning} role="status">
            Your last payment did not go through. Your subscription continues
            unchanged
            {subscription.graceUntil
              ? ` until ${formatDate(subscription.graceUntil)}`
              : ' for now'}
            {' '}- please update your card below to keep it that way.
          </p>
        )}

        {subscription?.status !== 'unpaid' &&
          subscription?.paymentState === 'action_required' && (
          <p className={styles.warning} role="status">
            Your bank has asked for extra confirmation of your last payment.
            Please finish confirming it from the payment method section below.
          </p>
        )}
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Change plan - the three-tier matrix with the current tier highlighted. The
// confirm dialog states exactly what will happen before anything is sent:
// upgrades charge the difference now, downgrades land at renewal (§3.2). An
// over-limit downgrade warns with the real numbers but is allowed - the
// degrade policy keeps existing records and blocks only new ones.
// ----------------------------------------------------------------------------

function ChangePlanCard({
  orgId,
  subscription,
  currentPlan,
  plans,
  usage,
}: {
  orgId: string;
  subscription: OrgSubscription | undefined;
  currentPlan: Plan | undefined;
  plans: Array<{ id: string; plan: Plan }>;
  usage: OrgUsage | undefined;
}) {
  const change = useCallable<ChangeSubscriptionRequest, ChangeSubscriptionResponse>(
    'changeSubscription',
  );
  // A second handle for the read-only proration quote, so its pending/error
  // state never leaks into the real change button.
  const preview = useCallable<ChangeSubscriptionRequest, ChangeSubscriptionResponse>(
    'changeSubscription',
  );
  const [choice, setChoice] = useState<{ id: string; plan: Plan } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // The quote for the OPEN dialog's upgrade, keyed by plan id so a stale
  // amount can never show against a different choice. 'failed' (or still
  // loading) falls back to the generic copy - a broken preview must never
  // block the change itself.
  const [quote, setQuote] = useState<
    { planId: string; amountPence: number } | 'loading' | 'failed' | null
  >(null);

  const currentPlanId = subscription?.planId;

  const confirmChange = async (target: { id: string; plan: Plan }) => {
    const response = await change.call({ orgId, planId: target.id });
    setChoice(null);
    if (!response) return;
    if (response.effective === 'immediate') {
      setResult(
        `Your plan is now ${target.plan.name}.` +
          (typeof response.prorationAmountPence === 'number' &&
          response.prorationAmountPence > 0
            ? ` ${formatPence(response.prorationAmountPence)} has been charged for the rest of this period.`
            : ''),
      );
    } else {
      setResult(
        `Your plan changes to ${target.plan.name} on ${formatDate(response.effectiveAt)}.`,
      );
    }
  };

  // Direction decides the copy; the plan documents' display order is the one
  // rank the catalogue defines (bronze < silver < gold).
  const isUpgrade = (target: Plan) =>
    currentPlan ? target.order > currentPlan.order : false;

  // Fetch the proration quote when an upgrade dialog opens (preview: true is
  // a pure read on the server - nothing is changed until the confirm press).
  useEffect(() => {
    if (!choice || !isUpgrade(choice.plan)) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const targetPlanId = choice.id;
    setQuote('loading');
    void preview
      .call({ orgId, planId: targetPlanId, preview: true })
      .then((response) => {
        if (cancelled) return;
        if (
          response?.effective === 'immediate' &&
          typeof response.prorationAmountPence === 'number' &&
          response.prorationAmountPence > 0
        ) {
          setQuote({
            planId: targetPlanId,
            amountPence: response.prorationAmountPence,
          });
        } else {
          setQuote('failed');
        }
      })
      .catch(() => {
        if (!cancelled) setQuote('failed');
      });
    return () => {
      cancelled = true;
    };
    // Only the dialog's choice should re-fire the quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, orgId]);

  // The honest over-limit lines for a downgrade target: current usage against
  // the target's limits, only where the target actually meters (-1 = unlimited).
  const overLimitLines = (target: Plan): string[] => {
    if (!usage) return [];
    const lines: string[] = [];
    const { limits } = target;
    if (limits.orgStaff !== -1 && usage.staffCount > limits.orgStaff) {
      lines.push(
        `You have ${usage.staffCount} staff members; ${target.name} includes ${limits.orgStaff}.`,
      );
    }
    if (limits.customers !== -1 && usage.customerCount > limits.customers) {
      lines.push(
        `You have ${usage.customerCount} customers; ${target.name} includes ${limits.customers}.`,
      );
    }
    if (
      limits.notificationsPerMonth !== -1 &&
      usage.notificationsThisMonth > limits.notificationsPerMonth
    ) {
      lines.push(
        `You have sent ${usage.notificationsThisMonth} notifications this month; ${target.name} includes ${limits.notificationsPerMonth}.`,
      );
    }
    return lines;
  };

  return (
    <Card>
      <CardHeader
        title="Change plan"
        hint="Upgrades start straight away; downgrades take effect at your renewal date."
      />
      <div className={styles.cardBody}>
        {plans.length === 0 ? (
          <p className={styles.note}>The plans could not be loaded just now.</p>
        ) : (
          <ul className={styles.planGrid}>
            {plans.map(({ id, plan }) => {
              const isCurrent = id === currentPlanId;
              return (
                <li
                  key={id}
                  className={
                    isCurrent
                      ? `${styles.planOption} ${styles.planOptionCurrent}`
                      : styles.planOption
                  }
                  aria-current={isCurrent || undefined}
                >
                  <span className={styles.planOptionName}>{plan.name}</span>
                  <span className={styles.planOptionPrice}>
                    {formatMonthlyPrice(plan.priceMonthlyPence)} per month
                  </span>
                  {isCurrent ? (
                    <span className={styles.currentBadge}>Current plan</span>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={change.pending || !currentPlan}
                      onClick={() => {
                        setResult(null);
                        setChoice({ id, plan });
                      }}
                    >
                      Choose {plan.name}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {change.error && <ErrorNotice message={change.error} />}
        {result && (
          <p className={styles.success} role="status">
            {result}
          </p>
        )}
      </div>

      {choice && (
        <EmailsDialog
          title={`Change to ${choice.plan.name}`}
          titleId="billing-change-plan-title"
          onClose={() => {
            if (!change.pending) setChoice(null);
          }}
        >
          <div className={styles.dialogBody}>
            {isUpgrade(choice.plan) ? (
              <p className={styles.dialogCopy}>
                Your new plan starts immediately.{' '}
                {typeof quote === 'object' && quote?.planId === choice.id
                  ? `You'll be charged ${formatPence(quote.amountPence)} now for the rest of this period.`
                  : "You'll be charged the difference for the rest of this period now."}{' '}
                From your next renewal you&apos;ll pay{' '}
                {formatMonthlyPrice(choice.plan.priceMonthlyPence)} per month.
              </p>
            ) : (
              <p className={styles.dialogCopy}>
                Your plan changes to {choice.plan.name}
                {subscription?.currentPeriodEnd
                  ? ` on ${formatDate(subscription.currentPeriodEnd)}`
                  : ' at your renewal date'}
                . You&apos;ll keep everything your current plan includes until
                then.
              </p>
            )}

            {!isUpgrade(choice.plan) &&
              overLimitLines(choice.plan).map((line) => (
                <p key={line} className={styles.warning}>
                  {line} You&apos;ll keep everything you already have, but
                  won&apos;t be able to add more until you&apos;re within the
                  limit.
                </p>
              ))}

            {change.error && <ErrorNotice message={change.error} />}

            <div className={styles.dialogActions}>
              <Button
                disabled={change.pending}
                onClick={() => void confirmChange(choice)}
              >
                {change.pending ? 'Changing…' : `Change to ${choice.plan.name}`}
              </Button>
              <Button
                variant="ghost"
                disabled={change.pending}
                onClick={() => setChoice(null)}
              >
                Keep my current plan
              </Button>
            </div>
          </div>
        </EmailsDialog>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Cancel / resume - period-end only (§3.3), through the house two-step inline
// confirm: the first press swaps the button for a short prompt, so a slip of
// the mouse can never cancel a subscription. While a cancellation is
// scheduled, the resume control replaces it entirely.
// ----------------------------------------------------------------------------

function CancelCard({
  orgId,
  subscription,
}: {
  orgId: string;
  subscription: OrgSubscription | undefined;
}) {
  const cancel = useCallable<CancelSubscriptionRequest, CancelSubscriptionResponse>(
    'cancelSubscription',
  );
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const periodEnd = subscription?.currentPeriodEnd;
  const scheduled = subscription?.cancelAtPeriodEnd === true;

  const run = async (resume: boolean) => {
    setConfirming(false);
    const response = await cancel.call(resume ? { orgId, resume: true } : { orgId });
    if (!response) return;
    setResult(
      response.cancelAtPeriodEnd
        ? `Your subscription is scheduled to end on ${formatDate(response.periodEnd)}. You can resume it at any time before then.`
        : 'Your subscription will continue as normal.',
    );
  };

  return (
    <Card>
      <CardHeader
        title={scheduled ? 'Resume subscription' : 'Cancel subscription'}
        hint={
          scheduled
            ? 'Pick your subscription back up before it ends.'
            : 'Cancelling takes effect at the end of your current period.'
        }
      />
      <div className={styles.cardBody}>
        {scheduled ? (
          <>
            <p className={styles.note}>
              Your subscription is set to end
              {periodEnd ? ` on ${formatDate(periodEnd)}` : ' at your renewal date'}
              . Resume it and nothing changes - your plan carries on as before.
            </p>
            <Button disabled={cancel.pending} onClick={() => void run(true)}>
              {cancel.pending ? 'Resuming…' : 'Resume subscription'}
            </Button>
          </>
        ) : (
          <>
            <p className={styles.note}>
              You&apos;ll keep full access
              {periodEnd ? ` until ${formatDate(periodEnd)}` : ' until the end of your current period'}
              , and you won&apos;t be charged again. You can resume any time
              before then.
            </p>
            {confirming ? (
              <span className={styles.confirmGroup}>
                <span className={styles.confirmPrompt}>
                  Cancel your subscription
                  {periodEnd ? ` from ${formatDate(periodEnd)}` : ''}?
                </span>
                <Button
                  variant="secondary"
                  disabled={cancel.pending}
                  onClick={() => void run(false)}
                >
                  Confirm
                </Button>
                <Button
                  variant="ghost"
                  disabled={cancel.pending}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <Button variant="ghost" onClick={() => setConfirming(true)}>
                Cancel subscription
              </Button>
            )}
          </>
        )}

        {cancel.error && <ErrorNotice message={cancel.error} />}
        {result && (
          <p className={styles.success} role="status">
            {result}
          </p>
        )}
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Restart - the SEV-1 way back from a dead subscription. A cancelled Stripe
// subscription cannot be revived, so restarting is a NEW subscription on the
// org's existing customer: pick a tier from the same matrix the change-plan
// card uses, the resubscribe callable returns the Payment Element secret, and
// the webhook flips the org back to active (and unblocks creates) the moment
// the payment confirms. Retrying is safe: resubscribe resumes a same-plan
// attempt and replaces a different-plan one.
// ----------------------------------------------------------------------------

function RestartCard({
  orgId,
  plans,
  stripe,
}: {
  orgId: string;
  plans: Array<{ id: string; plan: Plan }>;
  stripe: Stripe | null | 'loading';
}) {
  const restart = useCallable<ResubscribeRequest, ResubscribeResponse>('resubscribe');
  const [dialog, setDialog] = useState<{
    planName: string;
    clientSecret: string;
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const choosePlan = async (id: string, plan: Plan) => {
    setStatus(null);
    const response = await restart.call({ orgId, planId: id });
    if (response) {
      setDialog({ planName: plan.name, clientSecret: response.clientSecret });
    }
  };

  return (
    <Card>
      <CardHeader
        title="Restart your subscription"
        hint="Pick a plan and pay for your first month to carry on where you left off."
      />
      <div className={styles.cardBody}>
        <p className={styles.note}>
          Your subscription has ended, so creating new work is paused. All of
          your existing data is untouched - restart on any plan and everything
          picks up exactly where it left off.
        </p>

        {stripe === null ? (
          <p className={styles.note} role="status">
            Restarting is not available just yet. Please try again later, or
            contact us if this keeps happening.
          </p>
        ) : plans.length === 0 ? (
          <p className={styles.note}>The plans could not be loaded just now.</p>
        ) : (
          <ul className={styles.planGrid}>
            {plans.map(({ id, plan }) => (
              <li key={id} className={styles.planOption}>
                <span className={styles.planOptionName}>{plan.name}</span>
                <span className={styles.planOptionPrice}>
                  {formatMonthlyPrice(plan.priceMonthlyPence)} per month
                </span>
                <Button
                  variant="secondary"
                  disabled={restart.pending || stripe === 'loading'}
                  onClick={() => void choosePlan(id, plan)}
                >
                  Restart on {plan.name}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {restart.error && <ErrorNotice message={restart.error} />}
        {status && (
          <p className={styles.success} role="status">
            {status}
          </p>
        )}
      </div>

      {dialog && stripe !== null && stripe !== 'loading' && (
        <EmailsDialog
          title={`Restart on ${dialog.planName}`}
          titleId="billing-restart-dialog-title"
          onClose={() => setDialog(null)}
        >
          <div className={styles.dialogBody}>
            <Elements stripe={stripe} options={{ clientSecret: dialog.clientSecret }}>
              <PaymentDialogForm
                mode="payment"
                onDone={() => {
                  setDialog(null);
                  setStatus(
                    'Thank you - your payment has been confirmed. It can take a moment for your subscription to restart here.',
                  );
                }}
                onCancel={() => setDialog(null)}
              />
            </Elements>
          </div>
        </EmailsDialog>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Payment method - the card on file (display metadata only, SAQ-A), the
// update flow (§3.4: SetupIntent → Payment Element → webhook finalises), and
// the finish-a-pending-payment flow (§3.5: 3DS confirmation via the invoice's
// PaymentIntent secret). Both share one dialog; only the confirm call differs.
// ----------------------------------------------------------------------------

function PaymentMethodCard({
  orgId,
  subscription,
  stripe,
  pendingSecret,
  onPendingSettled,
}: {
  orgId: string;
  subscription: OrgSubscription | undefined;
  stripe: Stripe | null | 'loading';
  pendingSecret: string | null;
  onPendingSettled: () => void;
}) {
  const createIntent = useCallable<
    CreateCardUpdateIntentRequest,
    CreateCardUpdateIntentResponse
  >('createCardUpdateIntent');
  const [dialog, setDialog] = useState<{
    mode: 'setup' | 'payment';
    clientSecret: string;
  } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const method = subscription?.paymentMethod;

  // Why is a payment pending? A suspended (unpaid) or dunning (past_due)
  // subscription owes its OPEN INVOICE - "pay what's outstanding" - while
  // action_required is a 3DS challenge on a payment already in flight -
  // "confirm it". Same Payment Element flow either way; only the words change,
  // because telling a suspended admin to "finish confirming" a payment they
  // know failed reads like a bug.
  const paysOutstandingInvoice =
    subscription?.status === 'unpaid' || subscription?.status === 'past_due';

  const openCardUpdate = async () => {
    setStatus(null);
    const response = await createIntent.call({ orgId });
    if (response) setDialog({ mode: 'setup', clientSecret: response.clientSecret });
  };

  return (
    <Card>
      <CardHeader title="Payment method" />
      <div className={styles.cardBody}>
        {method ? (
          <p className={styles.cardLine}>
            {brandLabel(method.brand)} ending {method.last4}, expires{' '}
            {String(method.expMonth).padStart(2, '0')}/{method.expYear}
          </p>
        ) : (
          <p className={styles.note}>No card on file.</p>
        )}

        {stripe === null ? (
          <p className={styles.note} role="status">
            Card changes are not available just yet. Please try again later, or
            contact us if this keeps happening.
          </p>
        ) : (
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={createIntent.pending || stripe === 'loading'}
              onClick={() => void openCardUpdate()}
            >
              {createIntent.pending ? 'Preparing…' : 'Update card'}
            </Button>
            {pendingSecret && (
              <Button
                disabled={stripe === 'loading'}
                onClick={() => {
                  setStatus(null);
                  setDialog({ mode: 'payment', clientSecret: pendingSecret });
                }}
              >
                {paysOutstandingInvoice
                  ? 'Pay your outstanding invoice'
                  : 'Finish confirming your payment'}
              </Button>
            )}
          </div>
        )}

        {createIntent.error && <ErrorNotice message={createIntent.error} />}
        {status && (
          <p className={styles.success} role="status">
            {status}
          </p>
        )}
      </div>

      {dialog && stripe !== null && stripe !== 'loading' && (
        <EmailsDialog
          title={
            dialog.mode === 'setup'
              ? 'Update your card'
              : paysOutstandingInvoice
                ? 'Pay your outstanding invoice'
                : 'Confirm your payment'
          }
          titleId="billing-payment-dialog-title"
          onClose={() => setDialog(null)}
        >
          <div className={styles.dialogBody}>
            <Elements stripe={stripe} options={{ clientSecret: dialog.clientSecret }}>
              <PaymentDialogForm
                mode={dialog.mode}
                onDone={() => {
                  setDialog(null);
                  if (dialog.mode === 'setup') {
                    setStatus(
                      'Your card has been updated. It can take a moment for the new details to appear here.',
                    );
                  } else {
                    setStatus(
                      'Thank you - your payment has been confirmed. It can take a moment for your subscription to update here.',
                    );
                    onPendingSettled();
                  }
                }}
                onCancel={() => setDialog(null)}
              />
            </Elements>
          </div>
        </EmailsDialog>
      )}
    </Card>
  );
}

/**
 * The form inside the Elements provider (useStripe/useElements only resolve
 * there). Confirm stays in the dialog (`redirect: 'if_required'`) so 3DS is
 * handled inline; the webhook does the finalising server-side either way.
 */
function PaymentDialogForm({
  mode,
  onDone,
  onCancel,
}: {
  mode: 'setup' | 'payment';
  onDone: () => void;
  onCancel: () => void;
}) {
  const stripeJs = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const confirm = async () => {
    if (!stripeJs || !elements || submitting) return;
    setSubmitting(true);
    setCardError(null);
    try {
      const result =
        mode === 'setup'
          ? await stripeJs.confirmSetup({ elements, redirect: 'if_required' })
          : await stripeJs.confirmPayment({ elements, redirect: 'if_required' });
      if (result.error) {
        // Stripe's card errors are already written for the cardholder.
        setCardError(
          result.error.message ??
            'That did not go through. Please check the details and try again.',
        );
        return;
      }
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={styles.dialogForm}
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      <PaymentElement />
      {cardError && <ErrorNotice message={cardError} />}
      <div className={styles.dialogActions}>
        <Button type="submit" disabled={submitting}>
          {submitting
            ? 'Confirming…'
            : mode === 'setup'
              ? 'Save card'
              : 'Confirm payment'}
        </Button>
        <Button variant="ghost" disabled={submitting} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------------------------
// Invoices - the Stripe-hosted history (listInvoices, §7): number, date,
// amount, status as a word, and the hosted page link - Stripe hosts the PDF,
// keeping invoice delivery out of PCI scope. Pages through with hasMore /
// startingAfter.
// ----------------------------------------------------------------------------

const INVOICE_PAGE_SIZE = 12;

function InvoicesCard({ orgId }: { orgId: string }) {
  const list = useCallable<ListInvoicesRequest, ListInvoicesResponse>('listInvoices');
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void list.call({ orgId, limit: INVOICE_PAGE_SIZE }).then((response) => {
      if (cancelled || !response) return;
      setInvoices(response.invoices);
      setHasMore(response.hasMore);
    });
    return () => {
      cancelled = true;
    };
    // Mount-only by design: the handle is stable and invoices change on the
    // server's clock, not the render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  const showMore = async () => {
    const last = invoices?.[invoices.length - 1];
    if (!last) return;
    const response = await list.call({
      orgId,
      limit: INVOICE_PAGE_SIZE,
      startingAfter: last.id,
    });
    if (!response) return;
    setInvoices((previous) => [...(previous ?? []), ...response.invoices]);
    setHasMore(response.hasMore);
  };

  const columns: Array<Column<InvoiceSummary>> = [
    { header: 'Number', cell: (invoice) => invoice.number },
    { header: 'Date', cell: (invoice) => formatDateShort(invoice.created) },
    {
      header: 'Amount',
      align: 'end',
      cell: (invoice) => formatPence(invoice.amountPence),
    },
    { header: 'Status', cell: (invoice) => INVOICE_STATUS_LABELS[invoice.status] },
    {
      header: 'Invoice',
      cell: (invoice) =>
        invoice.hostedInvoiceUrl || invoice.pdfUrl ? (
          <span className={styles.invoiceLinks}>
            {invoice.hostedInvoiceUrl && (
              <a
                className={styles.invoiceLink}
                href={invoice.hostedInvoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View
              </a>
            )}
            {invoice.pdfUrl && (
              <a
                className={styles.invoiceLink}
                href={invoice.pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                PDF
              </a>
            )}
          </span>
        ) : (
          <span aria-hidden="true">-</span>
        ),
    },
  ];

  return (
    <Card flush>
      <CardHeader title="Invoices" hint="Invoices open on Stripe's secure site." />
      {list.error ? (
        <div className={styles.flushBody}>
          <ErrorNotice message={list.error} />
        </div>
      ) : invoices === null ? (
        <div className={styles.flushBody} aria-hidden="true">
          <Skeleton height="6rem" />
        </div>
      ) : invoices.length === 0 ? (
        <p className={`${styles.note} ${styles.flushBody}`}>No invoices yet.</p>
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={invoices}
            rowKey={(invoice) => invoice.id}
            label="Invoices"
          />
          {hasMore && (
            <div className={styles.flushBody}>
              <Button variant="ghost" disabled={list.pending} onClick={() => void showMore()}>
                {list.pending ? 'Loading…' : 'Show more'}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
