// ============================================================================
// OrgSwitcher - shows which workspace the session is acting in, and lets the
// user move between them: their organisations, and (for a super admin) the
// platform console.
//
// Most users belong to exactly one org, so the common rendering is static text:
// no affordance is promised that does nothing. A genuine multi-org member, or
// any super admin, gets the disclosure - the super admin because the switcher
// is also how they ENTER platform mode (a "Super Admin Dashboard" entry that
// navigates to /app/admin) and, once there, how they RETURN to an organisation.
//
// Entering platform mode is client-side navigation ONLY: it is not an org, so
// it never calls setActiveOrganisation and never touches the claims. Returning
// to a DIFFERENT org does switch, exactly as an in-org switch would.
//
// Switching is server-authoritative: the `setActiveOrganisation` callable
// rewrites the custom claims, we refresh the ID token to pick them up, and then
// we CLEAR the whole query cache - the claims name the org and environment that
// every cached RTDB path was read under, so after a switch every entry is data
// from the wrong workspace and none of it may be shown or "invalidated back to
// life". A clear is the only honest option.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { firebase } from '../firebase';
import { useAuth } from '../auth/AuthProvider';
import { useUserOrganisations } from '../auth/useUserOrganisations';
import type { SetActiveOrganisationInput, SetActiveOrganisationResult } from '../types';
import { useSuperAdminClaim } from './admin/useSuperAdminClaim';
import styles from './OrgSwitcher.module.css';

export function OrgSwitcher() {
  const { refreshSession } = useAuth();
  const { organisations, loading, hasMultiple } = useUserOrganisations();
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

  const switchTo = useCallback(
    // `navigateTo` moves the session on once the switch has landed - used when
    // RETURNING to a different org from platform mode, which must both restore
    // the org claims and leave /app/admin. An in-org switch passes nothing and
    // stays put.
    async (orgId: string, navigateTo?: string) => {
      setPending(true);
      setError(null);
      // An in-page action: the user stays on this screen, so focus returns to
      // the trigger rather than dropping to <body> when the panel unmounts.
      close(true);
      try {
        const call = httpsCallable<
          SetActiveOrganisationInput,
          SetActiveOrganisationResult
        >(firebase.functions(), 'setActiveOrganisation');
        await call({ orgId });
        // The claims changed, so refresh the token before touching any data.
        // The query cache is NOT cleared here: the AuthProvider clears it on
        // the orgId transition, in an effect that runs after the old org's
        // listeners have detached. Clearing here, mid-transition, would let a
        // late old-org snapshot repopulate the cache behind the clear.
        await refreshSession();
        if (navigateTo) {
          navigate(navigateTo);
        }
      } catch {
        setError('Could not switch organisation. Please try again.');
      } finally {
        setPending(false);
      }
    },
    [close, refreshSession, navigate],
  );

  // Enter platform mode: pure navigation, no claim change (it is not an org).
  const enterPlatform = useCallback(() => {
    close(true);
    navigate('/app/admin');
  }, [close, navigate]);

  const current = organisations.find((org) => org.isCurrent);

  if (loading) {
    // Nothing worth rendering yet: the shell's identity comes from the theme
    // and account menu, and a flash of skeleton text here would just be noise.
    return null;
  }

  // A super admin always gets the disclosure (it carries the platform entry and
  // the way back), even with a single org. Everyone else with no org has
  // nothing to show.
  if (organisations.length === 0 && !isSuperAdmin) {
    return null;
  }

  if (!hasMultiple && !isSuperAdmin) {
    // One organisation: static text, no dead disclosure. There is no create
    // entry here - organisations are founded by the platform operator until
    // Phase 3 self-serve onboarding (see /app/admin).
    return <span className={styles.single}>{organisations[0].name}</span>;
  }

  const triggerLabel = pending
    ? 'Switching organisation'
    : inPlatformMode
      ? 'Super Admin'
      : current?.name ?? 'Organisation';

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
        <ul className={styles.list} aria-label="Your organisations">
          {organisations.map((org) => {
            // In platform mode nothing is "current" among the orgs - the
            // platform entry below is - so the marker moves there, reinforcing
            // that the operator has left the tenant workspace.
            const isCurrentMode = org.isCurrent && !inPlatformMode;
            return (
              <li key={org.orgId}>
                <button
                  type="button"
                  className={styles.option}
                  aria-current={isCurrentMode ? 'true' : undefined}
                  disabled={pending}
                  onClick={() => {
                    if (inPlatformMode) {
                      // Returning to an organisation from platform mode always
                      // leaves /app/admin; only a DIFFERENT org also switches.
                      if (org.isCurrent) {
                        close(true);
                        navigate('/app');
                        return;
                      }
                      void switchTo(org.orgId, '/app');
                      return;
                    }
                    if (org.isCurrent) {
                      close(true);
                      return;
                    }
                    void switchTo(org.orgId);
                  }}
                >
                  <span className={styles.optionName}>{org.name}</span>
                  {isCurrentMode && <span className={styles.currentMark}>Current</span>}
                </button>
              </li>
            );
          })}
          {isSuperAdmin && (
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
                <span className={styles.optionName}>Super Admin Dashboard</span>
                {inPlatformMode && <span className={styles.currentMark}>Current</span>}
              </button>
            </li>
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
