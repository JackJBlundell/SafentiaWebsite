// ============================================================================
// AppCheckNotice - tells someone whose browser is blocking the security check
// (reCAPTCHA, which App Check runs on) what is wrong and how to fix it, instead
// of leaving them on a page that never finishes loading. Mounted by
// AuthProvider, so it covers sign-in, the console and the customer portal.
// ============================================================================

import { useSyncExternalStore } from 'react';
import { getAppCheckStatus, subscribeAppCheckStatus } from '../firebase';
import { Button } from './Button';
import styles from './AppCheckNotice.module.css';

export function AppCheckNotice() {
  const status = useSyncExternalStore(
    subscribeAppCheckStatus,
    getAppCheckStatus,
    // Pre-render: nothing has been checked, so nothing is shown.
    () => 'checking' as const,
  );
  if (status !== 'blocked') {
    return null;
  }
  return (
    <div role="alert" className={styles.notice}>
      <p className={styles.title}>Your browser is blocking a security check</p>
      <p className={styles.body}>
        Safentia uses Google reCAPTCHA to confirm requests really come from this
        site, and without it your data cannot load. Please allow google.com and
        gstatic.com in your ad blocker or privacy settings (or try another
        browser), then reload the page.
      </p>
      <Button variant="secondary" onClick={() => window.location.reload()}>
        Reload the page
      </Button>
    </div>
  );
}
