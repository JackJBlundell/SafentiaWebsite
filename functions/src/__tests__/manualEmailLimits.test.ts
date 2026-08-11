// ============================================================================
// manualEmailLimits - the per-org daily manual-email recipient cap (H3 fix).
//
// Pins the whole abuse contract: the counter charges the recipient count into
// the UTC day's node, an over-cap charge ABORTS (no write - all-or-nothing,
// never a partial spend) with resource-exhausted copy naming the limit and the
// reset, an exact-cap charge is still admitted, a new UTC day is a fresh
// counter, and a zero charge touches nothing. firebase-admin is mocked with a
// settable fake RTDB whose transaction fake honours the SDK's abort contract
// (returning undefined commits nothing) - the usageCounters.test.ts pattern.
// ============================================================================

const mockDbData: Record<string, unknown> = {};
let mockTransactionCalls = 0;

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      transaction: async (update: (current: unknown) => unknown) => {
        mockTransactionCalls += 1;
        const next = update(path in mockDbData ? mockDbData[path] : null);
        if (next === undefined) {
          // The SDK's abort: nothing written, committed false.
          return {
            committed: false,
            snapshot: { val: () => (path in mockDbData ? mockDbData[path] : null) },
          };
        }
        mockDbData[path] = next;
        return { committed: true, snapshot: { val: () => next } };
      },
    }),
  },
}));

import {
  MANUAL_EMAIL_DAILY_CAP,
  chargeManualEmailQuota,
  utcDayKey,
} from '../lib/manualEmailLimits';
import { paths } from '../lib/paths';
import { SafentiaFunctionError } from '../lib/errors';

const ORG = 'org-1';
// 2026-08-10T12:00:00Z - a fixed mid-day instant so the day key is unambiguous.
const NOON = Date.UTC(2026, 7, 10, 12, 0, 0);
const DAY_PATH = paths.ops.manualEmailCount('live', ORG, '20260810');

beforeEach(() => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  mockTransactionCalls = 0;
});

describe('utcDayKey', () => {
  it('formats the UTC calendar day with zero-padded month and day', () => {
    expect(utcDayKey(Date.UTC(2026, 0, 5, 3, 4, 5))).toBe('20260105');
    expect(utcDayKey(NOON)).toBe('20260810');
  });

  it('rolls to the next key exactly at the UTC midnight boundary', () => {
    const lastTick = Date.UTC(2026, 7, 10, 23, 59, 59, 999);
    expect(utcDayKey(lastTick)).toBe('20260810');
    expect(utcDayKey(lastTick + 1)).toBe('20260811');
  });
});

describe('chargeManualEmailQuota', () => {
  it('charges the recipient count into the day counter, accumulating across sends', async () => {
    await chargeManualEmailQuota('live', ORG, 50, NOON);
    expect(mockDbData[DAY_PATH]).toBe(50);
    await chargeManualEmailQuota('live', ORG, 30, NOON);
    expect(mockDbData[DAY_PATH]).toBe(80);
  });

  it('admits a charge that lands exactly on the cap', async () => {
    mockDbData[DAY_PATH] = MANUAL_EMAIL_DAILY_CAP - 50;
    await chargeManualEmailQuota('live', ORG, 50, NOON);
    expect(mockDbData[DAY_PATH]).toBe(MANUAL_EMAIL_DAILY_CAP);
  });

  it('aborts an over-cap charge all-or-nothing: no partial spend, calm copy naming limit and reset', async () => {
    mockDbData[DAY_PATH] = MANUAL_EMAIL_DAILY_CAP - 10;
    try {
      await chargeManualEmailQuota('live', ORG, 11, NOON);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SafentiaFunctionError);
      const failure = error as SafentiaFunctionError;
      expect(failure.code).toBe('resource-exhausted');
      expect(failure.message).toContain(String(MANUAL_EMAIL_DAILY_CAP));
      expect(failure.message).toContain('Nothing from this send was dispatched');
      expect(failure.message).toContain('midnight UTC');
    }
    // All-or-nothing: the counter did NOT advance by the part that "fitted".
    expect(mockDbData[DAY_PATH]).toBe(MANUAL_EMAIL_DAILY_CAP - 10);
  });

  it('refuses a single batch larger than the whole cap even on a fresh day', async () => {
    await expect(
      chargeManualEmailQuota('live', ORG, MANUAL_EMAIL_DAILY_CAP + 1, NOON),
    ).rejects.toThrow(SafentiaFunctionError);
    expect(DAY_PATH in mockDbData).toBe(false);
  });

  it('resets by date: a saturated yesterday does not touch today, and each env/org has its own bucket', async () => {
    mockDbData[DAY_PATH] = MANUAL_EMAIL_DAILY_CAP;
    const nextDay = Date.UTC(2026, 7, 11, 0, 0, 1);
    await chargeManualEmailQuota('live', ORG, 40, nextDay);
    expect(mockDbData[paths.ops.manualEmailCount('live', ORG, '20260811')]).toBe(40);
    // Yesterday's node is untouched and the paths are distinct per env/org.
    expect(mockDbData[DAY_PATH]).toBe(MANUAL_EMAIL_DAILY_CAP);
    await chargeManualEmailQuota('test', ORG, 5, NOON);
    expect(mockDbData[paths.ops.manualEmailCount('test', ORG, '20260810')]).toBe(5);
  });

  it('charges nothing - and runs no transaction - for a zero-recipient send', async () => {
    await chargeManualEmailQuota('live', ORG, 0, NOON);
    expect(mockTransactionCalls).toBe(0);
    expect(Object.keys(mockDbData)).toHaveLength(0);
  });
});
