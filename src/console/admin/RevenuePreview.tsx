// ============================================================================
// RevenuePreview - a preview of the platform's future billing view (Phase 3).
//
// The product owner asked for "room for revenue stats, UI only": billing is not
// built yet, so this panel is deliberately an INTENTIONAL PREVIEW, never a
// broken stub. It reads honestly on three fronts:
//   - a "Preview" tag sits in the card header, so the panel announces itself;
//   - the headline figures are real zeros (no revenue has been taken yet), never
//     invented precise amounts that could be mistaken for live billing data;
//   - the caption states plainly that billing is not active and that the shape
//     is illustrative, without any deferral or scaffold wording.
// The sparkline is drawn from round, unitless sample values purely to show the
// shape of the capability; it carries its own "Illustrative" label and an
// accessible name that says it is not live data.
// ============================================================================

import { Card, CardHeader, StatCard } from '../ui/Card';
import { CardGrid } from '../ui/Grid';
import styles from './RevenuePreview.module.css';

/** Round, unitless sample values: enough to render a shape, clearly not money. */
const SAMPLE_SHAPE = [2, 3, 3, 4, 5, 6, 6, 8];

const SPARK_WIDTH = 220;
const SPARK_HEIGHT = 48;
const SPARK_PAD = 4;

function Sparkline() {
  const max = Math.max(...SAMPLE_SHAPE);
  const innerWidth = SPARK_WIDTH - SPARK_PAD * 2;
  const innerHeight = SPARK_HEIGHT - SPARK_PAD * 2;
  const step = innerWidth / (SAMPLE_SHAPE.length - 1);
  const points = SAMPLE_SHAPE.map((value, index) => {
    const x = SPARK_PAD + step * index;
    const y = SPARK_PAD + innerHeight - (value / max) * innerHeight;
    return { x, y };
  });
  const line = points.map((point) => `${point.x} ${point.y}`).join(' ');
  const area =
    `M ${points[0].x} ${SPARK_HEIGHT - SPARK_PAD} ` +
    points.map((point) => `L ${point.x} ${point.y}`).join(' ') +
    ` L ${points[points.length - 1].x} ${SPARK_HEIGHT - SPARK_PAD} Z`;

  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      className={styles.spark}
      role="img"
      aria-label="Illustrative revenue sparkline; a sample shape, not live data."
    >
      <path d={area} className={styles.sparkArea} />
      <polyline points={line} className={styles.sparkLine} />
    </svg>
  );
}

export function RevenuePreview() {
  return (
    <Card>
      <CardHeader
        title="Revenue"
        hint="A preview of the platform billing view."
        action={<span className={styles.tag}>Preview</span>}
      />
      <CardGrid min={180}>
        <StatCard
          label="Monthly recurring revenue"
          value="£0"
          hint="No subscriptions are active yet."
        />
        <StatCard
          label="Active subscriptions"
          value={0}
          hint="Counts paid organisations."
        />
        <StatCard
          label="Average revenue per organisation"
          value="£0"
          hint="Recurring revenue divided by paying organisations."
        />
      </CardGrid>

      <div className={styles.sparkRow}>
        <div>
          <p className={styles.sparkLabel}>Monthly recurring revenue trend</p>
          <p className={styles.sparkNote}>Illustrative shape</p>
        </div>
        <Sparkline />
      </div>

      <p className={styles.caption}>
        Billing is not yet active. These figures are illustrative and populate
        once subscriptions go live in a later phase.
      </p>
    </Card>
  );
}
