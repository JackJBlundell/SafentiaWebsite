// ============================================================================
// ReportsPage - finance-role reporting over live platform data (story 2040).
//
// Every figure is a roll-up of a read the finance role is allowed to make
// (/buildings, /actions, /jobs and /activity are all org-readable per
// database.rules.json). Derivations live in orgMetrics.ts, shared with the
// organisation dashboard so the two surfaces cannot disagree.
//
// Honesty notes, stated in the UI as well as here:
//   - Jobs do not record a completion timestamp, so a completed job counts in
//     the month it was SCHEDULED for.
//   - Actions do not record a created-at timestamp, so "opened per month" is
//     not derivable; the page reports what is: open now, and closed per month
//     (signedOffAt).
//   - This is ORGANISATION-level reporting (the contract's Financials-role
//     surface), not the platform owner's console. Organisation-facing billing
//     is Phase 3 and is not mentioned here: a page should describe what it is,
//     not apologise for what does not exist yet (product-owner feedback).
// ============================================================================

import { useState } from 'react';
import {
  orderByChild,
  query,
  startAt,
} from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { ActivityEntry, Job, RiskLevel } from '../../types';
import { Card, CardHeader, StatCard } from '../ui/Card';
import { CardGrid } from '../ui/Grid';
import { DataTable, type Column } from '../ui/DataTable';
import { PageHeader } from '../ui/Page';
import { Skeleton, SkeletonStatus } from '../ui/Skeleton';
import { LoadingNote } from '../customers/shared';
import { downloadCsv } from '../lib/csv';
import { isReleaseAction } from '../lib/humaniseActivity';
import { ReleasesChart } from './ReleasesChart';
import {
  buildMonthlySummary,
  buildMonthlySummaryCsv,
  countBuildingsByRisk,
  countOverdueActions,
  countPerMonth,
  flattenActions,
  flattenBuildings,
  lastMonths,
  type ActionsRootNode,
  type BuildingsRootNode,
  type MonthlySummaryRow,
} from './orgMetrics';
import styles from './ReportsPage.module.css';

/** The reporting horizon: the current month and the eleven before it. */
const REPORT_MONTHS = 12;

/** The stat band's risk tiles, matching the dashboard's order and tones. */
const RISK_TILES: Array<{
  level: RiskLevel;
  label: string;
  tone: 'default' | 'warning' | 'danger';
}> = [
  { level: 'high', label: 'High risk', tone: 'danger' },
  { level: 'medium', label: 'Medium risk', tone: 'warning' },
  { level: 'low', label: 'Low risk', tone: 'default' },
  { level: 'pending', label: 'Not yet assessed', tone: 'default' },
];

/** Release events only, shaped for the month counter. The trail's other event
 *  kinds are irrelevant here, so they are dropped at selection time.
 *  isReleaseAction, not an exact string match: releaseAssessment appends a
 *  "(manual risk: ...)" detail when the assessor overrode the derived band,
 *  and those releases count too. */
function selectReleaseTimes(value: unknown): Array<{ at: number }> {
  const node = (value as Record<string, ActivityEntry> | null) ?? {};
  return Object.values(node)
    .filter((entry) => isReleaseAction(entry.action))
    .map((entry) => ({ at: entry.at }));
}

const SUMMARY_COLUMNS: Array<Column<MonthlySummaryRow>> = [
  { header: 'Month', cell: (row) => row.label },
  {
    header: 'Assessments released',
    cell: (row) => row.assessmentsReleased,
    align: 'end',
  },
  { header: 'Jobs scheduled', cell: (row) => row.jobsScheduled, align: 'end' },
  { header: 'Jobs completed', cell: (row) => row.jobsCompleted, align: 'end' },
  {
    header: 'Action items closed',
    cell: (row) => row.actionsClosed,
    align: 'end',
  },
];

export function ReportsPage() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(claims && paths);

  // Frozen at mount so the month window (and with it the subscription keys)
  // does not drift render-to-render; a page left open across midnight keeps
  // its window until revisited, which is the right trade for stable listeners.
  const [now] = useState(() => Date.now());
  const months = lastMonths(REPORT_MONTHS, now);
  // The window opens at the FIRST reporting month's local start.
  const [firstYear, firstMonth] = months[0].key.split('-').map(Number);
  const sinceMs = new Date(firstYear, firstMonth - 1, 1).getTime();

  // The same org-root roll-up reads the dashboard makes (shared cache keys, so
  // visiting both pages costs one listener each, not two).
  const buildingsNode = useRtdbQuery<BuildingsRootNode | null>({
    key: keys.buildingsRoot(orgId),
    path: paths ? paths.db.buildingsRoot(orgId) : '',
    enabled,
  });
  const actionsNode = useRtdbQuery<ActionsRootNode | null>({
    key: keys.actionsRoot(orgId),
    path: paths ? paths.db.actionsRoot(orgId) : '',
    enabled,
  });

  // Whole /jobs node: jobs carry their scheduledFor, so months are derived
  // client-side. One node read is right at current scale (see orgMetrics.ts's
  // scale note); a time-indexed window can bound it later without a key move.
  const jobsNode = useRtdbQuery<Record<string, Job> | null>({
    key: keys.jobs(orgId),
    path: paths ? paths.db.jobs(orgId) : '',
    enabled,
  });

  // Releases inside the reporting horizon: an INDEXED time-range window
  // (orderByChild('at').startAt(sinceMs)), not a whole-trail read.
  const releases = useRtdbQuery<Array<{ at: number }>>({
    key: keys.activitySince(orgId, sinceMs),
    path: paths ? paths.db.activity(orgId) : '',
    select: selectReleaseTimes,
    enabled,
    build: (node) => query(node, orderByChild('at'), startAt(sinceMs)),
  });

  // Derivations tolerate the not-yet-loaded state (a placeholder, never an
  // invented zero); loaded-but-empty nodes are real zeros.
  const buildingRows =
    buildingsNode.data === undefined
      ? undefined
      : flattenBuildings(buildingsNode.data);
  const riskCounts = buildingRows ? countBuildingsByRisk(buildingRows) : undefined;

  const actionRows =
    actionsNode.data === undefined ? undefined : flattenActions(actionsNode.data);
  const openActions = actionRows?.filter((action) => action.status === 'open');
  const overdue = actionRows ? countOverdueActions(actionRows, now) : undefined;

  const jobRecords =
    jobsNode.data === undefined
      ? undefined
      : Object.values(jobsNode.data ?? {});

  const loaded =
    buildingRows !== undefined &&
    actionRows !== undefined &&
    jobRecords !== undefined &&
    releases.data !== undefined;

  const summaryRows = loaded
    ? buildMonthlySummary(months, {
        released: countPerMonth(releases.data),
        jobsScheduled: countPerMonth(
          jobRecords.map((job) => ({ at: job.scheduledFor })),
        ),
        // No completion timestamp exists on a job, so a completed (released)
        // job counts in its SCHEDULED month - stated under the table.
        jobsCompleted: countPerMonth(
          jobRecords
            .filter((job) => job.status === 'released')
            .map((job) => ({ at: job.scheduledFor })),
        ),
        actionsClosed: countPerMonth(
          actionRows.flatMap((action) =>
            action.signedOffAt !== undefined ? [{ at: action.signedOffAt }] : [],
          ),
        ),
      })
    : undefined;

  const exportCsv = () => {
    if (!summaryRows) {
      return;
    }
    downloadCsv(
      buildMonthlySummaryCsv(summaryRows),
      `safentia-monthly-summary-${months[months.length - 1].key}.csv`,
    );
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        lede="Your organisation's assessment and action-plan activity, month by month, from live platform data."
      />

      <div className={styles.sections}>
        <section aria-label="Buildings by current risk">
          <h2 className={styles.sectionTitle}>Buildings by current risk</h2>
          <CardGrid min={170}>
            {RISK_TILES.map((tile) => (
              <StatCard
                key={tile.level}
                label={tile.label}
                value={riskCounts?.[tile.level]}
                hint="buildings"
                tone={tile.tone}
              />
            ))}
          </CardGrid>
        </section>

        <section aria-label="Action plan position">
          <h2 className={styles.sectionTitle}>Action plan position</h2>
          <CardGrid min={170}>
            <StatCard
              label="Open actions"
              value={openActions?.length}
              hint="across all buildings"
            />
            <StatCard
              label="Overdue actions"
              value={overdue?.overdue}
              hint="open, past their due date"
              tone={overdue && overdue.overdue > 0 ? 'warning' : 'default'}
            />
            <StatCard
              label="Life Protection overdue"
              value={overdue?.lifeProtectionOverdue}
              hint="overdue actions that protect life"
              tone={
                overdue && overdue.lifeProtectionOverdue > 0
                  ? 'danger'
                  : 'default'
              }
            />
          </CardGrid>
        </section>

        <Card>
          <CardHeader
            title="Releases per month"
            hint={`Assessments released in each of the last ${REPORT_MONTHS} months; the summary table below carries the same figures.`}
          />
          {releases.data === undefined && (
            <div>
              <SkeletonStatus label="Loading the releases chart" />
              <Skeleton height="120px" />
            </div>
          )}
          {releases.data !== undefined && (
            <ReleasesChart
              months={months}
              counts={countPerMonth(releases.data)}
            />
          )}
        </Card>

        <Card flush>
          <div className={styles.tableHeader}>
            <CardHeader
              title="Monthly summary"
              hint={`The last ${REPORT_MONTHS} months of assessment, job and action activity.`}
              action={
                <Button
                  variant="secondary"
                  onClick={exportCsv}
                  disabled={!summaryRows}
                >
                  Export CSV
                </Button>
              }
            />
          </div>
          {summaryRows === undefined && (
            <div className={styles.tablePad}>
              <LoadingNote>Loading the monthly summary</LoadingNote>
            </div>
          )}
          {summaryRows !== undefined && (
            <>
              <DataTable
                columns={SUMMARY_COLUMNS}
                rows={summaryRows}
                rowKey={(row) => row.key}
                label="Monthly summary"
              />
              <p className={styles.tableNote}>
                Completed jobs count in the month they were scheduled for; jobs
                do not record a separate completion date. Action items do not
                record an opened date, so the summary reports closures
                (sign-offs) rather than openings.
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
