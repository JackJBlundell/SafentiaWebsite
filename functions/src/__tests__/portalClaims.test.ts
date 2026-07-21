// ============================================================================
// Unit tests for computePortalClaims (FR-E22, onCustomerMembershipChange).
//
// The properties that matter to the security boundary:
//  - an ACTIVE member yields {portalOrgId, customerId, customerRoles, testMode}
//    and NEVER an `orgId` key (staff rules key on token.orgId; its absence is
//    what locks portal tokens out of the staff console);
//  - locked / archived / deleted members yield null (claims removed entirely);
//  - role flags are allow-listed - a corrupted record cannot mint a role;
//  - testMode mirrors the environment root the record lives under, exactly as
//    the rules require ((token.testMode === true) === ($env === 'test')).
// ============================================================================

// claims.ts imports the admin singletons at module load; stub them so this
// stays a pure unit test with no SDK initialisation.
jest.mock('../admin', () => ({
  auth: { setCustomUserClaims: jest.fn() },
  db: { ref: jest.fn() },
}));

import { computePortalClaims } from '../lib/claims';
import type { CustomerMember } from '../shared/types';

/** Factory with sensible defaults so each test states only what it cares about
 *  (brief 18.2 "factories, not copy-pasted fixtures"). */
function member(partial: Partial<CustomerMember> = {}): CustomerMember {
  return {
    roles: { viewer: true },
    name: 'Pat Example',
    email: 'pat@example.com',
    status: 'active',
    ...partial,
  };
}

describe('computePortalClaims - portal claim shape (FR-E22)', () => {
  it('mints portalOrgId/customerId/customerRoles for an active member', () => {
    const claims = computePortalClaims(
      member({ roles: { admin: true, viewer: true } }),
      'org-1',
      'cust-1',
      'live',
    );
    expect(claims).toEqual({
      portalOrgId: 'org-1',
      customerId: 'cust-1',
      customerRoles: { admin: true, viewer: true },
    });
  });

  it('NEVER carries an orgId key (the staff-rules discriminator)', () => {
    const claims = computePortalClaims(member(), 'org-1', 'cust-1', 'live');
    expect(claims).not.toBeNull();
    expect(Object.keys(claims as object)).not.toContain('orgId');
  });

  it('binds testMode to the environment root, not to the record', () => {
    expect(
      computePortalClaims(member(), 'org-1', 'cust-1', 'test')?.testMode,
    ).toBe(true);
    expect(
      computePortalClaims(member(), 'org-1', 'cust-1', 'live'),
    ).not.toHaveProperty('testMode');
  });

  it.each(['locked', 'archived'] as const)(
    'resolves a %s member to null (claims removed)',
    (status) => {
      expect(
        computePortalClaims(member({ status }), 'org-1', 'cust-1', 'live'),
      ).toBeNull();
    },
  );

  it('resolves a deleted (null/undefined) record to null', () => {
    expect(computePortalClaims(null, 'org-1', 'cust-1', 'live')).toBeNull();
    expect(computePortalClaims(undefined, 'org-1', 'cust-1', 'test')).toBeNull();
  });

  it('allow-lists roles: unknown flags and non-true values are dropped', () => {
    const corrupted = member({
      roles: {
        admin: 'yes',
        assessor: true, // a STAFF role - not a customer role
        finance: true,
        'made-up': true,
      } as unknown as CustomerMember['roles'],
    });
    const claims = computePortalClaims(corrupted, 'org-1', 'cust-1', 'live');
    expect(claims?.customerRoles).toEqual({ finance: true });
  });

  it('normalises a missing/garbage role set to an empty one, never throwing', () => {
    const claims = computePortalClaims(
      member({ roles: 'admin' as unknown as CustomerMember['roles'] }),
      'org-1',
      'cust-1',
      'live',
    );
    expect(claims?.customerRoles).toEqual({});
  });
});
