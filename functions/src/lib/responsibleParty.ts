// ============================================================================
// Responsible-party resolution - the ONE precedence chain for "who is
// accountable here", shared by every server path that needs it.
//
// THE MODEL (see the ResponsibleParty doc comment in shared/types): a building
// carries the admin-set DEFAULT party; an assessment carries its own copy so a
// single visit can switch party without editing the building; and every action
// born of that assessment inherits the name. The party is therefore chosen ONCE
// and applied everywhere - it must never be re-typed on each finding.
//
// WHY THIS MODULE EXISTS: that chain used to be implemented at the point of use
// - once (correctly) in releaseAssessment, once (partially) in the report
// assembler, and not at all on the create paths - so the three drifted and the
// defaulting was never persisted. Consumers reading stored records therefore saw
// a blank responsible party even though the building had one. One resolver, one
// precedence order, imported everywhere, is what stops that recurring.
//
// NO LEGACY FALLBACK: the free-text `Building.responsiblePerson` that preceded
// the structured party is gone - from the contract, from every write path, and
// (by scripts/backfillResponsibleParty.ts) from the data. That script promotes
// the string into a `{ name }` party and deletes the key, and it MUST be run
// against an environment before this code is deployed to it: without the read
// that used to sit at the end of these chains, an unmigrated building resolves
// to no party at all. One field, one chain, nothing to keep in step.
// ============================================================================

import type { Assessment, Building, ResponsibleParty } from '../shared/types';

/** The party-bearing shape each resolver needs, so callers can pass a full
 *  record, a partial read, or the RTDB `null` an absent node produces without
 *  ceremony. */
type PartySource = Pick<Assessment, 'responsibleParty'> | null | undefined;
type BuildingPartySource = Pick<Building, 'responsibleParty'> | null | undefined;

/** A party is only usable when it actually names someone. RTDB has no schema, so
 *  a `{ name: '' }` record is possible (a cleared field, a bad import); treating
 *  it as present would print an empty "Responsible person" line on a legally
 *  significant document and, worse, would be PERSISTED by the stamping paths as
 *  though a party had been chosen. Blank means absent - fall through instead. */
function named(party: ResponsibleParty | undefined): ResponsibleParty | undefined {
  return party && typeof party.name === 'string' && party.name.trim().length > 0
    ? party
    : undefined;
}

/**
 * The canonical STRUCTURED party for an assessment (or, with no assessment, for
 * a building on its own): the assessment's own party, else the building's
 * default, else nobody.
 *
 * Use this wherever the whole party is wanted - to persist onto an assessment,
 * or to render a display line that includes the role. Callers that only need the
 * NAME (an action's `responsible` is a bare string) want `resolveResponsibleName`
 * instead, which additionally honours a per-finding override.
 */
export function resolveResponsibleParty(
  assessment: PartySource,
  building: BuildingPartySource,
): ResponsibleParty | undefined {
  const fromAssessment = named(assessment?.responsibleParty);
  if (fromAssessment) {
    return fromAssessment;
  }
  return named(building?.responsibleParty);
}

/**
 * The canonical responsible NAME for one action: the finding's own override
 * first (an assessor may name a different party for a single remedial item),
 * then the assessment's party, then the building's default.
 *
 * DELIBERATELY nullish-coalescing rather than truthiness, and deliberately NOT
 * routed through `resolveResponsibleParty`'s blank guard: this is a lift of the
 * chain releaseAssessment has always run, and it is behaviour-preserving by
 * construction. Tightening it here would silently RE-ROUTE the responsible party
 * on already-released-shaped data (a blank override would start inheriting the
 * building's party), which is not a change to make blind inside a de-duplication.
 * The blank case is a data fault the stamping paths above no longer create.
 */
export function resolveResponsibleName(
  override: string | undefined,
  assessment: PartySource,
  building: BuildingPartySource,
): string | undefined {
  return (
    override ??
    assessment?.responsibleParty?.name ??
    building?.responsibleParty?.name
  );
}
