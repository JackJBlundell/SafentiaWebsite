// ============================================================================
// reportClientError (callable, any authenticated caller) - web telemetry.
//
// The console's error boundary and its global window handlers report a caught
// render/runtime crash here so a fault a user hit on site is diagnosable without
// them describing it. This is a TELEMETRY SINK, not a data write: it does NOT
// touch RTDB and creates no node - the report is emitted to Cloud Logging via the
// structured logger, and alerting is configured on the logging side (a log-based
// metric + alert policy), never in this function.
//
// It gates on App Check and auth only, deliberately not on org claims: a portal
// user (who carries a customerId and NO orgId) can crash a page too, and losing
// their telemetry to a permission gate would defeat the point. Whatever org or
// customer context the caller's token carries is attached softly for grouping.
// Per-user rate limiting backstops a stuck client; the client caps itself as well.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth } from '../lib/guards';
import { assertObject, optionalString, requireString } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';

/** The validated shape a client report reduces to. Only `message` is required;
 *  the stack fields and originating path are best-effort diagnostic context. */
export interface ReportClientErrorInput {
  message: string;
  stack?: string;
  componentStack?: string;
  path?: string;
}

/** Length ceilings for a client report. A message is a single error line; a
 *  stack or React component stack can be several frames, so those are roomier;
 *  a path is an in-app route, never a full URL. Bounded so no client can push an
 *  unbounded blob into the logs. */
const REPORT_LIMITS = {
  message: 2000,
  stack: 8000,
  componentStack: 8000,
  path: 512,
} as const;

/** C0 control characters minus the ones a real stack legitimately contains
 *  (tab, newline, carriage return). Rejecting the rest closes the log-injection
 *  vector (a NUL or ESC smuggled into a log line). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function rejectControlChars(value: string, field: string): string {
  if (CONTROL_CHARS.test(value)) {
    throw fail.invalidArgument(
      `The ${field} field contains unsupported characters.`,
      { field },
    );
  }
  return value;
}

/**
 * Validate a raw client-error payload into the typed report, or reject. Extracted
 * as a pure function so the validation contract is unit-testable without invoking
 * the callable (see __tests__/reportClientError.test.ts). Reject, never coerce
 * (brief 18.4): a missing message, an over-long field or an embedded control
 * character is a structured 'invalid-argument' naming the field.
 */
export function parseReportClientErrorInput(data: unknown): ReportClientErrorInput {
  const input = assertObject(data);
  const result: ReportClientErrorInput = {
    message: rejectControlChars(
      requireString(input, 'message', REPORT_LIMITS.message),
      'message',
    ),
  };
  const stack = optionalString(input, 'stack', REPORT_LIMITS.stack);
  if (stack !== undefined) {
    result.stack = rejectControlChars(stack, 'stack');
  }
  const componentStack = optionalString(
    input,
    'componentStack',
    REPORT_LIMITS.componentStack,
  );
  if (componentStack !== undefined) {
    result.componentStack = rejectControlChars(componentStack, 'componentStack');
  }
  const path = optionalString(input, 'path', REPORT_LIMITS.path);
  if (path !== undefined) {
    result.path = rejectControlChars(path, 'path');
  }
  return result;
}

export const reportClientError = onCall<unknown>(callableOptions, (request) => {
  const log = createLogger({ fn: 'reportClientError' });
  return runCallable<{ received: true }>(log, async () => {
    // 1. Attestation and identity. App Check and auth only - no claims gate, so
    // both staff and portal callers can report (see the header).
    assertAppCheck(request);
    const { uid } = assertAuth(request);
    await assertRateLimit(uid, 'reportClientError');

    // 2. Validate the small payload before it reaches a log line.
    const report = parseReportClientErrorInput(request.data);

    // 3. Attach whatever tenant context the token carries, softly: a staff token
    // has orgId, a portal token has customerId, and either may be absent on a
    // not-yet-onboarded account. None of these are required to record the report.
    const token = request.auth?.token;
    const orgId = typeof token?.orgId === 'string' ? token.orgId : undefined;
    const customerId =
      typeof token?.customerId === 'string' ? token.customerId : undefined;

    // 4. Emit to Cloud Logging at ERROR. The logger scrubs any email/token that
    // leaked into a message or stack (lib/logging), so a careless client cannot
    // put PII into the audit sink.
    const scoped = log.child({
      ...(orgId ? { orgId } : {}),
      ...(customerId ? { customerId } : {}),
    });
    scoped.error('Client-side error reported', {
      uid,
      path: report.path,
      clientMessage: report.message,
      stack: report.stack,
      componentStack: report.componentStack,
    });
    return { received: true };
  });
});
