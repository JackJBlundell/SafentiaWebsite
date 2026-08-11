// ============================================================================
// SubscribePaymentPage - step two of self-serve onboarding (Phase 3 §3.1):
// take payment for the chosen tier through Stripe's Payment Element.
//
// Two ways in, one screen: a fresh choice from SubscribePlanPage calls
// createSubscription (which writes the onboarding node at step 'payment' and
// returns the PaymentIntent client secret); a RESUMED session - the onboarding
// node already says 'payment' - asks getBillingState for the pending client
// secret instead, so a reload or a return visit re-enters the same incomplete
// subscription rather than minting another.
//
// Stripe.js arrives ONLY via loadStripeForEnv (dynamic import, SSG-safe); a
// null resolution means the publishable key is not configured and the page
// says so calmly instead of crashing. After confirmPayment succeeds the page
// hands over to ConfirmingScreen, which waits for the provisioning webhook.
// ============================================================================

import { useEffect, useState } from 'react';
import type { Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { useCallable } from '../ui/useCallable';
import { loadStripeForEnv } from './stripeClient';
import type {
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  Environment,
  GetBillingStateRequest,
  GetBillingStateResponse,
} from '../../types';
import { Button } from '../../components/Button';
import { ErrorNotice } from '../ui/Page';
import { Skeleton } from '../ui/Skeleton';
import { ConfirmingScreen } from './ConfirmingScreen';
import { SubscribeChrome } from './SubscribeChrome';
import { formatMonthlyPrice, type PlanChoice } from './SubscribePlanPage';
import styles from './SubscribePaymentPage.module.css';

export interface SubscribePaymentPageProps {
  env: Environment;
  /** The fresh selection, or null when resuming an onboarding node already at
   *  step 'payment' (the client secret is then recovered via getBillingState). */
  choice: PlanChoice | null;
  /** Back to the plan matrix. Abandoning here is graceful by design: the
   *  incomplete subscription expires server-side, and resuming also works. */
  onBack: () => void;
}

export function SubscribePaymentPage({
  env,
  choice,
  onBack,
}: SubscribePaymentPageProps) {
  const create = useCallable<CreateSubscriptionRequest, CreateSubscriptionResponse>(
    'createSubscription',
  );
  const billingState = useCallable<GetBillingStateRequest, GetBillingStateResponse>(
    'getBillingState',
  );

  // 'loading' until loadStripeForEnv settles; null means not configured.
  const [stripe, setStripe] = useState<Stripe | null | 'loading'>('loading');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  // Resume asked the server and found nothing pending (e.g. the incomplete
  // subscription expired): the plan matrix is the honest place to restart.
  const [nothingPending, setNothingPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // One secret fetch per entry, and Stripe.js is loaded from the mode the
  // SERVER used (returned as response.env), NOT the client-guessed `env` prop.
  // They can differ: FIRERITE_FORCE_TEST_SIGNUPS forces the server to test
  // while a claim-less account guesses live - and a live publishable key
  // cannot mount a test client secret, so the Payment Element never mounts and
  // confirmPayment throws. Loading Stripe.js only after the secret arrives,
  // keyed to its true mode, makes the key and secret always agree. Mount-only:
  // `choice` is fixed for this page's lifetime and the callable handles are
  // stable.
  useEffect(() => {
    let cancelled = false;
    const mountFor = async (secret: string, mode: Environment) => {
      const resolved = await loadStripeForEnv(mode);
      if (cancelled) return;
      setStripe(resolved);
      setClientSecret(secret);
    };
    const start = async () => {
      if (choice) {
        // The organisation's name and details already live on the onboarding
        // node (saveOnboardingDetails); only the plan travels.
        const response = await create.call({ planId: choice.planId });
        if (!cancelled && response) {
          await mountFor(response.clientSecret, response.env);
        }
        return;
      }
      const response = await billingState.call({});
      if (cancelled) return;
      if (response?.pendingPaymentClientSecret) {
        await mountFor(
          response.pendingPaymentClientSecret,
          response.env ?? env,
        );
      } else if (response) {
        setNothingPending(true);
      }
    };
    void start();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (confirmed) {
    return <ConfirmingScreen />;
  }

  const startError = create.error ?? billingState.error;

  return (
    <SubscribeChrome
      step={2}
      heading="Payment details"
      lede="Your subscription starts as soon as your payment is confirmed. You can change or cancel your plan at any time."
    >
      <div className={styles.body}>
        {/* Order summary for a fresh choice: a proper checkout block - what
            the card is about to pay for, said before the payment form. A
            resumed session has no plan doc to hand (choice is null), so it
            simply goes without. */}
        {choice && (
          <div className={styles.summary}>
            <p className={styles.summaryTitle}>Your order</p>
            <div className={styles.summaryRow}>
              <span className={styles.summaryPlan}>
                {choice.plan.name} plan
              </span>
              <span className={styles.summaryPrice}>
                {formatMonthlyPrice(choice.plan.priceMonthlyPence)}
                <span className={styles.summaryPeriod}>/month</span>
              </span>
            </div>
            <div className={styles.summaryFoot}>
              <span className={styles.summaryVat}>
                VAT added at the applicable rate.
              </span>
              <button
                type="button"
                className={styles.changePlanLink}
                onClick={onBack}
              >
                Change plan
              </button>
            </div>
          </div>
        )}

        {stripe === null ? (
          // The publishable key is absent: an operator problem, said calmly.
          <p className={styles.notice} role="status">
            Payments are not available just yet. Please try again later, or
            contact us if this keeps happening.
          </p>
        ) : startError ? (
          <ErrorNotice message={startError} />
        ) : nothingPending ? (
          <p className={styles.notice} role="status">
            There is no payment waiting to be completed. Choose a plan to
            continue.
          </p>
        ) : stripe === 'loading' || clientSecret === null ? (
          // The callable and Stripe.js race; one quiet placeholder covers both.
          <div className={styles.formSlot} aria-hidden="true">
            <Skeleton height="12rem" />
          </div>
        ) : (
          <Elements stripe={stripe} options={{ clientSecret }}>
            <PaymentForm onConfirmed={() => setConfirmed(true)} />
          </Elements>
        )}

        {/* Trust cue, text only: the card form is Stripe's, and saying so
            quietly is worth more than a badge. */}
        <p className={styles.trustLine}>Payments secured by Stripe.</p>

        {/* A real button: going back swaps the view, it does not navigate. */}
        <button type="button" className={styles.backLink} onClick={onBack}>
          Back to plans
        </button>
      </div>
    </SubscribeChrome>
  );
}

/**
 * The form inside the Elements provider (useStripe/useElements only resolve
 * there). Confirm stays on this page (`redirect: 'if_required'`) so 3DS is
 * handled inline and success flows straight into the confirming wait.
 */
function PaymentForm({ onConfirmed }: { onConfirmed: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const confirm = async () => {
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setCardError(null);
    try {
      const result = await stripe.confirmPayment({
        elements,
        redirect: 'if_required',
      });
      if (result.error) {
        // Stripe's card errors are already written for the cardholder.
        setCardError(
          result.error.message ??
            'The payment could not be completed. Please try again.',
        );
        return;
      }
      onConfirmed();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void confirm();
      }}
    >
      <PaymentElement />
      {cardError && <ErrorNotice message={cardError} />}
      <label className={styles.terms}>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(event) => setAgreed(event.target.checked)}
        />
        <span>
          I agree to the{' '}
          <a href="/legal/terms" target="_blank" rel="noreferrer">
            terms of service
          </a>
          .
        </span>
      </label>
      <Button type="submit" block disabled={!agreed || submitting}>
        {submitting ? 'Confirming…' : 'Subscribe'}
      </Button>
    </form>
  );
}
