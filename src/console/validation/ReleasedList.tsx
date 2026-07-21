// ============================================================================
// ReleasedList - the organisation's released assessments in one place
// (FR-E18 surface C), at /app/validation/released.
//
// Released work only ever surfaced piecemeal before this: the dashboard's
// "Recent releases" card, the activity trail, and each building's own history.
// None of them answered "show me everything this organisation has released".
// This does, as a single newest-first list that opens each row back on the
// assessment review page - the same page that now carries the report download
// and the link into the building's full history.
//
// The subscription is INDEXED and bounded, exactly as the queue's are:
// database.rules.json declares `.indexOn: ["status", ...]` on
// /assessments/{orgId}, so this is an orderByChild('status') + equalTo
// ('released') query capped with limitToLast - the listener pulls only released
// rows, never the whole subtree. limitToLast bounds the window to the most
// recent slice; a busy estate can release more than the cap, so the list says
// so rather than implying it is exhaustive.
//
// Each row's building name, customer name and RAG risk are resolved by cached
// single-node reads (the queue's pattern), and every one degrades to the raw id
// rather than a broken row or link when the record is dangling. The release
// attribution (workflow.releasedBy) is resolved through the same gated
// /orgMembers read the rest of the area uses.
// ============================================================================

import { useMemo } from 'react';
import { equalTo, limitToLast, orderByChild, query } from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type {
  Assessment,
  Building,
  Customer,
  Job,
  OrgMember,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable } from '../ui/DataTable';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { RagChip } from '../customers/shared';
import { actorName } from '../lib/actorName';
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

/** The best available release timestamp. releaseAssessment stamps releasedAt,
 *  so it is present on everything released since; acceptedAt (the immediately
 *  prior transition) and finally the conducted date cover older records, so a
 *  row always sorts and dates against a real, recorded moment. */
function releasedAt(assessment: Assessment): number {
  return (
    assessment.workflow?.releasedAt ??
    assessment.workflow?.acceptedAt ??
    assessment.conductedAt
  );
}

/** Resolves an assessment row's building: job -> siteId -> building, two cached
 *  single-node reads the review page re-uses for free. Renders the name, or the
 *  raw building id if the record is dangling - never a broken cell. */
function BuildingName({ jobId, buildingId }: { jobId: string; buildingId: string }) {
  const building = useBuilding(jobId, buildingId);
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
  const building = useBuilding(jobId, buildingId);
  if (!building) {
    return <span className={styles.muted}>Risk unavailable</span>;
  }
  return <RagChip level={building.riskLevel} />;
}

/** Shared job -> siteId -> building resolution for the two building cells. Both
 *  cells read the same keys, so the second is served from cache. */
function useBuilding(jobId: string, buildingId: string): Building | null {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const jobQuery = useRtdbQuery<Job | null>({
    key: keys.job(orgId, jobId),
    path: paths && jobId ? paths.db.job(orgId, jobId) : '',
    enabled: Boolean(orgId && paths && jobId),
  });
  const siteId = jobQuery.data?.siteId ?? '';
  const buildingQuery = useRtdbQuery<Building | null>({
    key: keys.building(orgId, siteId, buildingId),
    path: paths && siteId ? paths.db.building(orgId, siteId, buildingId) : '',
    enabled: Boolean(orgId && paths && siteId && buildingId),
  });
  return buildingQuery.data ?? null;
}

/** The customer's name from a cached single-node read, degrading to the raw
 *  customer id when the record is dangling. */
function CustomerName({ customerId }: { customerId: string }) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const customerQuery = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId, customerId),
    path: paths && customerId ? paths.db.customer(orgId, customerId) : '',
    enabled: Boolean(orgId && paths && customerId),
  });
  return <span>{customerQuery.data?.name ?? customerId}</span>;
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
            hint="Open a row to review the assessment, download its report, or reach the building's full history."
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
                header: 'Released',
                cell: (row) => {
                  const at = releasedAt(row);
                  return (
                    <time className={styles.time} dateTime={new Date(at).toISOString()}>
                      {dateTimeFormat.format(at)}
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
