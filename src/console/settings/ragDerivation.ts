// ============================================================================
// ragDerivation - the pure RAG roll-up model (story 2012, FR-E18).
//
// Derives a building's RiskLevel from its latest released assessment's finding
// distribution and the state of its action plan, tuned by the organisation's
// RagConfig. Pure by design: no imports beyond the types contract, no I/O, so
// the same function drives the settings page's live preview today and the
// release-time derivation in Functions tomorrow.
//
// IMPORTANT: RAG_CONFIG_DEFAULTS below are the DEVELOPER'S PROPOSED MODEL,
// awaiting client agreement at the Phase 2 review (story 2012, Schedule 1
// group 5 "configurable RAG thresholds and roll-up calculation, agreed during
// Discovery"). They are a starting point for that conversation, not a decided
// policy. Story 2039 (FR-E19) promotes this module into the mirrored contract
// (types/paths pattern) so the Cloud Functions release pipeline shares this
// exact implementation rather than re-deriving it.
// ============================================================================

import type { RagConfig, RagDistribution, RiskLevel } from '../../types';

/** The proposed defaults (see header): 10% red findings marks a building high
 *  risk, 25% amber-or-red marks it medium, and the action plan can only make
 *  things worse, never better. */
export const RAG_CONFIG_DEFAULTS: RagConfig = {
  redShareForHigh: 0.1,
  amberRedShareForMedium: 0.25,
  openHighActionForcesHigh: true,
  overdueActionEscalates: true,
};

export interface DeriveRiskInput {
  /** TRUE finding counts from the latest released assessment. Absent means the
   *  building has never had a released assessment. */
  distribution?: RagDistribution;
  /** An action of High severity (or Life Protection) is still open. */
  hasOpenHighAction?: boolean;
  /** Any action is past its due date. */
  hasOverdueAction?: boolean;
}

/** One band worse. High risk has nowhere further to go. */
function escalate(level: RiskLevel): RiskLevel {
  if (level === 'low') {
    return 'medium';
  }
  if (level === 'medium') {
    return 'high';
  }
  return level;
}

/**
 * Derive the risk level for one building.
 *
 * Order of operations:
 *   1. No distribution at all: 'pending' - an un-assessed building must never
 *      present as safe, and an action flag cannot conjure an assessment.
 *   2. Shares against the configured thresholds (>= is in-band, so a share
 *      exactly at a threshold qualifies). A zero-finding assessment is 'low'.
 *   3. `openHighActionForcesHigh`: an open High action holds the building at
 *      'high' regardless of shares.
 *   4. `overdueActionEscalates`: an overdue action bumps the result one band
 *      (low to medium, medium to high).
 */
export function deriveRiskLevel(
  input: DeriveRiskInput,
  config: RagConfig,
): RiskLevel {
  const { distribution, hasOpenHighAction, hasOverdueAction } = input;

  if (!distribution) {
    return 'pending';
  }

  const red = distribution.high;
  const amber = distribution.medium;
  const total = distribution.low + amber + red;

  let level: RiskLevel;
  if (total <= 0) {
    level = 'low';
  } else if (red / total >= config.redShareForHigh) {
    level = 'high';
  } else if ((amber + red) / total >= config.amberRedShareForMedium) {
    level = 'medium';
  } else {
    level = 'low';
  }

  if (config.openHighActionForcesHigh && hasOpenHighAction) {
    return 'high';
  }
  if (config.overdueActionEscalates && hasOverdueAction) {
    return escalate(level);
  }
  return level;
}
