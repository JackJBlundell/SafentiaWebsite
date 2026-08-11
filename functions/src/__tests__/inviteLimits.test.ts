// ============================================================================
// Staff-seat limit check - story 1023 + the Phase 3 pending-seat reservation.
//
// Pins the three legs of the staff ceiling (the customerLimits pattern):
//   - assertWithinInviteLimit: unlimited / within / refusal arithmetic, now
//     over occupied seats (staffCount) PLUS reserved seats (pending unexpired
//     staff invites) - acceptInvitation admits without re-checking, so the
//     seat must be spoken for at issue time.
//   - countPendingStaffInvites: which invitation summaries reserve a seat
//     (pending + unexpired + staff-scoped only).
//   - resolveInviteLimitContext: the full resolver over a fake RTDB, including
//     the grandfather chain and the suspended zero floor.
// The same gate now also guards updateMember's reinstatement branch, which is
// exactly why the arithmetic is pinned here once.
// ============================================================================

const mockDbData: Record<string, unknown> = {};

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      get: async () => ({ val: () => (path in mockDbData ? mockDbData[path] : null) }),
    }),
  },
}));

import { forEnv, platform } from '../lib/paths';
import {
  assertWithinInviteLimit,
  countPendingStaffInvites,
  resolveInviteLimitContext,
} from '../lib/inviteLimits';
import { SafentiaFunctionError } from '../lib/errors';
import type { InvitationSummary } from '../shared/types';

const env = forEnv('test');
const ORG = 'org-1';

const seed = (nodes: Record<string, unknown>) => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  Object.assign(mockDbData, nodes);
};

const summary = (overrides: Partial<InvitationSummary>): InvitationSummary => ({
  email: 'person@example.com',
  roles: { assessor: true },
  status: 'pending',
  expiresAt: Date.now() + 86_400_000,
  createdAt: Date.now(),
  invitedBy: 'admin-uid',
  ...overrides,
});

describe('assertWithinInviteLimit', () => {
  it('allows any count when no limit is configured (unlimited mode)', () => {
    expect(() =>
      assertWithinInviteLimit({
        currentStaffCount: 9999,
        pendingInviteCount: 9999,
        staffLimit: undefined,
      }),
    ).not.toThrow();
  });

  it('allows a claim strictly within the limit', () => {
    expect(() =>
      assertWithinInviteLimit({
        currentStaffCount: 3,
        pendingInviteCount: 1,
        staffLimit: 5,
      }),
    ).not.toThrow();
  });

  it('counts RESERVED seats: pending invites push an under-limit org over', () => {
    // 3 occupied of 5 would admit; 2 pending invites mean every seat is
    // already spoken for, so a further invite must be refused.
    try {
      assertWithinInviteLimit({
        currentStaffCount: 3,
        pendingInviteCount: 2,
        staffLimit: 5,
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SafentiaFunctionError);
      const failure = error as SafentiaFunctionError;
      expect(failure.code).toBe('resource-exhausted');
      expect(failure.details).toMatchObject({ limit: 5, current: 3, pending: 2 });
    }
  });

  it('never admits a claim on the suspended zero floor', () => {
    expect(() =>
      assertWithinInviteLimit({
        currentStaffCount: 0,
        pendingInviteCount: 0,
        staffLimit: 0,
      }),
    ).toThrow(SafentiaFunctionError);
  });
});

describe('countPendingStaffInvites', () => {
  const now = Date.now();

  it('counts only pending, unexpired STAFF invites', () => {
    expect(
      countPendingStaffInvites(
        {
          live: summary({}),
          accepted: summary({ status: 'accepted' }),
          revoked: summary({ status: 'revoked' }),
          expiredStatus: summary({ status: 'expired' }),
          expiredClock: summary({ expiresAt: now - 1 }),
          portal: summary({ customerId: 'cust-1', roles: {} }),
        },
        now,
      ),
    ).toBe(1);
  });

  it('treats an absent or empty node as zero', () => {
    expect(countPendingStaffInvites(null, now)).toBe(0);
    expect(countPendingStaffInvites(undefined, now)).toBe(0);
    expect(countPendingStaffInvites({}, now)).toBe(0);
  });
});

describe('resolveInviteLimitContext', () => {
  it('resolves to unlimited with no subscription (grandfather rule)', async () => {
    seed({ [env.db.orgUsage(ORG)]: { staffCount: 40 } });
    const ctx = await resolveInviteLimitContext(env, ORG);
    expect(ctx.staffLimit).toBeUndefined();
    expect(ctx.currentStaffCount).toBe(40);
    expect(ctx.pendingInviteCount).toBe(0);
  });

  it('resolves the seeded ceiling plus the org’s live pending invites', async () => {
    seed({
      [env.db.orgUsage(ORG)]: { staffCount: 2 },
      [env.db.orgSubscription(ORG)]: { planId: 'silver', status: 'active' },
      [platform.plan('test', 'silver')]: {
        name: 'Silver',
        features: { branding: true, emailTemplates: true, prioritySupport: false },
        limits: { orgStaff: 5 },
      },
      [env.db.orgInvitations(ORG)]: {
        a: summary({}),
        b: summary({ status: 'revoked' }),
        c: summary({ customerId: 'cust-9' }),
      },
    });
    expect(await resolveInviteLimitContext(env, ORG)).toEqual({
      currentStaffCount: 2,
      pendingInviteCount: 1,
      staffLimit: 5,
    });
  });

  it('resolves a terminally dead subscription to the zero-create floor', async () => {
    seed({
      [env.db.orgUsage(ORG)]: { staffCount: 1 },
      [env.db.orgSubscription(ORG)]: { planId: 'gold', status: 'canceled' },
      [platform.plan('test', 'gold')]: { name: 'Gold', limits: { orgStaff: -1 } },
    });
    const ctx = await resolveInviteLimitContext(env, ORG);
    expect(ctx.staffLimit).toBe(0);
    expect(() => assertWithinInviteLimit(ctx)).toThrow(SafentiaFunctionError);
  });
});
