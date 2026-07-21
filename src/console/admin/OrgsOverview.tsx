// ============================================================================
// OrgsOverview (story 2068) - every organisation on the platform, per
// environment: name, member / customer / building counts, drill to detail.
//
// Counts are live per-org reads (one bounded subscription per org per count,
// rendered by tiny cell components so each row owns its own listeners). That
// is deliberate: the platform is early and the org list is small, so a handful
// of node reads beats maintaining server-side counters. Revisit with derived
// roll-ups if the platform reaches hundreds of organisations.
//
// Read-only oversight: this screen (and everything under /app/admin) never
// writes tenant data.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Organisation } from '../../types';
import { Button } from '../../components/Button';
import { CreateOrganisationDialog } from '../CreateOrganisationDialog';
import { DataTable, type Column } from '../ui/DataTable';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { usePlatformEnv } from './platformEnv';
import styles from './admin.module.css';

interface OrgRowData {
  orgId: string;
  name: string;
}

/** The sortable columns (story 2068 polish). Name sorts on the row itself;
 *  the count columns sort on the live counts the cells report upward. */
type SortColumn = 'name' | 'members' | 'buildings';

/** Live counts per org, reported up by the cell components so the table can
 *  sort by them. Partial by nature: a count that has not loaded yet sorts
 *  last rather than blocking the render. */
type OrgCounts = Record<string, { members?: number; buildings?: number }>;

/** Count the children of one org-scoped node - a live, bounded read.
 *  `onCount` reports the value upward for sorting. */
function NodeCount({
  path,
  queryKey,
  onCount,
}: {
  path: string;
  queryKey: ReadonlyArray<string | number>;
  onCount?: (value: number) => void;
}) {
  const count = useRtdbQuery<number>({
    key: queryKey,
    path,
    select: (value) =>
      value && typeof value === 'object' ? Object.keys(value).length : 0,
  });
  // Reported from an effect, never mid-render: a render-phase parent setState
  // is a React error and a re-render loop risk.
  useEffect(() => {
    if (count.data !== undefined) {
      onCount?.(count.data);
    }
  }, [count.data, onCount]);
  // Render only a number: a defensive floor so a cache-shape mishap can never
  // render an object as a child and take the whole page down (the select above
  // is the primary guarantee; this is belt and braces for a reused cell).
  return <>{typeof count.data === 'number' ? count.data : '…'}</>;
}

/** A building count needs to flatten sites first ({siteId: {buildingId}}). */
function BuildingCount({
  path,
  queryKey,
  onCount,
}: {
  path: string;
  queryKey: ReadonlyArray<string | number>;
  onCount?: (value: number) => void;
}) {
  const count = useRtdbQuery<number>({
    key: queryKey,
    path,
    select: (value) => {
      if (!value || typeof value !== 'object') {
        return 0;
      }
      return Object.values(value as Record<string, unknown>).reduce<number>(
        (total, site) =>
          total +
          (site && typeof site === 'object' ? Object.keys(site).length : 0),
        0,
      );
    },
  });
  useEffect(() => {
    if (count.data !== undefined) {
      onCount?.(count.data);
    }
  }, [count.data, onCount]);
  // See NodeCount: render a number only, never a raw node.
  return <>{typeof count.data === 'number' ? count.data : '…'}</>;
}

export function OrgsOverview() {
  const [creating, setCreating] = useState(false);
  // The environment is the platform-wide choice from the rail toggle.
  const { env } = usePlatformEnv();
  const [sortBy, setSortBy] = useState<SortColumn>('name');
  const [descending, setDescending] = useState(false);
  const [counts, setCounts] = useState<OrgCounts>({});
  const paths = forEnv(env);

  const orgsQuery = useRtdbQuery<Record<string, Organisation> | null>({
    key: ['platformOrgs', env],
    path: paths.db.organisationsRoot(),
  });

  // The count cells report their live values here so sorting by them is
  // reactive. Guarded set: only a CHANGED value writes state, so the report
  // from a render can never cause a render loop.
  const reportCount = useCallback(
    (orgId: string, metric: 'members' | 'buildings', value: number) => {
      setCounts((previous) =>
        previous[orgId]?.[metric] === value
          ? previous
          : { ...previous, [orgId]: { ...previous[orgId], [metric]: value } },
      );
    },
    [],
  );

  const chooseSort = (column: SortColumn) => {
    if (column === sortBy) {
      setDescending((current) => !current);
      return;
    }
    setSortBy(column);
    // Counts read most usefully largest-first; names A to Z.
    setDescending(column !== 'name');
  };

  const rows: OrgRowData[] = Object.entries(orgsQuery.data ?? {})
    .map(([orgId, org]) => ({
      orgId,
      name: org?.profile?.name ?? orgId,
    }))
    .sort((a, b) => {
      let comparison: number;
      if (sortBy === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else {
        // A not-yet-loaded count sorts as -1 so unresolved rows group at the
        // small end instead of interleaving unpredictably.
        comparison =
          (counts[a.orgId]?.[sortBy] ?? -1) - (counts[b.orgId]?.[sortBy] ?? -1);
        if (comparison === 0) {
          comparison = a.name.localeCompare(b.name);
        }
      }
      return descending ? -comparison : comparison;
    });

  const columns: Array<Column<OrgRowData>> = [
    { header: 'Organisation', cell: (row) => row.name },
    {
      header: 'Members',
      // Platform-scoped cache keys (env included) so these oversight reads can
      // never collide with the operator's own org session in the query cache.
      // The key also carries a 'Count' suffix: useRtdbQuery caches the SHAPED
      // (post-select) value under the key, so this count MUST NOT share a key
      // with OrgDetail's raw members read of the same path - or one screen reads
      // the other's shape and renders an object as a child.
      cell: (row) => (
        <NodeCount
          path={paths.db.orgMembers(row.orgId)}
          queryKey={['platformOrgMembersCount', env, row.orgId]}
          onCount={(value) => reportCount(row.orgId, 'members', value)}
        />
      ),
    },
    {
      header: 'Customers',
      cell: (row) => (
        <NodeCount
          path={paths.db.customers(row.orgId)}
          queryKey={['platformCustomers', env, row.orgId]}
        />
      ),
    },
    {
      header: 'Buildings',
      cell: (row) => (
        <BuildingCount
          path={paths.db.buildingsRoot(row.orgId)}
          queryKey={['platformBuildings', env, row.orgId]}
          onCount={(value) => reportCount(row.orgId, 'buildings', value)}
        />
      ),
    },
  ];

  return (
    <div className={styles.stack}>
      <PageHeader
        title="Organisations"
        crumbs={[{ label: 'Platform', to: '/app/admin' }, { label: 'Organisations' }]}
        lede="Every organisation on Safentia. Read-only oversight; nothing here changes tenant data."
        action={
          <Button onClick={() => setCreating(true)}>Create organisation</Button>
        }
      />
      <div className={styles.toolbar}>
        <div className={styles.envToggle} role="group" aria-label="Sort by">
          {(
            [
              { column: 'name', label: 'Name' },
              { column: 'members', label: 'Members' },
              { column: 'buildings', label: 'Buildings' },
            ] as const
          ).map(({ column, label }) => (
            <button
              key={column}
              type="button"
              className={
                sortBy === column ? styles.envButtonActive : styles.envButton
              }
              aria-pressed={sortBy === column}
              onClick={() => chooseSort(column)}
            >
              {sortBy === column
                ? `${label} ${descending ? '↓' : '↑'}`
                : label}
            </button>
          ))}
        </div>
        <Link className={styles.toolbarLink} to="/app/admin/activity">
          Platform activity
        </Link>
      </div>

      {orgsQuery.isError && (
        <ErrorNotice message="Could not load the organisations. Please try again." />
      )}
      {!orgsQuery.isLoading && !orgsQuery.isError && rows.length === 0 && (
        <p className={styles.emptyNote}>
          No organisations exist in the {env} environment yet.
        </p>
      )}
      {rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.orgId}
          rowHref={(row) => `/app/admin/${row.orgId}`}
          label="Organisations"
        />
      )}
      <p className={styles.footnote}>Read-only oversight; counts are live.</p>
      {creating && (
        // On success the dialog refreshes the session and navigates to /app: the
        // callable re-pointed the operator's active-org claim at the new tenant,
        // so they land INSIDE it as its founding admin, ready to brand it and
        // invite the client's administrators via /app/staff. Leaving the admin
        // area is the intended operator journey, not an accident.
        <CreateOrganisationDialog onClose={() => setCreating(false)} />
      )}
    </div>
  );
}
