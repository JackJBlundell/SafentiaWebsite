// ============================================================================
// PlatformBuildings - every building across every organisation, per
// environment.
//
// The platform-wide roll-up behind the dashboard's "Buildings" tile: the org
// list is read once, then a tiny invisible reporter per org reads that org's
// buildings root ({siteId: {buildingId: Building}}) and pushes flattened rows
// up. Mirrors OrgsOverview and the dashboard - one bounded subscription per org.
//
// Risk is the STORED riskLevel the release pipeline derived; this screen
// presents it, it never re-derives. Each building links to the oversight
// drill-down, resolved from the building's own customerId; a building with no
// resolvable customer links to its organisation instead, never a broken URL.
//
// Read-only oversight: this screen never writes tenant data.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Building, Organisation, RiskLevel } from '../../types';
import { RagChip, formatDate } from '../customers/shared';
import { DataTable, type Column } from '../ui/DataTable';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { usePlatformEnv } from './platformEnv';
import admin from './admin.module.css';
import styles from './PlatformBuildings.module.css';

/** The org-wide buildings node: sites keyed by id, each a map of buildings. */
type BuildingsRootNode = Record<string, Record<string, Building>>;

interface BuildingRow {
  orgId: string;
  orgName: string;
  siteId: string;
  buildingId: string;
  name: string;
  customerId?: string;
  riskLevel: RiskLevel;
  lastAssessedAt?: number;
}

/** Flatten one org's buildings root into rows, carrying the siteId and the
 *  building's own customerId for the drill-down link. */
function rowsForOrg(
  orgId: string,
  orgName: string,
  root: BuildingsRootNode | null,
): BuildingRow[] {
  const rows: BuildingRow[] = [];
  for (const [siteId, buildings] of Object.entries(root ?? {})) {
    if (!buildings || typeof buildings !== 'object') {
      continue;
    }
    for (const [buildingId, building] of Object.entries(buildings)) {
      rows.push({
        orgId,
        orgName,
        siteId,
        buildingId,
        name: building?.name ?? buildingId,
        customerId: building?.customerId,
        riskLevel: building?.riskLevel ?? 'pending',
        lastAssessedAt: building?.lastAssessedAt,
      });
    }
  }
  return rows;
}

/** Read one org's buildings root and report flattened rows upward. Renders
 *  nothing itself. */
function OrgBuildingsReporter({
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
  onReport: (orgId: string, rows: BuildingRow[]) => void;
}) {
  // Shape in `select`: an absent node resolves to null -> an empty row list
  // (never undefined), so an org with no buildings reports honestly instead of
  // looking like it is still loading.
  const buildings = useRtdbQuery<BuildingRow[]>({
    key: queryKey,
    path,
    select: (value) => rowsForOrg(orgId, orgName, value as BuildingsRootNode | null),
  });
  // Reported from an effect, never mid-render (see the other platform lists);
  // the parent's reporter guard breaks any re-render cycle.
  useEffect(() => {
    if (buildings.data !== undefined) {
      onReport(orgId, buildings.data);
    }
  }, [buildings.data, orgId, onReport]);
  return null;
}

export function PlatformBuildings() {
  // The environment is the platform-wide choice from the rail toggle.
  const { env } = usePlatformEnv();
  const [rowsByOrg, setRowsByOrg] = useState<Record<string, BuildingRow[]>>({});
  const paths = forEnv(env);

  const orgsQuery = useRtdbQuery<Record<string, Organisation> | null>({
    key: ['platformOrgs', env],
    path: paths.db.organisationsRoot(),
  });

  // Guarded set: an unchanged report returns the previous state unchanged, so a
  // reporter that re-selects an equal row list on every render never drives a
  // re-render loop. Content equality, because select may hand back a fresh array.
  const reportRows = useCallback((orgId: string, rows: BuildingRow[]) => {
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

  const rows: BuildingRow[] = orgIds
    .flatMap((orgId) => rowsByOrg[orgId] ?? [])
    .sort(
      (a, b) =>
        a.orgName.localeCompare(b.orgName, 'en-GB') ||
        a.name.localeCompare(b.name, 'en-GB'),
    );

  // The building's own customerId gives the full drill-down; without it, fall
  // back to the organisation detail so the row is never a dead link.
  const rowHref = (row: BuildingRow): string =>
    row.customerId
      ? `/app/admin/${row.orgId}/customers/${row.customerId}/buildings/${row.siteId}/${row.buildingId}`
      : `/app/admin/${row.orgId}`;

  const columns: Array<Column<BuildingRow>> = [
    { header: 'Organisation', cell: (row) => row.orgName },
    { header: 'Building', cell: (row) => row.name },
    { header: 'Risk', cell: (row) => <RagChip level={row.riskLevel} /> },
    {
      header: 'Last assessed',
      cell: (row) =>
        row.lastAssessedAt !== undefined ? (
          formatDate(row.lastAssessedAt)
        ) : (
          <span className={styles.notAssessed}>Not yet assessed</span>
        ),
      desktopOnly: true,
    },
  ];

  return (
    <div className={admin.stack}>
      <PageHeader
        title="Buildings"
        crumbs={[{ label: 'Platform', to: '/app/admin' }, { label: 'Buildings' }]}
        lede="Every building across every organisation on Safentia. Read-only oversight; risk levels are the stored figures the release pipeline derived."
      />
      {/* Invisible per-org reporters: one bounded buildings read each. */}
      {orgs.map((org) => (
        <div key={org.orgId} hidden>
          <OrgBuildingsReporter
            orgId={org.orgId}
            orgName={org.name}
            path={paths.db.buildingsRoot(org.orgId)}
            queryKey={['platformBuildingsList', env, org.orgId]}
            onReport={reportRows}
          />
        </div>
      ))}

      {orgsQuery.isError && (
        <ErrorNotice message="Could not load the buildings. Please try again." />
      )}
      {!ready && !orgsQuery.isError && (
        <SkeletonRows rows={4} label="Loading buildings across the platform" />
      )}
      {ready && !orgsQuery.isError && rows.length === 0 && (
        <p className={admin.emptyNote}>No buildings found in this environment.</p>
      )}
      {ready && rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.orgId}:${row.siteId}:${row.buildingId}`}
          rowHref={rowHref}
          label="Buildings"
        />
      )}
      <p className={admin.footnote}>Read-only oversight; counts are live.</p>
    </div>
  );
}
