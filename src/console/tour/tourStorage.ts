// ============================================================================
// tourStorage - where "this person has seen the tour" lives.
//
// The tour is shown once per DEVICE CLASS (desktop and mobile are different
// enough chromes that seeing one does not teach the other), so the record is
// { desktop?: boolean; mobile?: boolean } per plan §5.6.
//
// The durable home is the per-user `consoleState/{uid}` RTDB node (owner
// read/write; established with the Getting Started checklist), so the flag
// follows the person across devices of the same class. The tour talks to this
// thin TourStorage seam so the backing store could move again without touching
// the overlay or the trigger. A read failure is treated as unrecorded and a
// write failure is swallowed: the worst case either way is the tour showing
// again, which is calm and skippable - never worth an error surface.
// ============================================================================

import { get, ref, update } from 'firebase/database';
import { firebase } from '../../firebase';
import { consoleState } from '../../paths';
import type { ConsoleState } from '../../types';

export type TourDeviceClass = 'desktop' | 'mobile';

export interface TourDone {
  desktop?: boolean;
  mobile?: boolean;
}

export interface TourStorage {
  /** The flags as last persisted; null when nothing is recorded yet. */
  read(): Promise<TourDone | null>;
  /** Records the tour as seen for one device class, leaving the other alone. */
  markDone(device: TourDeviceClass): Promise<void>;
}

export function createTourStorage(uid: string): TourStorage {
  return {
    async read() {
      try {
        const snapshot = await get(ref(firebase.db(), consoleState(uid)));
        const value = snapshot.val() as ConsoleState | null;
        const done = value?.tourDone;
        if (!done) {
          return null;
        }
        return {
          desktop: done.desktop === true || undefined,
          mobile: done.mobile === true || undefined,
        };
      } catch {
        return null;
      }
    },
    async markDone(device) {
      try {
        // Nested-path update touches only this class's flag, so desktop and
        // mobile never clobber one another (and neither disturbs the Getting
        // Started keys living beside tourDone on the same node).
        await update(ref(firebase.db(), consoleState(uid)), {
          [`tourDone/${device}`]: true,
        });
      } catch {
        // Nothing to do: the flag simply does not stick this session.
      }
    },
  };
}
