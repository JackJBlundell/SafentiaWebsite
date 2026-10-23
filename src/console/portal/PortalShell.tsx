// ============================================================================
// PortalShell - the customer portal's signed-in chrome (FR-E22, story 2056;
// story 2005's third landing). The portal twin of ConsoleShell, deliberately
// slimmer: a customer sees their buildings and released reports, nothing else,
// so the chrome is a brand row, the account controls and the routes.
//
// BRANDING: the portal wears the ASSESSING ORGANISATION's whitelabel identity,
// exactly as the staff console does. ConsoleRoute's BrandedShell reads
// /organisations/{orgId}/profile into the theme; PortalOrgProvider shares the
// same profile with the screens that need its name and logo. A portal token is
// admitted to that node by the `portalOrgId` arm of its rule - the customer
// needs to know whose fire safety service they are looking at - and the grant
// is scoped to the profile node alone, never the organisation subtree.
//
// Partial branding is the NORMAL case: an org with a name but no logo shows the
// name, and an org whose profile has not resolved (or is denied, when access is
// suspended) falls back to the Safentia wordmark. Neither looks broken.
// ============================================================================

import { Link, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { useUserSpaces } from '../../auth/useUserSpaces';
import { forgetSpaceChoice } from '../../auth/spaceChoice';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Customer } from '../../types';
import { Button } from '../../components/Button';
import { ThemeToggle } from '../../components/ThemeToggle';
import { Wordmark } from '../../components/Wordmark';
import { AccountPage } from '../AccountPage';
import { StoredImage } from '../lib/StoredFile';
import { PortalHome } from './PortalHome';
import { PortalBuilding } from './PortalBuilding';
import { PortalReport } from './PortalReport';
import { PortalTeam } from './PortalTeam';
import {
  usePortalScope,
  usePortalOrgIdentity,
  PortalOrgProvider,
  portalUrls,
} from './shared';
import styles from './PortalShell.module.css';

/** True when an RTDB error is a RULES denial rather than a transport failure.
 *  The database SDK reports denials as "permission_denied at /path ..." from a
 *  cancelled listener and "Permission denied" from a one-shot get; both carry
 *  the same two words, so the match covers either surface. */
function isPermissionDenied(error: Error | null): boolean {
  return error !== null && /permission.?denied/i.test(error.message);
}

export function PortalShell() {
  const { ready, orgId, customerId, isAdmin, db } = usePortalScope();

  // The shell owns the ONE customer subscription (the account badge reads its
  // data as a prop, not via a second listener). Rules deny every portal read
  // while the customer record is archived, so a permission denial on this
  // root read IS the suspended state - distinct from loading, where the query
  // simply has no data yet. While suspended, the routes are not mounted, so
  // no child listener exists to thrash; this single listener re-attaches once
  // per useRtdbQuery's retry delay, which doubles as the recovery path when
  // access is restored.
  const customer = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId || "none", customerId || "none"),
    path: ready && db ? db.customer(orgId, customerId) : "none",
    enabled: ready,
  });
  const suspended = customer.isError && isPermissionDenied(customer.error);

  return (
    <PortalOrgProvider>
      <div className={styles.root}>
        {/* The organisation's accent as a FILL, the one piece of brand colour
          that carries across every portal page. Decorative: it repeats no
          information, so it needs no accessible name. */}
        <div className={styles.brandRule} aria-hidden="true" />
        <header className={styles.chrome}>
          <PortalBrandMark />
          <div className={styles.actions}>
            {!suspended && <AccountBadge name={customer.data?.name} />}
            <ThemeToggle />
            {/* Team management is a customer-admin surface, so the link only
              shows for admins. The route below is still self-gated, and the
              callable re-checks the role, so hiding the link is convenience,
              not the boundary. */}
            {!suspended && isAdmin && (
              <Link to={portalUrls.team} className={styles.accountLink}>
                Team
              </Link>
            )}
            {!suspended && (
              <Link to={portalUrls.account} className={styles.accountLink}>
                Account
              </Link>
            )}
            <SwitchSpaceLink />
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
              {/* The customer admin's team surface. Mounted for every portal
                session and self-gated inside on the admin role, so a non-admin
                landing here by URL gets a calm dead end rather than the form. */}
              <Route path="team" element={<PortalTeam />} />
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
        <PortalFooter />
      </div>
    </PortalOrgProvider>
  );
}

/**
 * The footer names the assessing organisation and how to reach them, from the
 * org's own published contact block, so "contact your assessor" is an actual
 * name, email and phone rather than a dead instruction. Degrades a field at a
 * time: whatever the org has set shows, the rest is simply omitted, and if the
 * profile has not resolved (or the org set no contact) it falls back to the
 * plain sentence rather than a half-empty block.
 */
function PortalFooter() {
  const { name, contact } = usePortalOrgIdentity();
  const orgName = name ?? 'your fire risk assessor';
  const email = contact?.email;
  const phone = contact?.phone;

  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <p className={styles.footerCopy}>
          This portal is provided by {orgName}. Please contact them with any
          question about what it shows.
        </p>
        {(email || phone) && (
          <p className={styles.footerContact}>
            {email && (
              <a className={styles.footerLink} href={`mailto:${email}`}>
                {email}
              </a>
            )}
            {email && phone && <span aria-hidden="true"> · </span>}
            {phone && (
              <a className={styles.footerLink} href={`tel:${phone.replace(/\s+/g, '')}`}>
                {phone}
              </a>
            )}
          </p>
        )}
      </div>
    </footer>
  );
}

/**
 * The portal chrome carries the ASSESSING ORGANISATION's mark: their logo where
 * they have one, their name, and the quiet Safentia attribution beneath. Until
 * the profile resolves - or where access is suspended and the read is denied -
 * the Safentia wordmark holds the space, so the chrome is never blank and never
 * half-drawn.
 */
function PortalBrandMark() {
  const { name, logoUrl } = usePortalOrgIdentity();

  if (!name) {
    return <Wordmark to={portalUrls.home} />;
  }

  return (
    <Link
      to={portalUrls.home}
      className={styles.brandLink}
      aria-label={`${name} home`}
    >
      <span className={styles.brandIdentity}>
        {logoUrl && (
          <StoredImage reference={logoUrl} alt="" className={styles.brandLogo} />
        )}
        <span className={styles.brandName} title={name}>
          {name}
        </span>
      </span>
      <span className={styles.poweredBy}>Powered by Safentia</span>
    </Link>
  );
}

/** Which customer account this session is looking at. The organisation now owns
 *  the brand mark, so the reader still needs their own name somewhere: a
 *  contact who looks after several landlords must be able to tell at a glance
 *  which one they are signed in as. */
function AccountBadge({ name }: { name: string | undefined }) {
  if (!name) {
    return null;
  }
  return (
    <span className={styles.accountBadge}>
      <span className={styles.accountBadgeLabel}>Signed in for</span>
      <span className={styles.accountBadgeName} title={name}>
        {name}
      </span>
    </span>
  );
}

/**
 * "Switch space" - the portal's way back to the space picker, shown only to
 * someone who actually holds more than one space (the majority hold one and
 * would find it meaningless). The portal has no in-place switcher of its own, so
 * a stranded multi-space customer could otherwise only leave by signing out.
 *
 * It clears the recorded space choice and reloads /app: the picker gate is
 * component state in ConsoleRoute that a child cannot reset directly, and a full
 * reload re-evaluates it cleanly (choice forgotten -> the picker shows again).
 * A deliberate context change is a fair moment for a reload.
 */
function SwitchSpaceLink() {
  const { user } = useAuth();
  const spaces = useUserSpaces();
  if (!spaces.hasMultiple) {
    return null;
  }
  return (
    <Link
      to={portalUrls.home}
      className={styles.accountLink}
      onClick={(event) => {
        event.preventDefault();
        if (user?.uid) {
          forgetSpaceChoice(user.uid);
        }
        window.location.assign('/app');
      }}
    >
      Switch space
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
      <h1 className={styles.notFoundHeading}>
        There is nothing at this address
      </h1>
      <p className={styles.notFoundCopy}>
        The page may have moved, or the link you followed is out of date.
      </p>
      <Button variant="secondary" to={portalUrls.home}>
        Back to your buildings
      </Button>
    </section>
  );
}
