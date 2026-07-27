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
// Oversight of a large estate needs a way to narrow it: search (name, address,
// organisation) and two filters (organisation, risk level) that compose, each
// derived purely from rows already loaded so no filter adds a new listener. The
// risk filter reuses riskPresentation so its swatches carry the SAME fixed
// colour, label and icon as the table chips; colour is never the sole carrier.
//
// Read-only oversight: this screen never writes tenant data.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { riskPresentation } from '../../design/rag';
import { useTheme } from '../../design/ThemeProvider';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { RISK_LEVELS, type Building, type Organisation, type RiskLevel } from '../../types';
import { RagChip, formatDate } from '../customers/shared';
import shared from '../customers/shared.module.css';
import { DataTable, type Column } from '../ui/DataTable';
import { Toolbar, ToolbarGroup } from '../ui/Grid';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { usePlatformEnv } from './platformEnv';
import admin from './admin.module.css';
import styles from './PlatformBuildings.module.css';

/** The org-wide buildings node: sites keyed by id, each a map of buildings. */
type BuildingsRootNode = Record<string, Record<string, Building>>;

/** A risk filter value: any stored level, or the "all levels" default. */
type RiskFilter = RiskLevel | 'all';

interface BuildingRow {
  orgId: string;
  orgName: string;
  siteId: string;
  buildingId: string;
  name: string;
  address?: string;
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
        address: building?.address,
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

/** The risk filter as a single-select segment group. Each level's swatch is the
 *  SAME fixed colour, icon and label the table chips use (riskPresentation),
 *  never a recolour, so colour is paired with its word and toggling one level on
 *  clears any other. Clicking the active level clears back to "all". */
function RiskFilterGroup({
  value,
  onChange,
}: {
  value: RiskFilter;
  onChange: (next: RiskFilter) => void;
}) {
  const { theme } = useTheme();
  return (
    <div className={styles.riskFilter}>
      <span id="platform-buildings-risk-label" className={shared.label}>
        Risk level
      </span>
      <div
        className={styles.riskOptions}
        role="group"
        aria-labelledby="platform-buildings-risk-label"
      >
        <button
          type="button"
          className={value === 'all' ? styles.riskChipActive : styles.riskChip}
          aria-pressed={value === 'all'}
          onClick={() => onChange('all')}
        >
          All levels
        </button>
        {RISK_LEVELS.map((level) => {
          const rag = riskPresentation(theme, level);
          const active = value === level;
          return (
            <button
              key={level}
              type="button"
              className={active ? styles.riskChipActive : styles.riskChip}
              // Active state borrows the RAG surface/colour pairing (already
              // contrast-checked for the chip); the label and icon carry the
              // meaning so the colour is never doing the work alone.
              style={active ? { color: rag.color, background: rag.surface, borderColor: rag.color } : undefined}
              aria-pressed={active}
              onClick={() => onChange(active ? 'all' : level)}
            >
              <span aria-hidden="true">{rag.icon}</span>
              {rag.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PlatformBuildings() {
  // The environment is the platform-wide choice from the rail toggle.
  const { env } = usePlatformEnv();
  const [rowsByOrg, setRowsByOrg] = useState<Record<string, BuildingRow[]>>({});
  const [search, setSearch] = useState('');
  const [orgFilter, setOrgFilter] = useState('');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
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

  // Derived from the two live sources (the org list and each org's reported
  // rows), so it only recomputes when real data changes, not on every render.
  const rows: BuildingRow[] = useMemo(() => {
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
  // hold buildings), so the dropdown never offers a choice that filters to
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

  // Search AND organisation AND risk all narrow together; each clause reads only
  // fields already on the row, so filtering never triggers a new read.
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (orgFilter && row.orgId !== orgFilter) {
        return false;
      }
      if (riskFilter !== 'all' && row.riskLevel !== riskFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const haystack = [row.name, row.address, row.orgName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, search, orgFilter, riskFilter]);

  const hasFilters = search.trim() !== '' || orgFilter !== '' || riskFilter !== 'all';
  const clearFilters = () => {
    setSearch('');
    setOrgFilter('');
    setRiskFilter('all');
  };

  // The building's own customerId gives the full drill-down; without it, fall
  // back to the organisation detail so the row is never a dead link.
  const rowHref = (row: BuildingRow): string =>
    row.customerId
      ? `/app/admin/${row.orgId}/customers/${row.customerId}/buildings/${row.siteId}/${row.buildingId}`
      : `/app/admin/${row.orgId}`;

  const columns: Array<Column<BuildingRow>> = [
    { header: 'Organisation', cell: (row) => row.orgName },
    {
      header: 'Building',
      cell: (row) => (
        <span className={styles.buildingCell}>
          <span className={styles.buildingName}>{row.name}</span>
          {row.address && <span className={styles.buildingMeta}>{row.address}</span>}
        </span>
      ),
    },
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
        <>
          <Toolbar>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="platform-buildings-search">
                  Search buildings
                </label>
                <input
                  id="platform-buildings-search"
                  className={`${shared.input} ${admin.searchInput}`}
                  type="search"
                  autoComplete="off"
                  placeholder="Name, address or organisation"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </ToolbarGroup>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="platform-buildings-org">
                  Organisation
                </label>
                <select
                  id="platform-buildings-org"
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
              <RiskFilterGroup value={riskFilter} onChange={setRiskFilter} />
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
            {rows.length === 1 ? 'building' : 'buildings'}
          </p>

          {filteredRows.length === 0 ? (
            <div className={admin.noMatch}>
              <p className={admin.emptyNote}>
                No buildings match your search and filters.
              </p>
              <Button variant="secondary" type="button" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={filteredRows}
              rowKey={(row) => `${row.orgId}:${row.siteId}:${row.buildingId}`}
              rowHref={rowHref}
              label="Buildings"
            />
          )}
        </>
      )}
      <p className={admin.footnote}>Read-only oversight; counts are live.</p>
    </div>
  );
}
