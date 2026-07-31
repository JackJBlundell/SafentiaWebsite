// ============================================================================
// JobsBoard (story 2025) - every scheduled visit across the organisation, live.
//
// The jobs node grows for the life of the org, so the subscription is NEVER the
// whole subtree: it is an indexed, bounded window - orderByChild('scheduledFor')
// + limitToLast(N) against the declared `.indexOn: scheduledFor` - and "Load
// more" widens N a page at a time. The UI states the window honestly, because
// the filters search only what has been loaded, and the at-a-glance tiles count
// only that same window.
//
// A Job record carries only ids (templateId/customerId/siteId/buildingId/
// assessorUid - nothing is denormalised), so names are resolved client-side:
//   - customers from /customers/{orgId} (already subscribed for the filter),
//   - buildings from /buildings/{orgId}/{siteId}, one bounded subscription per
//     DISTINCT site in the loaded window (capped - see MAX_SITE_LOOKUPS),
//   - assessors from /orgMembers/{orgId}, which the rules grant only to admin,
//     assessor and auditor: the read is gated by role (as ActivityPage does)
//     and the column plus its filter degrade to the raw uid / no filter.
// ============================================================================

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  limitToLast,
  orderByChild,
  query,
} from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type { Building, Customer, Job, OrgMember } from '../../types';
import { JOB_STATUSES } from '../../types';
import { Card, CardHeader, StatCard } from '../ui/Card';
import { CardGrid } from '../ui/Grid';
import { DataTable } from '../ui/DataTable';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import {
  activeFilters,
  clearAllFilters,
  FilterBar,
  type FilterField,
} from '../ui/FilterBar';
import { sortByName, toEntries } from '../customers/shared';
import {
  formatJobDate,
  formatSlot,
  JOB_STATUS_LABELS,
  JobStatusBadge,
  jobUrls,
} from './shared';
import { actorName } from '../lib/actorName';
import styles from './JobsBoard.module.css';

/** How many jobs each page of the window holds. */
const PAGE_SIZE = 200;

/** The board resolves building names one subscription per distinct site in the
 *  loaded window. This caps that fan-out so a very spread-out window cannot
 *  open unbounded listeners; sites beyond the cap show the building id. */
const MAX_SITE_LOOKUPS = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface JobRow extends Job {
  id: string;
}

/** Quiet 16px glyphs for the stat tiles (icon + number, matching ConsoleHome).
 *  Stroke currentColor so they wear the label's muted ink; always aria-hidden -
 *  the label alone carries the meaning. */
const TILE_ICON_PROPS = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const TILE_ICONS = {
  clipboard: (
    <svg {...TILE_ICON_PROPS}>
      <rect x="3.5" y="2.5" width="9" height="12" rx="1.5" />
      <path d="M6 2.5h4" />
      <path d="M6 7h4M6 10h4" />
    </svg>
  ),
  calendar: (
    <svg {...TILE_ICON_PROPS}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2.5v2M10.5 2.5v2" />
    </svg>
  ),
  clock: (
    <svg {...TILE_ICON_PROPS}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.6" />
    </svg>
  ),
  xCircle: (
    <svg {...TILE_ICON_PROPS}>
      <circle cx="8" cy="8" r="6" />
      <path d="m6 6 4 4M10 6l-4 4" />
    </svg>
  ),
} as const;

/** Order by `scheduledFor` descending so the furthest scheduled visit leads:
 *  upcoming work at the top, history below. Ordering is derived from the field,
 *  not snapshot iteration, because the selector runs off the cached raw value. */
function selectJobRows(value: unknown): JobRow[] {
  const node = (value as Record<string, Job> | null) ?? {};
  return Object.entries(node)
    .map(([id, job]) => ({ id, ...job }))
    .sort((a, b) => b.scheduledFor - a.scheduledFor);
}

/** yyyy-mm-dd -> local midnight epoch millis. Slot times are written from local
 *  date+time inputs (see the wizard), so the date filters compare in local days
 *  to match what the operator scheduled. */
function startOfDayLocal(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  return new Date(`${value}T00:00:00`).getTime();
}

/** Bounded per-site buildings subscription. Renders nothing; it feeds the
 *  board's name map so table cells stay synchronous. */
function SiteBuildingsResolver({
  orgId,
  siteId,
  path,
  onLoaded,
}: {
  orgId: string;
  siteId: string;
  path: string;
  onLoaded: (siteId: string, buildings: Record<string, Building>) => void;
}) {
  const buildings = useRtdbQuery<Record<string, Building> | null>({
    key: keys.buildings(orgId, siteId),
    path,
  });
  const data = buildings.data;
  useEffect(() => {
    if (data !== undefined) {
      onLoaded(siteId, data ?? {});
    }
  }, [data, siteId, onLoaded]);
  return null;
}

/** The at-a-glance counts, derived from the CURRENTLY LOADED window only (no new
 *  read). `undefined` while the window is still attaching, so the tiles show a
 *  value-shaped skeleton rather than an invented zero. */
interface WindowStats {
  total: number;
  upcoming: number;
  awaiting: number;
  cancelled: number;
}

export function JobsBoard() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(orgId && paths);
  const isAdmin = claims?.roles.admin === true;

  const [windowSize, setWindowSize] = useState(PAGE_SIZE);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [assessorUid, setAssessorUid] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Bounded, indexed window over the jobs node; never the whole subtree.
  const buildWindow = useMemo<RtdbQueryBuilder>(
    () => (node) => query(node, orderByChild('scheduledFor'), limitToLast(windowSize)),
    [windowSize],
  );
  const jobsQuery = useRtdbQuery<JobRow[]>({
    key: keys.jobsWindow(orgId, windowSize),
    path: paths ? paths.db.jobs(orgId) : '',
    select: selectJobRows,
    enabled,
    build: buildWindow,
  });
  const jobs = useMemo(() => jobsQuery.data ?? [], [jobsQuery.data]);
  // `undefined` means the listener has not attached yet: the tiles and table
  // show their loading shapes rather than a false empty board.
  const loading = jobsQuery.data === undefined;

  // Customers: the filter's options and the Customer column's names. Readable
  // by every org role, and bounded by nature (an org's customer list).
  const customersQuery = useRtdbQuery<Record<string, Customer> | null>({
    key: keys.customers(orgId),
    path: paths ? paths.db.customers(orgId) : '',
    enabled,
  });
  const customerOptions = useMemo(
    () => sortByName(toEntries(customersQuery.data)),
    [customersQuery.data],
  );

  // Staff, for assessor names and the assessor filter. database.rules.json
  // grants /orgMembers only to admin, assessor and auditor: for anyone else the
  // listener would be denied and retried forever, so the subscription is gated
  // by role and the board degrades to raw uids with no assessor filter.
  const canReadMembers =
    claims?.roles.admin === true ||
    claims?.roles.assessor === true ||
    claims?.roles.auditor === true;
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: enabled && canReadMembers,
  });
  const assessorOptions = useMemo(
    () =>
      sortByName(
        toEntries(membersQuery.data).filter(([, member]) => member.roles.assessor === true),
      ),
    [membersQuery.data],
  );

  // Buildings, resolved per distinct site in the loaded window (capped).
  const [buildingsBySite, setBuildingsBySite] = useState<
    Record<string, Record<string, Building>>
  >({});
  const onSiteLoaded = useCallback(
    (siteId: string, buildings: Record<string, Building>) =>
      setBuildingsBySite((previous) => ({ ...previous, [siteId]: buildings })),
    [],
  );
  const distinctSiteCount = useMemo(
    () => new Set(jobs.map((job) => job.siteId)).size,
    [jobs],
  );
  const siteIds = useMemo(
    () => [...new Set(jobs.map((job) => job.siteId))].slice(0, MAX_SITE_LOOKUPS),
    [jobs],
  );
  // The cap is a fan-out guard, not a secret: when the window spans more sites
  // than the board will resolve, the header says so instead of leaving raw
  // building ids unexplained.
  const siteLookupsCapped = distinctSiteCount > MAX_SITE_LOOKUPS;

  const customerName = (id: string) => customersQuery.data?.[id]?.name ?? id;
  const buildingName = (row: JobRow) =>
    buildingsBySite[row.siteId]?.[row.buildingId]?.name ?? row.buildingId;
  const assessorName = (uid: string) =>
    actorName(membersQuery.data, uid, membersQuery.data !== undefined);

  // At-a-glance counts over the loaded window. Upcoming = a future visit that
  // is not cancelled; awaiting = booked but not yet begun. Honest to the window
  // the board actually holds - never a claim about the whole org.
  const stats = useMemo<WindowStats | undefined>(() => {
    if (jobsQuery.data === undefined) {
      return undefined;
    }
    const now = Date.now();
    let upcoming = 0;
    let awaiting = 0;
    let cancelled = 0;
    for (const job of jobs) {
      if (job.status === 'cancelled') {
        cancelled += 1;
      } else if (job.scheduledFor > now) {
        upcoming += 1;
      }
      if (job.status === 'scheduled') {
        awaiting += 1;
      }
    }
    return { total: jobs.length, upcoming, awaiting, cancelled };
  }, [jobsQuery.data, jobs]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const from = startOfDayLocal(fromDate);
    const toStart = startOfDayLocal(toDate);
    // The "to" date includes the whole of its own day (exclusive upper bound).
    const toExclusive = toStart === undefined ? undefined : toStart + DAY_MS;
    return jobs.filter((job) => {
      if (status && job.status !== status) return false;
      if (assessorUid && job.assessorUid !== assessorUid) return false;
      if (customerId && job.customerId !== customerId) return false;
      if (from !== undefined && job.scheduledFor < from) return false;
      if (toExclusive !== undefined && job.scheduledFor >= toExclusive) return false;
      if (needle.length > 0) {
        const haystack =
          `${buildingName(job)} ${customerName(job.customerId)}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    // buildingsBySite and the query data feed the name lookups used above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    jobs,
    search,
    status,
    assessorUid,
    customerId,
    fromDate,
    toDate,
    buildingsBySite,
    customersQuery.data,
  ]);

  const windowFull = jobs.length >= windowSize;

  // The board's filters, declared ONCE. FilterBar renders these, derives the
  // active-filter chips from them and clears them, so a filter added here can
  // never appear in the panel and go missing from the summary - which is
  // exactly what the hand-written chip list this replaces invited.
  const filterFields: FilterField[] = [
    {
      kind: 'search',
      id: 'jobs-search',
      label: 'Search',
      placeholder: 'Building or customer',
      value: search,
      onChange: setSearch,
    },
    {
      kind: 'select',
      id: 'jobs-status',
      label: 'Status',
      allLabel: 'All statuses',
      value: status,
      onChange: setStatus,
      options: JOB_STATUSES.map((value) => ({
        value,
        label: JOB_STATUS_LABELS[value],
      })),
    },
    // /orgMembers is readable by admin, assessor and auditor only, so for
    // anyone else the assessor filter is not offered at all - matching the
    // gated subscription above and the column's uid fallback.
    ...(canReadMembers
      ? [
          {
            kind: 'select',
            id: 'jobs-assessor',
            label: 'Assessor',
            allLabel: 'All assessors',
            value: assessorUid,
            onChange: setAssessorUid,
            options: assessorOptions.map(([uid, member]) => ({
              value: uid,
              label: member.name,
            })),
          } satisfies FilterField,
        ]
      : []),
    {
      kind: 'select',
      id: 'jobs-customer',
      label: 'Customer',
      allLabel: 'All customers',
      value: customerId,
      onChange: setCustomerId,
      options: customerOptions.map(([id, customer]) => ({
        value: id,
        label: customer.name,
      })),
    },
    {
      kind: 'dateRange',
      id: 'jobs-date',
      label: 'Visit date',
      from: fromDate,
      to: toDate,
      onChangeFrom: setFromDate,
      onChangeTo: setToDate,
      // Slot times are written from LOCAL date+time inputs (see the wizard), so
      // a bound reads in local days, matching what the operator scheduled.
      formatValue: (value) =>
        formatJobDate(new Date(`${value}T00:00:00`).getTime()),
    },
  ];

  const hasActiveFilters = activeFilters(filterFields).length > 0;
  // One reset for both the bar's Clear all and the filtered-empty state's
  // recovery action, derived from the same declaration, so the two cannot drift.
  const resetFilters = () => clearAllFilters(filterFields);

  // The stat tiles, in reading order. Values are undefined until the window
  // attaches (StatCard renders its own value-shaped skeleton for that state).
  const statTiles: Array<{
    label: string;
    value: number | undefined;
    hint: string;
    icon: ReactNode;
  }> = [
    {
      label: 'In view',
      value: stats?.total,
      hint: 'jobs in the loaded window',
      icon: TILE_ICONS.clipboard,
    },
    {
      label: 'Upcoming',
      value: stats?.upcoming,
      hint: 'future visits, not cancelled',
      icon: TILE_ICONS.calendar,
    },
    {
      label: 'Awaiting visit',
      value: stats?.awaiting,
      hint: 'scheduled, not yet begun',
      icon: TILE_ICONS.clock,
    },
    {
      label: 'Cancelled',
      value: stats?.cancelled,
      hint: 'in the loaded window',
      icon: TILE_ICONS.xCircle,
    },
  ];

  return (
    <div className={styles.board}>
      <PageHeader
        title="Jobs"
        lede="Every scheduled assessment visit across your organisation, live from the moment it is booked to the moment its report is released."
        action={isAdmin ? <Button to={jobUrls.jobNew}>Schedule a job</Button> : undefined}
      />

      {jobsQuery.isError && (
        <ErrorNotice message="Could not load the jobs board. Please try again." />
      )}

      {paths &&
        siteIds.map((siteId) => (
          <SiteBuildingsResolver
            key={siteId}
            orgId={orgId}
            siteId={siteId}
            path={paths.db.buildings(orgId, siteId)}
            onLoaded={onSiteLoaded}
          />
        ))}

      <section aria-label="Jobs at a glance" className={styles.stats}>
        <CardGrid min={200}>
          {statTiles.map((tile) => (
            <StatCard
              key={tile.label}
              label={tile.label}
              value={tile.value}
              hint={tile.hint}
              icon={tile.icon}
            />
          ))}
        </CardGrid>
      </section>

      <FilterBar
        label="Filter jobs"
        fields={filterFields}
        // The count is stated where the reader is looking, not buried in the
        // table's hint: how much is loaded, and how much of it survived the
        // filters. Announced, so a narrowing search is heard as well as seen.
        note={
          loading
            ? 'Loading the most recent scheduled visits.'
            : hasActiveFilters
              ? `${rows.length} of ${jobs.length} loaded jobs match. Filters search the loaded window only.`
              : `${jobs.length} jobs loaded. Filters search the loaded window only.`
        }
      />

      <Card flush>
        <CardHeader
          title="Scheduled jobs"
          hint={
            loading
              ? 'Loading the most recent scheduled visits.'
              : `Showing the most recent ${jobs.length} jobs by visit date. Filters search what is loaded.${
                  siteLookupsCapped
                    ? ` Building names are shown for the ${MAX_SITE_LOOKUPS} most recent sites; rows beyond that show the building id.`
                    : ''
                }`
          }
        />
        {loading ? (
          <div className={styles.tableSkeleton}>
            <SkeletonRows rows={6} label="Loading scheduled jobs" />
          </div>
        ) : rows.length === 0 ? (
          hasActiveFilters ? (
            <EmptyState
              title="No jobs match these filters"
              body="No loaded jobs match the filters above. Clear a filter, or load older jobs to widen the window."
              action={
                <Button variant="secondary" onClick={resetFilters}>
                  Clear all filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No jobs scheduled yet"
              body="Nothing has been scheduled across your organisation. Booking a visit puts it on this board instantly."
              action={
                isAdmin ? <Button to={jobUrls.jobNew}>Schedule a job</Button> : undefined
              }
            />
          )
        ) : (
          <DataTable<JobRow>
            label="Scheduled jobs"
            rows={rows}
            rowKey={(row) => row.id}
            rowHref={(row) => jobUrls.job(row.id)}
            columns={[
              {
                header: 'Date',
                cell: (row) => (
                  <span className={styles.when}>
                    <span className={styles.whenDate}>{formatJobDate(row.scheduledFor)}</span>
                    <span className={styles.whenSlot}>
                      {formatSlot(row.scheduledFor, row.scheduledUntil)}
                    </span>
                  </span>
                ),
              },
              { header: 'Customer', cell: (row) => customerName(row.customerId) },
              { header: 'Building', cell: (row) => buildingName(row) },
              {
                header: 'Assessor',
                desktopOnly: true,
                cell: (row) => assessorName(row.assessorUid),
              },
              { header: 'Status', cell: (row) => <JobStatusBadge status={row.status} /> },
            ]}
          />
        )}
        {windowFull && (
          <div className={styles.loadMore}>
            <Button
              variant="secondary"
              onClick={() => setWindowSize((size) => size + PAGE_SIZE)}
            >
              Load older jobs
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
