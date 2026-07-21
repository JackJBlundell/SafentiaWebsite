// ============================================================================
// StaffProfile - one member's page (/app/staff/:memberUid): who they are, what
// they have done, and (for admins) the controls to manage them.
//
// It is the detail half of the staff master/detail: the directory links here,
// and so does global search. It reads three strands of the member's history,
// each a BOUNDED, INDEXED query so a busy org never pulls a whole node:
//   - Actions   - /activity filtered by actorUid  (indexed: activity.actorUid)
//   - Assessments - /assessments by conductedBy    (indexed: assessments.conductedBy)
//   - Jobs      - /jobs filtered by assessorUid     (indexed: jobs.assessorUid)
// Each strand is the most recent window; the card says so when the window is
// full, because older history exists beyond it. History is strictly read-only.
//
// The member's role/status management (the MemberPanel below) MOVED here from
// the directory, so a member is edited on their own page. It is admin-only and
// keeps every guard it had: the client-side last-administrator pre-guard, and
// the server's transactional refusal as the real backstop.
//
// Reads that need /orgMembers ride the same role gate the console uses
// elsewhere (admin/assessor/auditor); the route gate in StaffRoutes keeps a
// viewer/finance out with a calm notice, so those reads never fire for them.
// ============================================================================

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { equalTo, limitToLast, orderByChild, query } from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import {
  ASSESSMENT_STAGE_LABELS,
  ORG_ROLES,
} from '../../types';
import type {
  ActivityEntry,
  Assessment,
  Customer,
  Job,
  OrgMember,
  OrgRole,
  OrgRoleSet,
  MemberStatus,
  UpdateMemberInput,
  UpdateMemberResult,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable } from '../ui/DataTable';
import { DescriptionList, PageGrid } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { useCallable } from '../ui/useCallable';
import {
  activityTargetUrl,
  humaniseAction,
  sentenceCase,
} from '../lib/humaniseActivity';
import {
  flattenBuildings,
  type BuildingsRootNode,
} from '../reports/orgMetrics';
import { jobUrls, JobStatusBadge } from '../jobs/shared';
import {
  ROLE_LABELS,
  RoleChips,
  StatusBadge,
  britishDate,
  roleList,
  staffUrls,
} from './shared';
import styles from './StaffProfile.module.css';

/** The most recent N of each history strand. Each read is limitToLast(N) on an
 *  indexed field, so this bounds the listener rather than filtering on the
 *  client; the card states the window honestly when it is full. */
const HISTORY_WINDOW = 100;

/** British date, 24-hour time: "12 Jun 2026, 14:03". */
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

interface ActivityRow extends ActivityEntry {
  id: string;
}
interface AssessmentRow {
  id: string;
  assessment: Assessment;
}
interface JobRow {
  id: string;
  job: Job;
}

/** Newest-first activity rows. The selector runs off the cached raw value,
 *  which carries no iteration order, so the order is derived from `at`. */
function selectActivityRows(value: unknown): ActivityRow[] {
  const node = (value as Record<string, ActivityEntry> | null) ?? {};
  return Object.entries(node)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.at - a.at);
}

export function StaffProfile() {
  const { memberUid = '' } = useParams();
  const { claims, paths, user } = useAuth();
  const orgId = claims?.orgId ?? '';
  const isAdmin = claims?.roles.admin === true;
  const enabled = Boolean(orgId && paths && memberUid);

  // The whole directory node: it holds the member's own record AND lets the
  // last-administrator guard count active admins. The same read the directory,
  // activity log and validation queue already make, so its cache is shared.
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled,
  });
  const members = membersQuery.data;
  const member = members?.[memberUid] ?? null;

  // Building and customer directories, for naming an assessment's building and a
  // job's customer. Org-readable by any active member; cache shared with the
  // dashboard and reports, so no new listener when those have been visited.
  const buildingsQuery = useRtdbQuery<BuildingsRootNode | null>({
    key: keys.buildingsRoot(orgId),
    path: paths ? paths.db.buildingsRoot(orgId) : '',
    enabled,
  });
  const customersQuery = useRtdbQuery<Record<string, Customer> | null>({
    key: keys.customers(orgId),
    path: paths ? paths.db.customers(orgId) : '',
    enabled,
  });

  const buildingNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of flattenBuildings(buildingsQuery.data)) {
      map.set(row.buildingId, row.building.name);
    }
    return map;
  }, [buildingsQuery.data]);
  const buildingName = (buildingId: string): string =>
    buildingNames.get(buildingId) ?? buildingId;
  const customerName = (customerId: string): string =>
    customersQuery.data?.[customerId]?.name ?? customerId;

  // --- The three history strands: bounded, indexed windows -------------------
  const buildActorWindow = useMemo<RtdbQueryBuilder>(
    () => (node) =>
      query(node, orderByChild('actorUid'), equalTo(memberUid), limitToLast(HISTORY_WINDOW)),
    [memberUid],
  );
  const activityQuery = useRtdbQuery<ActivityRow[]>({
    key: ['activity', orgId, 'actor', memberUid],
    path: paths ? paths.db.activity(orgId) : '',
    select: selectActivityRows,
    enabled,
    build: buildActorWindow,
  });

  const buildConductedWindow = useMemo<RtdbQueryBuilder>(
    () => (node) =>
      query(node, orderByChild('conductedBy'), equalTo(memberUid), limitToLast(HISTORY_WINDOW)),
    [memberUid],
  );
  const assessmentsQuery = useRtdbQuery<Record<string, Assessment> | null>({
    key: ['assessments', orgId, 'conductedBy', memberUid],
    path: paths ? paths.db.assessments(orgId) : '',
    enabled,
    build: buildConductedWindow,
  });

  const buildAssignedWindow = useMemo<RtdbQueryBuilder>(
    () => (node) =>
      query(node, orderByChild('assessorUid'), equalTo(memberUid), limitToLast(HISTORY_WINDOW)),
    [memberUid],
  );
  const jobsQuery = useRtdbQuery<Record<string, Job> | null>({
    key: keys.assessorJobList(orgId, memberUid),
    path: paths ? paths.db.jobs(orgId) : '',
    enabled,
    build: buildAssignedWindow,
  });

  const assessmentRows = useMemo<AssessmentRow[]>(
    () =>
      Object.entries(assessmentsQuery.data ?? {})
        .map(([id, assessment]) => ({ id, assessment }))
        .sort((a, b) => b.assessment.conductedAt - a.assessment.conductedAt),
    [assessmentsQuery.data],
  );
  const jobRows = useMemo<JobRow[]>(
    () =>
      Object.entries(jobsQuery.data ?? {})
        .map(([id, job]) => ({ id, job }))
        .sort((a, b) => b.job.scheduledFor - a.job.scheduledFor),
    [jobsQuery.data],
  );
  const activityRows = activityQuery.data ?? [];

  // --- The member header / not-found / loading gate --------------------------
  if (!member) {
    return (
      <div>
        <PageHeader
          title="Staff member"
          crumbs={[{ label: 'Staff', to: staffUrls.staff }]}
        />
        {membersQuery.isError ? (
          <ErrorNotice message="Could not load this member. Please try again." />
        ) : members === undefined ? (
          <Card>
            <SkeletonRows rows={3} label="Loading member" />
          </Card>
        ) : (
          <EmptyState
            title="Member not found"
            body="This person is not a member of your organisation, or their membership has been removed. Their recorded history, if any, remains in the activity log."
          />
        )}
      </div>
    );
  }

  const activeAdminCount = Object.values(members ?? {}).filter(
    (m) => m.status === 'active' && m.roles?.admin === true,
  ).length;
  const isSoleAdmin =
    member.roles?.admin === true &&
    member.status === 'active' &&
    activeAdminCount === 1;
  const isSelf = memberUid === user?.uid;

  return (
    <div>
      <PageHeader
        title={member.name}
        crumbs={[
          { label: 'Staff', to: staffUrls.staff },
          { label: member.name },
        ]}
        badges={<StatusBadge status={member.status} />}
      />

      <PageGrid
        aside={
          <>
            <Card>
              <CardHeader title="Member" />
              <DescriptionList
                items={[
                  { label: 'Email', value: member.email },
                  {
                    label: 'Roles',
                    value: (
                      <RoleChips
                        roles={member.roles}
                        label={`Roles for ${member.name}`}
                      />
                    ),
                  },
                  { label: 'Status', value: <StatusBadge status={member.status} /> },
                ]}
              />
            </Card>
            {isAdmin && (
              <Card>
                <CardHeader
                  title="Manage member"
                  hint="Roles decide what this person can do; status changes take effect on their next token refresh."
                />
                <MemberPanel
                  uid={memberUid}
                  member={member}
                  isSoleAdmin={isSoleAdmin}
                  isSelf={isSelf}
                />
              </Card>
            )}
          </>
        }
      >
        <ActionsCard
          rows={activityRows}
          isLoading={activityQuery.isLoading}
          isError={activityQuery.isError}
          name={member.name}
        />
        <AssessmentsCard
          rows={assessmentRows}
          isLoading={assessmentsQuery.isLoading}
          isError={assessmentsQuery.isError}
          name={member.name}
          buildingName={buildingName}
        />
        <JobsCard
          rows={jobRows}
          isLoading={jobsQuery.isLoading}
          isError={jobsQuery.isError}
          name={member.name}
          buildingName={buildingName}
          customerName={customerName}
        />
      </PageGrid>
    </div>
  );
}

/** Shared window-full note: history beyond the most recent window is not loaded,
 *  so the card says so rather than implying it shows everything. */
function windowHint(count: number): string | undefined {
  return count >= HISTORY_WINDOW
    ? `Showing the most recent ${HISTORY_WINDOW}`
    : undefined;
}

// ----------------------------------------------------------------------------
// Actions performed by this member (the audit trail, filtered to their uid).
// ----------------------------------------------------------------------------

function ActionsCard({
  rows,
  isLoading,
  isError,
  name,
}: {
  rows: ActivityRow[];
  isLoading: boolean;
  isError: boolean;
  name: string;
}) {
  return (
    <Card flush>
      <CardHeader title="Actions" hint={windowHint(rows.length)} />
      {isError ? (
        <p className={styles.cardMessage}>
          <ErrorNotice message="Could not load this member's actions. Please try again." />
        </p>
      ) : isLoading && rows.length === 0 ? (
        <div className={styles.cardPad}>
          <SkeletonRows rows={4} label={`Loading actions by ${name}`} />
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.cardMessage}>
          No recorded actions for {name} yet. Actions appear here as they work.
        </p>
      ) : (
        <DataTable<ActivityRow>
          label={`Actions by ${name}`}
          columns={[
            {
              header: 'When',
              width: '1%',
              cell: (row) => (
                <time
                  className={styles.time}
                  dateTime={new Date(row.at).toISOString()}
                >
                  {dateTimeFormat.format(row.at)}
                </time>
              ),
            },
            {
              header: 'Action',
              cell: (row) => {
                const { phrase, detail } = humaniseAction(row.action);
                return (
                  <span title={row.action}>
                    {sentenceCase(phrase)}
                    {detail ? ` (${detail})` : ''}
                  </span>
                );
              },
            },
            {
              header: 'Target',
              cell: (row) => {
                const targetUrl = activityTargetUrl(row.action, row.target);
                return targetUrl ? (
                  <Link to={targetUrl} className={styles.targetLink}>
                    {row.target}
                  </Link>
                ) : (
                  <span className={styles.target}>{row.target}</span>
                );
              },
            },
          ]}
          rows={rows}
          rowKey={(row) => row.id}
        />
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Assessments this member conducted. Each row links to the review page.
// ----------------------------------------------------------------------------

function AssessmentsCard({
  rows,
  isLoading,
  isError,
  name,
  buildingName,
}: {
  rows: AssessmentRow[];
  isLoading: boolean;
  isError: boolean;
  name: string;
  buildingName: (buildingId: string) => string;
}) {
  return (
    <Card flush>
      <CardHeader title="Assessments conducted" hint={windowHint(rows.length)} />
      {isError ? (
        <p className={styles.cardMessage}>
          <ErrorNotice message="Could not load this member's assessments. Please try again." />
        </p>
      ) : isLoading && rows.length === 0 ? (
        <div className={styles.cardPad}>
          <SkeletonRows rows={3} label={`Loading assessments by ${name}`} />
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.cardMessage}>
          {name} has not conducted any assessments yet.
        </p>
      ) : (
        <DataTable<AssessmentRow>
          label={`Assessments conducted by ${name}`}
          rowHref={({ id }) => jobUrls.validation(id)}
          columns={[
            {
              header: 'Building',
              cell: ({ assessment }) => (
                <span className={styles.strong}>
                  {buildingName(assessment.buildingId)}
                </span>
              ),
            },
            {
              header: 'Conducted',
              cell: ({ assessment }) => britishDate(assessment.conductedAt),
            },
            {
              header: 'Stage',
              cell: ({ assessment }) => (
                <span className={styles.stage}>
                  {ASSESSMENT_STAGE_LABELS[assessment.status]}
                </span>
              ),
            },
          ]}
          rows={rows}
          rowKey={({ id }) => id}
        />
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Jobs assigned to this member. Each row links to the job.
// ----------------------------------------------------------------------------

function JobsCard({
  rows,
  isLoading,
  isError,
  name,
  buildingName,
  customerName,
}: {
  rows: JobRow[];
  isLoading: boolean;
  isError: boolean;
  name: string;
  buildingName: (buildingId: string) => string;
  customerName: (customerId: string) => string;
}) {
  return (
    <Card flush>
      <CardHeader title="Jobs assigned" hint={windowHint(rows.length)} />
      {isError ? (
        <p className={styles.cardMessage}>
          <ErrorNotice message="Could not load this member's jobs. Please try again." />
        </p>
      ) : isLoading && rows.length === 0 ? (
        <div className={styles.cardPad}>
          <SkeletonRows rows={3} label={`Loading jobs assigned to ${name}`} />
        </div>
      ) : rows.length === 0 ? (
        <p className={styles.cardMessage}>
          No jobs are assigned to {name} right now.
        </p>
      ) : (
        <DataTable<JobRow>
          label={`Jobs assigned to ${name}`}
          rowHref={({ id }) => jobUrls.job(id)}
          columns={[
            {
              header: 'Visit',
              cell: ({ job }) => britishDate(job.scheduledFor),
            },
            {
              header: 'Building',
              cell: ({ job }) => (
                <span className={styles.identity}>
                  <span className={styles.strong}>
                    {buildingName(job.buildingId)}
                  </span>
                  <span className={styles.muted}>
                    {customerName(job.customerId)}
                  </span>
                </span>
              ),
            },
            {
              header: 'Status',
              cell: ({ job }) => <JobStatusBadge status={job.status} />,
            },
          ]}
          rows={rows}
          rowKey={({ id }) => id}
        />
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// MemberPanel - the admin's role/status editor, moved here from the directory.
// Every guard is preserved: the client-side last-administrator pre-guard
// (disabling the doomed controls with an explanation), with the server's
// transactional last-administrator protection as the real backstop. No
// optimistic writes: the live members listener reflects the server's write.
// ----------------------------------------------------------------------------

/** The confirmable status transitions. Copy is explicit about the consequence. */
type StatusAction = {
  label: string;
  target: MemberStatus;
  confirm: (name: string) => string;
  confirmLabel: string;
};

function statusActionsFor(status: MemberStatus): StatusAction[] {
  switch (status) {
    case 'active':
      return [
        {
          label: 'Lock',
          target: 'locked',
          confirm: (name) =>
            `Lock ${name}? They will be signed out on their next token refresh.`,
          confirmLabel: 'Lock account',
        },
        {
          label: 'Archive',
          target: 'archived',
          confirm: (name) =>
            `Archive ${name}? They will lose access and disappear from pickers; their history is preserved.`,
          confirmLabel: 'Archive account',
        },
      ];
    case 'locked':
      return [
        {
          label: 'Unlock',
          target: 'active',
          confirm: (name) => `Unlock ${name}? They will be able to sign in again.`,
          confirmLabel: 'Unlock account',
        },
        {
          label: 'Archive',
          target: 'archived',
          confirm: (name) =>
            `Archive ${name}? They will lose access and disappear from pickers; their history is preserved.`,
          confirmLabel: 'Archive account',
        },
      ];
    case 'archived':
    default:
      return [
        {
          label: 'Restore',
          target: 'active',
          confirm: (name) =>
            `Restore ${name}? Their account becomes active again with the roles shown above.`,
          confirmLabel: 'Restore account',
        },
      ];
  }
}

function MemberPanel({
  uid,
  member,
  isSoleAdmin,
  isSelf,
}: {
  uid: string;
  member: OrgMember;
  /** True when the panel shows the ONLY active administrator - whoever is
   *  looking. Purely UX: the server's transactional last-administrator
   *  protection is the real boundary; this disables the doomed actions
   *  (demote, lock, archive) with an explanation instead of letting the save
   *  fail. */
  isSoleAdmin: boolean;
  /** True when the panel shows the signed-in member, so the explanation can
   *  address them directly. */
  isSelf: boolean;
}) {
  const update = useCallable<UpdateMemberInput, UpdateMemberResult>('updateMember');
  const [draftRoles, setDraftRoles] = useState<OrgRoleSet>(() => ({
    ...member.roles,
  }));
  const [confirming, setConfirming] = useState<StatusAction | null>(null);

  const draftList = roleList(draftRoles);
  const rolesChanged = draftList.join(',') !== roleList(member.roles).join(',');

  const toggleRole = (role: OrgRole, checked: boolean) => {
    setDraftRoles((current) => {
      const next: OrgRoleSet = { ...current };
      if (checked) {
        next[role] = true;
      } else {
        delete next[role];
      }
      return next;
    });
  };

  const saveRoles = async () => {
    // The role set carries only `true` flags (contract shape); an unchecked
    // role is absent, not false.
    await update.call({ memberUid: uid, roles: draftRoles });
    // No optimistic write: the live listener updates the row when the server
    // has actually applied the change.
  };

  const applyStatus = async (action: StatusAction) => {
    const result = await update.call({ memberUid: uid, status: action.target });
    if (result) {
      setConfirming(null);
    }
    // On failure the confirm stays open with the error shown, so the admin can
    // read the reason (e.g. the last-administrator protection) in context.
  };

  return (
    <div className={styles.panelBody}>
      <fieldset className={styles.roleFieldset}>
        <legend className={styles.panelLegend}>Roles</legend>
        <div className={styles.roleGrid}>
          {ORG_ROLES.map((role) => {
            // The last-admin guard bites only on the admin checkbox while it is
            // still checked in the draft: unchecking it is the doomed action.
            const lastAdminLocked =
              isSoleAdmin && role === 'admin' && draftRoles.admin === true;
            return (
              <label
                key={role}
                className={styles.roleOption}
                htmlFor={`role-${uid}-${role}`}
              >
                <input
                  id={`role-${uid}-${role}`}
                  type="checkbox"
                  checked={draftRoles[role] === true}
                  disabled={lastAdminLocked}
                  onChange={(event) => toggleRole(role, event.target.checked)}
                />
                <span>{ROLE_LABELS[role]}</span>
              </label>
            );
          })}
        </div>
        {isSoleAdmin && (
          <p className={styles.hint}>
            {isSelf
              ? 'You are the only active administrator, so your administrator role cannot be removed. Make someone else an administrator first.'
              : `${member.name} is the only active administrator. The last administrator cannot be removed; make someone else an administrator first.`}
          </p>
        )}
        <Button
          variant="secondary"
          disabled={update.pending || !rolesChanged || draftList.length === 0}
          onClick={() => void saveRoles()}
        >
          {update.pending ? 'Saving' : 'Save roles'}
        </Button>
        {draftList.length === 0 && (
          <p className={styles.hint}>A member needs at least one role.</p>
        )}
      </fieldset>

      <div className={styles.statusActions}>
        {confirming ? (
          <div className={styles.confirmBox}>
            <p className={styles.confirmCopy}>{confirming.confirm(member.name)}</p>
            <div className={styles.confirmButtons}>
              <Button
                disabled={update.pending}
                onClick={() => void applyStatus(confirming)}
              >
                {update.pending ? 'Working' : confirming.confirmLabel}
              </Button>
              <Button
                variant="ghost"
                disabled={update.pending}
                onClick={() => {
                  setConfirming(null);
                  update.clearError();
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            {statusActionsFor(member.status).map((action) => {
              // Locking or archiving the sole active administrator is the same
              // lockout the server refuses; disable it here with the reason
              // stated below, keeping the server error as the backstop.
              const lastAdminBlocked = isSoleAdmin && action.target !== 'active';
              return (
                <Button
                  key={action.label}
                  variant="ghost"
                  disabled={update.pending || lastAdminBlocked}
                  onClick={() => setConfirming(action)}
                >
                  {action.label}
                </Button>
              );
            })}
            {isSoleAdmin && (
              <p className={styles.hint}>
                The last administrator cannot be removed, locked or archived.
              </p>
            )}
          </>
        )}
      </div>

      {update.error && <ErrorNotice message={update.error} />}
    </div>
  );
}
