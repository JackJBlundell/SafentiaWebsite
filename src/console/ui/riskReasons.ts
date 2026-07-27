// ============================================================================
// riskExplanation - turns a building's STORED risk level into the plain-English
// account of how it got there.
//
// A colour and a word ("High risk") is a verdict with no working shown, which
// is exactly the complaint this module answers. It re-states, in order, the
// same steps the shared deriveRiskLevel took at release time (ragDerivation.ts,
// mirrored to Functions), against the organisation's OWN RagConfig - never a
// hardcoded threshold, because the bands are per-org data.
//
// Honesty is the whole point, so:
//   - the manual override wins where it exists, and is NAMED as an override
//     rather than dressed up as a derivation that never happened
//     (releaseAssessment sets building.riskLevel = manualRiskLevel ?? derived);
//   - a surface that cannot see the action plan or the release record says so
//     in `caveat` instead of implying it saw everything;
//   - `pending` is stated as "never assessed", not softened.
//
// Pure: no React, no I/O, so each surface builds this from whatever it has
// already subscribed to and the wording cannot drift between screens.
// ============================================================================

import { deriveRiskLevel } from '../settings/ragDerivation';
import type { RagConfig, RagDistribution, RiskLevel } from '../../types';

/** The words a reader sees for each band, matching design/rag.ts labels. */
const LEVEL_WORDS: Record<RiskLevel, string> = {
  high: 'high risk',
  medium: 'medium risk',
  low: 'low risk',
  pending: 'not yet assessed',
};

export interface RiskManualOverride {
  level: RiskLevel;
  /** Resolved display name where the surface read the roster; absent is fine. */
  byName?: string;
  at: number;
}

export interface RiskActionState {
  hasOpenHighAction: boolean;
  hasOverdueAction: boolean;
}

export interface RiskExplanationInput {
  /** The STORED level on the building - what the badge is showing. */
  level: RiskLevel;
  distribution?: RagDistribution;
  lastAssessedAt?: number;
  config: RagConfig;
  /** Omit where the surface has not read the building's actions. */
  actions?: RiskActionState;
  /** Omit where the surface has not read the latest released assessment; pass
   *  null once it HAS been read and carries no override. */
  manualOverride?: RiskManualOverride | null;
  /** Injected so the wording is deterministic under test. */
  formatDate: (millis: number) => string;
}

export interface RiskFindingCounts {
  low: number;
  medium: number;
  high: number;
  total: number;
}

export interface RiskExplanation {
  /** One sentence that stands alone next to the badge, no interaction needed. */
  summary: string;
  /** The finding counts behind it, when an assessment has been released. */
  counts?: RiskFindingCounts;
  /** The ordered steps, in the order the derivation applies them. */
  reasons: string[];
  /** When assessed, in words; absent when never assessed. */
  assessedNote?: string;
  /** What this surface could NOT see. Absent when the account is complete. */
  caveat?: string;
}

/** A 0..1 share as a reader-facing percentage, e.g. 0.125 -> "12.5%". */
function percent(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
}

export function buildRiskExplanation(
  input: RiskExplanationInput,
): RiskExplanation {
  const {
    level,
    distribution,
    lastAssessedAt,
    config,
    actions,
    manualOverride,
    formatDate,
  } = input;

  const assessedNote =
    lastAssessedAt !== undefined
      ? `Last assessed ${formatDate(lastAssessedAt)}`
      : undefined;

  // 1. Never assessed. An un-assessed building must never read as safe, so this
  // is stated outright rather than explained away.
  if (!distribution || level === 'pending') {
    return {
      summary: 'No assessment has been released for this building yet.',
      reasons: [
        'A risk level is derived when an assessment is released. Until then the building has no level, and it is deliberately not shown as low risk.',
      ],
      assessedNote,
    };
  }

  const counts: RiskFindingCounts = {
    low: distribution.low,
    medium: distribution.medium,
    high: distribution.high,
    total: distribution.low + distribution.medium + distribution.high,
  };
  const redShare = counts.total > 0 ? counts.high / counts.total : 0;
  const amberRedShare =
    counts.total > 0 ? (counts.medium + counts.high) / counts.total : 0;

  const derived = deriveRiskLevel(
    {
      distribution,
      hasOpenHighAction: actions?.hasOpenHighAction,
      hasOverdueAction: actions?.hasOverdueAction,
    },
    config,
  );

  const findingsLine =
    counts.total === 0
      ? 'The last released assessment recorded no findings.'
      : `The last released assessment recorded ${counts.total} ${counts.total === 1 ? 'finding' : 'findings'}: ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`;

  // 2. A manual override REPLACED the derivation, so say that first and keep the
  // derived band visible as the thing it replaced.
  if (manualOverride) {
    const who = manualOverride.byName ? ` by ${manualOverride.byName}` : '';
    return {
      summary: `Set manually to ${LEVEL_WORDS[manualOverride.level]} when the assessment was released, rather than derived from the findings.`,
      counts,
      assessedNote,
      reasons: [
        `The assessor set the overall risk to ${LEVEL_WORDS[manualOverride.level]}${who} on ${formatDate(manualOverride.at)}. A manual level replaces the calculated one.`,
        findingsLine,
        `On the findings and the organisation's thresholds alone, the calculation gives ${LEVEL_WORDS[derived]}.`,
      ],
      caveat: actions
        ? undefined
        : 'The action plan is not read on this screen, so the calculated comparison above covers the findings only.',
    };
  }

  // 3. The derivation itself, step by step and in its real order.
  const reasons: string[] = [findingsLine];
  let bandBeforeActions: RiskLevel;
  if (counts.total === 0) {
    bandBeforeActions = 'low';
    reasons.push('With no findings recorded, the building starts at low risk.');
  } else if (redShare >= config.redShareForHigh) {
    bandBeforeActions = 'high';
    reasons.push(
      `High-severity findings are ${percent(redShare)} of the total, at or above this organisation's ${percent(config.redShareForHigh)} threshold for high risk.`,
    );
  } else if (amberRedShare >= config.amberRedShareForMedium) {
    bandBeforeActions = 'medium';
    reasons.push(
      `High and medium findings together are ${percent(amberRedShare)} of the total. That is below the ${percent(config.redShareForHigh)} high-risk threshold but at or above the ${percent(config.amberRedShareForMedium)} threshold for medium risk.`,
    );
  } else {
    bandBeforeActions = 'low';
    reasons.push(
      `High-severity findings are ${percent(redShare)} of the total and high plus medium are ${percent(amberRedShare)}, both below this organisation's ${percent(config.redShareForHigh)} and ${percent(config.amberRedShareForMedium)} thresholds.`,
    );
  }

  if (actions) {
    if (config.openHighActionForcesHigh && actions.hasOpenHighAction) {
      reasons.push(
        'An open high-severity or Life Protection action holds the building at high risk regardless of the finding counts.',
      );
    } else if (config.overdueActionEscalates && actions.hasOverdueAction) {
      reasons.push(
        `An action is past its due date, which raises the level by one band, from ${LEVEL_WORDS[bandBeforeActions]} to ${LEVEL_WORDS[derived]}.`,
      );
    }
  }

  // 4. What the reader is looking at versus what these inputs produce. A gap is
  // real information, not something to paper over: on a surface without the
  // release record it usually means an assessor set the level by hand, and the
  // action plan can also have moved on since the release.
  const mismatch = derived !== level;
  // "Complete" means this surface read BOTH the action plan and the release
  // record (manualOverride === null is a read that found no override).
  const complete = actions !== undefined && manualOverride === null;
  let caveat: string | undefined;
  if (mismatch && complete) {
    caveat = `The status stored at release is ${LEVEL_WORDS[level]}; today's findings and action plan give ${LEVEL_WORDS[derived]}. The action plan has moved on since the assessment was released, and the stored status is refreshed at the next release.`;
  } else if (mismatch) {
    caveat = `The recorded status is ${LEVEL_WORDS[level]}, which these inputs alone do not produce. That happens when an assessor set the risk manually at release, or when the action plan has changed since. Open the building for the full account.`;
  } else if (!actions) {
    caveat =
      'The action plan is not read on this list, so an open or overdue action may also be affecting the level. Open the building for the full account.';
  }

  const summary = mismatch
    ? `Recorded as ${LEVEL_WORDS[level]}. The findings on their own give ${LEVEL_WORDS[derived]}.`
    : reasons[reasons.length - 1];

  return { summary, counts, reasons, assessedNote, caveat };
}
