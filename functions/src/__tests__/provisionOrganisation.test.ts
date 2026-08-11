// ============================================================================
// provisionOrganisation - the shared atomic org bootstrap (Phase 3).
//
// Pins the contract both founding paths rely on: the bootstrap is ONE
// multi-location update carrying profile + usage + membership + login index
// (+ subscription snapshot and customer reverse index when present) + the
// audit entry; self-serve provisioning is idempotent per Stripe subscription
// id via the ops/provisionedSubs marker (a re-entry returns the stored orgId,
// never bootstraps a second org, and resumes the idempotent claims tail when
// the marker shows the bootstrap committed); the operator path (empty
// subscription) skips the marker entirely. Failure handling splits at the
// bootstrap commit: a PRE-commit failure RELEASES the claim so a webhook
// retry reprovisions from scratch, while a TAIL failure (after the commit)
// KEEPS the marker so the retry returns the SAME org instead of minting a
// duplicate. firebase-admin and the claims lib are mocked so the suite stays
// a pure unit test (templatedEmail pattern).
// ============================================================================

import { forEnv, ops } from '../lib/paths';
import { computeClaims, writeClaims } from '../lib/claims';
import { provisionOrganisation } from '../lib/provisionOrganisation';
import type { ProvisionedSubMarker } from '../lib/provisionOrganisation';
import type { Logger } from '../lib/logging';
import type { OrgSubscription } from '../shared/types';

// Settable fake RTDB: path -> stored value, plus a log of every root-level
// multi-location update. `mock`-prefixed so jest permits the hoisted factory
// to close over them.
const mockDbData: Record<string, unknown> = {};
const mockRootUpdates: Array<Record<string, unknown>> = [];
let mockPushCounter = 0;
let mockUpdateFailOnce = false;

jest.mock('../admin', () => ({
  auth: {
    getUser: jest.fn(async () => ({
      displayName: 'Fran Founder',
      email: 'fran@example.com',
    })),
  },
  db: {
    ref: (path?: string) => ({
      push: () => ({ key: `key-${++mockPushCounter}` }),
      update: async (update: Record<string, unknown>) => {
        if (path) {
          // Pathful update (the marker's bootstrapped stamp): merge in place.
          const current = (mockDbData[path] as Record<string, unknown>) ?? {};
          mockDbData[path] = { ...current, ...update };
          return;
        }
        // Root-level multi-location update: the atomic bootstrap. The
        // fail-once switch targets exactly this write (a pre-commit failure).
        if (mockUpdateFailOnce) {
          mockUpdateFailOnce = false;
          throw new Error('RTDB unavailable');
        }
        mockRootUpdates.push(update);
      },
      transaction: async (fn: (current: unknown) => unknown) => {
        const current = path && path in mockDbData ? mockDbData[path] : null;
        const next = fn(current);
        if (next === undefined) {
          return { committed: false, snapshot: { val: () => current } };
        }
        if (path) {
          mockDbData[path] = next;
        }
        return { committed: true, snapshot: { val: () => next } };
      },
      get: async () => ({
        val: () => (path && path in mockDbData ? mockDbData[path] : null),
      }),
      remove: async () => {
        if (path) {
          delete mockDbData[path];
        }
      },
    }),
  },
}));

jest.mock('../lib/claims', () => ({
  computeClaims: jest.fn((_member: unknown, orgId: string) => ({
    orgId,
    roles: { admin: true },
  })),
  writeClaims: jest.fn(async () => undefined),
}));

const mockWriteClaims = writeClaims as jest.Mock;
const mockComputeClaims = computeClaims as jest.Mock;

const makeLogger = (): Logger => {
  const logger: Logger = {
    correlationId: 'test-correlation',
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => logger,
  };
  return logger;
};

const UID = 'user-1';
const EMAIL = 'fran@example.com';
const ORG_NAME = 'Acme Fire Safety';

const SUBSCRIPTION: OrgSubscription = {
  stripeSubscriptionId: 'sub_123',
  stripeCustomerId: 'cus_9',
  planId: 'silver',
  status: 'active',
  currentPeriodEnd: 1_800_000_000_000,
};

beforeEach(() => {
  for (const key of Object.keys(mockDbData)) {
    delete mockDbData[key];
  }
  mockRootUpdates.length = 0;
  mockPushCounter = 0;
  mockUpdateFailOnce = false;
  jest.clearAllMocks();
});

describe('provisionOrganisation', () => {
  it('bootstraps atomically: profile, usage, membership, index, subscription, reverse index, activity, marker, claims', async () => {
    const result = await provisionOrganisation(
      { env: 'test', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: SUBSCRIPTION },
      makeLogger(),
    );

    expect(result.alreadyProvisioned).toBe(false);
    const { orgId } = result;
    const paths = forEnv('test').db;

    // One atomic multi-location update carrying the whole bootstrap.
    expect(mockRootUpdates).toHaveLength(1);
    const update = mockRootUpdates[0];
    expect(update[paths.orgProfile(orgId)]).toEqual({
      name: ORG_NAME,
      brand: { primary: '#D9C554', secondary: '#1E3A8A' },
    });
    expect(update[paths.orgUsage(orgId)]).toEqual({
      staffCount: 1,
      customerCount: 0,
      notificationsThisMonth: 0,
    });
    expect(update[paths.orgMember(orgId, UID)]).toEqual({
      roles: { admin: true },
      name: 'Fran Founder',
      email: EMAIL,
      status: 'active',
      testMode: true, // test-env founder produces a test member (brief 4.8)
    });
    expect(update[paths.userOrg(UID, orgId)]).toBe(true);
    expect(update[paths.orgSubscription(orgId)]).toEqual(SUBSCRIPTION);
    expect(update[ops.stripeCustomer('test', 'cus_9')]).toBe(orgId);
    // The audit entry rides in the SAME update (never skippable).
    const activityKeys = Object.keys(update).filter((key) =>
      key.startsWith(`test/activity/${orgId}/`),
    );
    expect(activityKeys).toHaveLength(1);
    expect(update[activityKeys[0]]).toMatchObject({
      actorUid: UID,
      action: 'organisation.created',
      target: orgId,
    });

    // Idempotency marker claimed with the minted orgId, then stamped
    // bootstrapped once the atomic update committed.
    const marker = mockDbData[
      ops.provisionedSub('test', 'sub_123')
    ] as ProvisionedSubMarker;
    expect(marker.orgId).toBe(orgId);
    expect(typeof marker.at).toBe('number');
    expect(marker.bootstrapped).toBe(true);

    // Claims re-minted for the founder from the member record.
    expect(mockComputeClaims).toHaveBeenCalledWith(
      update[paths.orgMember(orgId, UID)],
      orgId,
    );
    expect(mockWriteClaims).toHaveBeenCalledTimes(1);
    expect(mockWriteClaims).toHaveBeenCalledWith(UID, {
      orgId,
      roles: { admin: true },
    });
  });

  it('maps orgDetails onto the profile contact block (OrgContact vocabulary, present fields only)', async () => {
    const result = await provisionOrganisation(
      {
        env: 'test',
        uid: UID,
        email: EMAIL,
        orgName: ORG_NAME,
        orgDetails: {
          name: ORG_NAME,
          address: '1 King Street, Manchester, M2 6AW',
          phone: '0161 496 0000',
          // website deliberately absent: absent fields must not be written.
        },
        subscription: SUBSCRIPTION,
      },
      makeLogger(),
    );

    const paths = forEnv('test').db;
    expect(mockRootUpdates[0][paths.orgProfile(result.orgId)]).toEqual({
      name: ORG_NAME,
      brand: { primary: '#D9C554', secondary: '#1E3A8A' },
      contact: {
        address: '1 King Street, Manchester, M2 6AW',
        phone: '0161 496 0000',
      },
    });
  });

  it('is idempotent per subscription id: a re-entry returns the stored orgId with no second bootstrap', async () => {
    const logger = makeLogger();
    const first = await provisionOrganisation(
      { env: 'test', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: SUBSCRIPTION },
      logger,
    );
    const second = await provisionOrganisation(
      { env: 'test', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: SUBSCRIPTION },
      logger,
    );

    expect(second.orgId).toBe(first.orgId);
    expect(second.alreadyProvisioned).toBe(true);
    // No second bootstrap write. The re-entry DOES re-run the idempotent
    // claims tail (the marker is bootstrapped, and the re-entry cannot know
    // whether the first delivery's tail completed) - against the SAME orgId.
    expect(mockRootUpdates).toHaveLength(1);
    expect(mockWriteClaims).toHaveBeenCalledTimes(2);
    expect(mockWriteClaims.mock.calls[1][0]).toBe(UID);
    expect(mockWriteClaims.mock.calls[1][1]).toMatchObject({ orgId: first.orgId });
  });

  it('a re-entry on an UN-bootstrapped marker (concurrent delivery mid-bootstrap) returns the stored orgId without touching claims', async () => {
    // The concurrent invocation that holds the claim owns the bootstrap and
    // its tail; this loser only reports the org that delivery is creating.
    mockDbData[ops.provisionedSub('test', 'sub_123')] = {
      orgId: 'org-in-flight',
      at: 1,
    } satisfies ProvisionedSubMarker;

    const result = await provisionOrganisation(
      { env: 'test', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: SUBSCRIPTION },
      makeLogger(),
    );
    expect(result).toEqual({ orgId: 'org-in-flight', alreadyProvisioned: true });
    expect(mockRootUpdates).toHaveLength(0);
    expect(mockWriteClaims).not.toHaveBeenCalled();
  });

  it('operator path (empty subscription): no marker, no subscription node, no reverse index - still a full bootstrap', async () => {
    const result = await provisionOrganisation(
      { env: 'live', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: {} },
      makeLogger(),
    );

    expect(result.alreadyProvisioned).toBe(false);
    const { orgId } = result;
    const paths = forEnv('live').db;

    // No idempotency marker was written anywhere.
    const markerKeys = Object.keys(mockDbData).filter((key) =>
      key.startsWith('ops/provisionedSubs/'),
    );
    expect(markerKeys).toHaveLength(0);

    expect(mockRootUpdates).toHaveLength(1);
    const update = mockRootUpdates[0];
    // No subscription snapshot, no customer reverse index (nothing to write).
    expect(update[paths.orgSubscription(orgId)]).toBeUndefined();
    expect(
      Object.keys(update).some((key) => key.startsWith('ops/stripeCustomers/')),
    ).toBe(false);
    // The bootstrap itself is unchanged - and a LIVE founder has no testMode marker.
    expect(update[paths.orgProfile(orgId)]).toMatchObject({ name: ORG_NAME });
    expect(update[paths.orgUsage(orgId)]).toEqual({
      staffCount: 1,
      customerCount: 0,
      notificationsThisMonth: 0,
    });
    expect(update[paths.orgMember(orgId, UID)]).toEqual({
      roles: { admin: true },
      name: 'Fran Founder',
      email: EMAIL,
      status: 'active',
    });
    expect(update[paths.userOrg(UID, orgId)]).toBe(true);
    expect(mockWriteClaims).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the bootstrap itself fails, so a retry can reprovision from scratch', async () => {
    // PRE-commit failure: no org data exists, so the marker must go.
    mockUpdateFailOnce = true;
    await expect(
      provisionOrganisation(
        { env: 'test', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: SUBSCRIPTION },
        makeLogger(),
      ),
    ).rejects.toThrow('RTDB unavailable');

    // The marker was released, so the retry claims afresh and provisions.
    expect(mockDbData[ops.provisionedSub('test', 'sub_123')]).toBeUndefined();
    const retry = await provisionOrganisation(
      { env: 'test', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: SUBSCRIPTION },
      makeLogger(),
    );
    expect(retry.alreadyProvisioned).toBe(false);
    expect(mockRootUpdates).toHaveLength(1);
  });

  it('KEEPS the marker on a tail failure, so the retry returns the SAME org instead of duplicating it', async () => {
    // The bootstrap commits, then writeClaims (the tail) dies. The retry must
    // resume against the minted org - a released marker here is exactly the
    // duplicate-organisation bug (assessment H2).
    mockWriteClaims.mockRejectedValueOnce(new Error('claims service down'));
    await expect(
      provisionOrganisation(
        { env: 'test', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: SUBSCRIPTION },
        makeLogger(),
      ),
    ).rejects.toThrow('claims service down');

    // The bootstrap landed and the marker survived, stamped bootstrapped.
    expect(mockRootUpdates).toHaveLength(1);
    const marker = mockDbData[
      ops.provisionedSub('test', 'sub_123')
    ] as ProvisionedSubMarker;
    const orgId = marker.orgId;
    expect(marker.bootstrapped).toBe(true);

    // The Stripe retry: same orgId, NO second bootstrap, tail healed.
    const retry = await provisionOrganisation(
      { env: 'test', uid: UID, email: EMAIL, orgName: ORG_NAME, subscription: SUBSCRIPTION },
      makeLogger(),
    );
    expect(retry.orgId).toBe(orgId);
    expect(retry.alreadyProvisioned).toBe(true);
    expect(mockRootUpdates).toHaveLength(1);
    expect(mockWriteClaims).toHaveBeenCalledTimes(2);
    expect(mockWriteClaims.mock.calls[1][1]).toMatchObject({ orgId });
  });
});
