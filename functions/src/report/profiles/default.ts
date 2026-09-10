// ============================================================================
// defaultProfile - the generic, standard-neutral report profile.
//
// This is what a CUSTOM template (or any untagged one) renders under: a credible,
// professional fire risk assessment report built purely from the template's own
// sections, making NO claim of conformity to a specific published standard (that
// would be false for a bespoke template). Every standard profile is this baseline
// plus targeted overrides.
// ============================================================================

import type { ReportProfile } from './types';

export const defaultProfile: ReportProfile = {
  standard: 'custom',
  documentTitle: 'Fire Risk Assessment',
  methodologyLabel: 'Fire risk assessment',
  riskAssessmentIntro:
    'The following tables record each subject assessed, the questions considered, the answers given and the assessor observations. Subjects are presented in the order defined by the assessment template.',
  // Standard-neutral wording: it explains the convention without attributing it
  // to a published standard the bespoke template may not follow.
  notApplicableNote:
    "Some items in the tables below are recorded as 'Not applicable'. That is a decision by the assessor: the item was considered and judged not to apply to these premises. It is not an item that was left unassessed, no finding arises from it, it produces no remedial action, and it does not form part of the risk profile shown above.",
  standardNotes: [
    'This fire risk assessment has been carried out in accordance with the Regulatory Reform (Fire Safety) Order 2005. It records the significant findings of the assessment and the remedial actions considered necessary to reduce risk to an acceptable level.',
    'The assessment is based on the conditions observed on the date it was carried out and on the information made available to the assessor at that time. Areas that were inaccessible, concealed or could not reasonably be inspected are not covered by this assessment.',
    'The risk profile shown above is proportional to the actual distribution of findings recorded during the assessment. It is intended to summarise the balance of low, medium and high severity findings and should be read alongside the assessor risk opinion and the action plan, not in isolation.',
    'The responsible person remains responsible for implementing the action plan, for keeping this assessment under review, and for arranging a further assessment if there is reason to believe it is no longer valid or if there has been a significant change to the premises or its use.',
  ],
  signOffNotes: [],
  overviewExtraRows: () => [],
};
