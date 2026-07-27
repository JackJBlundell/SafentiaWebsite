// ============================================================================
// HoldingScreen - the web twin of the app's no-membership state (story 1022).
//
// A user can hold a valid Firebase account with no org claim: they registered
// before an administrator added them, or they were removed. That is not an
// error, so this screen is calm - it states the situation, shows which account
// is signed in (the commonest fix is "wrong email"), and offers the one real
// path forward: sign out and wait for an administrator's invitation. There is
// deliberately NO create-organisation entry here: organisations are founded by
// the platform operator until Phase 3 self-serve onboarding.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { Wordmark } from '../components/Wordmark';
import styles from './HoldingScreen.module.css';

/** Poll delays in milliseconds, then the last value repeats. Membership claims
 *  are written by a database trigger that normally lands within a second or two,
 *  so the first checks are quick; the backoff then keeps a genuinely
 *  membership-less session (the case this screen was written for) from polling
 *  the token endpoint forever at speed. */
const POLL_DELAYS_MS = [1_500, 2_500, 4_000, 8_000, 15_000];

export function HoldingScreen() {
  const { user, signOut, refreshSession } = useAuth();
  const [checking, setChecking] = useState(false);
  // Held in a ref, not state: it drives the timer schedule only, and re-rendering
  // on every tick would restart the effect and reset the backoff.
  const attempt = useRef(0);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      // Forces a fresh ID token and re-resolves claims. When the membership has
      // landed this flips the session to `authenticated`, so ConsoleGate stops
      // rendering this screen and the user is simply in - no manual reload.
      await refreshSession();
    } finally {
      setChecking(false);
    }
  }, [refreshSession]);

  // Why this screen polls at all: accepting an invitation writes the membership,
  // but the claims that carry it reach the browser only when the ID token is
  // refreshed, which Firebase otherwise does hourly. Without this, someone who
  // has just accepted (staff or customer portal alike) lands here and sits
  // looking at "not a member yet" until they think to reload. The screen has to
  // be able to clear itself.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      const delay =
        POLL_DELAYS_MS[Math.min(attempt.current, POLL_DELAYS_MS.length - 1)];
      timer = setTimeout(async () => {
        if (cancelled) return;
        attempt.current += 1;
        await check();
        // A successful join unmounts this screen, so reaching here means the
        // claims are still absent and we go round again.
        if (!cancelled) schedule();
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [check]);

  return (
    <main className={styles.root}>
      <div className={styles.panel}>
        <Wordmark size="lg" />
        <h1 className={styles.heading}>
          You are signed in, but not a member of an organisation yet
        </h1>
        <p className={styles.copy}>
          If you have just accepted an invitation, this clears by itself within a
          few seconds. Otherwise an administrator needs to invite you, so contact
          them if you were expecting access.
        </p>
        {user?.email && (
          <p className={styles.account}>
            Signed in as <strong>{user.email}</strong>
          </p>
        )}
        <div className={styles.actions}>
          {/* The poll already runs, but someone staring at this screen wants a
              control, not faith. */}
          <Button onClick={() => void check()} disabled={checking}>
            {checking ? 'Checking...' : 'Check again'}
          </Button>
          <Button variant="secondary" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}
