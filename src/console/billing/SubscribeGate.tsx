// ============================================================================
// SubscribeGate - the orchestrator ConsoleGate renders for a membership-less
// session that is (or could be) subscribing (Phase 3 §3.1). It owns three
// pieces of purely local choreography:
//
// - which page of the subscribe flow is showing: the org-details step (a
//   fresh journey, or an edit from the plan page), the plan matrix, or the
//   payment step (a fresh choice, or a resume when the live onboarding node
//   already says step 'payment'). Returning visitors resume wherever the
//   node says they left off - all the way to payment;
// - the calm swap to the OLD default - the invitation-wait HoldingScreen -
//   for the visitor who is not here to subscribe at all;
// - which Stripe environment this session belongs to. A membership-less token
//   carries no resolved claims, so the testMode claim is read off the ID token
//   directly - the same rule (envFromTestMode) every claimed session uses.
//
// Loaded lazily by ConsoleRoute, so Stripe-facing code stays out of the main
// console chunk; the default export is the shape React.lazy wants.
// ============================================================================

import { useEffect, useState } from 'react';
import { getIdTokenResult } from 'firebase/auth';
import { useAuth } from '../../auth/AuthProvider';
import { envFromTestMode } from '../../paths';
import type { Environment, UserOnboarding } from '../../types';
import { Wordmark } from '../../components/Wordmark';
import { HoldingScreen } from '../HoldingScreen';
import { OrgDetailsPage } from './OrgDetailsPage';
import { SubscribePlanPage, type PlanChoice } from './SubscribePlanPage';
import { SubscribePaymentPage } from './SubscribePaymentPage';
import styles from './ConfirmingScreen.module.css';

/**
 * The session's Stripe/data environment, read from the raw testMode claim.
 * Null while the token is being read; defaults to 'live' on a token without
 * the claim - exactly what envFromTestMode says for every other session.
 */
function useSessionEnv(): Environment | null {
  const { user } = useAuth();
  const [env, setEnv] = useState<Environment | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setEnv(null);
      return;
    }
    getIdTokenResult(user)
      .then((result) => {
        if (!cancelled) setEnv(envFromTestMode(result.claims.testMode === true));
      })
      .catch(() => {
        // An unreadable token defaults to live - the safe majority - rather
        // than blocking the whole flow on a transient token hiccup.
        if (!cancelled) setEnv('live');
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return env;
}

export interface SubscribeGateProps {
  /** The caller's live usersOnboarding node (ConsoleGate subscribes; this
   *  component only reads). Null when no journey has started. */
  onboarding: UserOnboarding | null;
}

export default function SubscribeGate({ onboarding }: SubscribeGateProps) {
  const env = useSessionEnv();
  // The secondary path: swap the pitch for the invitation-wait view.
  const [holding, setHolding] = useState(false);
  // The fresh selection carried from the plan matrix to the payment page.
  const [choice, setChoice] = useState<PlanChoice | null>(null);
  // Set by the payment page's back link. It outranks the onboarding node's
  // step 'payment' (createSubscription has already written it by then), so
  // "Back to plans" actually shows the plans instead of bouncing straight
  // back into the payment step.
  const [backToPlans, setBackToPlans] = useState(false);
  // "Edit details" from the plan page: show the details step again even
  // though the node has moved past it. Cleared on save or its back link.
  const [editingDetails, setEditingDetails] = useState(false);
  // The save response, bridging the moment between saveOnboardingDetails
  // returning and the live listener delivering the same node; the prop wins
  // again the instant it updates.
  const [savedNode, setSavedNode] = useState<UserOnboarding | null>(null);
  useEffect(() => {
    setSavedNode(null);
  }, [onboarding]);
  const node = savedNode ?? onboarding;

  if (holding) {
    return <HoldingScreen />;
  }

  if (env === null) {
    // The token read settles in milliseconds; a quiet splash beats a flash of
    // the wrong environment's prices.
    return (
      <main className={styles.root}>
        <Wordmark size="lg" />
        <span className="sr-only" role="status">
          Loading
        </span>
      </main>
    );
  }

  // The details step first: a fresh journey (no node, step 'details', or a
  // finished 'done' node starting over) or an explicit edit from the plan
  // page. Everything else has details banked and resumes at plan/payment.
  const needsDetails =
    !node || node.step === 'details' || node.step === 'done';
  if (editingDetails || needsDetails) {
    return (
      <OrgDetailsPage
        initialDetails={
          node?.orgDetails ??
          (node?.orgName ? { name: node.orgName } : null)
        }
        onSaved={(saved) => {
          setSavedNode(saved);
          setEditingDetails(false);
        }}
        // Only an EDIT can go back without saving; a fresh journey has no
        // plans to go back to yet.
        onBack={
          editingDetails && !needsDetails
            ? () => setEditingDetails(false)
            : undefined
        }
        onShowHolding={() => setHolding(true)}
      />
    );
  }

  const showPayment =
    !backToPlans && (choice !== null || node.step === 'payment');

  if (showPayment) {
    return (
      <SubscribePaymentPage
        env={env}
        choice={choice}
        onBack={() => setBackToPlans(true)}
      />
    );
  }

  return (
    <SubscribePlanPage
      env={env}
      orgName={node.orgDetails?.name ?? node.orgName ?? ''}
      onChoose={(next) => {
        setChoice(next);
        setBackToPlans(false);
      }}
      onEditDetails={() => setEditingDetails(true)}
      onShowHolding={() => setHolding(true)}
    />
  );
}
