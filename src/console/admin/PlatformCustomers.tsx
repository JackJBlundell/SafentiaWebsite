// ============================================================================
// PlatformCustomers - every customer across every organisation, per
// environment.
//
// The platform-wide roll-up behind the dashboard's "Customers" tile: the org
// list is read once, then a tiny invisible reporter per org reads that org's
// customers and pushes its rows up. Mirrors OrgsOverview and the dashboard -
// one bounded subscription per org, aggregated as the reporters report.
//
// Read-only oversight: this screen never writes tenant data. Each row links to
// its customer's detail page in the oversight drill-down.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Customer, Organisation } from '../../types';
import { StatusBadge } from '../customers/shared';
import { DataTable, type Column } from '../ui/DataTable';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { usePlatformEnv } from './platformEnv';
import admin from './admin.module.css';
import styles from './PlatformCustomers.module.css';

interface CustomerRow {
  orgId: string;
  orgName: string;
  customerId: string;
  name: string;
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

  const rows: CustomerRow[] = orgIds
    .flatMap((orgId) => rowsByOrg[orgId] ?? [])
    .sort(
      (a, b) =>
        a.orgName.localeCompare(b.orgName, 'en-GB') ||
        a.name.localeCompare(b.name, 'en-GB'),
    );

  const columns: Array<Column<CustomerRow>> = [
    { header: 'Organisation', cell: (row) => row.orgName },
    { header: 'Customer', cell: (row) => <span className={styles.name}>{row.name}</span> },
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
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.orgId}:${row.customerId}`}
          rowHref={(row) =>
            `/app/admin/${row.orgId}/customers/${row.customerId}`
          }
          label="Customers"
        />
      )}
      <p className={admin.footnote}>Read-only oversight; counts are live.</p>
    </div>
  );
}
