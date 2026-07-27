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
import type { SafentiaErrorCode } from '../../types';

/** The structured details a Safentia callable attaches to a rejection: the
 *  SafentiaError contract, carried inside HttpsError.details. */
interface SafentiaErrorDetails {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** The whole of a rejection, as a screen may need to branch on it. `message` is
 *  always populated (the generic fallback when the server sent nothing safe);
 *  `code` and `details` are present only when the failure came through our own
 *  runCallable wrapper rather than the transport. */
export interface CallableFailure {
  code: SafentiaErrorCode | null;
  message: string;
  details: Record<string, unknown> | null;
}

const SAFENTIA_ERROR_CODES: readonly SafentiaErrorCode[] = [
  'unauthenticated',
  'permission-denied',
  'app-check-failed',
  'invalid-argument',
  'not-found',
  'already-exists',
  'failed-precondition',
  'resource-exhausted',
  'internal',
];

/** Parse a callable rejection into the structured shape our Functions author.
 *  Anything unrecognised degrades to the generic message with no code, so a
 *  transport-level failure can never be mistaken for a domain outcome. */
export function callableErrorInfo(error: unknown): CallableFailure {
  let code: SafentiaErrorCode | null = null;
  let message: string | null = null;
  let details: Record<string, unknown> | null = null;

  if (typeof error === 'object' && error !== null) {
    const withDetails = error as { details?: SafentiaErrorDetails; message?: string };
    const contract = withDetails.details;
    if (contract && typeof contract === 'object') {
      const rawCode = contract.code;
      if (
        typeof rawCode === 'string' &&
        (SAFENTIA_ERROR_CODES as readonly string[]).includes(rawCode)
      ) {
        code = rawCode as SafentiaErrorCode;
      }
      if (contract.details && typeof contract.details === 'object') {
        details = contract.details;
      }
    }
    // Our runCallable wrapper returns its copy via the HttpsError message, and
    // richer context under details. Prefer the structured detail.
    const copy = contract?.message ?? withDetails.message;
    if (typeof copy === 'string' && copy.length > 0 && !/^internal$/i.test(copy)) {
      message = copy;
    }
  }

  return {
    code,
    message: message ?? 'Something went wrong. Please try again.',
    details,
  };
}

/** Extract the safe, human-readable message from a callable rejection. Our
 *  Functions put calm copy in `message`; anything else collapses to a generic. */
export function callableErrorMessage(error: unknown): string {
  return callableErrorInfo(error).message;
}

export interface CallableState<TInput, TResult> {
  call: (input: TInput) => Promise<TResult | null>;
  pending: boolean;
  /** The last failure's user-safe copy; cleared on the next call. */
  error: string | null;
  /** The same failure structured, for screens that branch on the code or the
   *  reason rather than showing one message. Always set whenever `error` is. */
  failure: CallableFailure | null;
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
  // The structured failure is the single source of truth; `error` is derived
  // from it, so the two can never disagree about the last outcome.
  const [failure, setFailure] = useState<CallableFailure | null>(null);
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
      setFailure(null);
      try {
        const fn = httpsCallable<TInput, TResult>(firebase.functions(), name);
        const response = await fn(input);
        return response.data;
      } catch (caught) {
        setFailure(callableErrorInfo(caught));
        return null;
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [name],
  );

  const clearError = useCallback(() => setFailure(null), []);

  return { call, pending, error: failure?.message ?? null, failure, clearError };
}
