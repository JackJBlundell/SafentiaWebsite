// ============================================================================
// ActivityRoutes - the mount point for the organisation activity area (story
// 2062). The shell mounts this once at /app/activity/*; routing detail below
// that stays private to this directory.
//
// The area has two surfaces: the audit trail (every role) and the email send
// log (admin only). The tab switcher and the /emails route are gated on
// claims.roles.admin, mirroring how other role-gated reads are handled (the
// send log's rule grants read to admin ONLY, so a non-admin listener would be
// denied and retried uselessly - the subscription must never mount). A
// non-admin sees no tabs and only the audit trail; a non-admin reaching
// /app/activity/emails by direct URL gets the access notice, not the panel.
// ============================================================================

import { NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState } from '../ui/Page';
import { ActivityPage } from './ActivityPage';
import { EmailLogPanel } from './EmailLogPanel';
import styles from './ActivityRoutes.module.css';

export function ActivityRoutes() {
  const { claims } = useAuth();
  const isAdmin = claims?.roles.admin === true;

  return (
    <div className={styles.layout}>
      {isAdmin && (
        <nav className={styles.subNav} aria-label="Activity sections">
          <NavLink
            to="/app/activity"
            end
            className={({ isActive }) =>
              isActive ? `${styles.subNavLink} ${styles.subNavLinkActive}` : styles.subNavLink
            }
          >
            Audit trail
          </NavLink>
          <NavLink
            to="/app/activity/emails"
            className={({ isActive }) =>
              isActive ? `${styles.subNavLink} ${styles.subNavLinkActive}` : styles.subNavLink
            }
          >
            Emails
          </NavLink>
        </nav>
      )}
      <div className={styles.content}>
        <Routes>
          <Route index element={<ActivityPage />} />
          <Route
            path="emails"
            element={
              isAdmin ? (
                <EmailLogPanel />
              ) : (
                <EmptyState
                  title="Administrator access required"
                  body="You need administrator access to view the email log. If you believe you should have it, ask an administrator at your organisation."
                />
              )
            }
          />
        </Routes>
      </div>
    </div>
  );
}
