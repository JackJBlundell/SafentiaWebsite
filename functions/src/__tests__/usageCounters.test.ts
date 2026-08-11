// ============================================================================
// usageCounters - the transactional usage-node helpers (Phase 3 brief 5.2).
//
// The contract under test is small but load-bearing: deltas apply atomically to
// ONE counter child, an absent node reads as 0 before the delta (pre-counter
// orgs just work), no delta may drive a counter below zero, and - because the
// helpers run AFTER the business write has committed - a database failure is
// swallowed with a warning, never rethrown. firebase-admin is mocked with a
// settable fake RTDB (the templatedEmail.test.ts pattern) so this stays a pure
// unit test.
// ============================================================================

import { forEnv } from '../shared/paths';
import type { Logger } from '../lib/logging';
import {
  adjustStaffCount,
  adjustCustomerCount,
  mirrorNotificationsThisMonth,
} from '../lib/usageCounters';

// Settable fake RTDB: path -> stored value. `mock`-prefixed so jest permits
// the factory to close over them (jest.mock factories are hoisted). The
// transaction fake mirrors the SDK's contract for these helpers: the update
// function receives the current value (null when absent) and its return value
// is stored.
const mockDbData: Record<string, unknown> = {};
let mockDbFail = false;

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      transaction: async (update: (current: unknown) => unknown) => {
        if (mockDbFail) throw new Error('RTDB unavailable');
        const next = update(path in mockDbData ? mockDbData[path] : null);
        mockDbData[path] = next;
        return { committed: true, snapshot: { val: () => next } };
      },
      set: async (value: unknown) => {
        if (mockDbFail) throw new Error('RTDB unavailable');
        mockDbData[path] = value;
      },
    }),
  },
}));

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

const ENV = forEnv('test');
const ORG = 'org-1';
const STAFF_PATH = `${ENV.db.orgUsage(ORG)}/staffCount`;
const CUSTOMER_PATH = `${ENV.db.orgUsage(ORG)}/customerCount`;
const NOTIFICATIONS_PATH = `${ENV.db.orgUsage(ORG)}/notificationsThisMonth`;

beforeEach(() => {
  for (const key of Object.keys(mockDbData)) {
    delete mockDbData[key];
  }
  mockDbFail = false;
});

describe('adjustStaffCount / adjustCustomerCount', () => {
  it('applies a positive delta to the existing count', async () => {
    mockDbData[STAFF_PATH] = 3;
    await adjustStaffCount(ENV, ORG, 1, makeLogger());
    expect(mockDbData[STAFF_PATH]).toBe(4);
  });

  it('applies a negative delta to the existing count', async () => {
    mockDbData[STAFF_PATH] = 3;
    await adjustStaffCount(ENV, ORG, -1, makeLogger());
    expect(mockDbData[STAFF_PATH]).toBe(2);
  });

  it('treats an absent counter as 0 before the delta', async () => {
    await adjustStaffCount(ENV, ORG, 1, makeLogger());
    expect(mockDbData[STAFF_PATH]).toBe(1);
  });

  it('clamps at zero: a decrement can never go negative', async () => {
    mockDbData[CUSTOMER_PATH] = 1;
    await adjustCustomerCount(ENV, ORG, -5, makeLogger());
    expect(mockDbData[CUSTOMER_PATH]).toBe(0);
  });

  it('clamps at zero when the counter is absent', async () => {
    await adjustCustomerCount(ENV, ORG, -1, makeLogger());
    expect(mockDbData[CUSTOMER_PATH]).toBe(0);
  });

  it('targets the counter named for the helper, not its sibling', async () => {
    await adjustStaffCount(ENV, ORG, 1, makeLogger());
    await adjustCustomerCount(ENV, ORG, 1, makeLogger());
    expect(mockDbData[STAFF_PATH]).toBe(1);
    expect(mockDbData[CUSTOMER_PATH]).toBe(1);
  });

  it('swallows a database failure and warns, never throws', async () => {
    mockDbFail = true;
    const logger = makeLogger();
    await expect(
      adjustStaffCount(ENV, ORG, 1, logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(mockDbData[STAFF_PATH]).toBeUndefined();
  });
});

describe('mirrorNotificationsThisMonth', () => {
  it('sets the month total absolutely (rollover overwrites a stale figure)', async () => {
    mockDbData[NOTIFICATIONS_PATH] = 41; // last month's stale figure
    await mirrorNotificationsThisMonth(ENV, ORG, 1, makeLogger());
    expect(mockDbData[NOTIFICATIONS_PATH]).toBe(1);
  });

  it('swallows a database failure and warns, never throws', async () => {
    mockDbFail = true;
    const logger = makeLogger();
    await expect(
      mirrorNotificationsThisMonth(ENV, ORG, 7, logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
