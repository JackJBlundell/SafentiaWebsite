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

// THE CONTACT IS THE POINT: a responsible party is a person the platform can
// EMAIL, so what travels down this chain is the `contactId` link, not a name.
// resolveResponsibleAssignment below is what the action-plan paths use, and it
// keeps the name and the id SOURCE-COHERENT: both always come from the same
// party, because a record naming one person while the release digest emails
// another is worse than either fact on its own.

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
 * or to render a display line that includes the role. Callers building an ACTION
 * want `resolveResponsibleAssignment` instead: it additionally honours a
 * per-finding override and carries the contact link an email needs.
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

/** Who an action holds accountable: the name it RECORDS, and the contact every
 *  automated email about it resolves through. Both keys are optional because
 *  legacy data can supply one without the other, but they are only ever filled
 *  from the SAME party (see resolveResponsibleAssignment). */
export interface ResponsibleAssignment {
  name?: string;
  contactId?: string;
}

/** A per-finding override as it sits packed on a non-conformity answer's `value`
 *  (the shape the app's nonConformity module writes). Only the responsible-party
 *  half is modelled here; the rest is the caller's business. */
export interface ResponsibleOverride {
  responsible?: string;
  responsibleContactId?: string;
}

/** A field counts as SUPPLIED only when it names something. RTDB has no schema,
 *  so a cleared override arrives as `''`, and treating that as an answer would
 *  pin an action to a blank party instead of letting it inherit one that can
 *  actually be emailed. */
function present(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Who ONE action holds accountable: the finding's own override first (an
 * assessor may name a different party for a single remedial item), then the
 * assessment's party, then the building's default.
 *
 * SOURCE COHERENCE IS THE INVARIANT: whichever step answers supplies BOTH the
 * name and the contact id, and a step that has neither is skipped entirely. The
 * alternative - taking the name from the override and the id from the building
 * because the override happened to lack one - would email the building's party
 * about an action recorded against somebody else, which is exactly the failure
 * this linkage exists to end.
 *
 * A step that carries a name but no `contactId` still wins its position: it is
 * an unlinked legacy or imported party (the only way one can now exist - every
 * live write path picks from the customer's contact directory), and honouring it
 * keeps the record honest. The action simply carries no contact id, which the
 * email seams log as the reason nobody was told rather than skipping in silence.
 */
export function resolveResponsibleAssignment(
  override: ResponsibleOverride | undefined,
  assessment: PartySource,
  building: BuildingPartySource,
): ResponsibleAssignment {
  const chain: ResponsibleAssignment[] = [
    {
      ...(present(override?.responsible)
        ? { name: override?.responsible }
        : {}),
      ...(present(override?.responsibleContactId)
        ? { contactId: override?.responsibleContactId }
        : {}),
    },
    partyAssignment(assessment?.responsibleParty),
    partyAssignment(building?.responsibleParty),
  ];
  for (const step of chain) {
    if (step.name !== undefined || step.contactId !== undefined) {
      return step;
    }
  }
  return {};
}

/** One structured party as an assignment. A party with neither a usable name nor
 *  a link is nothing at all, so it falls through rather than pinning an action
 *  to an empty record. */
function partyAssignment(
  party: ResponsibleParty | undefined,
): ResponsibleAssignment {
  return {
    ...(present(party?.name) ? { name: party?.name } : {}),
    ...(present(party?.contactId) ? { contactId: party?.contactId } : {}),
  };
}
