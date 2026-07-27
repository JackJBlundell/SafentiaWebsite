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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { MEMBER_STATUSES, ORG_ROLES } from '../../types';
import type {
  MemberStatus,
  Organisation,
  OrgMember,
  OrgRole,
} from '../../types';
import { Button } from '../../components/Button';
import { StatusBadge } from '../customers/shared';
import { DataTable, type Column } from '../ui/DataTable';
import { Toolbar, ToolbarGroup } from '../ui/Grid';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { usePlatformEnv } from './platformEnv';
import shared from '../customers/shared.module.css';
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

/** Human labels for the member-status filter. The StatusBadge keeps its own
 *  copy; these name the same states in the select the operator reads. */
const STATUS_LABELS: Record<MemberStatus, string> = {
  active: 'Active',
  locked: 'Locked',
  archived: 'Archived',
};

/** The filter select's sentinel for "no filter". Not a valid role or status, so
 *  it can never collide with the const vocabularies it sits beside. */
const ANY = 'all';

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
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<OrgRole | typeof ANY>(ANY);
  const [statusFilter, setStatusFilter] = useState<MemberStatus | typeof ANY>(ANY);
  const [orgFilter, setOrgFilter] = useState<string>(ANY);
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

  const orgs = useMemo(
    () =>
      Object.entries(orgsQuery.data ?? {})
        .map(([orgId, org]) => ({ orgId, name: org?.profile?.name ?? orgId }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en-GB')),
    [orgsQuery.data],
  );
  const orgIds = useMemo(() => orgs.map((org) => org.orgId), [orgs]);

  // Honest readiness: the org list has loaded AND every listed org has reported
  // (an empty org reports an empty list), so a slow org never flashes a false
  // "no members" state. The store is keyed per env, so stale keys from the
  // other environment are simply ignored below.
  const ready =
    !orgsQuery.isLoading &&
    (orgIds.length === 0 || orgIds.every((orgId) => rowsByOrg[orgId] !== undefined));

  // The full aggregate, memoised so re-filtering on a keystroke never re-walks
  // and re-sorts every org's reported rows.
  const rows: MemberRow[] = useMemo(
    () =>
      orgIds
        .flatMap((orgId) => rowsByOrg[orgId] ?? [])
        .sort(
          (a, b) =>
            a.orgName.localeCompare(b.orgName, 'en-GB') ||
            a.name.localeCompare(b.name, 'en-GB'),
        ),
    [orgIds, rowsByOrg],
  );

  const total = rows.length;
  const filtersActive =
    search.trim() !== '' ||
    roleFilter !== ANY ||
    statusFilter !== ANY ||
    orgFilter !== ANY;
  const clearFilters = () => {
    setSearch('');
    setRoleFilter(ANY);
    setStatusFilter(ANY);
    setOrgFilter(ANY);
  };

  // Search, role, status and org compose: each narrows the same set, so any
  // combination is an AND. Search runs over the person's name and email only.
  const filtered: MemberRow[] = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (needle === '' ||
          `${row.name} ${row.email}`.toLowerCase().includes(needle)) &&
        (roleFilter === ANY || row.roles.includes(roleFilter)) &&
        (statusFilter === ANY || row.status === statusFilter) &&
        (orgFilter === ANY || row.orgId === orgFilter),
    );
  }, [rows, search, roleFilter, statusFilter, orgFilter]);

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
      {ready && !orgsQuery.isError && total === 0 && (
        <p className={admin.emptyNote}>No members found in this environment.</p>
      )}
      {ready && !orgsQuery.isError && total > 0 && (
        <>
          <Toolbar>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="members-search">
                  Search members
                </label>
                <input
                  id="members-search"
                  className={`${shared.input} ${admin.searchInput}`}
                  type="search"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </ToolbarGroup>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="members-role">
                  Role
                </label>
                <select
                  id="members-role"
                  className={shared.select}
                  value={roleFilter}
                  onChange={(event) =>
                    setRoleFilter(event.target.value as OrgRole | typeof ANY)
                  }
                >
                  <option value={ANY}>All roles</option>
                  {ORG_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </div>
            </ToolbarGroup>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="members-status">
                  Status
                </label>
                <select
                  id="members-status"
                  className={shared.select}
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as MemberStatus | typeof ANY)
                  }
                >
                  <option value={ANY}>All statuses</option>
                  {MEMBER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </option>
                  ))}
                </select>
              </div>
            </ToolbarGroup>
            {orgs.length > 1 && (
              <ToolbarGroup>
                <div className={shared.field}>
                  <label className={shared.label} htmlFor="members-org">
                    Organisation
                  </label>
                  <select
                    id="members-org"
                    className={shared.select}
                    value={orgFilter}
                    onChange={(event) => setOrgFilter(event.target.value)}
                  >
                    <option value={ANY}>All organisations</option>
                    {orgs.map((org) => (
                      <option key={org.orgId} value={org.orgId}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </div>
              </ToolbarGroup>
            )}
            {filtersActive && (
              <ToolbarGroup push>
                <Button variant="secondary" type="button" onClick={clearFilters}>
                  Clear filters
                </Button>
              </ToolbarGroup>
            )}
          </Toolbar>

          <p role="status" className={admin.resultCount}>
            Showing {filtered.length} of {total}{' '}
            {total === 1 ? 'member' : 'members'}
          </p>

          {filtered.length === 0 ? (
            <div className={admin.noMatch}>
              <p className={admin.emptyNote}>
                No members match your search and filters.
              </p>
              <Button variant="secondary" type="button" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(row) => `${row.orgId}:${row.uid}`}
              rowHref={(row) => `/app/admin/${row.orgId}`}
              label="Members"
            />
          )}
        </>
      )}
      <p className={admin.footnote}>Read-only oversight; counts are live.</p>
    </div>
  );
}
