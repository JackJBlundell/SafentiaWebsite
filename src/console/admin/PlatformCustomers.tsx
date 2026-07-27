// ============================================================================
// PlatformCustomers - every customer across every organisation, per
// environment.
//
// The platform-wide roll-up behind the dashboard's "Customers" tile: the org
// list is read once, then a tiny invisible reporter per org reads that org's
// customers and pushes its rows up. Mirrors OrgsOverview and the dashboard -
// one bounded subscription per org, aggregated as the reporters report.
//
// Oversight of a large book needs a way to narrow it: search (name, address,
// email, organisation) and two filters (organisation, status) that compose,
// each derived purely from rows already loaded so no filter adds a new listener.
//
// Read-only oversight: this screen never writes tenant data. Each row links to
// its customer's detail page in the oversight drill-down.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  MEMBER_STATUSES,
  type Customer,
  type MemberStatus,
  type Organisation,
} from '../../types';
import { StatusBadge } from '../customers/shared';
import shared from '../customers/shared.module.css';
import { DataTable, type Column } from '../ui/DataTable';
import { Toolbar, ToolbarGroup } from '../ui/Grid';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { usePlatformEnv } from './platformEnv';
import admin from './admin.module.css';
import styles from './PlatformCustomers.module.css';

/** A status filter value: any member status, or the "all" default. */
type StatusFilter = MemberStatus | 'all';

/** Sentence-case labels for the status filter options; the values stay the
 *  allow-listed MEMBER_STATUSES so a bad choice can never be constructed. */
const STATUS_FILTER_LABELS: Record<MemberStatus, string> = {
  active: 'Active',
  locked: 'Locked',
  archived: 'Archived',
};

interface CustomerRow {
  orgId: string;
  orgName: string;
  customerId: string;
  name: string;
  address?: string;
  email?: string;
  status: Customer['status'];
}

/** Turn one org's customers node into rows. */
function rowsForOrg(
  orgId: string,
  orgName: string,
  customers: Record<string, Customer> | null,
): CustomerRow[] {
  return Object.entries(customers ?? {}).map(([customerId, customer]) => ({
    orgId,
    orgName,
    customerId,
    name: customer?.name ?? customerId,
    address: customer?.address,
    email: customer?.email,
    status: customer?.status ?? 'active',
  }));
}

/** Read one org's customers and report their rows upward. Renders nothing. */
function OrgCustomersReporter({
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
  onReport: (orgId: string, rows: CustomerRow[]) => void;
}) {
  // Shape in `select`: an absent node resolves to null -> an empty row list
  // (never undefined), so an org with no customers reports honestly instead of
  // looking like it is still loading.
  const customers = useRtdbQuery<CustomerRow[]>({
    key: queryKey,
    path,
    select: (value) =>
      rowsForOrg(orgId, orgName, value as Record<string, Customer> | null),
  });
  // Reported from an effect, never mid-render (see the other platform lists);
  // the parent's reporter guard breaks any re-render cycle.
  useEffect(() => {
    if (customers.data !== undefined) {
      onReport(orgId, customers.data);
    }
  }, [customers.data, orgId, onReport]);
  return null;
}

export function PlatformCustomers() {
  // The environment is the platform-wide choice from the rail toggle.
  const { env } = usePlatformEnv();
  const [rowsByOrg, setRowsByOrg] = useState<Record<string, CustomerRow[]>>({});
  const [search, setSearch] = useState('');
  const [orgFilter, setOrgFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const paths = forEnv(env);

  const orgsQuery = useRtdbQuery<Record<string, Organisation> | null>({
    key: ['platformOrgs', env],
    path: paths.db.organisationsRoot(),
  });

  // Guarded set: an unchanged report returns the previous state unchanged, so a
  // reporter that re-selects an equal row list on every render never drives a
  // re-render loop. Content equality, because select may hand back a fresh array.
  const reportRows = useCallback((orgId: string, rows: CustomerRow[]) => {
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

  const ready =
    !orgsQuery.isLoading &&
    (orgIds.length === 0 || orgIds.every((orgId) => rowsByOrg[orgId] !== undefined));

  // Derived from the two live sources (the org list and each org's reported
  // rows), so it only recomputes when real data changes, not on every render.
  const rows: CustomerRow[] = useMemo(() => {
    const ids = Object.keys(orgsQuery.data ?? {});
    return ids
      .flatMap((orgId) => rowsByOrg[orgId] ?? [])
      .sort(
        (a, b) =>
          a.orgName.localeCompare(b.orgName, 'en-GB') ||
          a.name.localeCompare(b.name, 'en-GB'),
      );
  }, [rowsByOrg, orgsQuery.data]);

  // The organisation options come from the loaded rows (only orgs that actually
  // hold customers), so the dropdown never offers a choice that filters to
  // nothing. Sorted for a stable, scannable list.
  const orgOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows) {
      byId.set(row.orgId, row.orgName);
    }
    return [...byId.entries()]
      .map(([orgId, name]) => ({ orgId, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
  }, [rows]);

  // Search AND organisation AND status all narrow together; each clause reads
  // only fields already on the row, so filtering never triggers a new read.
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (orgFilter && row.orgId !== orgFilter) {
        return false;
      }
      if (statusFilter !== 'all' && row.status !== statusFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const haystack = [row.name, row.address, row.email, row.orgName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, search, orgFilter, statusFilter]);

  const hasFilters = search.trim() !== '' || orgFilter !== '' || statusFilter !== 'all';
  const clearFilters = () => {
    setSearch('');
    setOrgFilter('');
    setStatusFilter('all');
  };

  const columns: Array<Column<CustomerRow>> = [
    { header: 'Organisation', cell: (row) => row.orgName },
    {
      header: 'Customer',
      cell: (row) => (
        <span className={styles.customerCell}>
          <span className={styles.name}>{row.name}</span>
          {row.address && <span className={styles.meta}>{row.address}</span>}
        </span>
      ),
    },
    {
      header: 'Status',
      cell: (row) => <StatusBadge status={row.status} />,
      desktopOnly: true,
    },
  ];

  return (
    <div className={admin.stack}>
      <PageHeader
        title="Customers"
        crumbs={[{ label: 'Platform', to: '/app/admin' }, { label: 'Customers' }]}
        lede="Every customer across every organisation on Safentia. Read-only oversight; nothing here changes tenant data."
      />
      {/* Invisible per-org reporters: one bounded customers read each. */}
      {orgs.map((org) => (
        <div key={org.orgId} hidden>
          <OrgCustomersReporter
            orgId={org.orgId}
            orgName={org.name}
            path={paths.db.customers(org.orgId)}
            queryKey={['platformCustomersList', env, org.orgId]}
            onReport={reportRows}
          />
        </div>
      ))}

      {orgsQuery.isError && (
        <ErrorNotice message="Could not load the customers. Please try again." />
      )}
      {!ready && !orgsQuery.isError && (
        <SkeletonRows rows={4} label="Loading customers across the platform" />
      )}
      {ready && !orgsQuery.isError && rows.length === 0 && (
        <p className={admin.emptyNote}>No customers found in this environment.</p>
      )}
      {ready && rows.length > 0 && (
        <>
          <Toolbar>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="platform-customers-search">
                  Search customers
                </label>
                <input
                  id="platform-customers-search"
                  className={`${shared.input} ${admin.searchInput}`}
                  type="search"
                  autoComplete="off"
                  placeholder="Name, address, email or organisation"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </ToolbarGroup>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="platform-customers-org">
                  Organisation
                </label>
                <select
                  id="platform-customers-org"
                  className={shared.select}
                  value={orgFilter}
                  onChange={(event) => setOrgFilter(event.target.value)}
                >
                  <option value="">All organisations</option>
                  {orgOptions.map((org) => (
                    <option key={org.orgId} value={org.orgId}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </div>
            </ToolbarGroup>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="platform-customers-status">
                  Status
                </label>
                <select
                  id="platform-customers-status"
                  className={shared.select}
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as StatusFilter)
                  }
                >
                  <option value="all">All statuses</option>
                  {MEMBER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_FILTER_LABELS[status]}
                    </option>
                  ))}
                </select>
              </div>
            </ToolbarGroup>
            {hasFilters && (
              <ToolbarGroup push>
                <Button variant="secondary" type="button" onClick={clearFilters}>
                  Clear filters
                </Button>
              </ToolbarGroup>
            )}
          </Toolbar>

          <p role="status" className={admin.resultCount}>
            Showing {filteredRows.length} of {rows.length}{' '}
            {rows.length === 1 ? 'customer' : 'customers'}
          </p>

          {filteredRows.length === 0 ? (
            <div className={admin.noMatch}>
              <p className={admin.emptyNote}>
                No customers match your search and filters.
              </p>
              <Button variant="secondary" type="button" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={filteredRows}
              rowKey={(row) => `${row.orgId}:${row.customerId}`}
              rowHref={(row) => `/app/admin/${row.orgId}/customers/${row.customerId}`}
              label="Customers"
            />
          )}
        </>
      )}
      <p className={admin.footnote}>Read-only oversight; counts are live.</p>
    </div>
  );
}
