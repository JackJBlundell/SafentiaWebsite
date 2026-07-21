// ============================================================================
// Session building blocks: claim resolution and error mapping.
//
// These are the two pieces of the auth layer with real decision logic - the
// provider itself is thin plumbing over the Firebase SDK and is exercised
// through the sign-in screen tests (login.test.tsx). What matters here:
//   - claims: the allow-list means an unexpected claim can never widen a role;
//   - errors: credential failures collapse to ONE message (non-enumerating).
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { IdTokenResult } from 'firebase/auth';
import { resolveClaims, rolesSummary } from './claims';
import { authErrorMessage } from './errors';

/** Shape a raw claims object into the IdTokenResult the resolver reads. Only
 *  `.claims` is consulted, so the rest of the result is irrelevant here. */
function tokenResult(claims: Record<string, unknown>): IdTokenResult {
  return { claims } as unknown as IdTokenResult;
}

describe('resolveClaims', () => {
  it('resolves a full membership claim into a typed staff session', () => {
    const session = resolveClaims(
      tokenResult({
        orgId: 'org-123',
        roles: { admin: true, assessor: true },
        testMode: true,
      }),
    );
    expect(session).toEqual({
      kind: 'staff',
      orgId: 'org-123',
      roles: { admin: true, assessor: true },
      environment: 'test',
    });
  });

  it('returns null when there is no org claim (no membership yet)', () => {
    expect(resolveClaims(tokenResult({}))).toBeNull();
    expect(resolveClaims(tokenResult({ orgId: 42 }))).toBeNull();
  });

  it('drops role keys outside the allow-list and non-true values', () => {
    const session = resolveClaims(
      tokenResult({
        orgId: 'org-123',
        // superuser is not an ORG_ROLE; viewer: 'yes' is not the literal true.
        roles: { superuser: true, viewer: 'yes', auditor: true },
      }),
    );
    expect(session?.roles).toEqual({ auditor: true });
  });

  it('defaults to the live environment when testMode is absent', () => {
    const session = resolveClaims(tokenResult({ orgId: 'org-123' }));
    expect(session?.environment).toBe('live');
  });
});

describe('rolesSummary', () => {
  it('joins held roles and reads "none" for an empty set', () => {
    expect(rolesSummary({ admin: true, viewer: true })).toBe('admin+viewer');
    expect(rolesSummary({})).toBe('none');
  });
});

describe('authErrorMessage', () => {
  it('collapses every credential failure to one non-enumerating message', () => {
    const codes = [
      'auth/invalid-credential',
      'auth/user-not-found',
      'auth/wrong-password',
      'auth/invalid-email',
    ];
    const messages = new Set(codes.map((code) => authErrorMessage({ code })));
    // One message for all four: a caller cannot tell "no such user" apart from
    // "wrong password", so the form cannot be used to probe for accounts.
    expect(messages.size).toBe(1);
    const [message] = messages;
    expect(message).toBe(
      'Those sign-in details were not recognised. Check your email and password and try again.',
    );
    expect(message).not.toMatch(/auth\//);
  });

  it('falls back to safe generic copy for unknown codes and non-errors', () => {
    const fallback = 'Something went wrong signing you in. Please try again.';
    expect(authErrorMessage({ code: 'auth/some-new-code' })).toBe(fallback);
    expect(authErrorMessage(undefined)).toBe(fallback);
    expect(authErrorMessage(new Error('raw SDK text'))).toBe(fallback);
  });
});
