// ============================================================================
// ReleasesChart - assessments released per month, as an inline SVG bar chart.
//
// Fed entirely by data ReportsPage already loads (the indexed activity window
// and the lastMonths/countPerMonth derivations in orgMetrics); no read of its
// own. One series, so no legend: the card title names it. Every bar carries
// its value as TEXT in ink tokens (never the bar colour), months run along
// the base, and the monthly-summary table beneath the chart is the accessible
// table view of the same numbers. The single data hue is --status-info -
// informational, defined for light and dark, and deliberately NOT a RAG
// colour: release volume is workload, not a safety judgement.
// ============================================================================

import styles from './ReleasesChart.module.css';

/** Fixed drawing space; the SVG scales to its container via viewBox. */
const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const MARGIN = { top: 22, right: 8, bottom: 26, left: 8 };
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

export interface ReleasesChartProps {
  /** Oldest first, exactly as lastMonths returns them. */
  months: ReadonlyArray<{ key: string; label: string }>;
  /** Per-month release counts keyed by month key (countPerMonth output). */
  counts: ReadonlyMap<string, number>;
}

export function ReleasesChart({ months, counts }: ReleasesChartProps) {
  const values = months.map((month) => counts.get(month.key) ?? 0);
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);

  const innerWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const slot = innerWidth / months.length;
  const barWidth = Math.min(MAX_BAR_WIDTH, slot * 0.55);
  const baseline = MARGIN.top + innerHeight;

  // The narrative sentence doubles as the SVG's accessible name; the summary
  // table below the chart carries the full month-by-month values.
  const label =
    `Assessments released per month over the last ${months.length} months: ` +
    `${total} in total, peaking at ${Math.max(...values)}.`;

  return (
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
      {months.map((month, index) => {
        const value = values[index];
        const height = (value / max) * innerHeight;
        const x = MARGIN.left + slot * index + (slot - barWidth) / 2;
        const centre = MARGIN.left + slot * index + slot / 2;
        // "Aug" alone reads fine mid-run; the year anchors the first slot and
        // every January so a 12-month run never loses its bearings.
        const monthWord = month.label.split(' ')[0];
        const axisLabel =
          index === 0 || monthWord === 'Jan' ? month.label : monthWord;
        return (
          <g key={month.key}>
            <title>{`${month.label}: ${value} released`}</title>
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
              {axisLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
