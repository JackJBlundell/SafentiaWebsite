// ============================================================================
// seedPlans - the pure parts of the plans seed script.
//
// The Stripe convergence itself is operator-run I/O and is not under test;
// what IS load-bearing here is the canonical tier data (PLAN_SEEDS must match
// the approved PHASE3_BILLING_PLAN.md section 1.1 matrix exactly - it is the
// single edit point for commercials) and the doc builder that turns a seed
// plus a mode's resolved price ID into the FULL Plan shape the runtime
// entitlement readers consume. The script guards its main() behind
// require.main, so importing these exports runs nothing; '../admin' is mocked
// anyway so a future import-graph change cannot start initialising
// firebase-admin under jest.
// ============================================================================

import {
  PLAN_SEEDS,
  buildPlanDoc,
  keyMatchesMode,
  lookupKeyFor,
  parseMode,
  productNameFor,
} from '../scripts/seedPlans';
import type { Plan } from '../shared/types';

jest.mock('../admin', () => ({ db: {} }));

describe('PLAN_SEEDS (section 1.1 matrix)', () => {
  it('defines exactly bronze, silver, gold in display order', () => {
    expect(PLAN_SEEDS.map((seed) => seed.planId)).toEqual([
      'bronze',
      'silver',
      'gold',
    ]);
    expect(PLAN_SEEDS.map((seed) => seed.order)).toEqual([0, 1, 2]);
  });

  it('carries the proposed monthly amounts pending sign-off', () => {
    expect(PLAN_SEEDS.map((seed) => seed.priceMonthlyPence)).toEqual([
      4900, 12900, 29900,
    ]);
  });

  it('matches the limit matrix, including capped gold notifications', () => {
    const [bronze, silver, gold] = PLAN_SEEDS;
    expect(bronze.limits).toEqual({
      orgStaff: 3,
      customers: 10,
      notificationsPerMonth: 200,
      assessmentTemplates: 1,
    });
    expect(silver.limits).toEqual({
      orgStaff: 10,
      customers: 50,
      notificationsPerMonth: 1000,
      assessmentTemplates: 5,
    });
    // Gold is unlimited (-1 sentinel) everywhere EXCEPT notifications: email
    // spend is real money, so 5,000/mo is the abuse ceiling, never -1.
    expect(gold.limits).toEqual({
      orgStaff: -1,
      customers: -1,
      notificationsPerMonth: 5000,
      assessmentTemplates: -1,
    });
  });

  it('gates branding/emailTemplates at silver and prioritySupport at gold', () => {
    const [bronze, silver, gold] = PLAN_SEEDS;
    expect(bronze.features).toEqual({
      branding: false,
      emailTemplates: false,
      prioritySupport: false,
    });
    expect(silver.features).toEqual({
      branding: true,
      emailTemplates: true,
      prioritySupport: false,
    });
    expect(gold.features).toEqual({
      branding: true,
      emailTemplates: true,
      prioritySupport: true,
    });
  });

  it('derives the documented Stripe names per tier', () => {
    expect(PLAN_SEEDS.map((seed) => productNameFor(seed.planId))).toEqual([
      'safentia_bronze',
      'safentia_silver',
      'safentia_gold',
    ]);
    expect(PLAN_SEEDS.map((seed) => lookupKeyFor(seed.planId))).toEqual([
      'safentia_bronze_monthly',
      'safentia_silver_monthly',
      'safentia_gold_monthly',
    ]);
  });
});

describe('buildPlanDoc', () => {
  it('produces the full Plan shape with the mode price ID injected', () => {
    const silver = PLAN_SEEDS[1];
    const doc = buildPlanDoc(silver, 'price_test_123');
    const expected: Plan = {
      name: 'Silver',
      stripePriceId: 'price_test_123',
      priceMonthlyPence: 12900,
      currency: 'gbp',
      features: { branding: true, emailTemplates: true, prioritySupport: false },
      limits: {
        orgStaff: 10,
        customers: 50,
        notificationsPerMonth: 1000,
        assessmentTemplates: 5,
      },
      order: 1,
    };
    expect(doc).toEqual(expected);
  });

  it('only the price ID varies between modes for the same seed', () => {
    const gold = PLAN_SEEDS[2];
    const testDoc = buildPlanDoc(gold, 'price_test_g');
    const liveDoc = buildPlanDoc(gold, 'price_live_g');
    expect({ ...testDoc, stripePriceId: 'x' }).toEqual({
      ...liveDoc,
      stripePriceId: 'x',
    });
  });
});

describe('parseMode', () => {
  it('accepts both --mode test and --mode=live forms', () => {
    expect(parseMode(['--mode', 'test'])).toBe('test');
    expect(parseMode(['--mode=live', '--apply'])).toBe('live');
  });

  it('rejects missing or invalid modes', () => {
    expect(parseMode([])).toBeNull();
    expect(parseMode(['--apply'])).toBeNull();
    expect(parseMode(['--mode', 'production'])).toBeNull();
    expect(parseMode(['--mode='])).toBeNull();
  });
});

describe('keyMatchesMode', () => {
  it('binds test keys to test mode and live keys to live mode', () => {
    expect(keyMatchesMode('sk_test_abc', 'test')).toBe(true);
    expect(keyMatchesMode('sk_live_abc', 'live')).toBe(true);
    expect(keyMatchesMode('sk_test_abc', 'live')).toBe(false);
    expect(keyMatchesMode('sk_live_abc', 'test')).toBe(false);
    // Restricted keys follow the same _test_ marker convention.
    expect(keyMatchesMode('rk_test_abc', 'test')).toBe(true);
    expect(keyMatchesMode('rk_live_abc', 'live')).toBe(true);
  });
});
