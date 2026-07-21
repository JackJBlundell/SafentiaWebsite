// ============================================================================
// RagMeter - the proportional Green/Amber/Red risk profile bar, exactly as the
// released report draws it. Segment widths are computed from the real counts,
// never eyeballed: a visual that claims proportional accuracy must be
// proportionally accurate on the marketing site too.
//
// RAG colours appear here because they mean risk. This component must only be
// used inside product depictions, never as page decoration (tokens.css header).
// ============================================================================

import styles from './RagMeter.module.css';

export interface RagMeterProps {
  /** Question counts by outcome. Widths are derived from these. */
  green: number;
  amber: number;
  red: number;
  /** A short line under the bar, e.g. what the counts are counts of. */
  caption?: string;
  className?: string;
}

const SEGMENTS = [
  { key: 'green', label: 'Green' },
  { key: 'amber', label: 'Amber' },
  { key: 'red', label: 'Red' },
] as const;

export function RagMeter({ green, amber, red, caption, className = '' }: RagMeterProps) {
  const counts = { green, amber, red };
  const total = green + amber + red;

  return (
    <div className={`${styles.root} ${className}`}>
      <div
        className={styles.bar}
        role="img"
        aria-label={`Risk profile: ${green} green, ${amber} amber, ${red} red of ${total}`}
      >
        {SEGMENTS.map(({ key }) =>
          counts[key] > 0 ? (
            <span
              key={key}
              className={styles[key]}
              style={{ width: `${((counts[key] / total) * 100).toFixed(2)}%` }}
            />
          ) : null,
        )}
      </div>
      <ul className={styles.legend}>
        {SEGMENTS.map(({ key, label }) => (
          <li key={key} className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles[key]}`} />
            {label} {counts[key]}
          </li>
        ))}
      </ul>
      {caption && <p className={styles.caption}>{caption}</p>}
    </div>
  );
}
