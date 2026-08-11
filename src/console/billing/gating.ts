// ============================================================================
// gating - the pure branch-selection rule for the two Phase 3 onboarding gates
// (PHASE3_BILLING_PLAN.md §3.1). ConsoleGate calls this with the session status
// and the caller's usersOnboarding node; the answer names which full-screen
// view stands between the session and the shell. Pure and side-effect free so
// the ladder's billing decisions are unit-testable without rendering a gate.
// ============================================================================

import type { UserOnboarding } from '../../types';

/** The views a membership-less or mid-onboarding session can be shown.
 *  'through' means no billing gate applies - the ladder continues. */
export type OnboardingView =
  | 'details' // no journey yet (or one at 'details'): the org-details step
  | 'subscribe' // details saved (step 'plan'): the plan matrix
  | 'payment' // an incomplete subscription exists: resume the payment step
  | 'confirming' // paid, waiting for the webhook to provision org + claims
  | 'setup' // org provisioned, setup wizard not yet finished
  | 'through'; // no gate - fall through to the rest of the ladder

/**
 * Decide the view for the given session status + onboarding node.
 *
 * With NO membership claims, the saved journey decides - a returning visitor
 * ALWAYS lands back on the step they left, all the way to payment:
 * - no node, or a node still at 'details' -> the org-details step, the
 *   journey's professional first impression. Self-serve is the default; the
 *   invitation-wait view is its secondary action, not a branch here.
 * - 'plan' (details saved, or an expired incomplete subscription cleared
 *   back) -> straight to the plan matrix, details already banked.
 * - 'payment' -> resume the payment step with the pending client secret.
 * - 'setup' -> the org exists but this browser's claims have not landed yet:
 *   show the confirming spinner and poll for the fresh token.
 * - 'done' -> a finished journey's node is IGNORED (§3.1.8: completed nodes
 *   are cleaned up lazily), so a claims-less session starts afresh at the
 *   details step - which itself carries the "expecting an invitation?"
 *   swap to the holding view for the visitor who is not here to buy.
 *
 * WITH membership claims ('authenticated'): the only gate left is the setup
 * wizard - a node at 'setup' without completedAt holds the shell back until
 * the wizard is finished or skipped. Everything else falls through.
 */
export function pickNoMembershipView(
  status: 'noMembership' | 'authenticated',
  onboarding: UserOnboarding | null | undefined,
): OnboardingView {
  if (status === 'authenticated') {
    return onboarding && onboarding.step === 'setup' && !onboarding.completedAt
      ? 'setup'
      : 'through';
  }

  if (onboarding?.step === 'payment') return 'payment';
  if (onboarding?.step === 'setup') return 'confirming';
  if (onboarding?.step === 'plan') return 'subscribe';
  // No node, step 'details', or a finished ('done') journey: collect the
  // organisation's details before any plan is pitched.
  return 'details';
}
