// ============================================================================
// ragDerivation unit tests - the methodology lives here, so the boundaries are
// tested exactly: at-threshold shares qualify, zero totals are low, and the
// action-plan flags only ever worsen the result.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { RAG_CONFIG_DEFAULTS, deriveRiskLevel } from './ragDerivation';
import type { RagConfig, RagDistribution } from '../../types';

const config: RagConfig = { ...RAG_CONFIG_DEFAULTS };

function dist(low: number, medium: number, high: number): RagDistribution {
  return { low, medium, high };
}

describe('deriveRiskLevel - bands', () => {
  it('returns pending when there is no distribution at all', () => {
    expect(deriveRiskLevel({}, config)).toBe('pending');
  });

  it('stays pending even with action flags set: no assessment means unknown, not high', () => {
    expect(
      deriveRiskLevel({ hasOpenHighAction: true, hasOverdueAction: true }, config),
    ).toBe('pending');
  });

  it('returns low for a released assessment with zero findings', () => {
    expect(deriveRiskLevel({ distribution: dist(0, 0, 0) }, config)).toBe('low');
  });

  it('returns low when every finding is low severity', () => {
    expect(deriveRiskLevel({ distribution: dist(20, 0, 0) }, config)).toBe('low');
  });

  it('returns high when the red share meets the threshold', () => {
    // 2 red of 10 = 20% >= 10%.
    expect(deriveRiskLevel({ distribution: dist(8, 0, 2) }, config)).toBe('high');
  });

  it('returns medium when amber+red meet their threshold but red alone does not', () => {
    // 0 red, 3 amber of 10 = 30% >= 25%.
    expect(deriveRiskLevel({ distribution: dist(7, 3, 0) }, config)).toBe('medium');
  });

  it('does NOT skew a large green building high for a small red share below threshold', () => {
    // 1 red of 20 = 5% < 10%; 1 amber+red of 20 = 5% < 25%.
    expect(deriveRiskLevel({ distribution: dist(19, 0, 1) }, config)).toBe('low');
  });
});

describe('deriveRiskLevel - exact boundaries (>= is in-band)', () => {
  it('red share exactly at redShareForHigh is high', () => {
    // 1 red of 10 = 10% exactly.
    expect(deriveRiskLevel({ distribution: dist(9, 0, 1) }, config)).toBe('high');
  });

  it('red share just under the threshold is not high', () => {
    // 1 red of 11 is about 9.1% < 10%; amber+red 9.1% < 25% so low.
    expect(deriveRiskLevel({ distribution: dist(10, 0, 1) }, config)).toBe('low');
  });

  it('amber+red share exactly at amberRedShareForMedium is medium', () => {
    // 1 amber of 4 = 25% exactly, no red.
    expect(deriveRiskLevel({ distribution: dist(3, 1, 0) }, config)).toBe('medium');
  });

  it('amber+red share just under the threshold is low', () => {
    // 1 amber of 5 = 20% < 25%.
    expect(deriveRiskLevel({ distribution: dist(4, 1, 0) }, config)).toBe('low');
  });

  it('red counts towards the amber+red share', () => {
    // Custom config where red alone misses high but red+amber makes medium:
    // 1 red + 1 amber of 8 = 25%.
    const custom: RagConfig = { ...config, redShareForHigh: 0.5 };
    expect(deriveRiskLevel({ distribution: dist(6, 1, 1) }, custom)).toBe('medium');
  });
});

describe('deriveRiskLevel - action-plan flags', () => {
  it('an open High action forces high even on an all-green distribution', () => {
    expect(
      deriveRiskLevel(
        { distribution: dist(20, 0, 0), hasOpenHighAction: true },
        config,
      ),
    ).toBe('high');
  });

  it('an open High action does nothing when the toggle is off', () => {
    const off: RagConfig = { ...config, openHighActionForcesHigh: false };
    expect(
      deriveRiskLevel({ distribution: dist(20, 0, 0), hasOpenHighAction: true }, off),
    ).toBe('low');
  });

  it('an overdue action escalates low to medium', () => {
    expect(
      deriveRiskLevel(
        { distribution: dist(20, 0, 0), hasOverdueAction: true },
        config,
      ),
    ).toBe('medium');
  });

  it('an overdue action escalates medium to high', () => {
    expect(
      deriveRiskLevel(
        { distribution: dist(7, 3, 0), hasOverdueAction: true },
        config,
      ),
    ).toBe('high');
  });

  it('an overdue action leaves high at high (no band above it)', () => {
    expect(
      deriveRiskLevel({ distribution: dist(0, 0, 5), hasOverdueAction: true }, config),
    ).toBe('high');
  });

  it('an overdue action does nothing when the toggle is off', () => {
    const off: RagConfig = { ...config, overdueActionEscalates: false };
    expect(
      deriveRiskLevel({ distribution: dist(20, 0, 0), hasOverdueAction: true }, off),
    ).toBe('low');
  });

  it('escalation applies to a zero-finding (low) building too', () => {
    expect(
      deriveRiskLevel({ distribution: dist(0, 0, 0), hasOverdueAction: true }, config),
    ).toBe('medium');
  });

  it('both flags together resolve to high (force wins, escalation cannot exceed it)', () => {
    expect(
      deriveRiskLevel(
        {
          distribution: dist(20, 0, 0),
          hasOpenHighAction: true,
          hasOverdueAction: true,
        },
        config,
      ),
    ).toBe('high');
  });
});
