// ============================================================================
// PlatformMembers - every member across every organisation, per environment.
//
// The platform-wide roll-up behind the dashboard's "Members" tile: the org
// list is read once, then a tiny invisible reporter per org reads that org's
// members and pushes its rows up. That mirrors OrgsOverview and the dashboard
// exactly - one bounded subscription per org, aggregated as the reporters
// report - and stays honest while the platform is early and the org list small.
//
// Read-only oversight: this screen never writes tenant data. Each row links to
// its organisation's detail page; from there the operator drills into a
// customer and a building.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { ORG_ROLES } from '../../types';
import type { Organisation, OrgMember, OrgRole } from '../../types';
import { StatusBadge } from '../customers/shared';
import { DataTable, type Column } from '../ui/DataTable';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { usePlatformEnv } from './platformEnv';
import admin from './admin.module.css';
import styles from './PlatformMembers.module.css';

/** Human labels for the role claims: the claim keys are API vocabulary; the
 *  table speaks to a person. */
const ROLE_LABELS: Record<OrgRole, string> = {
  admin: 'Administrator',
  assessor: 'Assessor',
  auditor: 'Auditor',
  finance: 'Finance',
  viewer: 'Viewer',
};

interface MemberRow {
  orgId: string;
  orgName: string;
  uid: string;
  name: string;
  email: string;
  roles: OrgRole[];
  status: OrgMember['status'];
}

/** Turn one org's members node into rows. A member with no `roles` field yields
 *  an empty role list rather than crashing - the platform staff read must never
 *  assume the shape is complete. */
function rowsForOrg(
  orgId: string,
  orgName: string,
  members: Record<string, OrgMember> | null,
): MemberRow[] {
  return Object.entries(members ?? {}).map(([uid, member]) => ({
    orgId,
    orgName,
    uid,
    name: member?.name ?? uid,
    email: member?.email ?? '',
    // Defensive: `roles` can be absent on a partially written member; filter
    // over an empty set so the cell renders no chips instead of throwing.
    roles: member?.roles ? ORG_ROLES.filter((role) => member.roles[role]) : [],
    status: member?.status ?? 'active',
  }));
}

/** Read one org's members and report their rows upward. Renders nothing. */
function OrgMembersReporter({
  orgId,
  orgName,
  path,
  queryKey,
  onReport,
}: {
  orgId: string;
  orgName: string;
  path: string;
  queryKey: ReadonlyArray<string | number>;
  onReport: (orgId: string, rows: MemberRow[]) => void;
}) {
  // Shape in `select`: an absent node resolves to null -> an empty row list
  // (never undefined), so an org with no members reports honestly instead of
  // looking like it is still loading.
  const members = useRtdbQuery<MemberRow[]>({
    key: queryKey,
    path,
    select: (value) =>
      rowsForOrg(orgId, orgName, value as Record<string, OrgMember> | null),
  });
  // Reported from an effect, never mid-render: a render-phase parent setState is
  // a React error and a re-render loop risk. The parent's reporter guard is what
  // actually breaks the cycle (see reportRows).
  useEffect(() => {
    if (members.data !== undefined) {
      onReport(orgId, members.data);
    }
  }, [members.data, orgId, onReport]);
  return null;
}

/** A text chip per role: colour is never the sole carrier - the role name is
 *  the content, so this reads for everyone. */
function RoleChips({ roles }: { roles: OrgRole[] }) {
  if (roles.length === 0) {
    return <span className={styles.noRoles}>No roles</span>;
  }
  return (
    <span className={styles.roleChips}>
      {roles.map((role) => (
        <span key={role} className={styles.roleChip}>
          {ROLE_LABELS[role]}
        </span>
      ))}
    </span>
  );
}

export function PlatformMembers() {
  // The environment is the platform-wide choice from the rail toggle.
  const { env } = usePlatformEnv();
  const [rowsByOrg, setRowsByOrg] = useState<Record<string, MemberRow[]>>({});
  const paths = forEnv(env);

  const orgsQuery = useRtdbQuery<Record<string, Organisation> | null>({
    key: ['platformOrgs', env],
    path: paths.db.organisationsRoot(),
  });

  // Guarded set: an unchanged report returns the previous state unchanged, so a
  // reporter that re-selects an equal row list on every parent render can never
  // drive a re-render loop. Content equality (not reference) because select may
  // hand back a fresh array of equal rows.
  const reportRows = useCallback((orgId: string, rows: MemberRow[]) => {
    setRowsByOrg((previous) => {
      const existing = previous[orgId];
      if (existing && JSON.stringify(existing) === JSON.stringify(rows)) {
        return previous;
      }
      return { ...previous, [orgId]: rows };
    });
  }, []);

  const orgs = Object.entries(orgsQuery.data ?? {}).map(([orgId, org]) => ({
    orgId,
    name: org?.profile?.name ?? orgId,
  }));
  const orgIds = orgs.map((org) => org.orgId);

  // Honest readiness: the org list has loaded AND every listed org has reported
  // (an empty org reports an empty list), so a slow org never flashes a false
  // "no members" state. The store is keyed per env, so stale keys from the
  // other environment are simply ignored below.
  const ready =
    !orgsQuery.isLoading &&
    (orgIds.length === 0 || orgIds.every((orgId) => rowsByOrg[orgId] !== undefined));

  const rows: MemberRow[] = orgIds
    .flatMap((orgId) => rowsByOrg[orgId] ?? [])
    .sort(
      (a, b) =>
        a.orgName.localeCompare(b.orgName, 'en-GB') ||
        a.name.localeCompare(b.name, 'en-GB'),
    );

  const columns: Array<Column<MemberRow>> = [
    { header: 'Organisation', cell: (row) => row.orgName },
    { header: 'Member', cell: (row) => row.name },
    { header: 'Email', cell: (row) => row.email, desktopOnly: true },
    { header: 'Roles', cell: (row) => <RoleChips roles={row.roles} /> },
    {
      header: 'Status',
      cell: (row) => <StatusBadge status={row.status} />,
      desktopOnly: true,
    },
  ];

  return (
    <div className={admin.stack}>
      <PageHeader
        title="Members"
        crumbs={[{ label: 'Platform', to: '/app/admin' }, { label: 'Members' }]}
        lede="Every member across every organisation on Safentia. Read-only oversight; nothing here changes tenant data."
      />
      {/* Invisible per-org reporters: one bounded members read each, pushing
          rows up to the aggregate table above. */}
      {orgs.map((org) => (
        <div key={org.orgId} hidden>
          <OrgMembersReporter
            orgId={org.orgId}
            orgName={org.name}
            path={paths.db.orgMembers(org.orgId)}
            queryKey={['platformMembersList', env, org.orgId]}
            onReport={reportRows}
          />
        </div>
      ))}

      {orgsQuery.isError && (
        <ErrorNotice message="Could not load the members. Please try again." />
      )}
      {!ready && !orgsQuery.isError && (
        <SkeletonRows rows={4} label="Loading members across the platform" />
      )}
      {ready && !orgsQuery.isError && rows.length === 0 && (
        <p className={admin.emptyNote}>No members found in this environment.</p>
      )}
      {ready && rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.orgId}:${row.uid}`}
          rowHref={(row) => `/app/admin/${row.orgId}`}
          label="Members"
        />
      )}
      <p className={admin.footnote}>Read-only oversight; counts are live.</p>
    </div>
  );
}
