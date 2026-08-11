// ============================================================================
// Customer limit check - Phase 3 billing §6 (the inviteLimits pattern).
//
// Pins both modes of the pure decision - unlimited and limited - and the full
// resolver chain over a fake RTDB: grandfathered orgs (no subscription, no
// plan, half-seeded plan) resolve to unlimited, a seeded ceiling is enforced
// with the plan named in the refusal, and a terminally dead subscription
// resolves to the zero-create floor. The admin module is mocked with a
// settable path -> value map, the templatedEmail.test pattern.
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
  assertWithinCustomerLimit,
  resolveCustomerLimitContext,
} from '../lib/customerLimits';
import { SafentiaFunctionError } from '../lib/errors';

const env = forEnv('test');
const ORG = 'org-1';

const seed = (nodes: Record<string, unknown>) => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  Object.assign(mockDbData, nodes);
};

describe('assertWithinCustomerLimit', () => {
  it('allows any count when no limit is configured (unlimited mode)', () => {
    expect(() =>
      assertWithinCustomerLimit({ currentCustomerCount: 9999, customerLimit: undefined }),
    ).not.toThrow();
  });

  it('allows a create strictly within the limit', () => {
    expect(() =>
      assertWithinCustomerLimit({ currentCustomerCount: 4, customerLimit: 5 }),
    ).not.toThrow();
  });

  it('refuses at the limit with resource-exhausted naming the plan and ceiling', () => {
    try {
      assertWithinCustomerLimit({
        currentCustomerCount: 5,
        customerLimit: 5,
        planName: 'Bronze',
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SafentiaFunctionError);
      const failure = error as SafentiaFunctionError;
      expect(failure.code).toBe('resource-exhausted');
      expect(failure.message).toContain('Bronze');
      expect(failure.message).toContain('5');
    }
  });

  it('never admits a create on the suspended zero floor', () => {
    expect(() =>
      assertWithinCustomerLimit({ currentCustomerCount: 0, customerLimit: 0 }),
    ).toThrow(SafentiaFunctionError);
  });
});

describe('resolveCustomerLimitContext', () => {
  it('resolves to unlimited when the org has no subscription (grandfather rule)', async () => {
    seed({ [env.db.orgUsage(ORG)]: { customerCount: 12 } });
    const ctx = await resolveCustomerLimitContext(env, ORG);
    expect(ctx).toEqual({ currentCustomerCount: 12, customerLimit: undefined });
  });

  it('resolves to unlimited when the named plan is not seeded', async () => {
    seed({
      [env.db.orgUsage(ORG)]: { customerCount: 3 },
      [env.db.orgSubscription(ORG)]: { planId: 'bronze', status: 'active' },
    });
    const ctx = await resolveCustomerLimitContext(env, ORG);
    expect(ctx.customerLimit).toBeUndefined();
  });

  it('resolves the seeded ceiling and plan name, and -1 as unlimited', async () => {
    seed({
      [env.db.orgUsage(ORG)]: { customerCount: 3 },
      [env.db.orgSubscription(ORG)]: { planId: 'bronze', status: 'active' },
      [platform.plan('test', 'bronze')]: {
        name: 'Bronze',
        features: { branding: false, emailTemplates: false, prioritySupport: false },
        limits: { customers: 10 },
      },
    });
    expect(await resolveCustomerLimitContext(env, ORG)).toEqual({
      currentCustomerCount: 3,
      customerLimit: 10,
      planName: 'Bronze',
    });

    seed({
      [env.db.orgSubscription(ORG)]: { planId: 'gold', status: 'active' },
      [platform.plan('test', 'gold')]: { name: 'Gold', limits: { customers: -1 } },
    });
    const gold = await resolveCustomerLimitContext(env, ORG);
    expect(gold.currentCustomerCount).toBe(0); // absent usage counts as zero
    expect(gold.customerLimit).toBeUndefined();
  });

  it('resolves a terminally dead subscription to the zero-create floor', async () => {
    seed({
      [env.db.orgUsage(ORG)]: { customerCount: 1 },
      [env.db.orgSubscription(ORG)]: { planId: 'bronze', status: 'unpaid' },
      [platform.plan('test', 'bronze')]: { name: 'Bronze', limits: { customers: 10 } },
    });
    const ctx = await resolveCustomerLimitContext(env, ORG);
    expect(ctx.customerLimit).toBe(0);
    expect(() => assertWithinCustomerLimit(ctx)).toThrow(SafentiaFunctionError);
  });
});
