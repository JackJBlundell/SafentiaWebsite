// ============================================================================
// ValidationQueue - the auditor's worklist (FR-E18 surface A).
//
// Three live sections over /assessments/{orgId}:
//   - "Awaiting validation": status === 'readyForValidation', oldest submitted
//     first, because the queue is a promise to assessors - first in, first
//     reviewed.
//   - "Waiting on assessor": status === 'infoRequired', with the count of
//     questions whose information request is still open.
//   - "Ready for release": status === 'readyForRelease' - accepted work that
//     still needs its release, so it can never fall out of sight.
//
// All subscriptions are INDEXED and bounded: database.rules.json declares
// `.indexOn: ["status", ...]` on /assessments/{$orgId}, so each section is an
// orderByChild('status') + equalTo(stage) query capped with limitToFirst - the
// listener pulls only that stage's rows, never the whole subtree (brief 18.7).
//
// An assessment names its building only by id (siteId lives on the Job), so a
// row resolves building name via two single-node reads - job, then building -
// in its own cell component. Both land in the shared query cache, so opening
// the review re-uses them for free. Assessor names come from the gated
// /orgMembers read (the ActivityPage pattern); the route gate already limits
// this area to auditors/admins, both of whom the rules grant that read.
// ============================================================================

import { useMemo } from 'react';
import { equalTo, limitToFirst, orderByChild, query } from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type {
  Assessment,
  AssessmentAnswer,
  Building,
  Job,
  OrgMember,
} from '../../types';
import { ASSESSMENT_STAGE_LABELS } from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable } from '../ui/DataTable';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { actorName } from '../lib/actorName';
import styles from './ValidationQueue.module.css';

/** Upper bound on each section's subscription. A validation queue this deep is
 *  an operational problem long before it is a rendering one; the bound keeps
 *  the listener honest rather than paginating a worklist that should be short. */
const QUEUE_LIMIT = 200;

interface QueueRow extends Assessment {
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

/** One stage's live, indexed, bounded slice of the assessments node. */
function useStageRows(orgId: string, path: string, enabled: boolean, stage: string) {
  const build = useMemo<RtdbQueryBuilder>(
    () => (node) =>
      query(node, orderByChild('status'), equalTo(stage), limitToFirst(QUEUE_LIMIT)),
    [stage],
  );
  const result = useRtdbQuery<Record<string, Assessment> | null>({
    key: keys.assessmentsByStatus(orgId, stage),
    path,
    enabled,
    build,
  });
  const rows = useMemo<QueueRow[]>(
    () =>
      Object.entries(result.data ?? {})
        .map(([id, assessment]) => ({ id, ...assessment }))
        // Oldest submitted first - the queue is first in, first reviewed.
        .sort(
          (a, b) =>
            (a.workflow?.submittedAt ?? a.conductedAt) -
            (b.workflow?.submittedAt ?? b.conductedAt),
        ),
    [result.data],
  );
  return { rows, isLoading: result.isLoading, isError: result.isError };
}

/** Resolves an assessment row's building name: job -> siteId -> building. Two
 *  cached single-node reads; the review page re-uses both. The job read also
 *  carries the job's status for free, so a submission against a since-
 *  cancelled job is badged "Job cancelled" with no extra listener. */
function BuildingName({ jobId }: { jobId: string }) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const jobQuery = useRtdbQuery<Job | null>({
    key: keys.job(orgId, jobId),
    path: paths ? paths.db.job(orgId, jobId) : '',
    enabled: Boolean(orgId && paths),
  });
  const siteId = jobQuery.data?.siteId ?? '';
  const buildingId = jobQuery.data?.buildingId ?? '';
  const buildingQuery = useRtdbQuery<Building | null>({
    key: keys.building(orgId, siteId, buildingId),
    path: paths && siteId ? paths.db.building(orgId, siteId, buildingId) : '',
    enabled: Boolean(orgId && paths && siteId && buildingId),
  });
  return (
    <span className={styles.buildingCell}>
      <span className={styles.buildingName}>
        {buildingQuery.data?.name ?? 'Loading building'}
      </span>
      {jobQuery.data?.status === 'cancelled' && (
        <span className={styles.cancelledBadge}>Job cancelled</span>
      )}
    </span>
  );
}

/** The count of OPEN information requests on an infoRequired assessment. An
 *  open request has no resolvedAt (ARCHITECTURE section 4); a resolved one is
 *  history, not outstanding work. */
function FlaggedCount({ assessmentId }: { assessmentId: string }) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const answersQuery = useRtdbQuery<Record<string, AssessmentAnswer> | null>({
    key: keys.assessmentAnswers(orgId, assessmentId),
    path: paths ? paths.db.assessmentAnswers(orgId, assessmentId) : '',
    enabled: Boolean(orgId && paths),
  });
  const count = Object.values(answersQuery.data ?? {}).filter(
    (answer) => answer.infoRequest && answer.infoRequest.resolvedAt === undefined,
  ).length;
  return (
    <span>
      {count} {count === 1 ? 'question' : 'questions'} flagged
    </span>
  );
}

export function ValidationQueue() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(orgId && paths);
  const assessmentsPath = paths ? paths.db.assessments(orgId) : '';

  const awaiting = useStageRows(orgId, assessmentsPath, enabled, 'readyForValidation');
  const waiting = useStageRows(orgId, assessmentsPath, enabled, 'infoRequired');
  const ready = useStageRows(orgId, assessmentsPath, enabled, 'readyForRelease');

  // The gated members read (the ActivityPage pattern): rules grant /orgMembers
  // to admin, assessor and auditor only. The route gate means everyone here
  // qualifies, but the enable stays explicit so the pattern reads the same in
  // every screen and a future role change cannot leave a denied listener
  // retrying forever.
  const canReadMembers =
    claims?.roles.admin === true ||
    claims?.roles.assessor === true ||
    claims?.roles.auditor === true;
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: enabled && canReadMembers,
  });
  const assessorName = (uid: string): string =>
    actorName(membersQuery.data, uid, membersQuery.data !== undefined);

  const isLoading = awaiting.isLoading || waiting.isLoading || ready.isLoading;
  const isError = awaiting.isError || waiting.isError || ready.isError;
  const isEmpty =
    !isLoading &&
    !isError &&
    awaiting.rows.length === 0 &&
    waiting.rows.length === 0 &&
    ready.rows.length === 0;

  const commonColumns = [
    {
      header: 'Building',
      cell: (row: QueueRow) => <BuildingName jobId={row.jobId} />,
    },
    {
      header: 'Assessor',
      cell: (row: QueueRow) => <span>{assessorName(row.conductedBy)}</span>,
    },
  ];

  return (
    <div className={styles.root}>
      <PageHeader
        title="Validation"
        lede="Submitted assessments awaiting an auditor's review, those returned to their assessor for more information, and accepted assessments awaiting release."
      />

      {isError && (
        <ErrorNotice message="Could not load the validation queue. Please try again." />
      )}

      {isLoading && !isError && (
        <p role="status" className={styles.loading}>
          Loading the validation queue
        </p>
      )}

      {isEmpty && (
        <EmptyState
          title="Nothing waiting"
          body="Submitted assessments appear here the moment an assessor sends them."
        />
      )}

      {!isLoading && !isError && !isEmpty && (
        <>
          <Card flush>
            <CardHeader
              title="Awaiting validation"
              hint="Oldest submission first. Open a row to review it in full."
              action={
                <span className={styles.count} aria-label={`${awaiting.rows.length} awaiting validation`}>
                  {awaiting.rows.length}
                </span>
              }
            />
            {awaiting.rows.length === 0 ? (
              <p className={styles.sectionEmpty}>
                No assessments are waiting for review right now.
              </p>
            ) : (
              <DataTable<QueueRow>
                label={ASSESSMENT_STAGE_LABELS.readyForValidation}
                columns={[
                  ...commonColumns,
                  {
                    header: 'Submitted',
                    cell: (row) => {
                      const at = row.workflow?.submittedAt;
                      return at ? (
                        <time className={styles.time} dateTime={new Date(at).toISOString()}>
                          {dateTimeFormat.format(at)}
                        </time>
                      ) : (
                        <span className={styles.time}>Not recorded</span>
                      );
                    },
                  },
                ]}
                rows={awaiting.rows}
                rowKey={(row) => row.id}
                rowHref={(row) => `/app/validation/${row.id}`}
              />
            )}
          </Card>

          <Card flush>
            <CardHeader
              title="Waiting on assessor"
              hint="Returned with information requests. They come back to the queue when the assessor resubmits."
              action={
                <span className={styles.count} aria-label={`${waiting.rows.length} waiting on assessor`}>
                  {waiting.rows.length}
                </span>
              }
            />
            {waiting.rows.length === 0 ? (
              <p className={styles.sectionEmpty}>
                Nothing is waiting on an assessor right now.
              </p>
            ) : (
              <DataTable<QueueRow>
                label={ASSESSMENT_STAGE_LABELS.infoRequired}
                columns={[
                  ...commonColumns,
                  {
                    header: 'Outstanding',
                    cell: (row) => <FlaggedCount assessmentId={row.id} />,
                  },
                ]}
                rows={waiting.rows}
                rowKey={(row) => row.id}
                rowHref={(row) => `/app/validation/${row.id}`}
              />
            )}
          </Card>

          <Card flush>
            <CardHeader
              title="Ready for release"
              hint="Accepted by an auditor. Open a row to release its report and action plan."
              action={
                <span className={styles.count} aria-label={`${ready.rows.length} ready for release`}>
                  {ready.rows.length}
                </span>
              }
            />
            {ready.rows.length === 0 ? (
              <p className={styles.sectionEmpty}>
                Nothing is waiting to be released right now.
              </p>
            ) : (
              <DataTable<QueueRow>
                label={ASSESSMENT_STAGE_LABELS.readyForRelease}
                columns={[
                  ...commonColumns,
                  {
                    header: 'Accepted',
                    cell: (row) => {
                      const at = row.workflow?.acceptedAt;
                      return at ? (
                        <time className={styles.time} dateTime={new Date(at).toISOString()}>
                          {dateTimeFormat.format(at)}
                        </time>
                      ) : (
                        <span className={styles.time}>Not recorded</span>
                      );
                    },
                  },
                ]}
                rows={ready.rows}
                rowKey={(row) => row.id}
                rowHref={(row) => `/app/validation/${row.id}`}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
