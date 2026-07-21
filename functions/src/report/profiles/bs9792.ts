// ============================================================================
// bs9792Profile - the BS 9792 Housing Fire Risk Assessment treatment.
//
// BS 9792 covers residential housing (the communal parts of blocks of flats and
// the wider premises), not general non-domestic premises, so the report is framed
// as a HOUSING FRA: a housing-specific title, intro and conformity wording, plus
// a standard-scope row in the overview. Everything else inherits the shared
// engine and the generic baseline.
// ============================================================================

import type { ReportModel } from '../assemble';
import type { ReportProfile } from './types';
import { defaultProfile } from './default';

export const bs9792Profile: ReportProfile = {
  ...defaultProfile,
  standard: 'bs9792',
  documentTitle: 'Housing Fire Risk Assessment',
  methodologyLabel: 'BS 9792 housing fire risk assessment',
  riskAssessmentIntro:
    'The following tables record each subject assessed under the BS 9792 housing methodology, the questions considered, the answers given and the assessor observations. Subjects are presented in the order defined by the assessment template and cover the communal parts of the premises.',
  standardNotes: [
    'This housing fire risk assessment has been carried out in accordance with the principles of BS 9792 and the Regulatory Reform (Fire Safety) Order 2005 as it applies to the communal parts of residential premises. It records the significant findings of the assessment and the remedial actions considered necessary to reduce risk to an acceptable level.',
    'The assessment is based on the conditions observed on the date it was carried out and on the information made available to the assessor at that time. Areas that were inaccessible, concealed or could not reasonably be inspected, and the interiors of individually occupied dwellings, are not covered unless expressly stated.',
    'The risk profile shown above is proportional to the actual distribution of findings recorded during the assessment. It is intended to summarise the balance of low, medium and high severity findings and should be read alongside the assessor risk opinion and the action plan, not in isolation.',
    'The responsible person remains responsible for implementing the action plan, for keeping this assessment under review, and for arranging a further assessment if there is reason to believe it is no longer valid or if there has been a significant change to the premises, its use or its residents.',
  ],
  signOffNotes: [
    'Housing fire risk assessments should be kept under regular review. Where a review-by date is shown above it is taken from the recorded service schedule; in the absence of a specific trigger, a review at least annually is recommended for premises with sleeping accommodation.',
  ],
  // A standard-scope descriptor. This is a factual statement of what BS 9792
  // covers, not building data, so it is always safe to show.
  overviewExtraRows: (_model: ReportModel) => [
    ['Assessment type', 'Housing / communal areas (BS 9792)'],
  ],
};
