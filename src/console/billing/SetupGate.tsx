// ============================================================================
// SetupGate - the thin gate ConsoleGate renders for a freshly-provisioned
// admin whose setup wizard is unfinished (PHASE3_BILLING_PLAN.md §3.1.7). It
// exists so the wizard itself - forms, uploads, step chrome - loads as its own
// chunk only when a session actually needs it: the gate is what ConsoleRoute's
// lazy import resolves, and the wizard arrives behind a second Suspense here.
//
// Default export is the shape React.lazy wants.
// ============================================================================

import { lazy, Suspense } from 'react';
import { Wordmark } from '../../components/Wordmark';
import type { UserOnboarding } from '../../types';
import type { SetupSummary } from './SetupCompleteScreen';
import styles from './ConfirmingScreen.module.css';

const SetupWizard = lazy(() => import('./SetupWizard'));

export interface SetupGateProps {
  /** The live usersOnboarding node at step 'setup' (ConsoleGate subscribes and
   *  guarantees the step; this component only passes it through). */
  onboarding: UserOnboarding;
  /** Passed through to the wizard's Finish setup. The flag it sets lives in
   *  ConsoleRoute - this gate unmounts with the wizard when the node flips
   *  'done', so it cannot hold the celebration itself. */
  onCelebrate: (summary: SetupSummary) => void;
}

export default function SetupGate({ onboarding, onCelebrate }: SetupGateProps) {
  return (
    <Suspense
      fallback={
        <main className={styles.root}>
          <Wordmark size="lg" />
          <span className="sr-only" role="status">
            Loading setup
          </span>
        </main>
      }
    >
      <SetupWizard onboarding={onboarding} onCelebrate={onCelebrate} />
    </Suspense>
  );
}
