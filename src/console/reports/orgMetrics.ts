// ============================================================================
// orgMetrics - pure roll-ups over the org-wide RTDB nodes (FR-E19).
//
// Both the organisation dashboard (ConsoleHome, story 2035) and the finance
// reporting pages (story 2040) read the same three org-rooted nodes:
//   /buildings/{orgId}  ->  { siteId: { buildingId: Building } }
//   /actions/{orgId}    ->  { buildingId: { actionId: Action } }
//   /activity/{orgId}   ->  bounded, indexed windows (orderByChild('at'))
// and derive their numbers here, in one pure module, so the dashboard tile and
// the report row can never disagree about what "overdue" means.
//
// SCALE NOTE: the org-root reads are ONE subscription each over the whole
// estate, which is right at current scale (tens of buildings, hundreds of
// actions). FUTURE_WORK: when an organisation's action plan outgrows a single
// node read, replace these client roll-ups with server-maintained aggregate
// counters (the ragDistribution precedent) written at release/sign-off time;
// this module's function signatures are the contract those counters replace.
//
// Every figure is traceable to a read: nothing here invents data. Buildings
// with no serviceSchedule simply do not appear in the review list; actions
// without a dueBy are never "overdue"; and Action has NO created-at timestamp,
// so "opened per month" is deliberately not derivable (the reports page says
// so rather than guessing from dueBy).
// ============================================================================

import type { Action, Building, RiskLevel } from '../../types';
import { escapeCsvField, toCsv } from '../lib/csv';

// ----------------------------------------------------------------------------
// Flattening the org-root node shapes.
// ----------------------------------------------------------------------------

/** One building with the ids its console URL needs (Building carries its own
 *  customerId; the siteId is the nesting key of the org-root read). */
export interface BuildingRow {
  siteId: string;
  buildingId: string;
  building: Building;
}

export type BuildingsRootNode = Record<string, Record<string, Building>>;

export function flattenBuildings(
  node: BuildingsRootNode | null | undefined,
): BuildingRow[] {
  if (!node) {
    return [];
  }
  const rows: BuildingRow[] = [];
  for (const [siteId, perSite] of Object.entries(node)) {
    for (const [buildingId, building] of Object.entries(perSite)) {
      rows.push({ siteId, buildingId, building });
    }
  }
  return rows;
}

export type ActionsRootNode = Record<string, Record<string, Action>>;

export function flattenActions(
  node: ActionsRootNode | null | undefined,
): Action[] {
  if (!node) {
    return [];
  }
  return Object.values(node).flatMap((perBuilding) =>
    Object.values(perBuilding),
  );
}

// ----------------------------------------------------------------------------
// Dashboard derivations (story 2035).
// ----------------------------------------------------------------------------

/** Buildings by their STORED risk level - the level the release pipeline
 *  derived via the shared ragDerivation model. The dashboard presents it; it
 *  never re-derives. */
export function countBuildingsByRisk(
  rows: readonly BuildingRow[],
): Record<RiskLevel, number> {
  const counts: Record<RiskLevel, number> = {
    high: 0,
    medium: 0,
    low: 0,
    pending: 0,
  };
  for (const row of rows) {
    // Tolerate an out-of-contract value without inventing a category.
    if (row.building.riskLevel in counts) {
      counts[row.building.riskLevel] += 1;
    }
  }
  return counts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OverdueCounts {
  /** Open actions past their due date. */
  overdue: number;
  /** The escalated subset: overdue AND flagged Life Protection. */
  lifeProtectionOverdue: number;
}

/**
 * THE one overdue derivation (story 2045). Every dueBy comparison in the
 * console - the building's action plan, the dashboard tiles, the customer
 * roll-ups, the reports page - goes through here, so no two surfaces can ever
 * disagree about whether the same action is overdue.
 *
 * An action is overdue when it is still open and the WHOLE due day has passed:
 * dueBy is stored as midnight UTC on the due day (the service-schedule
 * convention), so the action only reads overdue from `dueBy + 24h` onwards -
 * "due by the 9th" means the 9th itself is still on time, not one second past
 * midnight. Actions with no dueBy set are never overdue - absence of a
 * deadline is not a breach of one.
 */
export function isActionOverdue(action: Action, now: number): boolean {
  return (
    action.status === 'open' &&
    action.dueBy !== undefined &&
    now >= action.dueBy + DAY_MS
  );
}

/** Roll `isActionOverdue` up over a plan; the LTP subset is the escalated
 *  count the dashboards tile separately. */
export function countOverdueActions(
  actions: readonly Action[],
  now: number,
): OverdueCounts {
  let overdue = 0;
  let lifeProtectionOverdue = 0;
  for (const action of actions) {
    if (isActionOverdue(action, now)) {
      overdue += 1;
      if (action.lifeProtection) {
        lifeProtectionOverdue += 1;
      }
    }
  }
  return { overdue, lifeProtectionOverdue };
}

/** The review horizon: FRA reviews due in the next 60 days make the list. */
export const REVIEW_WINDOW_DAYS = 60;

export interface ReviewRow extends BuildingRow {
  /** The building's fraReview nextDue (epoch millis). */
  nextDue: number;
  /** Past due: the review date has already gone by. */
  lapsed: boolean;
}

/**
 * Buildings whose FRA review (serviceSchedule.fraReview.nextDue) is lapsed or
 * falls within the next `REVIEW_WINDOW_DAYS`. Lapsed reviews are pinned first
 * (most-lapsed at the top - the longest-outstanding is the most urgent), then
 * upcoming ones soonest-first.
 */
export function upcomingReviews(
  rows: readonly BuildingRow[],
  now: number,
): ReviewRow[] {
  const horizon = now + REVIEW_WINDOW_DAYS * DAY_MS;
  return rows
    .flatMap<ReviewRow>((row) => {
      const nextDue = row.building.serviceSchedule?.fraReview?.nextDue;
      if (nextDue === undefined || nextDue > horizon) {
        return [];
      }
      return [{ ...row, nextDue, lapsed: nextDue < now }];
    })
    .sort((a, b) => {
      if (a.lapsed !== b.lapsed) {
        return a.lapsed ? -1 : 1;
      }
      return a.nextDue - b.nextDue;
    });
}

// ----------------------------------------------------------------------------
// Monthly reporting derivations (story 2040).
// ----------------------------------------------------------------------------

/** The shape both monthly-report sources share: a thing that happened at a
 *  moment (an activity entry's `at`, a job's `scheduledFor`, an action's
 *  `signedOffAt`). */
interface Stamped {
  at: number;
}

/** "2026-06" - a sortable, unambiguous month key in LOCAL time (the console is
 *  a UK product; reporting months are the operator's calendar months). */
export function monthKey(millis: number): string {
  const date = new Date(millis);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

const monthLabelFormat = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: 'numeric',
});

/** The last `count` calendar months ending with the current one, oldest first:
 *  [{ key: '2026-02', label: 'Feb 2026' }, ...]. */
export function lastMonths(
  count: number,
  now: number,
): Array<{ key: string; label: string }> {
  const anchor = new Date(now);
  const months: Array<{ key: string; label: string }> = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const date = new Date(anchor.getFullYear(), anchor.getMonth() - back, 1);
    months.push({ key: monthKey(date.getTime()), label: monthLabelFormat.format(date) });
  }
  return months;
}

/** Count stamped events per month key. */
export function countPerMonth(events: readonly Stamped[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = monthKey(event.at);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface MonthlySummaryRow {
  key: string;
  label: string;
  assessmentsReleased: number;
  jobsScheduled: number;
  jobsCompleted: number;
  actionsClosed: number;
}

/** Assemble the monthly summary table from per-source month counts. Months
 *  with no events in any column render honest zeros: within the reporting
 *  window a month DID happen and nothing occurred in it. */
export function buildMonthlySummary(
  months: ReadonlyArray<{ key: string; label: string }>,
  sources: {
    released: Map<string, number>;
    jobsScheduled: Map<string, number>;
    jobsCompleted: Map<string, number>;
    actionsClosed: Map<string, number>;
  },
): MonthlySummaryRow[] {
  return months.map(({ key, label }) => ({
    key,
    label,
    assessmentsReleased: sources.released.get(key) ?? 0,
    jobsScheduled: sources.jobsScheduled.get(key) ?? 0,
    jobsCompleted: sources.jobsCompleted.get(key) ?? 0,
    actionsClosed: sources.actionsClosed.get(key) ?? 0,
  }));
}

// ----------------------------------------------------------------------------
// CSV. The escaping and serialising contract lives in ../lib/csv (one
// definition, shared with the log book export and the CSV import);
// escapeCsvField is re-exported because this module's tests assert it beside
// the builder below.
// ----------------------------------------------------------------------------

export { escapeCsvField };

/** Serialise the monthly summary to CSV (CRLF per RFC 4180). Pure, exported
 *  for tests; the page wraps it in a Blob download. */
export function buildMonthlySummaryCsv(
  rows: readonly MonthlySummaryRow[],
): string {
  const header = [
    'Month',
    'Assessments released',
    'Jobs scheduled',
    'Jobs completed',
    'Action items closed',
  ];
  const lines = [
    header,
    ...rows.map((row) => [
      row.label,
      String(row.assessmentsReleased),
      String(row.jobsScheduled),
      String(row.jobsCompleted),
      String(row.actionsClosed),
    ]),
  ];
  return toCsv(lines);
}
