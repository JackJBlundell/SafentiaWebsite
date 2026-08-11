// ============================================================================
// useTourTrigger - when the guided tour shows, and what closing it records.
//
// Shown ONCE per device class (plan §5.6): the desktop rail and the mobile
// top bar are different enough chromes that walking one does not teach the
// other, so `tourDone.desktop` and `tourDone.mobile` are separate flags.
// First run starts a breath after the shell mounts; completing OR skipping
// writes the flag for the class the user is on at that moment.
//
// Replay: the Getting Started card dispatches `safentia:start-tour` (a fixed
// contract with that workstream), which starts the tour regardless of the
// flags; the flag is only rewritten when that run is completed or skipped.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { DESKTOP_MEDIA_QUERY } from './tourSteps';
import { createTourStorage, type TourDeviceClass } from './tourStorage';

/** The replay event name - the Getting Started card dispatches exactly this. */
export const START_TOUR_EVENT = 'safentia:start-tour';

/** A settle delay after mount, so the tour never opens over a page still
 *  painting its first data. The targets are chrome and exist immediately;
 *  this is about calm, not correctness. */
const FIRST_RUN_DELAY_MS = 1200;

/** When the tour shipped (2026-08-07, UTC). Accounts created before this date
 *  already know the console, so the tour never auto-starts for them - being
 *  walked through chrome they use daily reads as noise, not help. The replay
 *  event still works for everyone. */
const TOUR_LAUNCHED_AT_MS = Date.UTC(2026, 7, 7);

/** True when the signed-in account provably predates the tour feature. An
 *  unreadable creation time counts as new - the worst case is one skippable
 *  tour, never a silent no-show for a genuinely new person. */
function predatesTour(creationTime: string | undefined): boolean {
  if (!creationTime) return false;
  const createdAt = Date.parse(creationTime);
  return Number.isFinite(createdAt) && createdAt < TOUR_LAUNCHED_AT_MS;
}

function deviceClass(): TourDeviceClass {
  return typeof window.matchMedia === 'function' &&
    window.matchMedia(DESKTOP_MEDIA_QUERY).matches
    ? 'desktop'
    : 'mobile';
}

export function useTourTrigger(): { active: boolean; close: () => void } {
  const { user } = useAuth();
  const uid = user?.uid;
  const storage = useMemo(() => (uid ? createTourStorage(uid) : null), [uid]);
  const [active, setActive] = useState(false);

  // First run: read the flags after the settle delay; start unless THIS device
  // class has already seen the tour. Cancelled cleanly on unmount, so a quick
  // route away never starts an orphaned overlay.
  useEffect(() => {
    if (!storage) {
      return;
    }
    let cancelled = false;
    const createdBeforeTour = predatesTour(user?.metadata?.creationTime);
    const timer = window.setTimeout(() => {
      void storage.read().then((done) => {
        if (cancelled || done?.[deviceClass()] === true) {
          return;
        }
        if (createdBeforeTour) {
          // Record the suppression as seen for this device class, so the
          // read above short-circuits every later visit.
          void storage.markDone(deviceClass());
          return;
        }
        setActive(true);
      });
    }, FIRST_RUN_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `user` only matters through the uid (already in `storage`) and the
    // immutable creationTime, so storage remains the honest dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage]);

  // Replay on demand, done flag or not.
  useEffect(() => {
    const onStart = () => setActive(true);
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, []);

  const close = useCallback(() => {
    setActive(false);
    // Completing and skipping both count as seen, for the class whose chrome
    // this run walked (measured NOW - the user may have crossed the
    // breakpoint mid-tour, and the class on screen is the one they finished).
    void storage?.markDone(deviceClass());
  }, [storage]);

  return { active, close };
}
