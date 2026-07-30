// ============================================================================
// FRA-review reminder day-matching (story 2046) - the PURE half of
// reviewReminders, split out so the calendar maths is unit-testable without a
// scheduler or an emulator.
//
// Comparison is by UTC DAY, not by millisecond distance: nextDue is stored as
// midnight UTC on the due day (the platform convention, see
// ServiceSchedulePanel), so "60 days ahead" means the due date's UTC day number
// is exactly 60 greater than today's - stable however far through the day the
// scheduler actually fires.
// ============================================================================

import {
  isValidReminderDays,
  resolveReminderDays,
  REVIEW_REMINDER_RULES,
} from './reminderSchedules';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch millis -> whole UTC days since the epoch. */
export function utcDayNumber(millis: number): number {
  return Math.floor(millis / DAY_MS);
}

/** A reminder stage is either an upcoming-review nudge a configured number of
 *  days out (a positive day offset), or the single 'lapsed' notice the first
 *  day AFTER the due day has fully passed. Once the offsets became org-
 *  configurable (story 2046 AC1) the offset can be any sane positive integer,
 *  not only the three built-in marks, so the type widened from a literal union
 *  to `number | 'lapsed'`. */
export type ReminderStage = number | 'lapsed';

/** The review ladder's rules now sit in the mirrored reminderSchedules module,
 *  beside the information-request and action ladders, so the console control,
 *  the callable and every sweep read ONE definition of what is legal. The
 *  wrappers below keep the review sweep reading in its own vocabulary; the
 *  numeric bounds are quoted from the rule set itself, never re-stated. */
export const DEFAULT_REVIEW_REMINDER_DAYS: readonly number[] =
  REVIEW_REMINDER_RULES.defaults;

/** Whether an arbitrary value is a valid configured review schedule (the shared
 *  rules: non-empty, capped, strictly descending, each mark within a year). */
export function isValidReviewReminderDays(value: unknown): value is number[] {
  return isValidReminderDays(value, REVIEW_REMINDER_RULES);
}

/** The review schedule to actually use: the org's configured one when it is
 *  valid, otherwise the built-in default - so one malformed settings node can
 *  never abort the cross-org sweep. */
export function resolveReviewReminderDays(configured: unknown): readonly number[] {
  return resolveReminderDays(configured, REVIEW_REMINDER_RULES);
}

/**
 * Which reminder (if any) a review's nextDue earns today, against a given
 * schedule (defaulting to the built-in one so existing callers and tests need
 * no change).
 *
 * 'lapsed' fires when the due day was YESTERDAY (day difference exactly -1):
 * the same "overdue only once the whole UTC due day has passed" semantics the
 * service-schedule panel shows, so the email and the screen agree. It is
 * independent of the configured schedule - an overdue review always earns its
 * single lapsed notice - and older overdue reviews return null rather than
 * nagging daily.
 */
export function reviewReminderStage(
  nextDue: number,
  now: number,
  reminderDays: readonly number[] = DEFAULT_REVIEW_REMINDER_DAYS,
): ReminderStage | null {
  const daysAhead = utcDayNumber(nextDue) - utcDayNumber(now);
  // The offsets are all positive, so a match here is always an upcoming nudge;
  // the lapsed case (daysAhead === -1) is handled separately below.
  if (reminderDays.includes(daysAhead)) {
    return daysAhead;
  }
  if (daysAhead === -1) {
    return 'lapsed';
  }
  return null;
}

/** Today's UTC calendar day as YYYY-MM-DD - the idempotency-marker key. */
export function utcDayKey(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

/** A deadline reminder is either "n days to go" or the single overdue notice. */
export type DeadlineStage = number | 'lapsed';

/**
 * The generalised form of reviewReminderStage, for deadlines whose reminder
 * ladder differs per concern (an information request runs for a week, an action
 * for up to three months, so they cannot share one set of offsets).
 *
 * Same UTC-day semantics as the review sweep, and deliberately so: an
 * information request's dueBy is stamped from the server clock rather than
 * midnight, so millisecond distance would drift with the hour the auditor
 * happened to press send, whereas the calendar day is what both the reminder
 * and the screen call "due". 'lapsed' fires exactly once, the day after the
 * due day fully passed, so an ignored deadline never nags daily.
 */
export function deadlineReminderStage(
  dueBy: number,
  now: number,
  offsets: readonly number[],
): DeadlineStage | null {
  const daysAhead = utcDayNumber(dueBy) - utcDayNumber(now);
  if (offsets.includes(daysAhead)) {
    return daysAhead;
  }
  if (daysAhead === -1) {
    return 'lapsed';
  }
  return null;
}
