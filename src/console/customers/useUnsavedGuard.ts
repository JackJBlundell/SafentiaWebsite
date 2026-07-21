// ============================================================================
// useUnsavedGuard - one shared beforeunload guard for the multi-step wizards
// (customer, site, building, job scheduling).
//
// A wizard holds real typed-in work that only exists in component state until
// its commit lands, so an accidental tab close or hard back-navigation would
// silently discard it. While `dirty` is true this hook arms the browser's
// native leave confirmation; when it flips false (successful submit, or the
// wizard finishing and navigating away, which unmounts the caller) the
// listener is removed. Deliberately beforeunload ONLY: in-app react-router
// navigation is left unguarded because every wizard's Cancel/Back controls
// are intentional exits, and a blocking prompt on them is noise.
// ============================================================================

import { useEffect } from 'react';

/**
 * Arm the browser's leave-page confirmation while `dirty` is true. Call it
 * once per wizard (or per step component that owns unsubmitted field state);
 * multiple armed instances behave as one prompt.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome requires returnValue to be set for the prompt to show.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
