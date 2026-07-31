// ============================================================================
// ReleasedList - the organisation's released assessments in one place
// (FR-E18 surface C), at /app/validation/released.
//
// Released work only ever surfaced piecemeal before this: the dashboard's
// "Recent releases" card, the activity trail, and each building's own history.
// None of them answered "show me everything this organisation has released".
// This does, as a single newest-first list that opens each row back on the
// assessment review page - the same page that carries the full assessment and
// the link into the building's history - while the report PDF itself is
// reachable from the row, without opening anything.
//
// The subscription is INDEXED and bounded, exactly as the queue's are:
// database.rules.json declares `.indexOn: ["status", ...]` on
// /assessments/{orgId}, so this is an orderByChild('status') + equalTo
// ('released') query capped with limitToLast - the listener pulls only released
// rows, never the whole subtree. limitToLast bounds the window to the most
// recent slice; a busy estate can release more than the cap, so the list says
// so rather than implying it is exhaustive.
//
// Each row's building name, customer name, template, RAG risk and report are
// resolved by the shared cached single-node reads in releaseShared, and every
// one degrades to the raw id (or to calm words) rather than a broken row. The
// release attribution (workflow.releasedBy) is resolved through the same gated
// /orgMembers read the rest of the area uses.
// ============================================================================

import { useMemo } from 'react';
import { equalTo, limitToLast, orderByChild, query } from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type { Assessment, OrgMember } from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable } from '../ui/DataTable';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { RiskDot, formatDateShort } from '../customers/shared';
import { actorName } from '../lib/actorName';
import {
  ReportLink,
  releasedAt,
  templateLabel,
  useCustomerName,
  useReleaseBuilding,
} from './releaseShared';
import styles from './ReleasedList.module.css';

/** Upper bound on the released-assessments window. Deep enough that the common
 *  "what have we released lately" question is answered in full, bounded so the
 *  listener never pulls an unbounded history; the list is honest that it is a
 *  window, not the complete archive (the building history is that). */
const RELEASED_LIMIT = 200;

interface ReleasedRow extends Assessment {
  id: string;
}

/** British date, 24-hour time: "12 Jun 2026, 14:03". */
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** The row's building name, or the raw building id if the record is dangling -
 *  never a broken cell. */
function BuildingName({ jobId, buildingId }: { jobId: string; buildingId: string }) {
  const { building } = useReleaseBuilding(jobId, buildingId);
  return (
    <span className={styles.buildingName}>
      {building?.name ?? buildingId}
    </span>
  );
}

/** The building's STORED risk level as a RAG chip - never re-derived here; the
 *  release pipeline set it. While the building is resolving, or if the record
 *  is dangling, a plain text placeholder stands in so colour is never asked to
 *  carry a meaning the row does not yet know. */
function BuildingRisk({ jobId, buildingId }: { jobId: string; buildingId: string }) {
  const { building } = useReleaseBuilding(jobId, buildingId);
  if (!building) {
    // A dash carrying the reason, so the column stays one glyph wide even when
    // the record is missing - the words used to wrap to three lines here.
    return (
      <span
        className={styles.muted}
        role="img"
        aria-label="Risk unavailable"
        title="Risk unavailable"
      >
        –
      </span>
    );
  }
  // The dot, not the chip: a risk COLUMN has room for one glyph. The level's
  // words remain the accessible name and the tooltip.
  return <RiskDot level={building.riskLevel} />;
}

/** The customer's name, degrading to the raw customer id when the record is
 *  dangling. */
function CustomerName({ customerId }: { customerId: string }) {
  const name = useCustomerName(customerId);
  // Same two-line clamp as the template column, and for the same reason: a
  // customer name is often three or four words and was setting the row height.
  return (
    <span className={styles.wrap} title={name}>
      {name}
    </span>
  );
}

/** The report affordance needs a subject for its accessible name, and that
 *  subject is the building this release covers. */
function RowReport({ row }: { row: ReleasedRow }) {
  const { building } = useReleaseBuilding(row.jobId, row.buildingId);
  return (
    <ReportLink
      buildingId={row.buildingId}
      assessmentId={row.id}
      subject={building?.name ?? row.buildingId}
    />
  );
}

export function ReleasedList() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(orgId && paths);

  // The indexed, bounded released slice - the queue's stage-query pattern, but
  // limitToLast for the most recent releases rather than limitToFirst for the
  // oldest waiting work.
  const build = useMemo<RtdbQueryBuilder>(
    () => (node) =>
      query(node, orderByChild('status'), equalTo('released'), limitToLast(RELEASED_LIMIT)),
    [],
  );
  const result = useRtdbQuery<Record<string, Assessment> | null>({
    key: keys.assessmentsByStatus(orgId, 'released'),
    path: paths ? paths.db.assessments(orgId) : '',
    enabled,
    build,
  });

  const rows = useMemo<ReleasedRow[]>(
    () =>
      Object.entries(result.data ?? {})
        .map(([id, assessment]) => ({ id, ...assessment }))
        // Newest release first - this reads as a running record of what has
        // just gone out of the door.
        .sort((a, b) => releasedAt(b) - releasedAt(a)),
    [result.data],
  );

  // The gated members read (the ActivityPage pattern) that resolves the
  // releaser uid to a name; the route gate means everyone here qualifies, but
  // the enable stays explicit so a future role change cannot leave a denied
  // listener retrying forever.
  const canReadMembers =
    claims?.roles.admin === true ||
    claims?.roles.assessor === true ||
    claims?.roles.auditor === true;
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: enabled && canReadMembers,
  });
  const releaserName = (uid: string): string =>
    actorName(membersQuery.data, uid, membersQuery.data !== undefined);

  return (
    <div className={styles.root}>
      <PageHeader
        title="Released"
        lede={`Assessments released to their customers, newest first. The list shows up to the most recent ${RELEASED_LIMIT} releases; a building's own record holds its complete history.`}
      />

      {result.isError && (
        <ErrorNotice message="Could not load released assessments. Please try again." />
      )}

      {result.isLoading && !result.isError && (
        <p role="status" className={styles.loading}>
          Loading released assessments
        </p>
      )}

      {!result.isLoading && !result.isError && rows.length === 0 && (
        <EmptyState
          title="Nothing released yet"
          body="No assessments have been released yet. Released assessments appear here the moment an auditor releases them."
        />
      )}

      {!result.isLoading && !result.isError && rows.length > 0 && (
        <Card flush>
          <CardHeader
            title="Released assessments"
            hint="Download a report straight from its row, or open the row to review the assessment and reach the building's full history."
            action={
              <span className={styles.count} aria-label={`${rows.length} released assessments`}>
                {rows.length}
              </span>
            }
          />
          <DataTable<ReleasedRow>
            label="Released assessments"
            columns={[
              {
                header: 'Building',
                cell: (row) => (
                  <BuildingName jobId={row.jobId} buildingId={row.buildingId} />
                ),
              },
              {
                header: 'Customer',
                cell: (row) => <CustomerName customerId={row.customerId} />,
              },
              {
                header: 'Template',
                // Clamped to two lines (see .wrap), so the full name is carried
                // on the title - the clamp must never be the only copy of it.
                cell: (row) => {
                  const label = templateLabel(row.templateSnapshot);
                  return (
                    <span className={styles.wrap} title={label}>
                      {label}
                    </span>
                  );
                },
              },
              {
                header: 'Released',
                // Numeric date only. The exact time is on the title for anyone
                // who needs it; in the column it cost a third of the width for a
                // precision nobody scans a release list for.
                cell: (row) => {
                  const at = releasedAt(row);
                  return (
                    <time
                      className={styles.time}
                      dateTime={new Date(at).toISOString()}
                      title={dateTimeFormat.format(at)}
                    >
                      {formatDateShort(at)}
                    </time>
                  );
                },
              },
              {
                header: 'Released by',
                cell: (row) => (
                  <span>
                    {row.workflow?.releasedBy
                      ? releaserName(row.workflow.releasedBy)
                      : 'Not recorded'}
                  </span>
                ),
              },
              {
                header: 'Risk',
                cell: (row) => (
                  <BuildingRisk jobId={row.jobId} buildingId={row.buildingId} />
                ),
              },
              {
                header: 'Report',
                align: 'end',
                width: '1%',
                // Its own trailing cell, so the download sits above the row's
                // stretched link rather than competing with it (DataTable gives
                // every non-link cell the higher stacking context).
                cell: (row) => <RowReport row={row} />,
              },
            ]}
            rows={rows}
            rowKey={(row) => row.id}
            rowHref={(row) => `/app/validation/${row.id}`}
          />
        </Card>
      )}
    </div>
  );
}
