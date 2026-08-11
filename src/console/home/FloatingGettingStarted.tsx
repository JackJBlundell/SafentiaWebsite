// ============================================================================
// FloatingGettingStarted - the onboarding checklist as a floating widget.
//
// Reworked from the old full-width dashboard card: mounted once in the
// ConsoleShell (org mode, admins only) so it floats bottom-right across EVERY
// console page and its ticks update live as steps are completed wherever the
// admin happens to be working - not just on the dashboard.
//
// Two states. A collapsed pill ("Getting started - 3/6") is the default; a
// click expands it into a compact panel holding the checklist. On desktop the
// panel anchors bottom-right; below the shell's rail breakpoint it becomes a
// bottom sheet. Collapse/expand is a per-tab preference kept in sessionStorage
// (the spaceChoice idiom) - deliberately NOT consoleState: it is a transient
// view preference, and growing the consoleState schema for it would be
// over-engineering next to the one honest stored tick that node exists for.
//
// The ticks are DERIVED from live org data wherever the data can answer, never
// stored: a checklist that remembers "done" separately from the thing done can
// drift into flattery. Tick sources, cheapest honest read first:
//   - profile / members / buildings ride the subscriptions ConsoleHome and the
//     shell already hold (same cache keys - no second listener attaches);
//   - customers, jobs and the first RELEASED assessment use one-record
//     presence probes (limitToFirst(1), the released one filtered by the
//     'status' index), because "has one ever happened?" never justifies the
//     whole node, and the server-maintained usage counters exist only for orgs
//     provisioned under Phase 3 billing - a counter would fake "not done" at
//     older orgs.
//
// Every tick is now data-derived: there is no stored "done" flag left, so the
// checklist can never flatter an org into thinking a step is finished when the
// thing itself is not there.
//
// First-landing sequencing: when the person arrived from the setup celebration
// this session (SetupCompleteScreen sets `safentia.arrivedFromSetup`), the
// widget opens EXPANDED once - its "here's what's next" moment - and the
// auto-tour stands down (useTourTrigger reads the same flag), so the two do not
// greet at once. The flag is session-scoped and consumed here on first mount.
//
// Honest loading: while ANY source is still attaching the widget renders
// nothing at all - an unticked flash would tell an org that has done
// everything that it has done nothing. It also removes itself once every item
// is ticked, and on "Hide forever" (persisted to consoleState/{uid} behind a
// two-step inline confirm, because the hide is permanent).
//
// Layering: the widget never claims the top of the stack. The guided tour's
// overlay sits at z-index 100 (tour/ConsoleTour.module.css); this widget stays
// below it (see the module CSS), so a running tour always covers the pill and
// panel rather than competing with them.
// ============================================================================

import {
  equalTo,
  limitToFirst,
  orderByChild,
  query,
  ref,
  update,
} from 'firebase/database';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { consoleState as consoleStatePath } from '../../paths';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type { ConsoleState, OrgMember, OrgProfile } from '../../types';
import styles from './FloatingGettingStarted.module.css';

/** One-record probe: enough to answer "does anything exist here?". */
const buildPresenceProbe: RtdbQueryBuilder = (node) =>
  query(node, limitToFirst(1));

/** One-record probe over the assessments node filtered to the released stage:
 *  enough to answer "has this org released an assessment yet?" without reading
 *  the whole node. Uses the same 'status' index ConsoleHome's release window
 *  already relies on. */
const buildReleasedProbe: RtdbQueryBuilder = (node) =>
  query(node, orderByChild('status'), equalTo('released'), limitToFirst(1));

/** An absent RTDB node arrives as null; anything else means at least one row. */
const selectPresent = (value: unknown): boolean => value != null;

const selectMemberCount = (value: unknown): number =>
  value == null ? 0 : Object.keys(value as Record<string, OrgMember>).length;

// --- The per-tab expand/collapse preference (the spaceChoice idiom) ---------
// Guarded access: Safari's private mode and locked-down enterprise profiles
// throw on storage access, and a widget that crashes the console is a far
// worse failure than one that opens collapsed a second time.

const EXPANDED_PREFIX = 'safentia.gettingStartedExpanded.';

function readExpanded(uid: string): boolean {
  try {
    return window.sessionStorage.getItem(EXPANDED_PREFIX + uid) === '1';
  } catch {
    return false;
  }
}

function writeExpanded(uid: string, expanded: boolean): void {
  try {
    if (expanded) {
      window.sessionStorage.setItem(EXPANDED_PREFIX + uid, '1');
    } else {
      window.sessionStorage.removeItem(EXPANDED_PREFIX + uid);
    }
  } catch {
    // Storage unavailable: the widget simply opens collapsed next load,
    // correct behaviour rather than a failure worth reporting.
  }
}

// --- The one-shot "arrived from the setup celebration" flag ------------------
// SetupCompleteScreen's CTA sets this the moment the person leaves the "You're
// all set" screen. Both this widget (which expands to greet) and useTourTrigger
// (which stands the auto-tour down) look for it; this widget owns CONSUMING it,
// so the greeting happens exactly once per setup arrival. Same guarded-storage
// idiom as above: an unavailable store simply means the organic welcome runs.

const ARRIVED_FROM_SETUP_KEY = 'safentia.arrivedFromSetup';

/** Reads and clears the flag in one go, returning whether it was set. */
function consumeArrivedFromSetup(): boolean {
  try {
    const arrived =
      window.sessionStorage.getItem(ARRIVED_FROM_SETUP_KEY) === '1';
    if (arrived) {
      window.sessionStorage.removeItem(ARRIVED_FROM_SETUP_KEY);
    }
    return arrived;
  } catch {
    return false;
  }
}

interface ChecklistItem {
  id: string;
  label: string;
  /** One calm line on why the step matters. */
  description: string;
  done: boolean;
  to: string;
  linkLabel: string;
}

export function FloatingGettingStarted() {
  const { user, claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const uid = user?.uid ?? '';
  const isAdmin = claims?.roles.admin === true;
  const enabled = Boolean(claims && paths && uid) && isAdmin;

  // Kept ABOVE the early returns: hooks must run unconditionally.
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const [expanded, setExpanded] = useState(() => readExpanded(uid));
  const [confirmingHide, setConfirmingHide] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Where focus should land after the NEXT expand/collapse commit. Set by the
   *  handlers (a tap on the mobile backdrop sets nothing, so it never steals
   *  focus), consumed once by the effect below. */
  const focusTarget = useRef<'pill' | 'panel' | null>(null);

  useEffect(() => {
    if (focusTarget.current === 'panel') {
      panelRef.current?.focus();
    } else if (focusTarget.current === 'pill') {
      pillRef.current?.focus();
    }
    focusTarget.current = null;
  }, [expanded]);

  // First-landing sequencing (Fix 11): if this session arrived from the setup
  // celebration, open expanded once as the "here's what's next" moment, and
  // consume the flag so a later remount this session opens by the ordinary
  // preference. The auto-tour reads the same flag and stands down (see
  // useTourTrigger), so the two never greet together. Runs once on mount; the
  // widget renders nothing until its data loads, so this settles before paint.
  useEffect(() => {
    if (consumeArrivedFromSetup()) {
      setExpanded(true);
      writeExpanded(uid, true);
    }
    // Intentionally mount-once: the flag is a one-shot session signal, and uid
    // is stable for the shell's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Already-subscribed keys (ConsoleHome holds profile/buildings/members for
  // admins) - these attach nothing new, they read the shared cache.
  const profile = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(orgId),
    path: paths ? paths.db.orgProfile(orgId) : '',
    enabled,
  });
  const buildings = useRtdbQuery<boolean>({
    key: keys.buildingsRoot(orgId),
    path: paths ? paths.db.buildingsRoot(orgId) : '',
    select: selectPresent,
    enabled,
  });
  const memberCount = useRtdbQuery<number>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    select: selectMemberCount,
    enabled,
  });

  // Bounded presence probes (their own cache keys, so they never clobber the
  // directory pages' full reads over the same nodes).
  const customersPresent = useRtdbQuery<boolean>({
    key: keys.customersPresence(orgId),
    path: paths ? paths.db.customers(orgId) : '',
    select: selectPresent,
    build: buildPresenceProbe,
    enabled,
  });
  const jobsPresent = useRtdbQuery<boolean>({
    key: keys.jobsPresence(orgId),
    path: paths ? paths.db.jobs(orgId) : '',
    select: selectPresent,
    build: buildPresenceProbe,
    enabled,
  });
  // "Has this org released an assessment yet?" - the honest replacement for the
  // old stored templates-visited tick. Its own presence key, so it never
  // clobbers ConsoleHome's bounded release window over the same node.
  const releasesPresent = useRtdbQuery<boolean>({
    key: keys.releasedAssessmentsPresence(orgId),
    path: paths ? paths.db.assessments(orgId) : '',
    select: selectPresent,
    build: buildReleasedProbe,
    enabled,
  });

  // The person's own console state: the dismiss flag and the visit-based tick.
  const consoleState = useRtdbQuery<ConsoleState | null>({
    key: keys.consoleState(uid),
    path: uid ? consoleStatePath(uid) : '',
    enabled,
  });

  if (!isAdmin) {
    return null;
  }

  // Honest loading: nothing renders until EVERY source has delivered. An
  // absent node delivers null (a real, loaded answer); undefined means the
  // listener has not spoken yet.
  if (
    profile.data === undefined ||
    buildings.data === undefined ||
    memberCount.data === undefined ||
    customersPresent.data === undefined ||
    jobsPresent.data === undefined ||
    releasesPresent.data === undefined ||
    consoleState.data === undefined
  ) {
    return null;
  }

  if (locallyDismissed || consoleState.data?.gettingStartedDismissed === true) {
    return null;
  }

  // The profile is "complete" when it says who and where the organisation is
  // beyond the name provisioning set: a contact address or an uploaded logo.
  // (`brand` always exists - provisioning writes default colours - so it
  // cannot distinguish a touched profile from an untouched one.)
  const profileDone = Boolean(
    profile.data?.contact?.address || profile.data?.logoUrl,
  );

  const items: ChecklistItem[] = [
    {
      id: 'profile',
      label: 'Complete your organisation profile',
      description: 'Your address and logo appear on released reports.',
      done: profileDone,
      to: '/app/settings',
      linkLabel: 'Open settings',
    },
    {
      id: 'team',
      label: 'Invite a teammate',
      description: 'Assessors and auditors carry out and check your work.',
      done: memberCount.data > 1,
      to: '/app/staff/invite',
      linkLabel: 'Invite staff',
    },
    {
      id: 'customer',
      label: 'Add a customer',
      description: 'Everything you assess belongs to a customer.',
      done: customersPresent.data,
      to: '/app/customers/new',
      linkLabel: 'New customer',
    },
    {
      id: 'building',
      label: 'Add a building',
      description: 'Buildings sit under a customer site, ready to assess.',
      done: buildings.data,
      to: '/app/customers',
      linkLabel: 'Open customers',
    },
    {
      id: 'job',
      label: 'Schedule a job',
      description: 'A job books an assessor into a building on a date.',
      done: jobsPresent.data,
      to: '/app/jobs/new',
      linkLabel: 'Schedule a job',
    },
    {
      id: 'assessment',
      label: 'Release your first assessment',
      description: 'Releasing sends the finished report to your customer.',
      done: releasesPresent.data,
      to: '/app/jobs',
      linkLabel: 'Open jobs',
    },
  ];

  const doneCount = items.filter((item) => item.done).length;

  // All done: the checklist has finished its job, so it leaves quietly.
  if (doneCount === items.length) {
    return null;
  }

  const expand = () => {
    setExpanded(true);
    writeExpanded(uid, true);
    focusTarget.current = 'panel';
  };

  /** Collapse back to the pill. Focus returns to the pill for keyboard-driven
   *  collapses (chevron, Escape); a tap on the mobile backdrop leaves focus
   *  where the tap put it. */
  const collapse = (returnFocus: boolean) => {
    setExpanded(false);
    writeExpanded(uid, false);
    setConfirmingHide(false);
    if (returnFocus) {
      focusTarget.current = 'pill';
    }
  };

  // Persisted so the choice follows the person across devices; hidden locally
  // at once so the click answers immediately. Best-effort: a failed write
  // costs one extra dismissal next visit, never an error surface.
  const dismiss = () => {
    setLocallyDismissed(true);
    update(ref(firebase.db(), consoleStatePath(uid)), {
      gettingStartedDismissed: true,
    }).catch(() => {});
  };

  // FIXED CONTRACT with the tour overlay (Phase 3 §7, workstream E3): the
  // overlay listens for exactly this event name to replay the tour. Do not
  // rename it here without renaming it there.
  const startTour = () => {
    window.dispatchEvent(new CustomEvent('safentia:start-tour'));
  };

  if (!expanded) {
    return (
      <button
        type="button"
        ref={pillRef}
        className={styles.pill}
        aria-expanded={false}
        onClick={expand}
      >
        <span>Getting started</span>
        <span className={styles.pillCount} aria-label={`${doneCount} of ${items.length} done`}>
          {doneCount}/{items.length}
        </span>
      </button>
    );
  }

  return (
    <>
      {/* Mobile-only scrim behind the bottom sheet (display:none on desktop):
          a tap outside collapses without stealing focus. */}
      <div
        className={styles.backdrop}
        aria-hidden="true"
        onClick={() => collapse(false)}
      />
      <div
        role="region"
        aria-label="Getting started"
        className={styles.panel}
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            collapse(true);
          }
        }}
      >
        <header className={styles.panelHeader}>
          <h2 className={styles.title}>Getting started</h2>
          <p className={styles.progress} role="status">
            {doneCount} of {items.length} done
          </p>
          <button
            type="button"
            className={styles.collapseButton}
            aria-expanded={true}
            aria-label="Collapse the checklist"
            onClick={() => collapse(true)}
          >
            <svg
              viewBox="0 0 12 12"
              className={styles.chevron}
              aria-hidden="true"
              focusable="false"
            >
              <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" strokeWidth="1.5" />
            </svg>
          </button>
        </header>
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id} className={styles.item}>
              <span
                className={item.done ? styles.tickDone : styles.tick}
                aria-hidden="true"
              >
                {item.done ? '✓' : ''}
              </span>
              <div className={styles.itemText}>
                <span className={item.done ? styles.labelDone : styles.label}>
                  <span className={styles.srOnly}>
                    {item.done ? 'Done: ' : 'To do: '}
                  </span>
                  {item.label}
                </span>
                <span className={styles.description}>{item.description}</span>
              </div>
              {!item.done && (
                <div className={styles.itemAction}>
                  <Button variant="ghost" to={item.to}>
                    {item.linkLabel}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <footer className={styles.footer}>
          {confirmingHide ? (
            // Two-step confirm: the hide is permanent (a consoleState write
            // that follows the person across devices), so one stray click must
            // never be enough.
            <div className={styles.confirmRow}>
              <span className={styles.confirmText}>
                Hide this checklist permanently?
              </span>
              <Button variant="ghost" onClick={dismiss}>
                Yes, hide it
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingHide(false)}>
                Keep it
              </Button>
            </div>
          ) : (
            <>
              <Button variant="ghost" onClick={startTour}>
                Take the tour
              </Button>
              <button
                type="button"
                className={styles.hideLink}
                onClick={() => setConfirmingHide(true)}
              >
                Hide forever
              </button>
            </>
          )}
        </footer>
      </div>
    </>
  );
}
