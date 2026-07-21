// ============================================================================
// useCallable - the one way console screens invoke Cloud Functions.
//
// Wraps httpsCallable with the pieces every call needs and no screen should
// re-implement: the typed contract from ../types, pending state, and mapping of
// the structured Safentia error shape (functions/src/lib/errors) into calm
// British-English copy. Raw Firebase error strings never reach the screen.
//
// Kept deliberately smaller than a data library: mutations here always reflect
// back through the live RTDB listeners (CONVENTIONS section 2), so there is no
// response-cache to manage - only the in-flight state and the error.
// ============================================================================

import { useCallback, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { firebase } from '../../firebase';

/** The structured details a Safentia callable attaches to a rejection. */
interface SafentiaErrorDetails {
  code?: string;
  message?: string;
}

/** Extract the safe, human-readable message from a callable rejection. Our
 *  Functions put calm copy in `message`; anything else collapses to a generic. */
export function callableErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const withDetails = error as { details?: SafentiaErrorDetails; message?: string };
    // Our runCallable wrapper returns its copy via the HttpsError message, and
    // richer context under details. Prefer the structured detail.
    const detail = withDetails.details?.message ?? withDetails.message;
    if (typeof detail === 'string' && detail.length > 0 && !/^internal$/i.test(detail)) {
      return detail;
    }
  }
  return 'Something went wrong. Please try again.';
}

export interface CallableState<TInput, TResult> {
  call: (input: TInput) => Promise<TResult | null>;
  pending: boolean;
  /** The last failure's user-safe copy; cleared on the next call. */
  error: string | null;
  clearError: () => void;
}

/**
 * A typed handle on one callable. `call` resolves with the result, or null on
 * failure (the error is exposed on state for the screen to render); it never
 * throws, so call sites read as straight-line code.
 */
export function useCallable<TInput, TResult>(
  name: string,
): CallableState<TInput, TResult> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One in-flight call at a time per handle: a double-click on a submit button
  // must not fire the mutation twice.
  const inFlight = useRef(false);

  const call = useCallback(
    async (input: TInput): Promise<TResult | null> => {
      if (inFlight.current) {
        return null;
      }
      inFlight.current = true;
      setPending(true);
      setError(null);
      try {
        const fn = httpsCallable<TInput, TResult>(firebase.functions(), name);
        const response = await fn(input);
        return response.data;
      } catch (caught) {
        setError(callableErrorMessage(caught));
        return null;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [name],
  );

  const clearError = useCallback(() => setError(null), []);

  return { call, pending, error, clearError };
}
