// ============================================================================
// resolveClaims discrimination tests (FR-E22): a staff token resolves to a
// 'staff' session, a portal token ({portalOrgId, customerId, customerRoles})
// to a 'portal' session, and a token with neither to null. The compatibility
// surface matters too: portal sessions expose orgId (= portalOrgId) and an
// EMPTY staff role set so shared code's `claims.roles.admin` checks read false.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { IdTokenResult } from 'firebase/auth';
import { isPortalSession, resolveClaims } from './claims';

/** Fake an IdTokenResult carrying the given raw custom claims. */
function tokenWith(claims: Record<string, unknown>): IdTokenResult {
  return { claims } as unknown as IdTokenResult;
}

describe('resolveClaims - session discrimination (FR-E22)', () => {
  it('resolves a staff token to a staff session', () => {
    const session = resolveClaims(
      tokenWith({ orgId: 'org-1', roles: { admin: true }, testMode: true }),
    );
    expect(session).toEqual({
      kind: 'staff',
      orgId: 'org-1',
      roles: { admin: true },
      environment: 'test',
    });
    expect(session && isPortalSession(session)).toBe(false);
  });

  it('resolves a portal token to a portal session with the compatibility surface', () => {
    const session = resolveClaims(
      tokenWith({
        portalOrgId: 'org-1',
        customerId: 'cust-1',
        customerRoles: { admin: true, viewer: true },
      }),
    );
    expect(session).toEqual({
      kind: 'portal',
      orgId: 'org-1',
      customerId: 'cust-1',
      customerRoles: { admin: true, viewer: true },
      roles: {},
      environment: 'live',
    });
    expect(session && isPortalSession(session)).toBe(true);
    // The load-bearing compatibility guarantee: staff role checks read false.
    expect(session?.roles.admin).toBeUndefined();
  });

  it('binds the portal environment to the testMode claim', () => {
    const session = resolveClaims(
      tokenWith({
        portalOrgId: 'org-1',
        customerId: 'cust-1',
        customerRoles: {},
        testMode: true,
      }),
    );
    expect(session?.environment).toBe('test');
  });

  it('allow-lists portal roles: unknown flags and non-true values are dropped', () => {
    const session = resolveClaims(
      tokenWith({
        portalOrgId: 'org-1',
        customerId: 'cust-1',
        customerRoles: { admin: 'yes', assessor: true, finance: true },
      }),
    );
    expect(session?.kind).toBe('portal');
    expect(session?.customerRoles).toEqual({ finance: true });
  });

  it('returns null for a portal token missing its customerId', () => {
    expect(resolveClaims(tokenWith({ portalOrgId: 'org-1' }))).toBeNull();
  });

  it('returns null when the token carries no membership claims', () => {
    expect(resolveClaims(tokenWith({}))).toBeNull();
  });
});
