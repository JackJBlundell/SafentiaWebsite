// ============================================================================
// SetupCompleteScreen - the full-page "you're all set" moment after the setup
// wizard's Finish setup. Deliberately NOT a wizard pane: finishing deserves a
// beat of its own, not a fourth stepper entry.
//
// Held by ConsoleRoute behind a local `celebrating` flag, because the gates
// unmount the wizard (and SetupGate with it) the moment the onboarding node
// flips to 'done' - which the background advanceOnboarding({finish:true}) call
// does almost immediately. A reload during the celebration therefore lands
// straight on the dashboard (the node is done) - acceptable: the celebration
// is a one-off flourish, not state anyone needs back.
//
// Motion: a drawn tick inside a brand-filled circle, then the copy rises in on
// a stagger - all on the motion/easing tokens, and all collapsed by the global
// prefers-reduced-motion rule (design/global.css) plus this file's own guard.
// ============================================================================

import { Button } from '../../components/Button';
import styles from './SetupCompleteScreen.module.css';

/** What the finishing wizard session actually did, for the summary line. */
export interface SetupSummary {
  brandingSaved: boolean;
  invitesSent: number;
  customersAdded: number;
}

/** One calm sentence about what just happened. Skipped everything is fine -
 *  the console's Getting started checklist picks the rest up. */
function summaryLine(summary: SetupSummary): string {
  const parts: string[] = [];
  if (summary.brandingSaved) parts.push('branding saved');
  if (summary.invitesSent > 0) {
    parts.push(
      `${summary.invitesSent} invitation${summary.invitesSent === 1 ? '' : 's'} sent`,
    );
  }
  if (summary.customersAdded > 0) {
    parts.push(
      `${summary.customersAdded} customer${summary.customersAdded === 1 ? '' : 's'} added`,
    );
  }
  if (parts.length === 0) {
    return 'Your organisation is ready - anything you skipped is waiting in the console.';
  }
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const sentence = `${list} - your organisation is ready.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export interface SetupCompleteScreenProps {
  summary: SetupSummary;
  /** The one CTA: clears the celebrating flag so the shell appears. */
  onContinue: () => void;
}

export default function SetupCompleteScreen({
  summary,
  onContinue,
}: SetupCompleteScreenProps) {
  return (
    <main className={styles.root}>
      <div className={styles.stage}>
        <svg
          className={styles.badge}
          viewBox="0 0 64 64"
          width="96"
          height="96"
          aria-hidden="true"
          focusable="false"
        >
          <circle className={styles.badgeCircle} cx="32" cy="32" r="30" />
          {/* pathLength=1 lets the draw animation use unit dash arithmetic. */}
          <path
            className={styles.badgeTick}
            d="M20 33 L28.5 41.5 L44 25"
            pathLength="1"
          />
        </svg>
        <h1 className={styles.heading}>You&rsquo;re all set</h1>
        <p className={styles.summary} role="status">
          {summaryLine(summary)}
        </p>
        <div className={styles.cta}>
          <Button type="button" size="lg" onClick={onContinue}>
            Go to your dashboard
          </Button>
        </div>
      </div>
    </main>
  );
}
