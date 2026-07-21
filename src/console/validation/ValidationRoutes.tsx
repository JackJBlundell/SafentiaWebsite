// ============================================================================
// ValidationRoutes - the auditor Validation console's router plus its role gate
// (FR-E18).
//
// The area is for auditors and administrators. The gate mirrors the staff
// area's: the shell may still show the nav item, so the direct-URL case lands
// on a calm panel, not an alarmed one - nothing was breached, the page just is
// not theirs. Viewers in particular must NOT browse here: unreleased findings
// are exactly the material story 2058 says a customer-facing account never
// sees early. The real boundary remains the database rules and each callable's
// own role check; this gate is presentation.
//
// Two surfaces sit under this area (the activity area's sub-nav pattern): the
// live queue of work in flight, and the "Released" list of everything already
// released. The single-assessment review at :assessmentId has no tab - it is
// reached by opening a row from either list, and both tabs point at it.
// ============================================================================

import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState } from '../ui/Page';
import { ValidationQueue } from './ValidationQueue';
import { ReleasedList } from './ReleasedList';
import { AssessmentReview } from './AssessmentReview';
import styles from './ValidationRoutes.module.css';

export function ValidationRoutes() {
  const { claims } = useAuth();
  const location = useLocation();
  const canValidate =
    claims?.roles.auditor === true || claims?.roles.admin === true;
  if (!canValidate) {
    return (
      <EmptyState
        title="Auditor access required"
        body="You need auditor access for this area. Validation is where submitted assessments are reviewed before release. If you believe you should have it, ask an administrator at your organisation."
      />
    );
  }

  // The sub-nav belongs on the two list surfaces, not on a single assessment's
  // review page - that page carries its own crumb back to the queue, and the
  // tabs would only compete with it.
  const showTabs =
    location.pathname === '/app/validation' ||
    location.pathname === '/app/validation/released';

  return (
    <div className={styles.layout}>
      {showTabs && (
        <nav className={styles.subNav} aria-label="Validation sections">
          <NavLink
            to="/app/validation"
            end
            className={({ isActive }) =>
              isActive ? `${styles.subNavLink} ${styles.subNavLinkActive}` : styles.subNavLink
            }
          >
            Queue
          </NavLink>
          <NavLink
            to="/app/validation/released"
            className={({ isActive }) =>
              isActive ? `${styles.subNavLink} ${styles.subNavLinkActive}` : styles.subNavLink
            }
          >
            Released
          </NavLink>
        </nav>
      )}
      <div className={styles.content}>
        <Routes>
          <Route index element={<ValidationQueue />} />
          <Route path="released" element={<ReleasedList />} />
          <Route path=":assessmentId" element={<AssessmentReview />} />
        </Routes>
      </div>
    </div>
  );
}
