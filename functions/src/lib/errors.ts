// ============================================================================
// Structured error handling (brief 4.5 / 18.3).
//
// Every Function returns the SafentiaError contract ({code, message, details})
// and NEVER a raw Firebase error. We build a SafentiaError internally, then map
// it onto a firebase-functions HttpsError at the boundary so the client receives
// the structured payload in HttpsError.details while still getting a real onCall
// error it can catch. The mapping is one-way and explicit: an unexpected throw is
// swallowed into a generic 'internal' error (with the real cause logged, never
// returned) so an implementation detail or a Firebase code can never leak to an
// assessor on site (brief 18.3).
// ============================================================================

import { HttpsError, FunctionsErrorCode } from 'firebase-functions/v2/https';
import type { SafentiaError, SafentiaErrorCode } from '../shared/types';
import type { Logger } from './logging';

/**
 * Our error class. Carrying the structured shape on a real Error means it can be
 * thrown through normal control flow and recognised at the boundary, while still
 * having a stack for server-side logging.
 */
export class SafentiaFunctionError extends Error implements SafentiaError {
  public readonly code: SafentiaErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: SafentiaErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SafentiaFunctionError';
    this.code = code;
    this.details = details;
  }

  /** The wire payload the client branches on. */
  toContract(): SafentiaError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

/** Terse constructors so call sites read as intent, not boilerplate. */
export const fail = {
  unauthenticated: (message = 'You are not signed in.', details?: Record<string, unknown>) =>
    new SafentiaFunctionError('unauthenticated', message, details),
  permissionDenied: (
    message = 'You do not have permission to do that.',
    details?: Record<string, unknown>,
  ) => new SafentiaFunctionError('permission-denied', message, details),
  appCheck: (
    message = 'This request could not be verified. Please update the app and try again.',
    details?: Record<string, unknown>,
  ) => new SafentiaFunctionError('app-check-failed', message, details),
  invalidArgument: (message: string, details?: Record<string, unknown>) =>
    new SafentiaFunctionError('invalid-argument', message, details),
  notFound: (message: string, details?: Record<string, unknown>) =>
    new SafentiaFunctionError('not-found', message, details),
  alreadyExists: (message: string, details?: Record<string, unknown>) =>
    new SafentiaFunctionError('already-exists', message, details),
  failedPrecondition: (message: string, details?: Record<string, unknown>) =>
    new SafentiaFunctionError('failed-precondition', message, details),
  resourceExhausted: (message: string, details?: Record<string, unknown>) =>
    new SafentiaFunctionError('resource-exhausted', message, details),
  internal: (
    message = 'Something went wrong on our side. Please try again shortly.',
    details?: Record<string, unknown>,
  ) => new SafentiaFunctionError('internal', message, details),
};

/** Map our structured code onto the matching onCall transport code. */
function toFunctionsCode(code: SafentiaErrorCode): FunctionsErrorCode {
  switch (code) {
    case 'unauthenticated':
      return 'unauthenticated';
    case 'permission-denied':
      return 'permission-denied';
    // App Check is a precondition of trust; surface it as failed-precondition on
    // the transport while keeping the precise 'app-check-failed' code in details.
    case 'app-check-failed':
      return 'failed-precondition';
    case 'invalid-argument':
      return 'invalid-argument';
    case 'not-found':
      return 'not-found';
    case 'already-exists':
      return 'already-exists';
    case 'failed-precondition':
      return 'failed-precondition';
    case 'resource-exhausted':
      return 'resource-exhausted';
    case 'internal':
      return 'internal';
    default:
      // Exhaustiveness guard: a new code added to the union without a mapping
      // becomes a compile error here rather than a silent 'internal' at runtime.
      return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled error code: ${String(value)}`);
}

/**
 * Convert a SafentiaFunctionError into the HttpsError the onCall runtime throws.
 * The structured contract travels in `details` so the client reads {code,message,
 * details} exactly as authored.
 */
function toHttpsError(error: SafentiaFunctionError): HttpsError {
  return new HttpsError(
    toFunctionsCode(error.code),
    error.message,
    error.toContract(),
  );
}

/**
 * The boundary wrapper every callable runs its body through. A SafentiaFunction
 * Error is mapped faithfully; anything else (a bug, a Firebase SDK throw) is
 * logged in full server-side and replaced with a generic 'internal' error so no
 * raw cause ever reaches the client (brief 18.3). RTDB triggers reuse the same
 * wrapper for the swallow-and-log behaviour, ignoring the return value.
 */
export async function runCallable<T>(
  logger: Logger,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (caught) {
    if (caught instanceof SafentiaFunctionError) {
      // Expected, structured failure: log at warning (it is part of normal
      // operation, e.g. a permission denial) and surface it faithfully.
      logger.warn('Callable rejected with structured error', {
        code: caught.code,
        // The message is safe (authored British-English copy); details may carry
        // a field name but never PII by construction.
        errorMessage: caught.message,
      });
      throw toHttpsError(caught);
    }
    // Unexpected: capture everything we can server-side, return nothing useful to
    // the caller. We never put `caught` in the client payload.
    logger.error('Callable threw an unexpected error', {
      errorName: caught instanceof Error ? caught.name : typeof caught,
      errorMessage: caught instanceof Error ? caught.message : String(caught),
      stack: caught instanceof Error ? caught.stack : undefined,
    });
    throw toHttpsError(fail.internal());
  }
}

/**
 * Trigger-side equivalent: triggers cannot return an error to a client, so a
 * failure is logged and rethrown to mark the invocation failed (which lets the
 * platform retry per the trigger's policy). It still scrubs unexpected causes
 * from any place they might be surfaced.
 */
export function logTriggerError(logger: Logger, caught: unknown): void {
  if (caught instanceof SafentiaFunctionError) {
    logger.error('Trigger failed with structured error', {
      code: caught.code,
      errorMessage: caught.message,
    });
    return;
  }
  logger.error('Trigger threw an unexpected error', {
    errorName: caught instanceof Error ? caught.name : typeof caught,
    errorMessage: caught instanceof Error ? caught.message : String(caught),
    stack: caught instanceof Error ? caught.stack : undefined,
  });
}
