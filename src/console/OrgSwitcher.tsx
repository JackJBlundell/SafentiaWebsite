// ============================================================================
// OrgSwitcher - shows which space the session is acting in, and lets the user
// move between every space they hold: the organisations they work for, the
// customer accounts they can view, and (for a super admin) the platform console.
//
// Both halves are offered here for the same reason the picker exists: a person
// who is staff at one firm and a customer contact at another must be able to
// move between the two without signing out. When they hold both kinds the list
// is grouped and labelled, because "Northern Housing" as a customer account and
// "Northern Housing" as an employer are different places.
//
// Most users hold exactly one space, so the common rendering is static text: no
// affordance is promised that does nothing. A genuine multi-space member, or any
// super admin, gets the disclosure - the super admin because the switcher is
// also how they ENTER platform mode (a "Super Admin Dashboard" entry that
// navigates to /app/admin) and, once there, how they RETURN to a space.
//
// Entering platform mode is client-side navigation ONLY: it is not a space, so
// it never calls setActiveOrganisation and never touches the claims. Returning
// to a DIFFERENT space does switch, exactly as an in-console switch would.
//
// Switching is server-authoritative: the `setActiveOrganisation` callable
// rewrites the custom claims, we refresh the ID token to pick them up, and then
// the AuthProvider CLEARS the whole query cache - the claims name the space and
// environment that every cached RTDB path was read under, so after a switch
// every entry is data from the wrong space and none of it may be shown or
// "invalidated back to life". A clear is the only honest option.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { activateSpace } from '../auth/activateSpace';
import { rememberSpaceChoice } from '../auth/spaceChoice';
import { useUserSpaces } from '../auth/useUserSpaces';
import type { UserSpace } from '../types';
import { useSuperAdminClaim } from './admin/useSuperAdminClaim';
import { SpaceMark } from './SpaceMark';
import styles from './OrgSwitcher.module.css';

/** Identity for one space in the list: the pair IS the space, and a portal space
 *  at the same organisation as a staff space must not collide with it. */
function spaceId(space: UserSpace): string {
  return `${space.kind}:${space.orgId}:${space.customerId ?? ''}`;
}

export function OrgSwitcher() {
  const { user, refreshSession } = useAuth();
  const { spaces, loading, hasMultiple } = useUserSpaces();
  const navigate = useNavigate();
  const location = useLocation();
  const isSuperAdmin = useSuperAdminClaim() === 'granted';
  // Platform mode: a super admin whose current URL is under /app/admin. Mirrors
  // ConsoleShell's own detection so the trigger and rail agree.
  const inPlatformMode =
    isSuperAdmin && location.pathname.startsWith('/app/admin');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  // Escape closes and returns focus; clicking outside dismisses. Attached only
  // while open, mirroring the account menu's disclosure behaviour.
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

  const current = spaces.find((space) => space.isCurrent);

  const switchTo = useCallback(
    // `navigateTo` moves the session on once the switch has landed. It is used
    // when RETURNING from platform mode, and whenever the switch crosses the
    // staff/portal line: the two halves have different routes, so staying on the
    // current URL would land the person on a page their new space does not have.
    async (space: UserSpace, navigateTo?: string) => {
      setPending(true);
      setError(null);
      // An in-page action: the user stays on this screen, so focus returns to
      // the trigger rather than dropping to <body> when the panel unmounts.
      close(true);
      try {
        await activateSpace(space.orgId, space.customerId);
        // The claims changed, so refresh the token before touching any data.
        // The query cache is NOT cleared here: the AuthProvider clears it on
        // the space transition, in an effect that runs after the old space's
        // listeners have detached. Clearing here, mid-transition, would let a
        // late old-space snapshot repopulate the cache behind the clear.
        await refreshSession();
        if (user?.uid) {
          // A deliberate switch answers the picker's question too, so a reload
          // does not immediately ask again where they wanted to be.
          rememberSpaceChoice(user.uid);
        }
        if (navigateTo) {
          navigate(navigateTo);
        }
      } catch {
        setError('Could not switch space. Please try again.');
      } finally {
        setPending(false);
      }
    },
    [close, refreshSession, navigate, user?.uid],
  );

  // Enter platform mode: pure navigation, no claim change (it is not a space).
  const enterPlatform = useCallback(() => {
    close(true);
    navigate('/app/admin');
  }, [close, navigate]);

  const activate = useCallback(
    (space: UserSpace) => {
      if (inPlatformMode) {
        // Returning to a space from platform mode always leaves /app/admin;
        // only a DIFFERENT space also switches.
        if (space.isCurrent) {
          close(true);
          navigate('/app');
          return;
        }
        void switchTo(space, '/app');
        return;
      }
      if (space.isCurrent) {
        close(true);
        return;
      }
      // EVERY switch lands on the dashboard, not just one that crosses the
      // staff/portal line.
      //
      // A console URL is full of record ids - /app/customers/{customerId}/sites/
      // {siteId}/buildings/{buildingId} - and every one of them belongs to the
      // organisation you were in. Staying put after a switch carries the old
      // org's ids into the new one, where at best they resolve to nothing and at
      // worst the rules refuse the read; either way the first thing the new
      // space shows you is a broken page. Even a list route is wrong: "Jobs"
      // filtered to an assessor who does not work here.
      //
      // The dashboard is the one page that is correct in every space, and it is
      // where someone who has just changed organisation wants to start.
      void switchTo(space, '/app');
    },
    [close, inPlatformMode, navigate, switchTo],
  );

  if (loading) {
    // Nothing worth rendering yet: the shell's identity comes from the theme
    // and account menu, and a flash of skeleton text here would just be noise.
    return null;
  }

  // A super admin always gets the disclosure (it carries the platform entry and
  // the way back), even with a single space. Everyone else with no space has
  // nothing to show.
  if (spaces.length === 0 && !isSuperAdmin) {
    return null;
  }

  if (!hasMultiple && !isSuperAdmin) {
    // One space: static text, no dead disclosure. There is no create entry here
    // - organisations are founded by the platform operator until Phase 3
    // self-serve onboarding (see /app/admin).
    return <span className={styles.single}>{spaces[0].name}</span>;
  }

  const staffSpaces = spaces.filter((space) => space.kind === 'staff');
  const portalSpaces = spaces.filter((space) => space.kind === 'portal');
  // Headings earn their space only when the list actually spans both halves;
  // a multi-org staff member sees the same flat list they always have.
  const grouped = staffSpaces.length > 0 && portalSpaces.length > 0;

  const triggerLabel = pending
    ? 'Switching space'
    : inPlatformMode
      ? 'Super Admin'
      : current?.name ?? 'Choose a space';

  const option = (space: UserSpace) => {
    // In platform mode nothing is "current" among the spaces - the platform
    // entry below is - so the marker moves there, reinforcing that the operator
    // has left the tenant workspace.
    const isCurrentMode = space.isCurrent && !inPlatformMode;
    return (
      <li key={spaceId(space)}>
        <button
          type="button"
          className={styles.option}
          aria-current={isCurrentMode ? 'true' : undefined}
          disabled={pending}
          onClick={() => activate(space)}
        >
          <SpaceMark space={space} size="sm" />
          <span className={styles.optionText}>
            <span className={styles.optionName}>{space.name}</span>
            {/* Every row states its half in words: a customer account and an
                employer can share a name, and the difference must never rest on
                the mark or position alone. */}
            <span className={styles.optionMeta}>
              {space.kind === 'portal'
                ? space.orgName
                  ? `Customer account, assessed by ${space.orgName}`
                  : 'Customer account'
                : 'Staff console'}
            </span>
          </span>
          {isCurrentMode && (
            <span className={styles.currentMark} aria-hidden="true" />
          )}
        </button>
      </li>
    );
  };

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.triggerLabel}>{triggerLabel}</span>
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
        <div className={styles.panel}>
          {grouped && (
            <p className={styles.groupHeading} id="org-switcher-staff">
              Organisations you work for
            </p>
          )}
          {staffSpaces.length > 0 && (
            <ul
              className={styles.list}
              {...(grouped
                ? { 'aria-labelledby': 'org-switcher-staff' }
                : { 'aria-label': 'Your spaces' })}
            >
              {staffSpaces.map(option)}
            </ul>
          )}
          {grouped && (
            <p className={styles.groupHeading} id="org-switcher-portal">
              Customer accounts you can view
            </p>
          )}
          {portalSpaces.length > 0 && (
            <ul
              className={styles.list}
              {...(grouped
                ? { 'aria-labelledby': 'org-switcher-portal' }
                : { 'aria-label': 'Your spaces' })}
            >
              {portalSpaces.map(option)}
            </ul>
          )}
          {isSuperAdmin && (
            <ul className={styles.list} aria-label="Platform">
              <li>
                <button
                  type="button"
                  className={styles.option}
                  aria-current={inPlatformMode ? 'true' : undefined}
                  disabled={pending}
                  onClick={() => {
                    if (inPlatformMode) {
                      close(true);
                      return;
                    }
                    enterPlatform();
                  }}
                >
                  <span className={`${styles.platformMark}`} aria-hidden="true">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={styles.platformGlyph}
                    >
                      <path d="M12 3l7 3v5c0 4.4-3 8-7 9-4-1-7-4.6-7-9V6z" />
                      <path d="M9.5 12l1.8 1.8 3.5-3.8" />
                    </svg>
                  </span>
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>
                      Super Admin Dashboard
                    </span>
                    <span className={styles.optionMeta}>Platform oversight</span>
                  </span>
                  {inPlatformMode && (
                    <span className={styles.currentMark} aria-hidden="true" />
                  )}
                </button>
              </li>
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
