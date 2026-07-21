// ============================================================================
// PortalShell - the customer portal's signed-in chrome (FR-E22, story 2056;
// story 2005's third landing). The portal twin of ConsoleShell, deliberately
// slimmer: a customer sees their buildings and released reports, nothing else,
// so the chrome is a brand row, the account controls and the routes.
//
// BRANDING LIMITATION (deliberate, documented): the staff console brands its
// chrome from /organisations/{orgId}/profile, but that node's rule is keyed on
// `token.orgId`, which a portal token never carries - so the portal CANNOT read
// the org's logo, colours or fonts. We render the CUSTOMER's name as the brand
// mark with the quiet "Powered by Safentia" line, under the default accent
// theme. Granting portal users a read on the org profile (or mirroring the
// brand into a portal-readable node) is a future RULES decision, not something
// to smuggle in client-side.
// ============================================================================

import { Link, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Customer } from '../../types';
import { Button } from '../../components/Button';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Wordmark } from '../../components/Wordmark';
import { AccountPage } from '../AccountPage';
import { PortalHome } from './PortalHome';
import { PortalBuilding } from './PortalBuilding';
import { PortalReport } from './PortalReport';
import { usePortalScope, portalUrls } from './shared';
import styles from './PortalShell.module.css';

/** True when an RTDB error is a RULES denial rather than a transport failure.
 *  The database SDK reports denials as "permission_denied at /path ..." from a
 *  cancelled listener and "Permission denied" from a one-shot get; both carry
 *  the same two words, so the match covers either surface. */
function isPermissionDenied(error: Error | null): boolean {
  return error !== null && /permission.?denied/i.test(error.message);
}

export function PortalShell() {
  const { ready, orgId, customerId, db } = usePortalScope();

  // The shell owns the ONE customer subscription (the brand mark reads its
  // data as a prop, not via a second listener). Rules deny every portal read
  // while the customer record is archived, so a permission denial on this
  // root read IS the suspended state - distinct from loading, where the query
  // simply has no data yet. While suspended, the routes are not mounted, so
  // no child listener exists to thrash; this single listener re-attaches once
  // per useRtdbQuery's retry delay, which doubles as the recovery path when
  // access is restored.
  const customer = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId || 'none', customerId || 'none'),
    path: ready && db ? db.customer(orgId, customerId) : 'none',
    enabled: ready,
  });
  const suspended = customer.isError && isPermissionDenied(customer.error);

  return (
    <div className={styles.root}>
      <header className={styles.chrome}>
        <PortalBrandMark name={customer.data?.name} />
        <div className={styles.actions}>
          <ThemeToggle />
          {!suspended && (
            <Link to={portalUrls.account} className={styles.accountLink}>
              Account
            </Link>
          )}
          <SignOutButton />
        </div>
      </header>
      <main className={styles.main}>
        {suspended ? (
          <SuspendedPanel />
        ) : (
          <Routes>
            <Route index element={<PortalHome />} />
            {/* AccountPage reads only the user (display name, password change,
                sign out) - no claims or org reads - so the staff page serves the
                portal unchanged. */}
            <Route path="account" element={<AccountPage />} />
            <Route
              path="sites/:siteId/buildings/:buildingId"
              element={<PortalBuilding />}
            />
            {/* The released-report email deep-links here, so this URL and the
                one onAssessmentStageChange builds must move together. */}
            <Route
              path="sites/:siteId/buildings/:buildingId/reports/:reportId"
              element={<PortalReport />}
            />
            <Route path="*" element={<NotFoundPanel />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

/**
 * The portal chrome carries the CUSTOMER's identity (see the header note for
 * why it cannot carry the org's whitelabel brand). Until the customer record
 * resolves, the Safentia wordmark holds the space so the chrome never renders
 * blank.
 */
function PortalBrandMark({ name }: { name: string | undefined }) {
  if (!name) {
    return <Wordmark to={portalUrls.home} />;
  }

  return (
    <Link
      to={portalUrls.home}
      className={styles.brandLink}
      aria-label={`${name} home`}
    >
      <span className={styles.brandName}>{name}</span>
      <span className={styles.poweredBy}>Powered by Safentia</span>
    </Link>
  );
}

function SignOutButton() {
  const { signOut } = useAuth();
  return (
    <Button variant="secondary" onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}

/** The full-page notice while the organisation has suspended this customer's
 *  portal access (the customer record is archived, so rules deny every portal
 *  read). Calm and plain: the state is the assessor's to resolve, not the
 *  reader's. */
function SuspendedPanel() {
  return (
    <section className={styles.notFound} aria-labelledby="portal-suspended">
      <h1 id="portal-suspended" className={styles.notFoundHeading}>
        Portal access suspended
      </h1>
      <p className={styles.notFoundCopy}>
        Your organisation&apos;s portal access is currently suspended. Please
        contact your fire-risk assessor.
      </p>
    </section>
  );
}

/** A portal URL that does not exist. Small and honest. */
function NotFoundPanel() {
  return (
    <section className={styles.notFound}>
      <h1 className={styles.notFoundHeading}>There is nothing at this address</h1>
      <p className={styles.notFoundCopy}>
        The page may have moved, or the link you followed is out of date.
      </p>
      <Button variant="secondary" to={portalUrls.home}>
        Back to your buildings
      </Button>
    </section>
  );
}
