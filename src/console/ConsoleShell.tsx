// ============================================================================
// ConsoleShell - the signed-in chrome: top bar plus the console's own routes.
//
// The chrome is deliberately minimal. The dashboards, job boards and reporting
// views are later epics; this wave ships only what is real today (home, account,
// switching organisation), because fake tiles in a safety product erode the
// trust the whole console depends on.
//
// The account menu is a disclosure, not a role="menu" menubar: it holds two
// items and the full menu pattern's arrow-key contract would be ceremony. What
// it DOES honour: aria-expanded on the trigger, Escape closes and returns focus
// to the trigger, and clicking outside dismisses.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { equalTo, limitToFirst, orderByChild, query } from 'firebase/database';
import { useAuth } from '../auth/AuthProvider';
import { keys } from '../query/keys';
import {
  subscribeToQuery,
  useRtdbQuery,
  type RtdbQueryBuilder,
} from '../query/useRtdbQuery';
import type { Assessment, OrgProfile, OrgRole } from '../types';
import { Button } from '../components/Button';
import { ThemeToggle } from '../components/ThemeToggle';
import { Wordmark } from '../components/Wordmark';
import { AccountPage } from './AccountPage';
import { ConsoleHome } from './ConsoleHome';
import { OrgSwitcher } from './OrgSwitcher';
import { CustomersRoutes } from './customers/CustomersRoutes';
import { StaffRoutes } from './staff/StaffRoutes';
import { SettingsRoutes } from './settings/SettingsRoutes';
import { ActivityRoutes } from './activity/ActivityRoutes';
import { JobsRoutes } from './jobs/JobsRoutes';
import { ValidationRoutes } from './validation/ValidationRoutes';
import { TemplatesRoutes } from './templates/TemplatesRoutes';
import { ReportsRoutes, REPORTS_ROLES } from './reports/ReportsRoutes';
import { AdminRoutes } from './admin/AdminRoutes';
import { PlatformEnvProvider, usePlatformEnv } from './admin/platformEnv';
import { useSuperAdminClaim } from './admin/useSuperAdminClaim';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { GlobalSearch } from './search/GlobalSearch';
import styles from './ConsoleShell.module.css';

type NavIconName =
  | 'home'
  | 'customers'
  | 'templates'
  | 'jobs'
  | 'validation'
  | 'activity'
  | 'reports'
  | 'staff'
  | 'platform'
  | 'dashboard'
  | 'buildings'
  | 'settings';

interface NavItem {
  to: string;
  label: string;
  end: boolean;
  adminOnly: boolean;
  icon: NavIconName;
  /** When present, the item shows only to members holding ANY listed role
   *  (admins are not implicitly included - list them). `adminOnly` keeps its
   *  exact meaning for the existing items. */
  roles?: readonly OrgRole[];
}

/**
 * Primary console navigation, shown while acting inside an ORGANISATION.
 * Admin-only (and role-listed) areas are HIDDEN from members without the role,
 * but hiding is presentation: the real boundary is the rules and each
 * callable's own role check, so a hand-typed URL gains nothing.
 *
 * The platform console is a SEPARATE mode with its own rail (PLATFORM_NAV_ITEMS
 * below); a super admin enters it from the organisation switcher, not from a
 * nav item wedged in beside the tenant's own areas.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { to: '/app', label: 'Home', end: true, adminOnly: false, icon: 'home' },
  { to: '/app/customers', label: 'Customers', end: false, adminOnly: false, icon: 'customers' },
  { to: '/app/jobs', label: 'Jobs', end: false, adminOnly: false, icon: 'jobs' },
  // Validation is an auditor workflow (admins retain oversight); assessors and
  // finance members previously saw a nav item that dead-ended on a role gate.
  { to: '/app/validation', label: 'Validation', end: false, adminOnly: false, icon: 'validation', roles: ['auditor', 'admin'] },
  { to: '/app/templates', label: 'Templates', end: false, adminOnly: true, icon: 'templates' },
  { to: '/app/activity', label: 'Activity', end: false, adminOnly: false, icon: 'activity' },
  { to: '/app/reports', label: 'Reports', end: false, adminOnly: false, icon: 'reports', roles: REPORTS_ROLES },
  { to: '/app/staff', label: 'Staff', end: false, adminOnly: true, icon: 'staff' },
  { to: '/app/settings', label: 'Settings', end: false, adminOnly: true, icon: 'settings' },
] as const;

/**
 * The PLATFORM rail (FR-E24). Shown only in platform mode - a super admin under
 * /app/admin - INSTEAD of the org nav, so the operator surface never blends
 * into a tenant workspace. Every operator holds the superAdmin claim by the time
 * this renders, so no per-item role gate is needed; the real boundary stays the
 * rules' superAdmin cascade. Dashboard uses an exact (`end`) match so it is not
 * always lit; the rest match their subpaths, and a drill-down under
 * /app/admin/:orgId simply lights nothing rather than mis-highlighting.
 */
const PLATFORM_NAV_ITEMS: readonly NavItem[] = [
  { to: '/app/admin', label: 'Dashboard', end: true, adminOnly: false, icon: 'dashboard' },
  { to: '/app/admin/organisations', label: 'Organisations', end: false, adminOnly: false, icon: 'platform' },
  { to: '/app/admin/customers', label: 'Customers', end: false, adminOnly: false, icon: 'customers' },
  { to: '/app/admin/buildings', label: 'Buildings', end: false, adminOnly: false, icon: 'buildings' },
  { to: '/app/admin/members', label: 'Members', end: false, adminOnly: false, icon: 'staff' },
  { to: '/app/admin/activity', label: 'Activity', end: false, adminOnly: false, icon: 'activity' },
] as const;

/** Minimal geometric glyphs for the rail, drawn inline (no icon dependency,
 *  currentColor, crisp at 18px). Paired with the label always - the icon is
 *  reinforcement, never the sole carrier. */
function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<string, React.ReactNode> = {
    home: <path d="M3 9.2 9 4l6 5.2V15a1 1 0 0 1-1 1h-3.2v-4H7.2v4H4a1 1 0 0 1-1-1z" />,
    customers: (
      <>
        <path d="M3 16V7.5L7 4l4 3.5V16" />
        <path d="M11 16V9h4v7" />
        <path d="M3 16h13" />
      </>
    ),
    activity: <path d="M2 10h3l2-5 4 9 2-4h3" />,
    reports: (
      <>
        <path d="M3 3v11.5h12" />
        <path d="M6.5 12V8.5M10 12V5.5M13.5 12V10" />
      </>
    ),
    jobs: (
      <>
        <rect x="2.5" y="4" width="13" height="11" rx="1.5" />
        <path d="M2.5 8h13M6 2.5V5M12 2.5V5" />
      </>
    ),
    validation: (
      <>
        <path d="M9 2.5 3.5 5v4c0 3.4 2.3 5.8 5.5 6.5 3.2-.7 5.5-3.1 5.5-6.5V5z" />
        <path d="M6.5 9.2 8.3 11l3.2-3.5" />
      </>
    ),
    templates: (
      <>
        <rect x="3" y="2.5" width="12" height="13" rx="1.5" />
        <path d="M6 6h6M6 9h6M6 12h3.5" />
      </>
    ),
    staff: (
      <>
        <circle cx="7" cy="6.5" r="2.6" />
        <path d="M2.5 15.5c.6-2.6 2.4-4 4.5-4s3.9 1.4 4.5 4" />
        <circle cx="13.5" cy="7.5" r="2" />
        <path d="M12.6 11.6c1.9.2 3.2 1.4 3.7 3.4" />
      </>
    ),
    settings: (
      <>
        <circle cx="9" cy="9" r="2.4" />
        <path d="M9 2.8v2M9 13.2v2M2.8 9h2M13.2 9h2M4.6 4.6l1.4 1.4M12 12l1.4 1.4M13.4 4.6 12 6M6 12l-1.4 1.4" />
      </>
    ),
    platform: (
      <>
        <circle cx="9" cy="9" r="6.5" />
        <path d="M2.5 9h13M9 2.5c2 1.8 3 4 3 6.5s-1 4.7-3 6.5c-2-1.8-3-4-3-6.5s1-4.7 3-6.5z" />
      </>
    ),
    dashboard: (
      <>
        <rect x="2.8" y="2.8" width="5" height="5" rx="1" />
        <rect x="10.2" y="2.8" width="5" height="5" rx="1" />
        <rect x="2.8" y="10.2" width="5" height="5" rx="1" />
        <rect x="10.2" y="10.2" width="5" height="5" rx="1" />
      </>
    ),
    buildings: (
      <>
        <rect x="2.5" y="6" width="6" height="9.5" rx="1" />
        <rect x="9" y="2.5" width="6.5" height="13" rx="1" />
        <path d="M4.5 9h2M4.5 11.5h2M11 5.5h2.5M11 8.5h2.5M11 11.5h2.5" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 18 18" className={styles.navIcon} aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

/** The rail badge's subscription cap. Must match ValidationQueue's QUEUE_LIMIT:
 *  the badge deliberately reuses the queue's exact cache key, so both call
 *  sites must describe the same bounded, indexed subscription. */
const VALIDATION_BADGE_LIMIT = 200;

/**
 * How many assessments are waiting in the validation queue, for the rail badge
 * (mirrors the queue's "Awaiting validation" section). Returns undefined when
 * the badge should not render at all: zero waiting, the read still attaching or
 * denied, or a session without a role the rules grant the read to.
 */
function useValidationWaitingCount(): { count: number; shown: string } | undefined {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  // database.rules.json gates /assessments/{orgId} to active members; the nav
  // item itself is limited to auditors and admins, and the subscription attaches
  // only for those same roles (the ConsoleHome /orgMembers gating pattern), so a
  // member the item is hidden from never holds a listener for it.
  const canRead = claims?.roles.auditor === true || claims?.roles.admin === true;
  const build = useMemo<RtdbQueryBuilder>(
    () => (node) =>
      query(
        node,
        orderByChild('status'),
        equalTo('readyForValidation'),
        limitToFirst(VALIDATION_BADGE_LIMIT),
      ),
    [],
  );
  const waiting = useRtdbQuery<Record<string, Assessment> | null>({
    // The queue's own key for this stage, so the badge and the queue share one
    // cache entry and one listener rather than reading the node twice.
    key: keys.assessmentsByStatus(orgId, 'readyForValidation'),
    path: paths ? paths.db.assessments(orgId) : '',
    enabled: Boolean(orgId && paths) && canRead,
    build,
  });
  if (!canRead || waiting.isError) {
    return undefined;
  }
  const count = Object.keys(waiting.data ?? {}).length;
  if (count === 0) {
    return undefined;
  }
  return { count, shown: count > 99 ? '99+' : String(count) };
}

/** Grace period before a drop is announced, so route changes, token refreshes
 *  and sub-second blips never flash the banner. */
const CONNECTION_GRACE_MS = 4_000;

/** The SDK's synthetic connectivity node. Not part of the database schema, so
 *  it has no `paths` builder; this literal is its single home. */
const INFO_CONNECTED_PATH = '.info/connected';

/**
 * The slim, non-blocking connection notice. `.info/connected` is subscribed
 * through the shared bridge's imperative surface (subscribeToQuery) rather
 * than useRtdbQuery, because the hook's one-shot get() fallback would ask the
 * SERVER for a value only the local client holds; the live listener is the
 * only correct read of a synthetic node. The disabled useQuery below simply
 * observes the cache entry the subscription writes.
 */
function ConnectionBanner() {
  const client = useQueryClient();
  useEffect(
    () =>
      subscribeToQuery<boolean>(client, {
        key: keys.infoConnected(),
        path: INFO_CONNECTED_PATH,
        select: (value) => value === true,
      }),
    [client],
  );
  // skipToken: observe the cache entry, never fetch it (fetching is the
  // subscription's job above, and a get() of this path would be wrong anyway).
  const connected = useQuery<boolean>({
    queryKey: keys.infoConnected(),
    queryFn: skipToken,
  });

  // Undefined means "not reported yet" (first paint; the subscription attaches
  // in an effect, so the pre-render pass can never show this). Only an explicit
  // false starts the grace timer, and a reconnect clears the banner at once.
  const dropped = connected.data === false;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!dropped) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), CONNECTION_GRACE_MS);
    return () => clearTimeout(timer);
  }, [dropped]);

  if (!visible) {
    return null;
  }
  return (
    <div className={styles.connectionBanner} role="status">
      Connection lost. Reconnecting...
    </div>
  );
}

export function ConsoleShell() {
  const { claims } = useAuth();
  const location = useLocation();
  const isAdmin = claims?.roles.admin === true;
  const validationWaiting = useValidationWaitingCount();
  // The superAdmin claim is a platform concern read from the raw token (see
  // admin/useSuperAdminClaim); 'loading' shows nothing, so the item can only
  // ever appear once the claim is proven.
  const superAdmin = useSuperAdminClaim();
  // Platform mode is a whole separate console: a super admin whose current URL
  // is under /app/admin. It swaps the rail and the brand chrome for the
  // operator surface, so the org and platform navigations never mix.
  const inPlatformMode =
    superAdmin === 'granted' && location.pathname.startsWith('/app/admin');
  /** Every org-nav visibility rule must pass: the legacy admin flag and any
   *  role list. */
  const showsItem = (item: NavItem): boolean => {
    if (item.adminOnly && !isAdmin) {
      return false;
    }
    if (item.roles && !item.roles.some((role) => claims?.roles[role] === true)) {
      return false;
    }
    return true;
  };
  const navItems = inPlatformMode
    ? PLATFORM_NAV_ITEMS
    : NAV_ITEMS.filter(showsItem);

  // ONE DOM, two presentations: a left rail on desktop (nav vertical, session
  // controls pinned to its foot), the established top-bar pattern below the
  // breakpoint. The stylesheet does the re-laying; nothing renders twice, so
  // no duplicated listeners or menus.
  // The provider is always mounted (org mode simply never reads it), so the
  // platform env is one value shared by the rail toggle below and every routed
  // platform screen.
  return (
    <PlatformEnvProvider>
      <div className={styles.root}>
        <header className={styles.chrome}>
          <div className={styles.brandRow}>
            {inPlatformMode ? <PlatformBrandMark /> : <OrgBrandMark />}
          </div>
          {/* Global search is an ORG-console aid only: the platform operator
              surface has its own scoped screens and never mixes tenant data. */}
          {!inPlatformMode && (
            <div className={styles.searchRow}>
              <GlobalSearch />
            </div>
          )}
          <nav className={styles.nav} aria-label={inPlatformMode ? 'Platform' : 'Console'}>
            {navItems.map((item) => {
              // The Validation item carries its waiting count. The aria-label
              // replaces the link's name with the count in words, so the badge
              // is never a bare number to assistive technology.
              const badge =
                item.to === '/app/validation' ? validationWaiting : undefined;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  aria-label={
                    badge ? `${item.label}, ${badge.count} waiting` : undefined
                  }
                  className={({ isActive }) =>
                    isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
                  }
                >
                  <NavIcon name={item.icon} />
                  <span>{item.label}</span>
                  {badge && (
                    <span className={styles.navBadge} aria-hidden="true">
                      {badge.shown}
                    </span>
                  )}
                </NavLink>
              );
            })}
            {/* The environment toggle lives in the platform rail ONLY, the one
                place a super admin chooses live or test for the whole area. */}
            {inPlatformMode && <PlatformEnvToggle />}
          </nav>
          {/* data-tip-side flips icon-control tooltips to the trigger's right in
              the desktop rail (see ThemeToggle.module.css); below the breakpoint
              the same DOM is a top bar and tooltips sit underneath as usual. */}
          {/* The org switcher keeps its own row; below it the account menu and the
              theme toggle share a row, the toggle pinned to the far end. On the
              mobile top bar .sessionRow is display:contents, so all three controls
              sit inline exactly as before. */}
          <div className={styles.actions} data-tip-side="right">
            <OrgSwitcher />
            <div className={styles.sessionRow}>
              <ThemeToggle />
              <AccountMenu />
            </div>
          </div>
        </header>
        <main className={styles.main}>
          <ConnectionBanner />
          {/* The boundary sits INSIDE the chrome: a crashed page falls back to
              the calm card while the rail, switcher and account menu stay alive
              as the way out. resetKey clears an errored boundary on navigation. */}
          <ErrorBoundary resetKey={location.pathname}>
            <Routes>
              <Route index element={<ConsoleHome />} />
              <Route path="account" element={<AccountPage />} />
              <Route path="customers/*" element={<CustomersRoutes />} />
              <Route path="activity/*" element={<ActivityRoutes />} />
              <Route path="jobs/*" element={<JobsRoutes />} />
              <Route path="validation/*" element={<ValidationRoutes />} />
              <Route path="templates/*" element={<TemplatesRoutes />} />
              <Route path="reports/*" element={<ReportsRoutes />} />
              <Route path="staff/*" element={<StaffRoutes />} />
              <Route path="settings/*" element={<SettingsRoutes />} />
              <Route path="admin/*" element={<AdminRoutes />} />
              <Route path="*" element={<NotFoundPanel />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
    </PlatformEnvProvider>
  );
}

/**
 * The signed-in chrome carries the ORGANISATION's identity, not Safentia's -
 * this is a whitelabel product, and the report the customer receives already
 * carries the org's brand. Safentia stays present as the quiet "Powered by"
 * line. Until the profile resolves (or for a member of no named org) the
 * Safentia wordmark holds the space, so the chrome never renders blank.
 * The profile read shares keys.orgProfile with the branded theme, so the
 * value comes straight from the same cache entry.
 */
function OrgBrandMark() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId;
  const profile = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(orgId ?? 'none'),
    path: orgId && paths ? paths.db.orgProfile(orgId) : 'none',
    enabled: Boolean(orgId && paths),
  });

  const name = profile.data?.name;
  const logoUrl = profile.data?.logoUrl;

  if (!name) {
    return <Wordmark to="/app" />;
  }

  return (
    <Link to="/app" className={styles.brandLink} aria-label={`${name} home`}>
      <span className={styles.brandIdentity}>
        {logoUrl && <img src={logoUrl} alt="" className={styles.brandLogo} />}
        <span className={styles.brandName}>{name}</span>
      </span>
      <span className={styles.poweredBy}>Powered by Safentia</span>
    </Link>
  );
}

/**
 * The single live/test switch for the whole platform area, shown once in the
 * platform rail. It writes the shared PlatformEnvProvider, so every platform
 * screen re-reads the chosen environment at once. A two-button segmented group:
 * the label is text (colour is reinforcement, never the sole carrier) and
 * aria-pressed marks the active side.
 */
function PlatformEnvToggle() {
  const { env, setEnv } = usePlatformEnv();
  return (
    <div className={styles.envToggle} role="group" aria-label="Environment">
      {(['live', 'test'] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={env === option ? styles.envButtonActive : styles.envButton}
          aria-pressed={env === option}
          onClick={() => setEnv(option)}
        >
          {option === 'live' ? 'Live' : 'Test'}
        </button>
      ))}
    </div>
  );
}

/**
 * The platform-mode brand: a neutral Safentia wordmark, not a tenant's logo.
 * It deliberately drops the per-org identity and the "Powered by" line so the
 * operator is never in any doubt that this is the platform console rather than
 * a customer workspace. Links back to the platform dashboard.
 */
function PlatformBrandMark() {
  return (
    <Link
      to="/app/admin"
      className={styles.brandLink}
      aria-label="Safentia Platform, dashboard"
    >
      {/* The mark carries the product name here, so no typeset name beside it.
          The link's own aria-label is what assistive technology announces. */}
      <span className={styles.brandIdentity}>
        <Wordmark size="sm" />
      </span>
      <span className={styles.platformTag}>Platform console</span>
    </Link>
  );
}

/** The signed-in user's disclosure: account settings and sign-out. */
function AccountMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  // Escape closes and hands focus back to the trigger; a click anywhere outside
  // dismisses without stealing focus. Both listeners exist only while open, so
  // the shell adds no document-level work when the menu is shut.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close(true);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  // The visible identity: a display name when the user has set one, otherwise
  // the email they signed in with. Never blank chrome.
  const label = user?.displayName || user?.email || 'Account';

  return (
    <div className={styles.menuContainer} ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.menuTrigger}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.menuLabel}>{label}</span>
        <svg
          viewBox="0 0 12 12"
          className={styles.chevron}
          aria-hidden="true"
          focusable="false"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className={styles.menuPanel}>
          <Link
            to="/app/account"
            className={styles.menuItem}
            onClick={() => close(false)}
          >
            Account settings
          </Link>
          <button
            type="button"
            className={styles.menuItem}
            onClick={() => {
              // In-page action: restore focus to the trigger while the gate
              // processes the sign-out and swaps this tree for the redirect.
              close(true);
              void signOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** A console URL that does not exist. Small and honest; no marketing 404. */
function NotFoundPanel() {
  return (
    <section className={styles.notFound}>
      <h1 className={styles.notFoundHeading}>There is nothing at this address</h1>
      <p className={styles.notFoundCopy}>
        The page may have moved, or the link you followed is out of date.
      </p>
      <Button variant="secondary" to="/app">
        Back to the console
      </Button>
    </section>
  );
}
