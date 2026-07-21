// ============================================================================
// Unit tests for the proportional RAG meter (story 1072 AC2).
//
// The single most important property to prove: the meter is drawn in EXACT
// proportion to the true findings distribution and is NEVER skewed to red (the
// legacy system's known failing). A mostly-green building must render mostly
// green; one red item among many must occupy only its true fraction, not the
// whole bar.
//
// The tests are deterministic and use a small factory rather than copy-pasted
// fixtures (brief 18.2).
// ============================================================================

import { computeRagMeter } from '../report/ragMeter';
import type { RagDistribution } from '../shared/types';

/** Factory: a distribution with sensible zero defaults so each test states only
 *  the counts it cares about (brief 18.2 "factories, not copy-pasted fixtures"). */
function dist(partial: Partial<RagDistribution>): RagDistribution {
  return { low: 0, medium: 0, high: 0, ...partial };
}

/** Look up the rendered fraction for a band, or 0 if the band is not drawn. */
function fractionOf(
  segments: ReturnType<typeof computeRagMeter>['segments'],
  band: 'low' | 'medium' | 'high',
): number {
  return segments.find((s) => s.band === band)?.fraction ?? 0;
}

describe('computeRagMeter - proportional RAG geometry (story 1072)', () => {
  it('renders a mostly-green building as mostly green, not all red', () => {
    // 18 low, 1 medium, 1 high = 90% green. The legacy bug would paint this red.
    const meter = computeRagMeter(dist({ low: 18, medium: 1, high: 1 }));

    expect(meter.total).toBe(20);
    expect(meter.isEmpty).toBe(false);

    const greenFraction = fractionOf(meter.segments, 'low');
    const redFraction = fractionOf(meter.segments, 'high');

    // The proof: green dominates and red is a small slice, EXACTLY proportional.
    expect(greenFraction).toBeCloseTo(0.9, 10);
    expect(redFraction).toBeCloseTo(0.05, 10);
    expect(greenFraction).toBeGreaterThan(redFraction);
  });

  it('makes every segment width exactly its share of the total', () => {
    const meter = computeRagMeter(dist({ low: 2, medium: 3, high: 5 }));

    expect(meter.total).toBe(10);
    expect(fractionOf(meter.segments, 'low')).toBeCloseTo(0.2, 10);
    expect(fractionOf(meter.segments, 'medium')).toBeCloseTo(0.3, 10);
    expect(fractionOf(meter.segments, 'high')).toBeCloseTo(0.5, 10);
  });

  it('always sums the drawn fractions to exactly 1 (the bar is filled, no gaps or overflow)', () => {
    const meter = computeRagMeter(dist({ low: 7, medium: 11, high: 13 }));
    const sum = meter.segments.reduce((acc, s) => acc + s.fraction, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('orders segments low, then medium, then high (best to worst)', () => {
    const meter = computeRagMeter(dist({ low: 1, medium: 1, high: 1 }));
    expect(meter.segments.map((s) => s.band)).toEqual(['low', 'medium', 'high']);
  });

  it('omits bands with a zero count so the bar shows only what is present', () => {
    const meter = computeRagMeter(dist({ low: 4, high: 1 })); // no medium
    expect(meter.segments.map((s) => s.band)).toEqual(['low', 'high']);
    expect(fractionOf(meter.segments, 'low')).toBeCloseTo(0.8, 10);
    expect(fractionOf(meter.segments, 'high')).toBeCloseTo(0.2, 10);
  });

  it('does NOT inflate red when only one red item exists among many findings', () => {
    // 99 green, 1 red. Red must be 1%, never a forced minimum or the whole bar.
    const meter = computeRagMeter(dist({ low: 99, high: 1 }));
    expect(fractionOf(meter.segments, 'high')).toBeCloseTo(0.01, 10);
    expect(fractionOf(meter.segments, 'low')).toBeCloseTo(0.99, 10);
  });

  it('treats an all-red building honestly as fully red', () => {
    // The meter is not biased AGAINST red either: when findings truly are all
    // high severity, red fills the bar.
    const meter = computeRagMeter(dist({ high: 6 }));
    expect(fractionOf(meter.segments, 'high')).toBeCloseTo(1, 10);
    expect(meter.segments).toHaveLength(1);
  });

  it('reports an empty model for a building with no findings', () => {
    const meter = computeRagMeter(dist({}));
    expect(meter.isEmpty).toBe(true);
    expect(meter.total).toBe(0);
    expect(meter.segments).toHaveLength(0);
  });

  it('is defensive against missing or malformed distributions (legacy data gaps)', () => {
    // Undefined distribution, negative and fractional counts must not throw and
    // must not contribute nonsense to the proportion (brief 18.3).
    expect(computeRagMeter(undefined).isEmpty).toBe(true);

    const meter = computeRagMeter(
      dist({ low: -5, medium: 2.7, high: Number.NaN }),
    );
    // low clamps to 0, medium floors to 2, high (NaN) clamps to 0 -> total 2.
    expect(meter.total).toBe(2);
    expect(fractionOf(meter.segments, 'medium')).toBeCloseTo(1, 10);
  });

  it('rounds the on-bar percent label without distorting the underlying fraction', () => {
    const meter = computeRagMeter(dist({ low: 1, medium: 1, high: 1 }));
    const low = meter.segments.find((s) => s.band === 'low')!;
    // Label rounds to 33 for display, but the geometry stays the exact third.
    expect(low.percent).toBe(33);
    expect(low.fraction).toBeCloseTo(1 / 3, 10);
  });
});
