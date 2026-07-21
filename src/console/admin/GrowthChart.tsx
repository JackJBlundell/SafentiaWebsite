// ============================================================================
// GrowthChart - members invited per month across the whole platform, drawn as
// an inline SVG LINE chart (the platform twin of reports/ReleasesChart, which
// is a bar chart; the technique and quality match, the mark differs).
//
// HONESTY NOTE: the schema records no member/org creation timestamp, so this
// cannot claim "users over time". The one real, admin-readable growth signal is
// InvitationSummary.createdAt (per org, at /{env}/orgInvitations/{orgId}), so the
// series is EXACTLY "Members invited per month" and is labelled that way on the
// axis caption, the accessible name and the table. An org with no invitations
// node contributes zero, never an error.
//
// One series, so no legend: the caption names it. The line and its markers wear
// the informational hue (--status-info, defined for light and dark, and NOT a
// RAG colour: invitations are activity, not a safety judgement); every value and
// axis label wears ink tokens, never the data colour. The month-by-month table
// beneath is the accessible alternative view of the same numbers.
// ============================================================================

import styles from './GrowthChart.module.css';

/** Fixed drawing space; the SVG scales to its container via viewBox. */
const CHART_WIDTH = 640;
const CHART_HEIGHT = 220;
const MARGIN = { top: 24, right: 16, bottom: 28, left: 16 };

export interface GrowthChartProps {
  /** Oldest first, exactly as lastMonths returns them. */
  months: ReadonlyArray<{ key: string; label: string }>;
  /** Members-invited counts keyed by month key (countPerMonth output). */
  counts: ReadonlyMap<string, number>;
}

export function GrowthChart({ months, counts }: GrowthChartProps) {
  const values = months.map((month) => counts.get(month.key) ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const peak = Math.max(...values);

  // Honest empty state: no invitations recorded anywhere in this environment.
  if (total === 0) {
    return (
      <p className={styles.empty}>
        No members have been invited in this environment yet, so there is no
        growth to plot. Members invited per month will appear here once
        organisations start sending invitations.
      </p>
    );
  }

  const innerWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const max = Math.max(1, peak);
  const baseline = MARGIN.top + innerHeight;
  // A single-point run has no width to divide; pin it to the left edge.
  const step = months.length > 1 ? innerWidth / (months.length - 1) : 0;

  const points = months.map((month, index) => {
    const value = values[index];
    const x = MARGIN.left + step * index;
    const y = baseline - (value / max) * innerHeight;
    return { month, value, x, y };
  });

  const line = points.map((point) => `${point.x} ${point.y}`).join(' ');
  // The filled area anchors the line to the baseline so the trend reads as
  // volume, not a floating thread. Its fill is the quiet info surface token.
  const area =
    `M ${points[0].x} ${baseline} ` +
    points.map((point) => `L ${point.x} ${point.y}`).join(' ') +
    ` L ${points[points.length - 1].x} ${baseline} Z`;

  // The narrative sentence doubles as the SVG's accessible name; the table
  // below carries the full month-by-month figures.
  const label =
    `Members invited per month over the last ${months.length} months: ` +
    `${total} in total, peaking at ${peak} in a single month.`;

  return (
    <div className={styles.wrap}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
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
        <path d={area} className={styles.area} />
        <polyline points={line} className={styles.line} />
        {points.map(({ month, value, x, y }, index) => {
          // "Aug" alone reads fine mid-run; the year anchors the first slot and
          // every January so a 12-month run never loses its bearings.
          const monthWord = month.label.split(' ')[0];
          const axisLabel =
            index === 0 || monthWord === 'Jan' ? month.label : monthWord;
          return (
            <g key={month.key}>
              <title>{`${month.label}: ${value} invited`}</title>
              <circle cx={x} cy={y} r={4} className={styles.marker} />
              <text
                x={x}
                y={y - 9}
                textAnchor="middle"
                className={styles.value}
              >
                {value}
              </text>
              <text
                x={x}
                y={baseline + 18}
                textAnchor="middle"
                className={styles.axis}
              >
                {axisLabel}
              </text>
            </g>
          );
        })}
      </svg>

      {/* The accessible alternative view: the same numbers as a compact table. */}
      <table className={styles.table}>
        <caption className={styles.caption}>
          Members invited per month
        </caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Members invited</th>
          </tr>
        </thead>
        <tbody>
          {points.map(({ month, value }) => (
            <tr key={month.key}>
              <th scope="row">{month.label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
