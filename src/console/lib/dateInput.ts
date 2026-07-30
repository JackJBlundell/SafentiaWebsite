// ============================================================================
// dateInput - the ONE conversion between an <input type="date"> and the epoch
// millis the platform stores.
//
// Every date the console captures (a service review date, an action's due-by, a
// contract end date) is stored as MIDNIGHT UTC, so a date means the same day to
// the server sweeps that compare by UTC day and to a browser in any timezone.
// The conversion was written out three times before this module; each copy was
// correct, but a fourth would eventually not have been.
// ============================================================================

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch millis -> the yyyy-mm-dd a date input wants, in UTC. */
export function toDateInputValue(epochMillis: number | undefined): string {
  if (epochMillis === undefined) {
    return '';
  }
  return new Date(epochMillis).toISOString().slice(0, 10);
}

/** yyyy-mm-dd -> epoch millis at midnight UTC (the platform convention).
 *  Undefined for an empty field, and for anything that is not a real date -
 *  a caller that needs to TELL the person why should check for undefined. */
export function fromDateInputValue(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }
  const millis = Date.UTC(year, month - 1, day);
  return Number.isFinite(millis) ? millis : undefined;
}

/** Midnight UTC today - the boundary a "must be in the future" check compares
 *  against, so today itself is never accepted as a future date. */
export function todayUtc(): number {
  return Math.floor(Date.now() / DAY_MS) * DAY_MS;
}
