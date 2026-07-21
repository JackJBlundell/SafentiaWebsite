// ============================================================================
// Skeleton - the console's loading placeholder.
//
// While a listener attaches, the page shows the SHAPE of what is coming (a
// stat value, a list of rows), never the word "Loading" as data and never an
// invented zero. The shimmer is decoration: the blocks are aria-hidden, and a
// visually-hidden role="status" line carries the loading announcement for
// screen readers, so assistive tech hears exactly what sighted users infer.
// Motion is disabled under prefers-reduced-motion (the CSS drops to a static
// two-tone block).
// ============================================================================

import styles from './Skeleton.module.css';

export interface SkeletonProps {
  /** Rendered width, e.g. "3ch", "60%", "8rem". Defaults to full width. */
  width?: string;
  /** Rendered height. Defaults to one line of text. */
  height?: string;
  className?: string;
}

/** One shimmer block, sized to the content it stands in for. Purely visual:
 *  pair it with SkeletonStatus (or an existing status line) for announcement. */
export function Skeleton({ width, height, className = '' }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`${styles.block} ${className}`.trim()}
      style={{ width, height }}
    />
  );
}

/** The screen-reader half of a skeleton region: visually hidden, announced
 *  once via role="status". Render exactly one per loading region. */
export function SkeletonStatus({ label }: { label: string }) {
  return (
    <span role="status" className={styles.visuallyHidden}>
      {label}
    </span>
  );
}

/** A list-shaped skeleton: N two-line rows approximating the feed rows they
 *  stand in for, plus the announcement. */
export function SkeletonRows({
  rows,
  label,
}: {
  rows: number;
  label: string;
}) {
  return (
    <div className={styles.rows}>
      <SkeletonStatus label={label} />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className={styles.row}>
          <Skeleton width="70%" height="0.9375rem" />
          <Skeleton width="45%" height="0.8125rem" />
        </div>
      ))}
    </div>
  );
}
