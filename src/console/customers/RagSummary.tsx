// ============================================================================
// RagSummary - the compact risk distribution strip list rows carry, so the
// risk picture of a customer or site is legible without clicking in.
//
// One horizontal row of icon+number pairs: each non-zero level renders its
// riskPresentation glyph in the level's strong colour immediately followed by
// its count as plain tabular-nums text (the glyph differs per level, so colour
// is never the sole carrier). Zero-count levels are omitted; an all-zero strip
// says "No buildings" rather than rendering nothing. The optional overdue pair
// is an alert glyph + count in error tone, its wording escalated in the aria
// sentence when any overdue action is Life Protection. The visual row is
// aria-hidden behind ONE combined sentence, so a screen reader hears the whole
// picture in a single announcement instead of a glyph-by-glyph fragment stream.
// ============================================================================

import { useTheme } from '../../design/ThemeProvider';
import { riskPresentation } from '../../design/rag';
import type { OverdueCounts } from '../reports/orgMetrics';
import type { RiskLevel } from '../../types';
import styles from './RagSummary.module.css';

/** Severity order, matching the dashboard's tiles. */
const LEVELS: readonly RiskLevel[] = ['high', 'medium', 'low', 'pending'];

/** The overdue pair's glyph: an alert triangle forced to TEXT presentation
 *  (U+FE0E) so it takes the error colour instead of an emoji rendering. */
const ALERT_GLYPH = '⚠︎';

/** The overdue wording, escalated when the Life Protection subset is
 *  non-empty. `withNoun` adds "action(s)" for prose (the aria sentences). */
export function overdueLabel(counts: OverdueCounts, withNoun = false): string {
  const base = withNoun
    ? `${counts.overdue} overdue ${counts.overdue === 1 ? 'action' : 'actions'}`
    : `${counts.overdue} overdue`;
  return counts.lifeProtectionOverdue > 0
    ? `${base}, ${counts.lifeProtectionOverdue} Life Protection`
    : base;
}

/** Standalone overdue indicator for a table's Overdue column: alert glyph +
 *  count in error tone when anything is overdue, a quiet zero otherwise (an
 *  honest zero, never a blank that could read as "not loaded"). The full
 *  escalated wording is the accessible name and the hover title. */
export function OverdueBadge({ counts }: { counts: OverdueCounts }) {
  const { theme } = useTheme();
  if (counts.overdue === 0) {
    return <span className={styles.zero}>0</span>;
  }
  const label = overdueLabel(counts, true);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={styles.pair}
      style={{ color: theme.rag.red }}
    >
      <span aria-hidden="true" className={styles.glyph}>
        {ALERT_GLYPH}
      </span>
      <span aria-hidden="true" className={styles.overdueCount}>
        {counts.overdue}
      </span>
    </span>
  );
}

export interface RagSummaryProps {
  /** Buildings by stored risk level (countBuildingsByRisk's shape). */
  counts: Record<RiskLevel, number>;
  /** When provided AND non-zero, the overdue pair joins the strip. */
  overdue?: OverdueCounts;
  /** The all-zero wording; defaults to the customer/site meaning. */
  emptyLabel?: string;
}

export function RagSummary({ counts, overdue, emptyLabel = 'No buildings' }: RagSummaryProps) {
  const { theme } = useTheme();
  const present = LEVELS.filter((level) => counts[level] > 0);
  const showOverdue = overdue !== undefined && overdue.overdue > 0;

  if (present.length === 0 && !showOverdue) {
    return <span className={styles.empty}>{emptyLabel}</span>;
  }

  const riskSentence = present
    .map(
      (level) =>
        `${counts[level]} ${riskPresentation(theme, level).label.toLowerCase()}`,
    )
    .join(', ');
  const ariaLabel = [
    riskSentence ? `Buildings: ${riskSentence}` : '',
    showOverdue ? overdueLabel(overdue, true) : '',
  ]
    .filter(Boolean)
    .join('; ');

  return (
    <span role="img" aria-label={ariaLabel} className={styles.root}>
      <span aria-hidden="true" className={styles.strip}>
        {present.map((level) => {
          const rag = riskPresentation(theme, level);
          return (
            <span key={level} className={styles.pair} title={`${rag.label}: ${counts[level]}`}>
              <span className={styles.glyph} style={{ color: rag.color }}>
                {rag.icon}
              </span>
              <span className={styles.count}>{counts[level]}</span>
            </span>
          );
        })}
        {showOverdue && (
          <span
            className={styles.pair}
            style={{ color: theme.rag.red }}
            title={overdueLabel(overdue, true)}
          >
            <span className={styles.glyph}>{ALERT_GLYPH}</span>
            <span className={styles.overdueCount}>{overdue.overdue}</span>
          </span>
        )}
      </span>
    </span>
  );
}
