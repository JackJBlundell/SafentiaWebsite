// ============================================================================
// Notification quota resolution - brief 4.5 #9 through the Phase 3 §6.3 lens.
//
// Pins that resolveNotificationLimit judges from the SHARED entitlements
// resolution (lib/planContext), not a bare plan read: the grandfather chain
// still resolves to unlimited, a seeded monthly cap passes through, -1 means
// unlimited, and a suspended subscription resolves to the ZERO floor - so a
// suspended org's notifications stop exactly as the mirrored entitlements the
// console renders (SUSPENDED_LIMITS.notificationsPerMonth = 0) promise. The
// admin module is mocked with a settable path -> value map (the
// customerLimits.test pattern).
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
import { resolveNotificationLimit } from '../lib/notificationLimits';

const env = forEnv('test');
const ORG = 'org-1';

const seed = (nodes: Record<string, unknown>) => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  Object.assign(mockDbData, nodes);
};

describe('resolveNotificationLimit', () => {
  it('resolves to unlimited with no subscription (grandfather rule)', async () => {
    seed({});
    expect(await resolveNotificationLimit(env, ORG)).toBeUndefined();
  });

  it('resolves to unlimited when the named plan is unseeded or capless', async () => {
    seed({ [env.db.orgSubscription(ORG)]: { planId: 'ghost', status: 'active' } });
    expect(await resolveNotificationLimit(env, ORG)).toBeUndefined();

    seed({
      [env.db.orgSubscription(ORG)]: { planId: 'gold', status: 'active' },
      [platform.plan('test', 'gold')]: { name: 'Gold', limits: { notificationsPerMonth: -1 } },
    });
    expect(await resolveNotificationLimit(env, ORG)).toBeUndefined();
  });

  it('passes a seeded monthly cap through', async () => {
    seed({
      [env.db.orgSubscription(ORG)]: { planId: 'bronze', status: 'active' },
      [platform.plan('test', 'bronze')]: {
        name: 'Bronze',
        limits: { notificationsPerMonth: 100 },
      },
    });
    expect(await resolveNotificationLimit(env, ORG)).toBe(100);
  });

  it('keeps the full cap through an OPEN dunning grace window', async () => {
    seed({
      [env.db.orgSubscription(ORG)]: {
        planId: 'bronze',
        status: 'past_due',
        paymentState: 'past_due',
        graceUntil: Date.now() + 86_400_000,
      },
      [platform.plan('test', 'bronze')]: {
        name: 'Bronze',
        limits: { notificationsPerMonth: 100 },
      },
    });
    expect(await resolveNotificationLimit(env, ORG)).toBe(100);
  });

  it('resolves a suspended subscription to the ZERO floor (notifications stop)', async () => {
    for (const status of ['unpaid', 'canceled', 'incomplete'] as const) {
      seed({
        [env.db.orgSubscription(ORG)]: { planId: 'gold', status },
        [platform.plan('test', 'gold')]: {
          name: 'Gold',
          limits: { notificationsPerMonth: -1 },
        },
      });
      expect(await resolveNotificationLimit(env, ORG)).toBe(0);
    }

    // Expired grace window: suspended by the promise the banner made.
    seed({
      [env.db.orgSubscription(ORG)]: {
        planId: 'bronze',
        status: 'past_due',
        paymentState: 'past_due',
        graceUntil: Date.now() - 1,
      },
      [platform.plan('test', 'bronze')]: {
        name: 'Bronze',
        limits: { notificationsPerMonth: 100 },
      },
    });
    expect(await resolveNotificationLimit(env, ORG)).toBe(0);
  });
});
