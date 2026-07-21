// ============================================================================
// reportClientError input-validation unit tests (web telemetry).
//
// The callable itself is an onCall wrapper (attestation, auth, rate limit, then
// a Cloud Logging emit), so its contract-critical, testable-in-isolation part is
// the payload validator: only `message` is required, every field is length
// bounded, and embedded control characters are rejected so nothing can inject a
// forged line into the logs. admin is stubbed so importing the module (which
// pulls in the rate-limit lib) stays a pure unit test with no SDK init.
// ============================================================================

jest.mock('../admin', () => ({
  db: { ref: jest.fn() },
  auth: {},
  storage: {},
}));

import { parseReportClientErrorInput } from '../functions/reportClientError';
import { SafentiaFunctionError } from '../lib/errors';

describe('parseReportClientErrorInput', () => {
  it('accepts a minimal payload of just a message', () => {
    const result = parseReportClientErrorInput({ message: 'boom' });
    expect(result).toEqual({ message: 'boom' });
  });

  it('carries the optional stack, componentStack and path through', () => {
    const result = parseReportClientErrorInput({
      message: 'Cannot read properties of undefined',
      stack: 'Error: boom\n  at Foo (Foo.tsx:1:1)',
      componentStack: '\n  in Foo\n  in ErrorBoundary',
      path: '/app/jobs',
    });
    expect(result).toEqual({
      message: 'Cannot read properties of undefined',
      stack: 'Error: boom\n  at Foo (Foo.tsx:1:1)',
      componentStack: 'in Foo\n  in ErrorBoundary',
      path: '/app/jobs',
    });
  });

  it('rejects a missing message', () => {
    expect(() => parseReportClientErrorInput({})).toThrow(SafentiaFunctionError);
    expect(() => parseReportClientErrorInput({ stack: 'only a stack' })).toThrow(
      /message field is required/,
    );
  });

  it('rejects a non-object payload', () => {
    expect(() => parseReportClientErrorInput(null)).toThrow(SafentiaFunctionError);
    expect(() => parseReportClientErrorInput('boom')).toThrow(
      SafentiaFunctionError,
    );
  });

  it('rejects an over-long message', () => {
    const tooLong = 'x'.repeat(2001);
    expect(() => parseReportClientErrorInput({ message: tooLong })).toThrow(
      /message field is too long/,
    );
  });

  it('rejects a control character smuggled into the message', () => {
    expect(() =>
      parseReportClientErrorInput({ message: 'boom\u0007injected' }),
    ).toThrow(/unsupported characters/);
  });

  it('allows tab/newline in a stack but rejects a NUL', () => {
    expect(() =>
      parseReportClientErrorInput({
        message: 'boom',
        stack: 'Error\n\tat x',
      }),
    ).not.toThrow();
    expect(() =>
      parseReportClientErrorInput({
        message: 'boom',
        stack: 'Error\u0000at x',
      }),
    ).toThrow(/unsupported characters/);
  });
});
