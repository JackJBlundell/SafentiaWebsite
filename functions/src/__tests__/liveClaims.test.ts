// ============================================================================
// getLiveClaims (security fix): a staff callable must authorise from the LIVE
// orgMembers record, not the (up to an hour stale) ID token. A locked member
// is refused outright, and a role revoked in the record is dropped even while
// the token still carries it.
// ============================================================================

const mockDbData: Record<string, unknown> = {};

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      get: async () => ({ val: () => (path in mockDbData ? mockDbData[path] : null) }),
    }),
  },
}));

import type { CallableRequest } from 'firebase-functions/v2/https';
import { getLiveClaims } from '../lib/guards';
import { forEnv } from '../lib/paths';
import { SafentiaFunctionError } from '../lib/errors';

const ORG = 'org-1';
const UID = 'user-1';

const seed = (nodes: Record<string, unknown>) => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  Object.assign(mockDbData, nodes);
};

const req = (token: Record<string, unknown>, uid: string | null = UID): CallableRequest =>
  ({ auth: uid ? { uid, token } : undefined, data: {} }) as unknown as CallableRequest;

async function expectDenied(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error('expected a refusal');
  } catch (error) {
    expect(error).toBeInstanceOf(SafentiaFunctionError);
    expect((error as SafentiaFunctionError).code).toBe(code);
  }
}

describe('getLiveClaims', () => {
  it('returns the LIVE roles for an active member', async () => {
    seed({
      [forEnv('live').db.orgMember(ORG, UID)]: { status: 'active', roles: { admin: true, assessor: true } },
    });
    const claims = await getLiveClaims(req({ orgId: ORG, roles: { admin: true, assessor: true } }));
    expect(claims.orgId).toBe(ORG);
    expect(claims.roles).toEqual({ admin: true, assessor: true });
  });

  it('rejects a LOCKED member even though the token still carries roles', async () => {
    seed({
      [forEnv('live').db.orgMember(ORG, UID)]: { status: 'locked', roles: { admin: true } },
    });
    await expectDenied(getLiveClaims(req({ orgId: ORG, roles: { admin: true } })), 'permission-denied');
  });

  it('rejects an archived member', async () => {
    seed({
      [forEnv('live').db.orgMember(ORG, UID)]: { status: 'archived', roles: { admin: true } },
    });
    await expectDenied(getLiveClaims(req({ orgId: ORG, roles: { admin: true } })), 'permission-denied');
  });

  it('rejects a removed member (no record at all)', async () => {
    seed({});
    await expectDenied(getLiveClaims(req({ orgId: ORG, roles: { admin: true } })), 'permission-denied');
  });

  it('drops a role revoked in the record even while the token still has it', async () => {
    seed({
      [forEnv('live').db.orgMember(ORG, UID)]: { status: 'active', roles: { assessor: true } },
    });
    const claims = await getLiveClaims(req({ orgId: ORG, roles: { admin: true, assessor: true } }));
    expect(claims.roles.admin).toBeUndefined();
    expect(claims.roles).toEqual({ assessor: true });
  });

  it('never grants a role the record lacks and ignores non-true / unknown role values', async () => {
    seed({
      [forEnv('live').db.orgMember(ORG, UID)]: {
        status: 'active',
        roles: { admin: 'yes', superAdmin: true, viewer: true },
      },
    });
    const claims = await getLiveClaims(req({ orgId: ORG, roles: { viewer: true } }));
    expect(claims.roles).toEqual({ viewer: true });
  });

  it('reads the TEST-root record for a testMode token', async () => {
    seed({
      [forEnv('test').db.orgMember(ORG, UID)]: { status: 'active', roles: { auditor: true } },
      // A live record that would grant admin must NOT be consulted.
      [forEnv('live').db.orgMember(ORG, UID)]: { status: 'active', roles: { admin: true } },
    });
    const claims = await getLiveClaims(req({ orgId: ORG, roles: { admin: true }, testMode: true }));
    expect(claims.testMode).toBe(true);
    expect(claims.roles).toEqual({ auditor: true });
  });

  it('rejects an unauthenticated request', async () => {
    seed({});
    await expectDenied(getLiveClaims(req({}, null)), 'unauthenticated');
  });
});
