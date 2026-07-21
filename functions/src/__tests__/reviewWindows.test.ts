// ============================================================================
// reviewWindows unit tests - the FRA-review reminder day maths (story 2046):
// exact-day matches at 60/30/7 ahead, the single lapsed notice the day after
// the due day passes, and silence everywhere else.
// ============================================================================

import { reviewReminderStage, utcDayKey, utcDayNumber } from '../lib/reviewWindows';

const DAY_MS = 24 * 60 * 60 * 1000;
// Mid-afternoon UTC, deliberately not midnight: day comparison must not care
// how far through the day the scheduler fires.
const NOW = Date.UTC(2026, 6, 1, 14, 30);
const midnight = (daysFromNow: number) =>
  Date.UTC(2026, 6, 1) + daysFromNow * DAY_MS;

describe('reviewReminderStage', () => {
  it.each([[60], [30], [7]] as const)(
    'matches a review exactly %i days ahead',
    (days) => {
      expect(reviewReminderStage(midnight(days), NOW)).toBe(days);
    },
  );

  it('is silent on near-miss days around each window', () => {
    for (const days of [61, 59, 31, 29, 8, 6, 1, 0]) {
      expect(reviewReminderStage(midnight(days), NOW)).toBeNull();
    }
  });

  it('reports lapsed exactly one day after the due day, then goes quiet', () => {
    expect(reviewReminderStage(midnight(-1), NOW)).toBe('lapsed');
    expect(reviewReminderStage(midnight(-2), NOW)).toBeNull();
    expect(reviewReminderStage(midnight(-30), NOW)).toBeNull();
  });

  it('compares by UTC day, not millisecond distance', () => {
    // 23:59 on the day 7 days ahead is still "7 days ahead".
    const lateOnDueDay = midnight(7) + DAY_MS - 60 * 1000;
    expect(reviewReminderStage(lateOnDueDay, NOW)).toBe(7);
  });
});

describe('utc day helpers', () => {
  it('utcDayNumber increments at UTC midnight', () => {
    expect(utcDayNumber(midnight(1)) - utcDayNumber(NOW)).toBe(1);
    expect(utcDayNumber(midnight(1) - 1) - utcDayNumber(NOW)).toBe(0);
  });

  it('utcDayKey names the UTC calendar day', () => {
    expect(utcDayKey(NOW)).toBe('2026-07-01');
  });
});
