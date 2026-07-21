// ============================================================================
// reportClientError - the console's best-effort client-error telemetry.
//
// A caught render crash (the page ErrorBoundary) or an uncaught runtime error /
// unhandled rejection (the global window handlers below) is forwarded to the
// `reportClientError` callable, which logs it to Cloud Logging. It exists so a
// fault a user hit on site is diagnosable without them describing it.
//
// The one rule that governs everything here: TELEMETRY MUST NEVER CASCADE. Every
// path is wrapped so a failure to report can never surface as a second error on
// top of the first - the callable is fired and forgotten, and any throw (Firebase
// not started, an offline network, a rejected call) is swallowed. It also guards
// against loops: the same error is reported once, and a session is capped, so a
// component that re-throws on every render cannot flood the backend.
// ============================================================================

import { httpsCallable } from 'firebase/functions';
import { firebase } from '../../firebase';

/** The diagnostic shape sent to the callable. Mirrors its validated input; only
 *  `message` is required, the rest is best-effort context. */
export interface ClientErrorReport {
  message: string;
  stack?: string;
  componentStack?: string;
  path?: string;
}

/** Client-side ceilings, matched to the callable's so an over-long stack is
 *  trimmed here rather than rejected there (and a rejection would be swallowed
 *  anyway). */
const LIMITS = {
  message: 2000,
  stack: 8000,
  componentStack: 8000,
  path: 512,
} as const;

/** At most this many reports per page session: a component that throws on every
 *  render must not turn into a request flood. */
const MAX_REPORTS_PER_SESSION = 5;

let reportsSent = 0;
/** De-dupe key set (message + path): the same fault is reported once. */
const seen = new Set<string>();
/** The global window handlers are attached at most once (see the init below). */
let globalHandlersInstalled = false;

/** Trim to a ceiling, returning undefined for an empty/absent value so the
 *  callable receives clean optional fields rather than empty strings. */
function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

/**
 * Report a client-side error, best-effort. Never throws and never returns a
 * rejection: a telemetry failure is swallowed so it cannot cascade on top of the
 * error being reported. Repeats and floods are guarded (per-session cap + de-dupe).
 */
export function reportClientError(details: ClientErrorReport): void {
  try {
    const message = bounded(details.message, LIMITS.message);
    if (message === undefined) {
      return;
    }
    if (reportsSent >= MAX_REPORTS_PER_SESSION) {
      return;
    }
    const path = bounded(details.path, LIMITS.path);
    const dedupeKey = `${message}::${path ?? ''}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    reportsSent += 1;

    const payload: ClientErrorReport = { message };
    const stack = bounded(details.stack, LIMITS.stack);
    if (stack !== undefined) {
      payload.stack = stack;
    }
    const componentStack = bounded(details.componentStack, LIMITS.componentStack);
    if (componentStack !== undefined) {
      payload.componentStack = componentStack;
    }
    if (path !== undefined) {
      payload.path = path;
    }

    const call = httpsCallable<ClientErrorReport, { received: true }>(
      firebase.functions(),
      'reportClientError',
    );
    // Fire and forget: the caller does not await telemetry, and a rejection
    // (offline, unattested, rate limited) must die here, not propagate.
    void call(payload).catch(() => undefined);
  } catch {
    // The reporting path itself must never throw into the caller (e.g. Firebase
    // not yet initialised). Swallow and move on.
  }
}

/** The current in-app path, or undefined outside a browser. */
function currentPath(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

/**
 * Attach the process-wide error handlers ONCE. Idempotent: repeated calls (one
 * per ErrorBoundary mount) install the listeners a single time. Catches the
 * errors a React error boundary cannot - an uncaught error outside render and an
 * unhandled promise rejection - and routes them through the same best-effort sink.
 */
export function initGlobalErrorReporting(): void {
  if (globalHandlersInstalled || typeof window === 'undefined') {
    return;
  }
  globalHandlersInstalled = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    reportClientError({
      message: event.message || 'Uncaught error',
      stack: event.error instanceof Error ? event.error.stack : undefined,
      path: currentPath(),
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    reportClientError({
      message:
        reason instanceof Error
          ? reason.message
          : `Unhandled rejection: ${String(reason)}`,
      stack: reason instanceof Error ? reason.stack : undefined,
      path: currentPath(),
    });
  });
}
