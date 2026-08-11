// ============================================================================
// FinancePage - the super-admin Finance tab (Phase 3 §7).
//
// READ-ONLY OVERSIGHT, BY DESIGN: like every screen under /app/admin, this tab
// mutates nothing - not a tenant's data, not a subscription, not a price. It
// derives every figure from three superAdmin-readable sources (the org root's
// subscription blocks, the env-nested plan catalogue, and the bounded
// financeEvents feed the webhook writes) via the pure financeMetrics module.
// All mutation - refunds, comps, cancellations - happens in the Stripe
// dashboard; the health table links out to each org's Stripe customer page,
// which is a way OUT, never an action here. The two CSV exports are reads too:
// they serialise the already-loaded feed window, client-side, via lib/csv.
//
// The environment is the platform-wide rail toggle (usePlatformEnv): test-mode
// Stripe money and live revenue never blend. The date range (FilterBar,
// defaulting to the last 12 months) narrows the charts, the activity feed and
// both exports together - one window, stated once, never three disagreeing
// ones. Charts are hand-rolled inline SVG cloned from the console's two chart
// precedents - the net-revenue line follows GrowthChart, the plan-mix bars
// follow ReleasesChart - each with the same accessible table of the same
// numbers beneath, values in ink tokens, the one data hue --status-info
// (informational, NOT a RAG colour: revenue is money, not a safety judgement).
// ============================================================================

import { limitToLast, orderByChild, query } from 'firebase/database';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/Button';
import { forEnv, platform } from '../../paths';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type { FinanceEvent, Organisation, Plan } from '../../types';
import { Card, CardHeader, StatCard } from '../ui/Card';
import { CardGrid, PageGrid, Toolbar, ToolbarGroup } from '../ui/Grid';
import { DataTable, type Column } from '../ui/DataTable';
import { FilterBar, type FilterField } from '../ui/FilterBar';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { Skeleton, SkeletonRows, SkeletonStatus } from '../ui/Skeleton';
import { formatDate } from '../customers/shared';
import { downloadCsv } from '../lib/csv';
import {
  activityCsv,
  defaultFinanceRange,
  endOfDayUtcExclusive,
  exportFilename,
  quickBooksCsv,
  startOfDayUtc,
} from './financeCsv';
import {
  activeSubscriptionCount,
  arpoPence,
  EVENT_PHRASES,
  EVENT_TONES,
  formatPence,
  groupEventsByDay,
  monthlyNetRevenue,
  monthsForRange,
  mrrPence,
  pastDueCount,
  planChangePhrase,
  planMix,
  statusChip,
  stripeCustomerUrl,
  subscriptionRows,
  type PlanMixSlice,
  type SubscriptionRow,
} from './financeMetrics';
import { usePlatformEnv } from './platformEnv';
import admin from './admin.module.css';
import styles from './FinancePage.module.css';

/** The bounded feed window: enough for a year of a small platform's events
 *  without ever subscribing to an unbounded node. */
const EVENT_WINDOW = 500;
/** How many feed entries the activity aside presents at most. */
const FEED_LENGTH = 30;

// ----------------------------------------------------------------------------
// Shared chart scaffolding (the GrowthChart/ReleasesChart technique).
// ----------------------------------------------------------------------------

const CHART_WIDTH = 640;
const LINE_HEIGHT = 220;
const BAR_HEIGHT = 200;
const MARGIN = { top: 24, right: 16, bottom: 28, left: 16 };
/** Bars stay thin (dataviz mark spec caps columns at 24px). */
const MAX_BAR_WIDTH = 24;

/** Top-rounded column path: 4px rounded data-end, square at the baseline. */
function barPath(x: number, y: number, width: number, height: number): string {
  const radius = Math.min(4, width / 2, height);
  return [
    `M ${x} ${y + height}`,
    `V ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `H ${x + width - radius}`,
    `Q ${x + width} ${y} ${x + width} ${y + radius}`,
    `V ${y + height}`,
    'Z',
  ].join(' ');
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

// ----------------------------------------------------------------------------
// Net revenue over time - payments minus refunds per month as a LINE chart
// (the GrowthChart clone: same margins, same area-under-line, same
// axis-labelling rules, same accessible table of the same numbers beneath).
// A refund-heavy month can dip below zero, so the zero line is the anchor and
// the scale makes room beneath it when it must.
// ----------------------------------------------------------------------------

function RevenueChart({
  months,
  totals,
}: {
  /** Oldest first, exactly as monthsForRange returns them. */
  months: ReadonlyArray<{ key: string; label: string }>;
  /** Net pence keyed by month key (monthlyNetRevenue output). */
  totals: ReadonlyMap<string, number>;
}) {
  const values = months.map((month) => totals.get(month.key) ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);

  // Honest empty state: no money moved in this environment and range.
  if (values.every((value) => value === 0)) {
    return (
      <p className={styles.empty}>
        No payments or refunds were recorded in this environment within the
        selected dates, so there is no revenue to plot. Monthly net revenue will
        appear here once subscriptions start billing.
      </p>
    );
  }

  const innerWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = LINE_HEIGHT - MARGIN.top - MARGIN.bottom;
  // The scale always includes zero: the zero line is the chart's anchor, and a
  // negative month stretches the scale downward rather than being clipped.
  const top = Math.max(1, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom;
  const y = (value: number) => MARGIN.top + ((top - value) / span) * innerHeight;
  const zeroY = y(0);
  const axisY = MARGIN.top + innerHeight + 18;
  // A single-point run has no width to divide; pin it to the left edge.
  const step = months.length > 1 ? innerWidth / (months.length - 1) : 0;

  const points = months.map((month, index) => ({
    month,
    value: values[index],
    x: MARGIN.left + step * index,
    y: y(values[index]),
  }));

  const line = points.map((point) => `${point.x} ${point.y}`).join(' ');
  // The filled area anchors the line to the ZERO line so the trend reads as
  // volume, not a floating thread. Its fill is the quiet info surface token.
  const area =
    `M ${points[0].x} ${zeroY} ` +
    points.map((point) => `L ${point.x} ${point.y}`).join(' ') +
    ` L ${points[points.length - 1].x} ${zeroY} Z`;

  // The narrative sentence doubles as the SVG's accessible name; the table
  // below carries the full month-by-month figures.
  const label =
    `Net revenue per month (payments minus refunds) over ` +
    `${months.length} ${months.length === 1 ? 'month' : 'months'}: ` +
    `${formatPence(total)} in total.`;

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${LINE_HEIGHT}`}
        className={styles.chart}
        role="img"
        aria-label={label}
      >
        {/* Zero line: the one recessive structural line the chart needs. */}
        <line
          x1={MARGIN.left}
          x2={CHART_WIDTH - MARGIN.right}
          y1={zeroY}
          y2={zeroY}
          className={styles.baseline}
        />
        <path d={area} className={styles.area} />
        <polyline points={line} className={styles.line} />
        {points.map(({ month, value, x, y: pointY }, index) => {
          // "Aug" alone reads fine mid-run; the year anchors the first slot and
          // every January so a 12-month run never loses its bearings.
          const monthWord = month.label.split(' ')[0];
          const axisLabel =
            index === 0 || monthWord === 'Jan' ? month.label : monthWord;
          return (
            <g key={month.key}>
              <title>{`${month.label}: ${formatPence(value)} net`}</title>
              <circle cx={x} cy={pointY} r={4} className={styles.marker} />
              <text
                x={x}
                // A negative point's label sits BELOW its marker: above it
                // would collide with the zero line it just crossed.
                y={value < 0 ? pointY + 18 : pointY - 9}
                textAnchor="middle"
                className={styles.value}
              >
                {formatPence(value)}
              </text>
              <text x={x} y={axisY} textAnchor="middle" className={styles.axis}>
                {axisLabel}
              </text>
            </g>
          );
        })}
      </svg>

      {/* The accessible alternative view: the same numbers as a compact table. */}
      <table className={styles.table}>
        <caption className={styles.caption}>Net revenue per month</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Net revenue</th>
          </tr>
        </thead>
        <tbody>
          {points.map(({ month, value }) => (
            <tr key={month.key}>
              <th scope="row">{month.label}</th>
              <td>{formatPence(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Plan mix - organisations per plan as a BAR chart (the ReleasesChart clone,
// with the plan catalogue on the axis instead of months, plus the same
// accessible table beneath that the console's other card chart carries).
// ----------------------------------------------------------------------------

function PlanMixChart({ slices }: { slices: readonly PlanMixSlice[] }) {
  const values = slices.map((slice) => slice.count);
  const total = values.reduce((sum, value) => sum + value, 0);

  // Honest empty state: a catalogue with no subscribers (or no catalogue at
  // all) has no mix to plot.
  if (slices.length === 0 || total === 0) {
    return (
      <p className={styles.empty}>
        No organisations hold an active subscription in this environment yet, so
        there is no plan mix to plot. Each plan&apos;s subscriber count will
        appear here once organisations subscribe.
      </p>
    );
  }

  const max = Math.max(1, ...values);
  const innerWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = BAR_HEIGHT - MARGIN.top - MARGIN.bottom;
  const slot = innerWidth / slices.length;
  const barWidth = Math.min(MAX_BAR_WIDTH, slot * 0.55);
  const baseline = MARGIN.top + innerHeight;

  // The narrative sentence doubles as the SVG's accessible name; the table
  // beneath carries the per-plan values.
  const label =
    `Organisations per plan among active subscriptions: ${total} in total ` +
    `across ${slices.length} ${slices.length === 1 ? 'plan' : 'plans'}, ` +
    `peaking at ${Math.max(...values)}.`;

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${BAR_HEIGHT}`}
        className={styles.chart}
        role="img"
        aria-label={label}
      >
        {/* Baseline: the one recessive structural line the chart needs. */}
        <line
          x1={MARGIN.left}
          x2={CHART_WIDTH - MARGIN.right}
          y1={baseline}
          y2={baseline}
          className={styles.baseline}
        />
        {slices.map((slice, index) => {
          const value = values[index];
          const height = (value / max) * innerHeight;
          const x = MARGIN.left + slot * index + (slot - barWidth) / 2;
          const centre = MARGIN.left + slot * index + slot / 2;
          return (
            <g key={slice.planId}>
              <title>{`${slice.label}: ${value} ${value === 1 ? 'organisation' : 'organisations'}`}</title>
              {value > 0 && (
                <path
                  d={barPath(x, baseline - height, barWidth, height)}
                  className={styles.bar}
                />
              )}
              <text
                x={centre}
                y={baseline - height - 6}
                textAnchor="middle"
                className={styles.value}
              >
                {value}
              </text>
              <text
                x={centre}
                y={baseline + 16}
                textAnchor="middle"
                className={styles.axis}
              >
                {slice.label}
              </text>
            </g>
          );
        })}
      </svg>

      {/* The accessible alternative view: the same numbers as a compact table. */}
      <table className={styles.table}>
        <caption className={styles.caption}>Organisations per plan</caption>
        <thead>
          <tr>
            <th scope="col">Plan</th>
            <th scope="col">Organisations</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((slice) => (
            <tr key={slice.planId}>
              <th scope="row">{slice.label}</th>
              <td>{slice.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Shared reads + headline derivation (the page and the dashboard summary read
// through the SAME hook and cache keys, so the two surfaces can never disagree).
// ----------------------------------------------------------------------------

function useFinanceHeadlines() {
  const { env } = usePlatformEnv();
  const paths = forEnv(env);

  // The org root is the dashboard's own key, deliberately: one subscription
  // serves both screens and the tiles here match the tiles there.
  const orgsQuery = useRtdbQuery<Record<string, Organisation> | null>({
    key: ['platformOrgs', env],
    path: paths.db.organisationsRoot(),
  });
  const plansQuery = useRtdbQuery<Record<string, Plan> | null>({
    key: keys.platformPlans(env),
    path: platform.plans(env),
  });

  const rows = useMemo(
    () => subscriptionRows(orgsQuery.data, plansQuery.data),
    [orgsQuery.data, plansQuery.data],
  );

  const loading = orgsQuery.isLoading || plansQuery.isLoading;
  const totalMrr = mrrPence(rows);
  const active = activeSubscriptionCount(rows);

  return {
    env,
    rows,
    plans: plansQuery.data,
    isError: orgsQuery.isError || plansQuery.isError,
    // undefined while loading => StatCard renders its value-shaped skeleton,
    // never an invented zero; real zeros once the reads settle.
    mrr: loading ? undefined : formatPence(totalMrr),
    active: loading ? undefined : active,
    arpo: loading ? undefined : formatPence(arpoPence(totalMrr, active)),
    pastDue: loading ? undefined : pastDueCount(rows),
    loading,
  };
}

// ----------------------------------------------------------------------------
// The dashboard's compact revenue summary (replaces the Phase 2 preview card).
// ----------------------------------------------------------------------------

/**
 * The PlatformDashboard's live revenue card: the three headline tiles, computed
 * by the same helpers over the same cached reads as the Finance tab, with the
 * tab itself one link away. Lives here so dashboard and tab share one metric
 * pipeline end to end.
 */
export function FinanceSummary() {
  const headlines = useFinanceHeadlines();

  return (
    <Card>
      <CardHeader
        title="Revenue"
        hint={`Live billing figures for the ${headlines.env} environment.`}
        action={
          <Link className={styles.viewLink} to="/app/admin/finance">
            View finance
          </Link>
        }
      />
      {headlines.isError && (
        <ErrorNotice message="Could not load the billing figures. Please try again." />
      )}
      <CardGrid min={180}>
        <StatCard
          label="Monthly recurring revenue"
          value={headlines.mrr}
          hint="Priced plans on active, past-due and trialling subscriptions."
        />
        <StatCard
          label="Active subscriptions"
          value={headlines.active}
          hint="Counts paid organisations."
        />
        <StatCard
          label="Average revenue per organisation"
          value={headlines.arpo}
          hint="Recurring revenue divided by paying organisations."
        />
      </CardGrid>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// The billing activity aside: the feed grouped by UTC day, each entry a
// compact row - a tone dot (reinforcing, never the sole carrier: the phrase
// beside it says what happened), the org link, and the amount right-aligned
// in tabular figures, refunds signed negative.
// ----------------------------------------------------------------------------

const feedTime = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

function ActivityFeed({
  entries,
}: {
  entries: ReadonlyArray<{ id: string; event: FinanceEvent }>;
}) {
  const groups = groupEventsByDay(entries);
  return (
    <div className={styles.feedGroups}>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h3 className={styles.feedDay}>{group.label}</h3>
          <ul className={styles.feed}>
            {group.entries.map(({ id, event }) => (
              <li key={id} className={styles.feedRow}>
                <span
                  aria-hidden="true"
                  className={`${styles.feedDot} ${styles[`tone-${EVENT_TONES[event.type] ?? 'neutral'}`]}`}
                />
                <div className={styles.feedMain}>
                  <span className={styles.feedPhrase}>
                    {EVENT_PHRASES[event.type] ?? event.type}
                  </span>
                  <span className={styles.feedOrg}>
                    <Link
                      to={`/app/admin/${event.orgId}`}
                      className={styles.orgLink}
                    >
                      {event.orgName}
                    </Link>
                    <span className={styles.feedWhen}>
                      {feedTime.format(event.at)} UTC
                    </span>
                  </span>
                </div>
                {typeof event.amountPence === 'number' && (
                  <span className={styles.feedAmount}>
                    {event.type === 'refund'
                      ? `-${formatPence(event.amountPence)}`
                      : formatPence(event.amountPence)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// The Finance tab.
// ----------------------------------------------------------------------------

export function FinancePage() {
  const headlines = useFinanceHeadlines();
  const { env, rows, plans } = headlines;

  // The date range narrows charts, feed and exports together. It defaults to
  // the last 12 calendar months and lives as the FilterBar's yyyy-mm-dd pair;
  // either bound can be cleared (its chip) for an open end.
  const [defaults] = useState(() => defaultFinanceRange(Date.now()));
  const [fromDate, setFromDate] = useState(defaults.from);
  const [toDate, setToDate] = useState(defaults.to);
  const fromMs = startOfDayUtc(fromDate);
  const toMs = endOfDayUtcExclusive(toDate);

  // The billing feed: one bounded, indexed window, newest first. The builder is
  // stable (useMemo) because its identity is not a re-subscription dependency.
  const buildWindow = useMemo<RtdbQueryBuilder>(
    () => (node) => query(node, orderByChild('at'), limitToLast(EVENT_WINDOW)),
    [],
  );
  const eventsQuery = useRtdbQuery<Array<{ id: string; event: FinanceEvent }>>({
    key: keys.platformFinanceEvents(env, EVENT_WINDOW),
    path: platform.financeEvents(env),
    build: buildWindow,
    select: (value) =>
      Object.entries((value as Record<string, FinanceEvent> | null) ?? {})
        .map(([id, event]) => ({ id, event }))
        .sort((a, b) => b.event.at - a.event.at),
  });
  const events = eventsQuery.data;

  // Everything below the toolbar shares this one range-narrowed window.
  const inRange = useMemo(
    () =>
      (events ?? []).filter(
        ({ event }) =>
          (fromMs === undefined || event.at >= fromMs) &&
          (toMs === undefined || event.at < toMs),
      ),
    [events, fromMs, toMs],
  );

  const months = useMemo(
    () => monthsForRange(fromMs, toMs, Date.now()),
    [fromMs, toMs],
  );
  const netTotals = useMemo(
    () => monthlyNetRevenue(inRange.map((entry) => entry.event)),
    [inRange],
  );
  const mix = useMemo(() => planMix(rows, plans), [rows, plans]);

  const filterFields: FilterField[] = [
    {
      kind: 'dateRange',
      id: 'finance-date',
      label: 'Dates',
      from: fromDate,
      to: toDate,
      onChangeFrom: setFromDate,
      onChangeTo: setToDate,
      formatValue: (value) => {
        const ms = startOfDayUtc(value);
        return ms === undefined ? value : formatDate(ms);
      },
    },
  ];

  // Client-side exports of the loaded, range-narrowed feed - reads, like
  // everything else on this screen. Filenames carry environment and range so
  // a folder of exports stays self-describing.
  const exportQuickBooks = () => {
    downloadCsv(
      quickBooksCsv(inRange.map((entry) => entry.event), plans),
      exportFilename('quickbooks', env, fromDate, toDate),
    );
  };
  const exportActivity = () => {
    downloadCsv(
      activityCsv(inRange.map((entry) => entry.event), plans),
      exportFilename('activity', env, fromDate, toDate),
    );
  };

  const columns: Array<Column<SubscriptionRow>> = [
    {
      header: 'Organisation',
      cell: (row) => (
        <Link to={`/app/admin/${row.orgId}`} className={styles.orgLink}>
          {row.orgName}
        </Link>
      ),
    },
    {
      header: 'Plan',
      cell: (row) => {
        const change = planChangePhrase(row);
        return (
          <span className={styles.planCell}>
            <span>{row.planName}</span>
            {/* The deferred downgrade (§3.2): the plan it lands on, and when. */}
            {change && <span className={styles.planChange}>{change}</span>}
          </span>
        );
      },
    },
    {
      header: 'Status',
      cell: (row) => {
        const chip = statusChip(row);
        return (
          <span className={`${styles.chip} ${styles[`tone-${chip.tone}`]}`}>
            {chip.label}
          </span>
        );
      },
    },
    {
      header: 'Period end',
      desktopOnly: true,
      cell: (row) =>
        row.currentPeriodEnd ? formatDate(row.currentPeriodEnd) : '—',
    },
    {
      header: 'MRR',
      align: 'end',
      cell: (row) => (
        <span className={styles.mrrCell}>{formatPence(row.mrrPence)}</span>
      ),
    },
    {
      header: 'Stripe',
      align: 'end',
      width: '1%',
      desktopOnly: true,
      // A link OUT to the customer in the Stripe dashboard - where refunds and
      // every other billing action happen - never an action on this screen.
      cell: (row) =>
        row.stripeCustomerId ? (
          <a
            className={styles.stripeLink}
            href={stripeCustomerUrl(env, row.stripeCustomerId)}
            target="_blank"
            rel="noreferrer"
          >
            Open in Stripe
          </a>
        ) : (
          '—'
        ),
    },
  ];

  const feed = inRange.slice(0, FEED_LENGTH);

  return (
    <div className={admin.stack}>
      <PageHeader
        title="Finance"
        crumbs={[{ label: 'Platform', to: '/app/admin' }, { label: 'Finance' }]}
        lede={`Billing across every organisation in the ${env} environment. Read-only oversight: refunds and other billing actions happen in the Stripe dashboard.`}
      />

      {headlines.isError && (
        <ErrorNotice message="Could not load the billing overview. Please try again." />
      )}

      {/* The action row: the date range that narrows charts, feed and exports
          together, and the two accounting exports of that same window. The
          environment itself is the rail toggle - not duplicated here. */}
      <Toolbar>
        <FilterBar
          label="Filter finance by date"
          className={styles.filters}
          fields={filterFields}
          note={
            events === undefined
              ? 'Loading billing events'
              : `${inRange.length} of the ${events.length} loaded billing events fall in this range; charts, feed and exports share it.`
          }
          toggleLabel="Dates"
        />
        <ToolbarGroup push>
          <Button
            type="button"
            variant="secondary"
            onClick={exportQuickBooks}
            disabled={events === undefined}
          >
            Export for QuickBooks (CSV)
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={exportActivity}
            disabled={events === undefined}
          >
            Export all activity (CSV)
          </Button>
        </ToolbarGroup>
      </Toolbar>

      <CardGrid min={200}>
        <StatCard
          label="Monthly recurring revenue"
          value={headlines.mrr}
          hint="Priced plans on active, past-due and trialling subscriptions."
        />
        <StatCard
          label="Active subscriptions"
          value={headlines.active}
          hint="Counts paid organisations."
        />
        <StatCard
          label="Average revenue per organisation"
          value={headlines.arpo}
          hint="Recurring revenue divided by paying organisations."
        />
        <StatCard
          label="Past due"
          value={headlines.pastDue}
          hint="Organisations in a dunning grace window."
        />
      </CardGrid>

      <div className={styles.chartsGrid}>
        <Card>
          <CardHeader
            title="Net revenue"
            hint="Payments minus refunds per month within the selected dates; the table beneath carries the same figures."
          />
          {events === undefined ? (
            <ChartSkeleton label="Loading the revenue chart" />
          ) : (
            <RevenueChart months={months} totals={netTotals} />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Plan mix"
            hint="Organisations per plan among active subscriptions; the table beneath carries the same figures."
          />
          {headlines.loading ? (
            <ChartSkeleton label="Loading the plan mix chart" />
          ) : (
            <PlanMixChart slices={mix} />
          )}
        </Card>
      </div>

      <PageGrid
        aside={
          <Card>
            <CardHeader
              title="Billing activity"
              hint="Events within the selected dates, newest first, grouped by day (UTC)."
            />
            {events === undefined ? (
              <SkeletonRows rows={5} label="Loading billing activity" />
            ) : feed.length === 0 ? (
              <p className={admin.emptyNote}>
                No billing events were recorded in this environment within the
                selected dates.
              </p>
            ) : (
              <>
                <ActivityFeed entries={feed} />
                {inRange.length > feed.length && (
                  <p className={styles.feedNote}>
                    Showing the latest {feed.length} of {inRange.length} events
                    in this range. Use the exports for the full list.
                  </p>
                )}
              </>
            )}
          </Card>
        }
      >
        <Card flush>
          <CardHeader
            title="Subscription health"
            // DataTable is deliberately sortless, so the fixed order is
            // stated rather than faked with dead sort affordances.
            hint="Every subscribed organisation, sorted by monthly contribution, largest first."
          />
          {headlines.loading ? (
            <SkeletonRows rows={6} label="Loading subscriptions" />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No subscriptions yet"
              body={`No organisation in the ${env} environment holds a subscription. Positions appear here as organisations subscribe.`}
            />
          ) : (
            <DataTable<SubscriptionRow>
              label="Subscription health"
              columns={columns}
              rows={rows}
              rowKey={(row) => row.orgId}
            />
          )}
        </Card>
      </PageGrid>

      <p className={admin.footnote}>
        Read-only oversight; figures are live. Billing actions happen in the
        Stripe dashboard.
      </p>
    </div>
  );
}
