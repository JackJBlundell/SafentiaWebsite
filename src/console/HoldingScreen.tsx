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

import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { Wordmark } from '../components/Wordmark';
import styles from './HoldingScreen.module.css';

export function HoldingScreen() {
  const { user, signOut } = useAuth();

  return (
    <main className={styles.root}>
      <div className={styles.panel}>
        <Wordmark size="lg" />
        <h1 className={styles.heading}>
          You are signed in, but not a member of an organisation yet
        </h1>
        <p className={styles.copy}>
          An administrator at your organisation needs to invite you. If you were
          expecting access, contact them.
        </p>
        {user?.email && (
          <p className={styles.account}>
            Signed in as <strong>{user.email}</strong>
          </p>
        )}
        <Button variant="secondary" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </main>
  );
}
