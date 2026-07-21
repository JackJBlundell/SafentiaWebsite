// ============================================================================
// Proportional RAG meter geometry - story 1072 (the legacy system's known
// failing was painting an entire building red for a single red finding).
//
// This module is PURE (no I/O, no pdfkit) so every branch is deterministically
// unit-testable (brief 18.2). It takes the building's TRUE findings counts
// (RagDistribution: low / medium / high) and returns the geometry the renderer
// draws: three contiguous segments whose widths are EXACTLY proportional to the
// counts. A building that is 80% green renders 80% green; one red item out of
// twenty is one twentieth of the bar, never the whole bar.
//
// The one deliberate departure from raw proportion is the EMPTY case: a building
// with no findings at all has nothing to be proportional to, so we render a
// single neutral "no findings recorded" bar rather than an arbitrary or a misli-
// eadingly all-green one. That is an honest representation, not a skew.
// ============================================================================

import type { RagDistribution } from '../shared/types';

/** The three semantic RAG bands, in the order they render left to right (best to
 *  worst), so the eye reads improving-to-worsening consistently. */
export type RagBand = 'low' | 'medium' | 'high';

/**
 * One drawn segment of the meter. `fraction` is the share of the whole bar this
 * band occupies (0..1); `count` is the true finding count behind it; `percent`
 * is `fraction` rounded to a whole number purely for the on-bar label. The
 * renderer multiplies `fraction` by the bar's pixel width to get the segment
 * width, so the bar is proportional at any size.
 */
export interface RagSegment {
  band: RagBand;
  count: number;
  fraction: number;
  percent: number;
  /** Client-facing British-English label paired with the colour (colour is never
   *  the sole carrier of meaning - brief 18.5). */
  label: string;
}

export interface RagMeterModel {
  /** The segments to draw, always in low -> medium -> high order, omitting bands
   *  with a zero count so the bar shows only what is actually present. */
  segments: RagSegment[];
  /** The total finding count the proportions are computed from. */
  total: number;
  /** True when there are no findings at all; the renderer shows a neutral bar and
   *  an explanatory caption instead of an empty or all-green one. */
  isEmpty: boolean;
}

/** Human labels for each band. The "low" band is the reassuring end of the meter,
 *  so it reads "Low risk findings", etc., never bare colour names. */
const BAND_LABELS: Record<RagBand, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** The bands in render order (best to worst). Stated once so the meter, the
 *  legend and any future consumer iterate the identical sequence. */
const BAND_ORDER: RagBand[] = ['low', 'medium', 'high'];

/**
 * Coerce a possibly-missing or malformed count to a safe non-negative integer.
 * Legacy and seeded data is inconsistent (brief 18.3): a count may be absent,
 * null, negative or fractional. We floor to an integer and clamp at zero rather
 * than throw, so a single bad field never fails report generation; a nonsense
 * value simply contributes nothing to the proportion.
 */
function safeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Compute the proportional meter model from the true findings distribution.
 *
 * The contract that makes story 1072 pass: each band's `fraction` is its own
 * count divided by the TOTAL count, so the rendered widths sum to the whole bar
 * and reflect the real mix. There is no weighting that inflates red, no minimum
 * red width, no "any red => mostly red" rule. The assessor's risk opinion is
 * displayed alongside the meter by the renderer but never rewrites these numbers
 * (1072 AC3).
 */
export function computeRagMeter(
  distribution: RagDistribution | undefined,
): RagMeterModel {
  const counts: Record<RagBand, number> = {
    low: safeCount(distribution?.low),
    medium: safeCount(distribution?.medium),
    high: safeCount(distribution?.high),
  };

  const total = counts.low + counts.medium + counts.high;

  // No findings: nothing to be proportional to. Return an explicit empty model so
  // the renderer can draw an honest neutral bar (see module header).
  if (total === 0) {
    return { segments: [], total: 0, isEmpty: true };
  }

  const segments: RagSegment[] = BAND_ORDER.filter((band) => counts[band] > 0).map(
    (band) => {
      const count = counts[band];
      const fraction = count / total;
      return {
        band,
        count,
        fraction,
        // Round only for the human-readable label; the drawn width uses the exact
        // fraction so rounding never distorts the geometry.
        percent: Math.round(fraction * 100),
        label: BAND_LABELS[band],
      };
    },
  );

  return { segments, total, isEmpty: false };
}
