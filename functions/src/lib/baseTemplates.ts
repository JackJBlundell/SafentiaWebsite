// ============================================================================
// Base templates - the system templates every organisation arrives with.
//
// Safentia ships two: the PAS 79-1:2020 default and the BS 9792 Housing FRA.
// Their content is product content held in code (seed/data), so the version
// here IS the current one: a new organisation always receives the latest
// wording, and an org's own amendments are published over the same id.
//
// Their ids are FIXED (seed/ids.ts) - the only durable marker of a base
// template in the data, mirrored by the console's isBaseTemplate().
//
// Used by provisionOrganisation (every new org, both founding paths) and by
// the test-root backfill script, so the two can never disagree about the list.
// ============================================================================

import type { Template } from '../shared/types';
import { BS9792_TEMPLATE_ID, PAS79_TEMPLATE_ID } from '../seed/ids';
import { PAS79_TEMPLATE } from '../seed/data/pas79Template';
import { BS9792_TEMPLATE } from '../seed/data/bs9792Template';

export const BASE_TEMPLATES: ReadonlyArray<{ id: string; template: Template }> = [
  { id: PAS79_TEMPLATE_ID, template: PAS79_TEMPLATE },
  { id: BS9792_TEMPLATE_ID, template: BS9792_TEMPLATE },
];

const BASE_TEMPLATE_IDS: ReadonlySet<string> = new Set(
  BASE_TEMPLATES.map(({ id }) => id),
);

/** True for the ids of the templates Safentia provides. They are included
 *  with every plan, so they never occupy a plan's template slot. */
export function isBaseTemplateId(templateId: string): boolean {
  return BASE_TEMPLATE_IDS.has(templateId);
}
