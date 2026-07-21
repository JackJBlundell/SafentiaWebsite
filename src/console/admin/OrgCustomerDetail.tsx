// ============================================================================
// OrgCustomerDetail - super-admin oversight of ONE customer inside an
// organisation (FR-E24 drill-down). Read-only: the customer's recorded facts,
// its sites, and under each site the buildings that stand on it, each linking
// down to the building's assessment history. Mirrors the tenant CustomerDetail
// / SiteDetail layout with every mutation affordance stripped - a platform
// operator observes tenants, never acts on their behalf.
//
// Data reads the whole environment via the superAdmin rules cascade
// (database.rules.json). Buildings come from the ONE org-wide buildings root
// (`{siteId: {buildingId}}`), so the whole customer's estate is one
// subscription rather than a per-site fan-out. Cache keys are platform-scoped
// (prefixed 'platform', carrying env + ids) so they never collide with a
// tenant session's own keys.
// ============================================================================

import { useParams } from 'react-router-dom';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Building, Customer, OrgProfile, Site } from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { DescriptionList, PageGrid, type DescriptionItem } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import {
  formatDate,
  RagChip,
  sortByName,
  StatusBadge,
  toEntries,
} from '../customers/shared';
import { usePlatformEnv } from './platformEnv';
import styles from './OrgCustomerDetail.module.css';

type BuildingsBySite = Record<string, Record<string, Building> | null>;
interface BuildingRow {
  siteId: string;
  buildingId: string;
  building: Building;
}

export function OrgCustomerDetail() {
  const { orgId = '', customerId = '' } = useParams<{
    orgId: string;
    customerId: string;
  }>();
  // The environment is the platform-wide choice from the rail toggle, no longer
  // read from the URL; only the ids come from the route.
  const { env } = usePlatformEnv();
  const paths = forEnv(env);
  const enabled = Boolean(orgId && customerId);

  const orgProfileQuery = useRtdbQuery<OrgProfile | null>({
    key: ['platformOrgProfile', env, orgId],
    path: paths.db.orgProfile(orgId),
    enabled: Boolean(orgId),
  });
  const customerQuery = useRtdbQuery<Customer | null>({
    key: ['platformCustomer', env, orgId, customerId],
    path: paths.db.customer(orgId, customerId),
    enabled,
  });
  const sitesQuery = useRtdbQuery<Record<string, Site> | null>({
    key: ['platformCustomerSites', env, orgId, customerId],
    path: paths.db.sites(orgId, customerId),
    enabled,
  });
  // Every building across the org keyed by siteId - one read for the whole
  // estate, filtered to this customer's sites below.
  const buildingsRootQuery = useRtdbQuery<BuildingsBySite | null>({
    key: ['platformBuildingsRoot', env, orgId],
    path: paths.db.buildingsRoot(orgId),
    enabled: Boolean(orgId),
  });

  const orgName = orgProfileQuery.data?.name ?? orgId;
  const crumbs = [
    { label: 'Platform', to: '/app/admin' },
    { label: orgName, to: `/app/admin/${orgId}` },
    { label: customerQuery.data?.name ?? customerId },
  ];

  if (customerQuery.isError) {
    return (
      <ErrorNotice message="Could not load this customer. Please try again." />
    );
  }
  if (!customerQuery.isLoading && !customerQuery.data) {
    return (
      <EmptyState
        title="Customer not found"
        body="This customer does not exist in this environment."
      />
    );
  }

  const customer = customerQuery.data;
  const siteRows = sortByName(toEntries(sitesQuery.data));

  const facts: DescriptionItem[] = [
    { label: 'Address', value: customer?.address },
    { label: 'Switchboard email', value: customer?.email },
    { label: 'Phone', value: customer?.phone },
    {
      label: 'Status',
      value: customer ? <StatusBadge status={customer.status} /> : undefined,
    },
    { label: 'Customer id', value: customerId },
  ];

  const buildingColumns: Array<Column<BuildingRow>> = [
    { header: 'Building', cell: (row) => row.building.name },
    {
      header: 'Risk',
      cell: (row) => <RagChip level={row.building.riskLevel ?? 'pending'} />,
      desktopOnly: true,
    },
    {
      header: 'Last assessed',
      cell: (row) =>
        row.building.lastAssessedAt
          ? formatDate(row.building.lastAssessedAt)
          : 'Never',
      desktopOnly: true,
    },
  ];

  return (
    <div className={styles.stack}>
      <PageHeader
        title={customer?.name ?? customerId}
        crumbs={crumbs}
        lede="Read-only oversight. Nothing on this screen changes the customer."
      />

      <PageGrid
        aside={
          <Card>
            <CardHeader title="Customer" />
            <DescriptionList items={facts} />
          </Card>
        }
      >
        <Card flush={siteRows.length > 0}>
          <CardHeader
            title="Sites"
            hint="The locations this customer occupies, and the buildings that stand on each."
          />
          {sitesQuery.isLoading ? (
            <SkeletonRows rows={3} label="Loading sites" />
          ) : siteRows.length === 0 ? (
            <p className={styles.emptyNote}>This customer has no sites.</p>
          ) : (
            <ul className={styles.siteList}>
              {siteRows.map(([siteId, site]) => {
                const buildingRows: BuildingRow[] = sortByName(
                  toEntries(buildingsRootQuery.data?.[siteId]),
                ).map(([buildingId, building]) => ({
                  siteId,
                  buildingId,
                  building,
                }));
                return (
                  <li key={siteId} className={styles.site}>
                    <div className={styles.siteHead}>
                      <span className={styles.siteName}>{site.name}</span>
                      {site.address && (
                        <span className={styles.siteMeta}>{site.address}</span>
                      )}
                    </div>
                    {buildingsRootQuery.isLoading ? (
                      <SkeletonRows rows={2} label="Loading buildings" />
                    ) : buildingRows.length === 0 ? (
                      <p className={styles.emptyNote}>
                        No buildings recorded for this site.
                      </p>
                    ) : (
                      <DataTable
                        columns={buildingColumns}
                        rows={buildingRows}
                        rowKey={(row) => `${row.siteId}/${row.buildingId}`}
                        rowHref={(row) =>
                          `/app/admin/${orgId}/customers/${customerId}/buildings/${row.siteId}/${row.buildingId}`
                        }
                        label={`Buildings at ${site.name}`}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </PageGrid>
    </div>
  );
}
