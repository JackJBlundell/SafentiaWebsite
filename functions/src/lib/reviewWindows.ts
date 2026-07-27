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

/** The built-in reminder schedule used when an org has not configured its own,
 *  or has a malformed one. Descending, matching the OrgSettings contract. Kept
 *  as the single fallback so an unconfigured org still gets sensible reminders
 *  at two months, one month and one week out. */
export const DEFAULT_REVIEW_REMINDER_DAYS: readonly number[] = [60, 30, 7];

/** A configured schedule may hold at most this many marks: enough for a rich
 *  ladder, low enough that no org can turn the sweep into a daily nag. */
export const MAX_REVIEW_REMINDER_DAYS = 8;

/** No single mark may sit further out than a year: beyond that the reminder is
 *  noise, and it also bounds the values the sweep compares against. */
export const MAX_REVIEW_REMINDER_DAY = 365;

/**
 * Whether an arbitrary value is a valid configured reminder schedule: a non-
 * empty, capped array of strictly-descending positive integers, each within a
 * year. Strictly descending is deliberate - it rejects duplicates and enforces
 * the "descending day offsets" the contract documents in one test, and it means
 * the largest (earliest) mark is always element zero. This is the ONE source of
 * the rules, shared by the server validator (updateOrgSettings) and the sweep,
 * so the client, the callable and the reminder computation cannot drift.
 */
export function isValidReviewReminderDays(value: unknown): value is number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_REVIEW_REMINDER_DAYS
  ) {
    return false;
  }
  // `previous` starts at +Infinity so the first entry only has to be finite and
  // in range; each subsequent entry must be strictly smaller than the last.
  let previous = Number.POSITIVE_INFINITY;
  for (const entry of value) {
    if (
      typeof entry !== 'number' ||
      !Number.isInteger(entry) ||
      entry < 1 ||
      entry > MAX_REVIEW_REMINDER_DAY ||
      entry >= previous
    ) {
      return false;
    }
    previous = entry;
  }
  return true;
}

/**
 * The reminder schedule to actually use: the org's configured one when it is
 * valid, otherwise the built-in default. Repairing a malformed config by
 * falling back (rather than throwing) is what keeps a single bad settings node
 * from aborting the whole cross-org sweep.
 */
export function resolveReviewReminderDays(configured: unknown): readonly number[] {
  return isValidReviewReminderDays(configured)
    ? configured
    : DEFAULT_REVIEW_REMINDER_DAYS;
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
