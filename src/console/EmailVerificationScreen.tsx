// ============================================================================
// EmailVerificationScreen - the blocking state for a signed-in account whose
// email address Firebase does not record as verified.
//
// Shape and tone follow HoldingScreen deliberately: this is not an error the
// visitor caused, so it states the situation, names the account (the commonest
// cause is signing in with the wrong one) and offers the two real ways forward
// - re-check, or sign out. It is a screen rather than a redirect because a
// redirect from an authenticated session would loop straight back here.
//
// The re-check matters: the browser's copy of `emailVerified` is a snapshot
// taken when the session's account record was last read, so an account repaired
// server-side (see functions/src/scripts/backfillEmailVerified.ts) still looks
// unverified here until the record is re-read. The screen re-reads once on
// mount, so a plain page reload resolves it with no action at all, and offers
// the button for a session that was already sitting open.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { Wordmark } from '../components/Wordmark';
import styles from './HoldingScreen.module.css';

export function EmailVerificationScreen() {
  const { user, signOut, refreshEmailVerification, resendVerificationEmail } =
    useAuth();
  const [checking, setChecking] = useState(false);
  // Only a password account can confirm its own address by email: Google
  // accounts arrive verified, and invited accounts are stamped by the server.
  const selfServe =
    user?.providerData.some((info) => info.providerId === 'password') ?? false;
  const [resendState, setResendState] = useState<
    'idle' | 'sending' | 'sent' | 'error'
  >('idle');
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  // A short cooldown so the button cannot be hammered into Firebase's
  // too-many-requests limit (which then blocks the visitor for minutes).
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  async function handleResend() {
    if (resendState === 'sending' || cooldown > 0) {
      return;
    }
    setResendState('sending');
    setResendMessage(null);
    try {
      await resendVerificationEmail();
      setResendState('sent');
      setCooldown(60);
      timer.current = setInterval(() => {
        setCooldown((left) => {
          if (left <= 1 && timer.current) {
            clearInterval(timer.current);
            timer.current = null;
          }
          return Math.max(0, left - 1);
        });
      }, 1_000);
    } catch (error) {
      setResendState('error');
      setResendMessage(
        error instanceof Error
          ? error.message
          : 'We could not send the email. Please try again.',
      );
    }
  }

  // One automatic re-read on mount. If the account was verified server-side
  // since this session started, the gate above re-evaluates and this screen
  // disappears without the visitor doing anything.
  useEffect(() => {
    void refreshEmailVerification().catch((error) => {
      // A failed re-read leaves the manual button as the fallback; it must not
      // take down the screen that is explaining the problem.
      console.error('[Safentia auth] refreshEmailVerification', error);
    });
  }, [refreshEmailVerification]);

  async function handleCheck() {
    setChecking(true);
    try {
      await refreshEmailVerification();
    } catch (error) {
      console.error('[Safentia auth] refreshEmailVerification', error);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className={styles.root}>
      <div className={styles.panel}>
        <Wordmark size="lg" />
        <h1 className={styles.heading}>
          {selfServe
            ? 'Confirm your email address'
            : <>This account&apos;s email address has not been confirmed</>}
        </h1>
        {selfServe ? (
          <p className={styles.copy}>
            We have sent a confirmation link to your inbox. Open it, then come
            back here and press Check again. If it has not arrived, check your
            spam folder or send it again.
          </p>
        ) : (
          <p className={styles.copy}>
            Safentia can only open your organisation&apos;s data to a confirmed
            email address. Ask your administrator to send you a new invitation,
            or to confirm the address on your account, then check again.
          </p>
        )}
        {user?.email && (
          <p className={styles.account}>
            Signed in as <strong>{user.email}</strong>
          </p>
        )}
        <Button onClick={() => void handleCheck()} disabled={checking}>
          {checking ? 'Checking...' : 'Check again'}
        </Button>
        {selfServe && (
          <Button
            variant="secondary"
            onClick={() => void handleResend()}
            disabled={resendState === 'sending' || cooldown > 0}
          >
            {resendState === 'sending'
              ? 'Sending...'
              : cooldown > 0
                ? `Email sent - resend in ${cooldown}s`
                : 'Resend confirmation email'}
          </Button>
        )}
        {resendState === 'error' && resendMessage && (
          <p role="alert" className={styles.copy}>
            {resendMessage}
          </p>
        )}
        <Button variant="secondary" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </main>
  );
}
