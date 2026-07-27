// ============================================================================
// UK calendar helpers - the one wall clock Safentia's scheduling and copy share.
//
// Safentia is a UK product: assessors, admins and the daily reminder scheduler
// all live on the Europe/London clock, so "today" is the London calendar day,
// never a raw UTC slice (which reads a day off around midnight under BST).
// Formatting in the zone is correct across the BST/GMT switch without any offset
// arithmetic, which is why every helper here goes through Intl rather than doing
// millisecond maths.
//
// Two jobs:
//   - `ukDay` gives a sortable YYYY-MM-DD key for grouping/idempotency markers
//     (dailyJobReminders claims one marker per assessor per UK day).
//   - `ukWhenPhrase` gives the human phrase a notification embeds, so an assessor
//     reading a push knows immediately whether the visit is TODAY - the thing a
//     bare date cannot convey when the morning digest has already been sent.
// ============================================================================

/** Sortable calendar-day key, e.g. '2026-08-12'. en-CA formats as YYYY-MM-DD. */
const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Human date for notification copy, e.g. '12 Aug 2026'. */
const DAY_LABEL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Human 24-hour time for slotted visits, e.g. '14:00'. */
const TIME_LABEL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** The UK calendar day for an epoch-millis value, as a stable YYYY-MM-DD key. */
export function ukDay(millis: number): string {
  return DAY_KEY.format(new Date(millis));
}

/** True when `millis` falls on the same UK calendar day as `now`. */
export function isUkToday(millis: number, now: number = Date.now()): boolean {
  return ukDay(millis) === ukDay(now);
}

/**
 * The calendar day AFTER a YYYY-MM-DD key. Computed on the key itself (via a
 * midday-UTC anchor, safely inside any day) rather than by adding 24 hours to a
 * timestamp: a real 24 hours crosses TWO London days on the spring-forward night,
 * which would call Sunday's job "Monday". Pure calendar arithmetic cannot.
 */
function nextDay(dayKey: string): string {
  const anchor = new Date(`${dayKey}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + 1);
  return anchor.toISOString().slice(0, 10);
}

/**
 * The "when" phrase for notification copy, relative to `now` on the UK clock:
 * 'today', 'tomorrow', or the date - each with the start time appended when the
 * job carries a time slot ('today at 14:00'). Deliberately returns NO preposition
 * so the caller supplies the one its sentence needs ("scheduled for ...",
 * "rescheduled to ...").
 *
 * @param scheduledFor   The visit's start, epoch millis.
 * @param scheduledUntil Present only on slotted jobs; its presence (not its value)
 *                       is what tells us the job has a time worth naming.
 */
export function ukWhenPhrase(
  scheduledFor: number,
  scheduledUntil?: number,
  now: number = Date.now(),
): string {
  const day = ukDay(scheduledFor);
  const today = ukDay(now);

  let phrase: string;
  if (day === today) {
    phrase = 'today';
  } else if (day === nextDay(today)) {
    phrase = 'tomorrow';
  } else {
    phrase = DAY_LABEL.format(new Date(scheduledFor));
  }

  // Date-only jobs (Phase 1 jobs, and any visit booked without a slot) carry no
  // meaningful time of day - naming one would invent precision the admin never set.
  return scheduledUntil === undefined
    ? phrase
    : `${phrase} at ${TIME_LABEL.format(new Date(scheduledFor))}`;
}
