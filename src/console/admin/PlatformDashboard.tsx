// ============================================================================
// PlatformDashboard - the super-admin platform landing (FR-E24).
//
// The oversight home: top-line stat tiles (organisations, members, buildings,
// customers), a real growth line chart, and a preview of the future billing
// view. The full organisations table lives one link away at
// /app/admin/organisations.
//
// Counts and growth are live per-org reads, exactly the technique OrgsOverview
// uses: one bounded subscription per org per node, each read by a tiny invisible
// reporter that pushes its value up. That is deliberate while the platform is
// early and the org list is small (a handful of node reads beats server-side
// counters); revisit with derived roll-ups at hundreds of organisations.
//
// The tiles aggregate as the reporters report (a guarded reducer over a counts
// map, so a report from a render can never loop), and show the RUNNING total
// rather than blocking on the slowest org. Cache keys are platform-scoped and
// carry the environment, so these oversight reads can never collide with the
// operator's own org session in the query cache.
//
// Read-only oversight: this screen never writes tenant data.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { countPerMonth, lastMonths } from '../reports/orgMetrics';
import type { Organisation } from '../../types';
import { Card, CardHeader, StatCard } from '../ui/Card';
import { CardGrid } from '../ui/Grid';
import { PageHeader, ErrorNotice } from '../ui/Page';
import { Skeleton, SkeletonStatus } from '../ui/Skeleton';
import { GrowthChart } from './GrowthChart';
import { usePlatformEnv } from './platformEnv';
import { RevenuePreview } from './RevenuePreview';
import styles from './PlatformDashboard.module.css';

/** How many months of invitation history the growth chart plots. */
const GROWTH_MONTHS = 12;

/** The aggregate node counts one org contributes. Partial by nature: a count
 *  that has not loaded yet is simply absent and contributes zero to the running
 *  total until it reports. */
type OrgCounts = Record<string, { members?: number; customers?: number; buildings?: number }>;

/** Per-org invitation createdAt timestamps, reported up for the growth series. */
type OrgInviteStamps = Record<string, number[]>;

/** Count the children of one org-scoped map node - a live, bounded read - and
 *  report the count upward. Renders nothing itself. */
function MapCountReporter({
  path,
  queryKey,
  onReport,
}: {
  path: string;
  queryKey: ReadonlyArray<string | number>;
  onReport: (value: number) => void;
}) {
  const count = useRtdbQuery<number>({
    key: queryKey,
    path,
    select: (value) =>
      value && typeof value === 'object' ? Object.keys(value).length : 0,
  });
  // Reported from an effect, never mid-render: a render-phase parent setState is
  // a React error and a re-render loop risk. The reducer upstream is guarded, so
  // an unchanged report is a no-op.
  useEffect(() => {
    if (count.data !== undefined) {
      onReport(count.data);
    }
  }, [count.data, onReport]);
  return null;
}

/** A building count flattens sites first ({siteId: {buildingId}}) before counting. */
function BuildingCountReporter({
  path,
  queryKey,
  onReport,
}: {
  path: string;
  queryKey: ReadonlyArray<string | number>;
  onReport: (value: number) => void;
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
          total + (site && typeof site === 'object' ? Object.keys(site).length : 0),
        0,
      );
    },
  });
  useEffect(() => {
    if (count.data !== undefined) {
      onReport(count.data);
    }
  }, [count.data, onReport]);
  return null;
}

/** Read one org's invitation summaries and report their createdAt timestamps up
 *  for the platform growth series. An absent node reports an empty list (zero
 *  contribution), never an error. Renders nothing itself. */
function InviteStampsReporter({
  path,
  queryKey,
  onReport,
}: {
  path: string;
  queryKey: ReadonlyArray<string | number>;
  onReport: (stamps: number[]) => void;
}) {
  const invites = useRtdbQuery<number[]>({
    key: queryKey,
    path,
    select: (value) => {
      if (!value || typeof value !== 'object') {
        return [];
      }
      return Object.values(value as Record<string, unknown>)
        .map((invite) =>
          invite && typeof invite === 'object'
            ? (invite as { createdAt?: unknown }).createdAt
            : undefined,
        )
        .filter((stamp): stamp is number => typeof stamp === 'number');
    },
  });
  useEffect(() => {
    if (invites.data !== undefined) {
      onReport(invites.data);
    }
  }, [invites.data, onReport]);
  return null;
}

/** The drill-through cue on a whole-tile stat link: a chevron that fades in on
 *  hover/focus without shifting layout (absolutely positioned, opacity only).
 *  Decorative - the tile's label and number are the link's accessible name.
 *  Mirrors ConsoleHome's stat tiles so the org and platform dashboards share
 *  one affordance. */
function StatChevron() {
  return (
    <span aria-hidden="true" className={styles.statChevron}>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m6 3.5 4.5 4.5L6 12.5" />
      </svg>
    </span>
  );
}

/** A value-shaped skeleton block standing in for a chart while it loads. */
function ChartSkeleton({ label }: { label: string }) {
  return (
    <div>
      <SkeletonStatus label={label} />
      <Skeleton height="180px" />
    </div>
  );
}

export function PlatformDashboard() {
  // The environment is the platform-wide choice from the rail toggle, not a
  // per-page state: every platform screen reads the same value.
  const { env } = usePlatformEnv();
  const [counts, setCounts] = useState<OrgCounts>({});
  const [inviteStamps, setInviteStamps] = useState<OrgInviteStamps>({});
  const paths = forEnv(env);

  const orgsQuery = useRtdbQuery<Record<string, Organisation> | null>({
    key: ['platformOrgs', env],
    path: paths.db.organisationsRoot(),
  });

  // Guarded set: only a CHANGED value writes state, so the report from a render
  // can never cause a render loop.
  const reportCount = useCallback(
    (orgId: string, metric: 'members' | 'customers' | 'buildings', value: number) => {
      setCounts((previous) =>
        previous[orgId]?.[metric] === value
          ? previous
          : { ...previous, [orgId]: { ...previous[orgId], [metric]: value } },
      );
    },
    [],
  );

  const reportInvites = useCallback((orgId: string, stamps: number[]) => {
    setInviteStamps((previous) => {
      const existing = previous[orgId];
      if (
        existing &&
        existing.length === stamps.length &&
        existing.every((value, index) => value === stamps[index])
      ) {
        return previous;
      }
      return { ...previous, [orgId]: stamps };
    });
  }, []);

  const orgIds = Object.keys(orgsQuery.data ?? {});

  // Tiles show the running total: undefined (skeleton) until the org list loads,
  // then the sum of whatever the reporters have contributed so far.
  const sumMetric = (metric: 'members' | 'customers' | 'buildings') =>
    orgIds.reduce((total, orgId) => total + (counts[orgId]?.[metric] ?? 0), 0);

  const totalOrganisations = orgsQuery.isLoading ? undefined : orgIds.length;
  const totalMembers = orgsQuery.isLoading ? undefined : sumMetric('members');
  const totalBuildings = orgsQuery.isLoading ? undefined : sumMetric('buildings');
  const totalCustomers = orgsQuery.isLoading ? undefined : sumMetric('customers');

  // The growth chart waits until every listed org's invitations node has
  // reported, so a slow org can never flash a false "no data" empty state.
  const invitesReady =
    !orgsQuery.isLoading &&
    (orgIds.length === 0 || orgIds.every((orgId) => inviteStamps[orgId] !== undefined));

  const months = lastMonths(GROWTH_MONTHS, Date.now());
  const growthCounts = countPerMonth(
    orgIds
      .flatMap((orgId) => inviteStamps[orgId] ?? [])
      .map((createdAt) => ({ at: createdAt })),
  );

  return (
    <div className={styles.stack}>
      <PageHeader
        title="Platform"
        lede="Oversight of every organisation on Safentia, across the live and test environments."
      />

      {/* Invisible per-org reporters: one bounded read each, pushing counts and
          invitation timestamps up to the aggregates above. */}
      {orgIds.map((orgId) => (
        <div key={orgId} hidden>
          <MapCountReporter
            path={paths.db.orgMembers(orgId)}
            queryKey={['platformOrgMembersCount', env, orgId]}
            onReport={(value) => reportCount(orgId, 'members', value)}
          />
          <MapCountReporter
            path={paths.db.customers(orgId)}
            queryKey={['platformCustomersCount', env, orgId]}
            onReport={(value) => reportCount(orgId, 'customers', value)}
          />
          <BuildingCountReporter
            path={paths.db.buildingsRoot(orgId)}
            queryKey={['platformBuildingsCount', env, orgId]}
            onReport={(value) => reportCount(orgId, 'buildings', value)}
          />
          <InviteStampsReporter
            path={paths.db.orgInvitations(orgId)}
            queryKey={['platformOrgInvitations', env, orgId]}
            onReport={(stamps) => reportInvites(orgId, stamps)}
          />
        </div>
      ))}

      {orgsQuery.isError && (
        <ErrorNotice message="Could not load the platform overview. Please try again." />
      )}

      {/* Each tile is a whole-tile link into its platform-wide list, exactly
          as ConsoleHome's tiles drill through: the focus ring and hover lift
          come from the shared statLink idiom, and the numbers still render. */}
      <CardGrid min={200}>
        {(
          [
            { label: 'Organisations', value: totalOrganisations, to: '/app/admin/organisations' },
            { label: 'Members', value: totalMembers, to: '/app/admin/members' },
            { label: 'Buildings', value: totalBuildings, to: '/app/admin/buildings' },
            { label: 'Customers', value: totalCustomers, to: '/app/admin/customers' },
          ] as const
        ).map((tile) => (
          <Link key={tile.label} to={tile.to} className={styles.statLink}>
            <StatCard label={tile.label} value={tile.value} />
            <StatChevron />
          </Link>
        ))}
      </CardGrid>

      <div className={styles.grid}>
        <Card>
          <CardHeader
            title="Members invited per month"
            hint={`New member invitations sent across all organisations in each of the last ${GROWTH_MONTHS} months; the table beneath carries the same figures.`}
          />
          {invitesReady ? (
            <GrowthChart months={months} counts={growthCounts} />
          ) : (
            <ChartSkeleton label="Loading the growth chart" />
          )}
        </Card>

        <RevenuePreview />
      </div>

      <Card>
        <div className={styles.tableLinkRow}>
          <div>
            <p className={styles.tableLinkTitle}>All organisations</p>
            <p className={styles.tableLinkHint}>
              Every organisation with its live member, customer and building
              counts.
            </p>
          </div>
          <Link className={styles.tableLink} to="/app/admin/organisations">
            View all organisations
          </Link>
        </div>
      </Card>

      <p className={styles.footnote}>Read-only oversight; counts are live.</p>
    </div>
  );
}
