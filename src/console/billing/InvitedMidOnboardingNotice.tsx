// ============================================================================
// InvitedMidOnboardingNotice - the calm one-time word for a user who was
// invited into an organisation part-way through founding their own (assessment
// 1.6). Without it, accepting an invitation mid-subscribe drops the user
// straight into the inviting org's shell with no acknowledgement that the
// payment they had started is being left behind - a silent hand-off that reads
// as "where did my subscription go?".
//
// It is informational, not a fork: now that the session holds org membership,
// createSubscription refuses it anyway (a member founds nothing new), and the
// abandoned incomplete subscription self-expires server-side within ~23h. So
// the honest choice is a single "Continue" that steps aside into the org they
// joined. Reuses ConfirmingScreen's centred chrome (the same quiet panel every
// no-shell billing state wears), tokens-only, both themes.
// ============================================================================

import { Button } from '../../components/Button';
import { Wordmark } from '../../components/Wordmark';
import styles from './ConfirmingScreen.module.css';

export interface InvitedMidOnboardingNoticeProps {
  /** Dismiss the notice and fall through to the organisation's shell. */
  onContinue: () => void;
}

export function InvitedMidOnboardingNotice({
  onContinue,
}: InvitedMidOnboardingNoticeProps) {
  return (
    <main className={styles.root}>
      <div className={styles.panel}>
        <Wordmark size="lg" />
        <h1 className={styles.heading}>You have joined an organisation</h1>
        <p className={styles.copy}>
          You were setting up a subscription of your own, but you have now been
          added to an existing organisation - so you do not need to finish that
          subscription. Any unfinished payment is set aside on its own and never
          charged.
        </p>
        <Button onClick={onContinue}>Continue</Button>
      </div>
    </main>
  );
}
