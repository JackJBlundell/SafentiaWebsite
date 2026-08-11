// ============================================================================
// Stripe client seam - configuration guards, reverse index and event claims.
//
// The seam's load-bearing behaviour is everything AROUND the Stripe SDK, not
// the SDK itself (which is not under test): unconfigured modes must fail
// loudly with an actionable error, the customer reverse index must round-trip,
// and the webhook claim must be claim-once (a Stripe retry of an in-flight or
// done event gets false) yet reclaimable after a release - and a STALE
// 'processing' marker (a crashed invocation that never released) must be
// reclaimable after STALE_PROCESSING_CLAIM_MS, or the event would be lost
// forever behind "Already handled" 200s. firebase-admin is
// mocked with a settable fake RTDB - the code under test only ever lazily
// imports it (templatedEmail.test.ts precedent), which is why the mock
// factory works without touching admin initialisation.
// ============================================================================

import {
  STALE_PROCESSING_CLAIM_MS,
  claimStripeEvent,
  isStripeConfigured,
  markStripeEventDone,
  orgForStripeCustomer,
  recordStripeCustomer,
  releaseStripeEvent,
  stripeCustomerIndexPath,
  stripeForEnv,
  webhookSecretForMode,
} from '../lib/stripe';
import type { StripeEventClaim } from '../lib/stripe';

// Settable fake RTDB: path -> stored value. `mock`-prefixed so jest permits
// the hoisted factory to close over it.
const mockDbData: Record<string, unknown> = {};

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      set: async (value: unknown) => {
        mockDbData[path] = value;
      },
      get: async () => ({
        val: () => (path in mockDbData ? mockDbData[path] : null),
      }),
      update: async (patch: Record<string, unknown>) => {
        const current = (mockDbData[path] as Record<string, unknown>) ?? {};
        mockDbData[path] = { ...current, ...patch };
      },
      remove: async () => {
        delete mockDbData[path];
      },
      // RTDB transaction semantics: handler sees the current value (null when
      // absent); returning undefined aborts (committed:false), anything else
      // is written and commits.
      transaction: async (handler: (current: unknown) => unknown) => {
        const current = path in mockDbData ? mockDbData[path] : null;
        const next = handler(current);
        if (next === undefined) {
          return { committed: false, snapshot: { val: () => current } };
        }
        mockDbData[path] = next;
        return { committed: true, snapshot: { val: () => next } };
      },
    }),
  },
}));

const STRIPE_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY_TEST',
  'STRIPE_WEBHOOK_SECRET_TEST',
] as const;

const savedEnv: Partial<Record<(typeof STRIPE_ENV_VARS)[number], string>> = {};

beforeAll(() => {
  for (const name of STRIPE_ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterAll(() => {
  for (const name of STRIPE_ENV_VARS) {
    const value = savedEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

beforeEach(() => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  for (const name of STRIPE_ENV_VARS) delete process.env[name];
});

// ============================================================================
// Configuration guards
// ============================================================================

describe('configuration guards', () => {
  test('isStripeConfigured reflects the per-mode secret, not the other mode', () => {
    expect(isStripeConfigured('live')).toBe(false);
    expect(isStripeConfigured('test')).toBe(false);

    process.env.STRIPE_SECRET_KEY_TEST = 'sk_test_dummy';
    expect(isStripeConfigured('test')).toBe(true);
    // The live mode must NOT be considered configured by the test key.
    expect(isStripeConfigured('live')).toBe(false);
  });

  test('stripeForEnv throws an actionable error naming the missing secret', () => {
    expect(() => stripeForEnv('live')).toThrow(/STRIPE_SECRET_KEY\b/);
    expect(() => stripeForEnv('live')).toThrow(/STRIPE_SETUP\.md/);
    expect(() => stripeForEnv('test')).toThrow(/STRIPE_SECRET_KEY_TEST/);
  });

  test('stripeForEnv constructs once and caches per mode', () => {
    process.env.STRIPE_SECRET_KEY_TEST = 'sk_test_dummy';
    const first = stripeForEnv('test');
    const second = stripeForEnv('test');
    expect(second).toBe(first);
    // The live client is a separate cache slot and is still unconfigured. The
    // env var was cleared by beforeEach but the test-mode client above came
    // from the cache - proving the cache is per mode, not global.
    expect(() => stripeForEnv('live')).toThrow(/not configured/);
  });

  test('webhookSecretForMode returns the mode-matched secret and throws when absent', () => {
    expect(() => webhookSecretForMode('live')).toThrow(/STRIPE_WEBHOOK_SECRET\b/);
    expect(() => webhookSecretForMode('test')).toThrow(/STRIPE_WEBHOOK_SECRET_TEST/);

    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_dummy';
    process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test_dummy';
    expect(webhookSecretForMode('live')).toBe('whsec_live_dummy');
    expect(webhookSecretForMode('test')).toBe('whsec_test_dummy');
  });
});

// ============================================================================
// Customer reverse index
// ============================================================================

describe('customer reverse index', () => {
  test('paths are env-nested under the server-only ops namespace', () => {
    expect(stripeCustomerIndexPath('live', 'cus_123')).toBe(
      'ops/stripeCustomers/live/cus_123',
    );
    expect(stripeCustomerIndexPath('test', 'cus_123')).toBe(
      'ops/stripeCustomers/test/cus_123',
    );
  });

  test('record then resolve round-trips the orgId', async () => {
    await recordStripeCustomer('test', 'cus_abc', 'org-1');

    expect(await orgForStripeCustomer('test', 'cus_abc')).toBe('org-1');
    // Envs are isolated: the live tree knows nothing of the test customer.
    expect(await orgForStripeCustomer('live', 'cus_abc')).toBeNull();
  });

  test('unknown customer resolves to null, never throws', async () => {
    expect(await orgForStripeCustomer('live', 'cus_never_seen')).toBeNull();
  });
});

// ============================================================================
// Webhook event claims
// ============================================================================

describe('webhook event claims', () => {
  test('first claim wins and records a processing marker; second claim returns false', async () => {
    const won = await claimStripeEvent('test', 'evt_1', 'invoice.paid');
    expect(won).toBe(true);

    const claim = mockDbData['ops/stripeEvents/test/evt_1'] as StripeEventClaim;
    expect(claim.type).toBe('invoice.paid');
    expect(claim.status).toBe('processing');
    expect(typeof claim.receivedAt).toBe('number');
    expect(claim.attempts).toBe(1);

    // The Stripe retry (same event id) must NOT win a second claim.
    expect(await claimStripeEvent('test', 'evt_1', 'invoice.paid')).toBe(false);
  });

  test('a done event still refuses re-claims (late retry after success)', async () => {
    await claimStripeEvent('test', 'evt_2', 'invoice.paid');
    await markStripeEventDone('test', 'evt_2');

    const claim = mockDbData['ops/stripeEvents/test/evt_2'] as StripeEventClaim;
    expect(claim.status).toBe('done');
    expect(typeof claim.doneAt).toBe('number');
    // markStripeEventDone merges - the original claim fields survive.
    expect(claim.type).toBe('invoice.paid');

    expect(await claimStripeEvent('test', 'evt_2', 'invoice.paid')).toBe(false);
  });

  test('release deletes the claim so the retry can reclaim and reprocess', async () => {
    await claimStripeEvent('test', 'evt_3', 'invoice.payment_failed');
    await releaseStripeEvent('test', 'evt_3');

    expect(mockDbData['ops/stripeEvents/test/evt_3']).toBeUndefined();
    expect(
      await claimStripeEvent('test', 'evt_3', 'invoice.payment_failed'),
    ).toBe(true);
  });

  test('claims are isolated per env: the same event id claims independently in live and test', async () => {
    expect(await claimStripeEvent('test', 'evt_4', 'charge.refunded')).toBe(true);
    expect(await claimStripeEvent('live', 'evt_4', 'charge.refunded')).toBe(true);
    expect(await claimStripeEvent('live', 'evt_4', 'charge.refunded')).toBe(false);
  });

  test('a STALE processing marker (crashed invocation) is reclaimed with a fresh receivedAt and bumped attempts', async () => {
    // A claim that has sat 'processing' beyond the stale threshold can only
    // belong to an invocation that died before release - the retry must win.
    const staleClaim: StripeEventClaim = {
      type: 'invoice.paid',
      receivedAt: Date.now() - STALE_PROCESSING_CLAIM_MS - 1000,
      status: 'processing',
      attempts: 1,
    };
    mockDbData['ops/stripeEvents/test/evt_stale'] = staleClaim;

    expect(await claimStripeEvent('test', 'evt_stale', 'invoice.paid')).toBe(true);
    const reclaimed = mockDbData['ops/stripeEvents/test/evt_stale'] as StripeEventClaim;
    expect(reclaimed.status).toBe('processing');
    expect(reclaimed.receivedAt).toBeGreaterThan(staleClaim.receivedAt);
    expect(reclaimed.attempts).toBe(2);
  });

  test('a FRESH processing marker is never reclaimed - the invocation may still be running', async () => {
    const freshClaim: StripeEventClaim = {
      type: 'invoice.paid',
      // Just inside the threshold: old, but not provably orphaned.
      receivedAt: Date.now() - STALE_PROCESSING_CLAIM_MS + 5000,
      status: 'processing',
      attempts: 1,
    };
    mockDbData['ops/stripeEvents/test/evt_fresh'] = freshClaim;

    expect(await claimStripeEvent('test', 'evt_fresh', 'invoice.paid')).toBe(false);
    // The claim is untouched - same receivedAt, same attempt count.
    expect(mockDbData['ops/stripeEvents/test/evt_fresh']).toEqual(freshClaim);
  });

  test('a DONE marker is never reclaimed however old - done is done', async () => {
    mockDbData['ops/stripeEvents/test/evt_ancient_done'] = {
      type: 'invoice.paid',
      receivedAt: 0, // arbitrarily ancient
      status: 'done',
      doneAt: 1,
      attempts: 1,
    } satisfies StripeEventClaim;

    expect(
      await claimStripeEvent('test', 'evt_ancient_done', 'invoice.paid'),
    ).toBe(false);
    expect(
      (mockDbData['ops/stripeEvents/test/evt_ancient_done'] as StripeEventClaim)
        .status,
    ).toBe('done');
  });

  test('a legacy processing marker with no receivedAt cannot prove freshness and is reclaimed', async () => {
    mockDbData['ops/stripeEvents/test/evt_legacy'] = {
      type: 'invoice.paid',
      status: 'processing',
    };
    expect(await claimStripeEvent('test', 'evt_legacy', 'invoice.paid')).toBe(true);
    const reclaimed = mockDbData['ops/stripeEvents/test/evt_legacy'] as StripeEventClaim;
    expect(typeof reclaimed.receivedAt).toBe('number');
    expect(reclaimed.attempts).toBe(2); // absent attempts reads as 1
  });
});
