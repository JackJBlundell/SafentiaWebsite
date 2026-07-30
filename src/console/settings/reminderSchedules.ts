// ============================================================================
// reminderSchedules - the reminder-ladder contract (stories 2046 / 2071).
//
// Three sweeps chase three different dated commitments: an FRA review date
// (reviewReminders), an open information request and an open action
// (deadlineReminders). Each runs its own ladder of day offsets, and each ladder
// is now org-configurable, so there has to be exactly ONE definition of which
// ladders are legal. Without it the console would happily save a schedule the
// callable rejects, or - worse - the callable would store one the sweep quietly
// ignores, and nobody would learn that the reminders had stopped.
//
// The ladders differ because the deadlines do. An information request runs for a
// week (INFO_REQUEST_DUE_DAYS), so a 60-day mark on it could never fire; an
// action's window reaches three months at severity L (DUE_WINDOW_DAYS); a review
// is set a year ahead. Hence one rule SET per concern rather than one global
// rule, with the offered choices bounded by the window each concern actually
// uses.
//
// ARCHITECTURE NOTE: like the types and paths contracts, this module has NO
// shared package. It is mirrored byte-for-byte into:
//   - fireritesite/src/console/settings/reminderSchedules.ts  (web console)
//   - fireritesite/functions/src/lib/reminderSchedules.ts     (Cloud Functions)
// Change one, change the other in the same change set; scripts/verify-schema-
// mirror.sh fails the build if the two diverge. It therefore imports NOTHING, so
// the identical text compiles in both projects.
// ============================================================================

/** The rules governing one concern's reminder ladder. */
export interface ReminderScheduleRules {
  /** Used when an organisation has not configured a ladder, or has a malformed
   *  one. Descending, like every stored schedule. */
  readonly defaults: readonly number[];
  /** Most marks one ladder may hold: enough for a rich ladder, few enough that
   *  no organisation can turn a daily sweep into a daily nag. */
  readonly maxMarks: number;
  /** Furthest out a single mark may sit. Past the window the deadline is
   *  actually set within, a mark would simply never fire, so the bound is the
   *  concern's own horizon rather than one number for all three. */
  readonly maxDay: number;
  /** The offsets the settings control offers, descending. Every entry satisfies
   *  the rules above, so anything an admin can pick is valid by construction -
   *  which is the point of a chip control over a free-text field. */
  readonly choices: readonly number[];
}

/** FRA reviews are scheduled a year out, so the ladder starts months ahead: two
 *  months, one month and a week is the built-in default the sweep has always
 *  used. */
export const REVIEW_REMINDER_RULES: ReminderScheduleRules = {
  defaults: [60, 30, 7],
  maxMarks: 8,
  maxDay: 365,
  choices: [90, 60, 30, 14, 7, 3, 1],
};

/** An information request's default window is a week, so its marks are short:
 *  a nudge with a few days left, a final one the day before. Anything beyond a
 *  fortnight would outlive the request itself. */
export const INFO_REQUEST_REMINDER_RULES: ReminderScheduleRules = {
  defaults: [3, 1],
  maxMarks: 6,
  maxDay: 30,
  choices: [14, 7, 5, 3, 2, 1],
};

/** An action's due window runs to ninety days at severity L, so it earns the
 *  longest ladder of the three; the bound allows a little room past that window
 *  for a manually extended due date. */
export const ACTION_REMINDER_RULES: ReminderScheduleRules = {
  defaults: [30, 7, 1],
  maxMarks: 8,
  maxDay: 180,
  choices: [90, 60, 30, 14, 7, 3, 1],
};

/**
 * Whether an arbitrary value is a valid configured ladder for these rules: a
 * non-empty, capped array of strictly-descending positive integers within the
 * concern's horizon. Strictly descending is deliberate - it rejects duplicates
 * and enforces the documented "descending day offsets" in one test, and it means
 * the largest (earliest) mark is always element zero, which reviewReminders
 * relies on when deciding what to withhold from a customer.
 *
 * This is the ONE source of the rules: the console's control validates against
 * it before saving, updateOrgSettings validates against it before storing, and
 * the sweeps resolve against it before matching, so the three cannot drift.
 */
export function isValidReminderDays(
  value: unknown,
  rules: ReminderScheduleRules,
): value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > rules.maxMarks) {
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
      entry > rules.maxDay ||
      entry >= previous
    ) {
      return false;
    }
    previous = entry;
  }
  return true;
}

/**
 * The ladder to actually use: the organisation's configured one when it is
 * valid, otherwise the built-in default. Repairing a malformed config by falling
 * back rather than throwing is what keeps one bad settings node from aborting a
 * whole cross-org sweep.
 */
export function resolveReminderDays(
  configured: unknown,
  rules: ReminderScheduleRules,
): readonly number[] {
  return isValidReminderDays(configured, rules) ? configured : rules.defaults;
}

/**
 * The offsets a settings control should show: the offered choices, plus any
 * mark the organisation has already saved that the list does not offer.
 *
 * A schedule stored before these choices existed - typed into the free-text
 * field the chips replaced - may hold e.g. 45 days. Showing it alongside the
 * offered marks means an admin can see exactly what their organisation runs
 * today and clear it deliberately, rather than have the control silently drop a
 * live reminder the moment the page is saved.
 */
export function reminderDayOptions(
  rules: ReminderScheduleRules,
  selected: readonly number[],
): number[] {
  const days = new Set<number>(rules.choices);
  for (const day of selected) {
    if (Number.isInteger(day) && day >= 1 && day <= rules.maxDay) {
      days.add(day);
    }
  }
  return [...days].sort((a, b) => b - a);
}
