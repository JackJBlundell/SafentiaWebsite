// ============================================================================
// Actions / action plan (brief 10), generated from the RELEASED assessments.
//
// Actions span Low/Medium/High severity (so the proportional gauge has a true
// mix and is visibly NOT all-red - story 1072), include some flagged Life
// Protection (the "LTP" marker) and some carrying a flag-location composite
// image as `locationFlagUrl` (story 1074, brief 8 downstream). Due dates derive
// from severity using the DUE_WINDOW_DAYS contract (H 7d, M 30d, L 90d).
//
// Only released assessments (Tower A, Tower B) generate actions; mid-lifecycle
// and pending buildings have none, which is the correct state.
//
// Storage URLs (flag composites, action images) are injected after upload.
// ============================================================================

import type { Action, Severity, SectionCode } from '../../shared/types';
import { DUE_WINDOW_DAYS } from '../../shared/types';
import { ASSESSMENT, BUILDING, CONTACT, UID, days } from '../ids';

/** The customer contacts an action can be assigned to, and the name each one is
 *  recorded under. Actions are LINKED to a contact exactly as the release
 *  pipeline links them - the seed cannot demonstrate an assignment email, an
 *  overdue chase or the console's contact picker with a party who is only a
 *  typed name, because none of those resolve anybody without the link. */
const CONTACT_NAMES: Record<string, string> = {
  [CONTACT.meridianHelen]: 'Helen Carter',
  [CONTACT.meridianMarcus]: 'Marcus Webb',
};

export interface SeedAction {
  buildingId: string;
  id: string;
  action: Action;
}

interface ActionSeed {
  buildingId: string;
  id: string;
  assessmentId: string;
  sectionCode: SectionCode;
  question: string;
  observation: string;
  severity: Severity;
  lifeProtection: boolean;
  /** The CustomerContact who owes the work (a CONTACT id). The recorded name
   *  follows from it, never the other way round. */
  responsibleContact: string;
  /** Key into the flag-composite URL map, if this action carries a location. */
  flagKey?: string;
  /** Photo keys (into the action-image URL map) to embed as titled images. */
  photoKeys?: Array<{ key: string; title: string }>;
}

// Due dates are derived from severity per the contract, anchored to the release
// date (we use "now minus a little" as the action-creation point).
function dueBySeverity(severity: Severity): number {
  return days(DUE_WINDOW_DAYS[severity] - 18); // released ~18 days ago
}

const ACTION_SEEDS: ActionSeed[] = [
  // Tower A - High, Life Protection, with a flag composite + photo.
  {
    buildingId: BUILDING.meridianTowerA,
    id: 'act-tower-a-electrical',
    assessmentId: ASSESSMENT.towerA,
    sectionCode: '02',
    question:
      'Is the fixed electrical installation in satisfactory condition and within inspection date?',
    observation:
      'Remove the daisy-chained extension leads serving comms equipment on the Level 6 riser and provide a suitably rated permanent supply. The overloaded board is an immediate ignition risk.',
    severity: 'H',
    lifeProtection: true,
    responsibleContact: CONTACT.meridianHelen,
    flagKey: 'asmt-tower-a-flag-escape',
    photoKeys: [
      { key: 'asmt-tower-a-electrical', title: 'Overloaded distribution board, Level 6 riser' },
    ],
  },
  // Tower A - High, Life Protection, escape distance, with the same flag plan.
  {
    buildingId: BUILDING.meridianTowerA,
    id: 'act-tower-a-escape',
    assessmentId: ASSESSMENT.towerA,
    sectionCode: '05',
    question: 'Are escape routes adequate in number, width and travel distance?',
    observation:
      'Provide an alternative means of escape or reduce the single-direction travel distance from the east end of Level 6 to the protected stair.',
    severity: 'H',
    lifeProtection: true,
    responsibleContact: CONTACT.meridianHelen,
    flagKey: 'asmt-tower-a-flag-escape',
  },
  // Tower A - Medium, PEEPs.
  {
    buildingId: BUILDING.meridianTowerA,
    id: 'act-tower-a-peeps',
    assessmentId: ASSESSMENT.towerA,
    sectionCode: '01',
    question: 'Are suitable PEEPs in place for all persons who need them?',
    observation:
      'Prepare individual Personal Emergency Evacuation Plans for the two registered wheelchair users on Level 9 to replace the generic plan currently held.',
    severity: 'M',
    lifeProtection: true,
    responsibleContact: CONTACT.meridianMarcus,
  },
  // Tower A - Medium, obstruction.
  {
    buildingId: BUILDING.meridianTowerA,
    id: 'act-tower-a-obstruction',
    assessmentId: ASSESSMENT.towerA,
    sectionCode: '05',
    question: 'Are all escape routes and final exits kept clear and unobstructed?',
    observation:
      'Remove the stored furniture obstructing the Level 3 escape corridor and reinforce the clear-routes policy with staff.',
    severity: 'M',
    lifeProtection: false,
    responsibleContact: CONTACT.meridianHelen,
  },
  // Tower A - Low, emergency lighting luminaire.
  {
    buildingId: BUILDING.meridianTowerA,
    id: 'act-tower-a-emlight',
    assessmentId: ASSESSMENT.towerA,
    sectionCode: '08',
    question: 'Is emergency escape lighting provided where needed and adequate?',
    observation:
      'Replace the non-maintained emergency luminaire that failed the duration test in the Level 11 lobby.',
    severity: 'L',
    lifeProtection: false,
    responsibleContact: CONTACT.meridianHelen,
  },
  // Tower A - Low, faded signage.
  {
    buildingId: BUILDING.meridianTowerA,
    id: 'act-tower-a-signage',
    assessmentId: ASSESSMENT.towerA,
    sectionCode: '11',
    question: 'Is escape-route signage adequate, compliant and visible?',
    observation:
      'Replace the two faded photoluminescent escape signs at basement level.',
    severity: 'L',
    lifeProtection: false,
    responsibleContact: CONTACT.meridianHelen,
  },
  // Tower B - the single High item, Life Protection, with a photo.
  {
    buildingId: BUILDING.meridianTowerB,
    id: 'act-tower-b-signage',
    assessmentId: ASSESSMENT.towerB,
    sectionCode: '11',
    question: 'Is escape-route signage adequate, compliant and visible?',
    observation:
      'Install directional escape signage at the basement stair head so occupants unfamiliar with the building are not misdirected.',
    severity: 'H',
    lifeProtection: true,
    responsibleContact: CONTACT.meridianHelen,
    photoKeys: [
      { key: 'asmt-tower-b-signage', title: 'Missing directional sign, basement stair' },
    ],
  },
];

/** Build all actions given the flag-composite and action-photo URL maps. One
 *  action is pre-signed-off to demonstrate the signed-off state. */
export function buildActions(
  flagUrls: Record<string, string>,
  photoUrls: Record<string, string>,
): SeedAction[] {
  return ACTION_SEEDS.map((seed) => {
    const action: Action = {
      assessmentId: seed.assessmentId,
      sectionCode: seed.sectionCode,
      question: seed.question,
      observation: seed.observation,
      severity: seed.severity,
      lifeProtection: seed.lifeProtection,
      responsible: CONTACT_NAMES[seed.responsibleContact],
      responsibleContactId: seed.responsibleContact,
      dueBy: dueBySeverity(seed.severity),
      status: 'open',
    };
    if (seed.flagKey) {
      action.locationFlagUrl = flagUrls[seed.flagKey] ?? '';
    }
    if (seed.photoKeys) {
      action.images = seed.photoKeys.map((p) => ({
        path: photoUrls[p.key] ?? '',
        title: p.title,
      }));
    }
    // One low-severity Tower A action is already signed off (auditor action) so
    // the signed-off state is demonstrable in the action plan.
    if (seed.id === 'act-tower-a-signage') {
      action.status = 'signedOff';
      action.signedOffBy = UID.auditor;
      action.signedOffAt = days(-12);
    }
    return { buildingId: seed.buildingId, id: seed.id, action };
  });
}
