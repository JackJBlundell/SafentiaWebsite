// ============================================================================
// acceptReport role gate - who may accept and sign off a released report.
//
// Product decision: a customer `admin` or `finance` contact may sign for the
// customer, a `viewer` may not (they still read and download once someone
// entitled has accepted). Pinned at two levels:
//   - portalRoleMayAccept: the role table in isolation, including the empty /
//     malformed role sets that must be judged as the least-privileged seat.
//   - the callable end to end over a fake RTDB, so the gate is proven to be
//     WIRED to the live /customerMembers seat (not the token) and to refuse
//     before the acceptance transaction can ever run.
// admin is stubbed with an in-memory store, so the test needs no SDK init.
// ============================================================================

const mockStore: Record<string, unknown> = {};

jest.mock('../admin', () => ({
  db: {
    ref: (path?: string) => ({
      get: async () => ({
        val: () => (path !== undefined && path in mockStore ? mockStore[path] : null),
      }),
      // The real transaction runs the callback against the node's current value;
      // returning undefined aborts. Both the rate limiter and the acceptance
      // claim rely on exactly that contract.
      transaction: async (update: (current: unknown) => unknown) => {
        const key = path ?? '';
        const current = key in mockStore ? mockStore[key] : null;
        const next = update(current);
        if (next === undefined) {
          return { committed: false, snapshot: { val: () => current } };
        }
        mockStore[key] = next;
        return { committed: true, snapshot: { val: () => next } };
      },
      // activityUpdate mints the audit entry's id from a push key.
      push: () => ({ key: 'activity-key' }),
      update: async (values: Record<string, unknown>) => {
        Object.assign(mockStore, values);
      },
    }),
  },
  auth: {},
  storage: {},
}));

import type { CallableRequest } from 'firebase-functions/v2/https';
import { acceptReport, portalRoleMayAccept } from '../functions/acceptReport';
import { forEnv } from '../lib/paths';
import type {
  AcceptReportInput,
  CustomerMember,
  CustomerRoleSet,
} from '../shared/types';

const env = forEnv('test');
const ORG = 'org-1';
const CUSTOMER = 'cust-1';
const BUILDING = 'b-1';
const REPORT = 'r-1';
const UID = 'portal-uid';
const ACCEPTANCE_PATH = `${env.db.report(ORG, 'building', BUILDING, REPORT)}/acceptance`;

/** Seed a building owned by the caller's customer, a released report with no
 *  acceptance yet, and the caller's LIVE seat carrying `roles`. */
const seed = (roles: CustomerRoleSet | undefined) => {
  for (const key of Object.keys(mockStore)) delete mockStore[key];
  const seat = { status: 'active', roles } as unknown as CustomerMember;
  Object.assign(mockStore, {
    [env.db.buildingCustomer(ORG, BUILDING)]: CUSTOMER,
    [env.db.customerMember(ORG, CUSTOMER, UID)]: seat,
    [env.db.report(ORG, 'building', BUILDING, REPORT)]: {
      pdfPath: 'test/orgs/org-1/reports/r-1.pdf',
      generatedAt: 1,
    },
  });
};

/** A portal request as the onCall runtime hands it over. The TOKEN claims the
 *  most privileged role on purpose: the gate must judge the live seat, so a
 *  stale admin token cannot carry a since-demoted viewer past it. */
const request = (): CallableRequest<AcceptReportInput> =>
  ({
    app: { appId: 'app' },
    auth: {
      uid: UID,
      token: {
        portalOrgId: ORG,
        customerId: CUSTOMER,
        customerRoles: { admin: true },
        testMode: true,
      },
    },
    data: { buildingId: BUILDING, reportId: REPORT, name: 'Pat Contact' },
  }) as unknown as CallableRequest<AcceptReportInput>;

const run = () => acceptReport.run(request());

describe('portalRoleMayAccept', () => {
  it('admits a customer admin and a finance contact', () => {
    expect(portalRoleMayAccept({ admin: true })).toBe(true);
    expect(portalRoleMayAccept({ finance: true })).toBe(true);
    // The union model: any one entitled role is enough.
    expect(portalRoleMayAccept({ viewer: true, finance: true })).toBe(true);
  });

  it('refuses a viewer', () => {
    expect(portalRoleMayAccept({ viewer: true })).toBe(false);
  });

  it('judges an empty or malformed role set as a viewer', () => {
    expect(portalRoleMayAccept(undefined)).toBe(false);
    expect(portalRoleMayAccept({})).toBe(false);
    // Only a literal `true` asserts a role.
    expect(
      portalRoleMayAccept({ admin: 'yes' } as unknown as CustomerRoleSet),
    ).toBe(false);
  });
});

describe('acceptReport role gate (end to end)', () => {
  it('denies a viewer and records no acceptance', async () => {
    seed({ viewer: true });
    await expect(run()).rejects.toMatchObject({
      code: 'permission-denied',
      message:
        'Only a customer administrator or finance contact can accept this report.',
    });
    expect(mockStore[ACCEPTANCE_PATH]).toBeUndefined();
  });

  it('denies a seat with no roles at all', async () => {
    seed({});
    await expect(run()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mockStore[ACCEPTANCE_PATH]).toBeUndefined();
  });

  it('accepts for a finance contact, attributed to the verified uid', async () => {
    seed({ finance: true });
    const result = await run();
    expect(typeof result.acceptedAt).toBe('number');
    expect(mockStore[ACCEPTANCE_PATH]).toMatchObject({
      name: 'Pat Contact',
      byUid: UID,
    });
  });

  it('accepts for a customer admin', async () => {
    seed({ admin: true });
    await expect(run()).resolves.toMatchObject({
      acceptedAt: expect.any(Number),
    });
    expect(mockStore[ACCEPTANCE_PATH]).toMatchObject({ byUid: UID });
  });
});
