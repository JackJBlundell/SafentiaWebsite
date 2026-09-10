// ============================================================================
// pas79Profile - the PAS 79-1:2020 report treatment.
//
// PAS 79 is the dominant path, so this profile deliberately reproduces the report
// EXACTLY as it rendered before profiles existed (same title, same Section 2
// intro, same notes, no extra overview rows). The standard-specific value is the
// conformity wording below - which used to be applied to every report regardless
// of standard, and is now correctly scoped to PAS 79 assessments only.
// ============================================================================

import type { ReportProfile } from './types';
import { defaultProfile } from './default';

export const pas79Profile: ReportProfile = {
  ...defaultProfile,
  standard: 'pas79',
  documentTitle: 'Fire Risk Assessment',
  methodologyLabel: 'PAS 79-1:2020 fire risk assessment',
  // PAS 79 applies one common question set to every premises, so an item that
  // does not exist there (a provision the building simply does not have) is an
  // ordinary and expected outcome. The wording says what the standard's method
  // requires it to say: the item was CONSIDERED and dismissed on the assessor's
  // judgement, which is the significant fact, and is materially different from
  // an item left unanswered.
  notApplicableNote:
    "Some items in the tables below are recorded as 'Not applicable'. Under the PAS 79-1:2020 method the same schedule of items is considered at every premises, so an item may be judged not to apply here - for example a provision these premises do not have, or a matter outside the scope of this assessment. 'Not applicable' therefore records a decision by the assessor that the item was considered and judged not to apply; it is not an item left unassessed. No finding arises from such an item, it produces no remedial action, and it does not form part of the risk profile shown above.",
  // Verbatim the pre-profiles wording, so PAS 79 output is unchanged.
  standardNotes: [
    'This fire risk assessment has been carried out in accordance with the principles of PAS 79-1:2020 and the Regulatory Reform (Fire Safety) Order 2005. It records the significant findings of the assessment and the remedial actions considered necessary to reduce risk to an acceptable level.',
    'The assessment is based on the conditions observed on the date it was carried out and on the information made available to the assessor at that time. Areas that were inaccessible, concealed or could not reasonably be inspected are not covered by this assessment.',
    'The risk profile shown above is proportional to the actual distribution of findings recorded during the assessment. It is intended to summarise the balance of low, medium and high severity findings and should be read alongside the assessor risk opinion and the action plan, not in isolation.',
    'The responsible person remains responsible for implementing the action plan, for keeping this assessment under review, and for arranging a further assessment if there is reason to believe it is no longer valid or if there has been a significant change to the premises or its use.',
  ],
};
