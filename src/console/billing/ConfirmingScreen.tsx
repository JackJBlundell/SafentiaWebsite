// ============================================================================
// ConfirmingScreen - the wait between "your card was accepted" and "your
// organisation exists" (PHASE3_BILLING_PLAN.md §3.1.6). Provisioning happens
// server-side off the Stripe webhook, normally within seconds; this screen
// polls refreshSession (the HoldingScreen idiom) so the freshly-minted claims
// flip the session to `authenticated` without a manual reload, at which point
// ConsoleGate unmounts it in favour of the setup wizard.
//
// After 30 seconds it adds calm fallback copy pointing at support - webhooks
// are usually <5s, so a longer wait deserves an explanation, not a spinner
// alone. The poll keeps running regardless: slow is not failed.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Wordmark } from '../../components/Wordmark';
import styles from './ConfirmingScreen.module.css';

/** Same backoff idiom as HoldingScreen: quick first checks (the webhook is
 *  normally seconds away), then gentler so a genuinely stuck journey does not
 *  hammer the token endpoint. */
const POLL_DELAYS_MS = [1_500, 2_500, 4_000, 8_000, 15_000];

/** When the reassurance copy appears. Webhooks land in seconds; half a minute
 *  without claims deserves words, not just a spinner. */
const SLOW_AFTER_MS = 30_000;

const SUPPORT_EMAIL = 'contact@safentia.co.uk';

export function ConfirmingScreen() {
  const { refreshSession } = useAuth();
  const [slow, setSlow] = useState(false);
  // Ref, not state: the attempt count only drives the timer schedule, and
  // re-rendering per tick would restart the effect and reset the backoff.
  const attempt = useRef(0);

  // Poll for the claims the provisioning webhook mints. When they land the
  // session flips to `authenticated` and ConsoleGate unmounts this screen -
  // the poll never needs to stop itself on success.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      const delay =
        POLL_DELAYS_MS[Math.min(attempt.current, POLL_DELAYS_MS.length - 1)];
      timer = setTimeout(async () => {
        if (cancelled) return;
        attempt.current += 1;
        try {
          await refreshSession();
        } catch {
          // A transient token-refresh failure just means we try again on the
          // next tick; the screen itself is the safe place to be waiting.
        }
        if (!cancelled) schedule();
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refreshSession]);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className={styles.root}>
      <div className={styles.panel}>
        <Wordmark size="lg" />
        <span className={styles.spinner} aria-hidden="true" />
        <h1 className={styles.heading} role="status">
          Confirming your subscription&hellip;
        </h1>
        <p className={styles.copy}>
          Your payment has been received and we are setting up your
          organisation. This normally takes a few seconds.
        </p>
        {slow && (
          <p className={styles.copy} role="alert">
            This is taking longer than usual. Your payment is safe and your
            organisation will appear as soon as setup completes. If this screen
            does not clear in the next few minutes, contact{' '}
            <a className={styles.supportLink} href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>{' '}
            and we will finish the setup for you.
          </p>
        )}
      </div>
    </main>
  );
}
