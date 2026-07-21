// ============================================================================
// Assessments and their per-question answers (brief 10).
//
// The set spans every lifecycle state the app renders:
//   - Tower A : released, full history, photos, a flag answer and several
//               non-conformities across L/M/H (drives actions + the gauge).
//   - Tower B : released, mostly-green - only a single red non-conformity.
//   - Riverside Mill : readyForValidation (mid-lifecycle, awaiting auditor).
//   - Lodge House : infoRequired with an OPEN infoRequest on a question, so the
//                   assessor's respond-to-info flow (story 1050) has real data.
// Two buildings (Central Annexe, Harbourside Unit) have NO assessment - the
// pending path.
//
// Every assessment embeds a templateSnapshot (a copy of the pinned template) so
// it renders the exact questions it began with regardless of later template
// edits (brief 6 + story 1031). Answers include text/longtext/yesno/select/
// multiselect values, photos, a flag (pins + composite url), and nonConformity
// answers carrying severity + observation.
//
// Storage URLs (answer photos, flag composites) are injected after upload via
// the maps the seed passes in, so records and stored objects never drift.
// ============================================================================

import type {
  Assessment,
  AssessmentAnswer,
  Template,
  Severity,
} from '../../shared/types';
import { PAS79_TEMPLATE } from './pas79Template';
import {
  ASSESSMENT,
  JOB,
  BUILDING,
  CUSTOMER,
  PLAN,
  UID,
  days,
  NOW,
} from '../ids';

/** Storage keys the seed must generate/upload for assessment media, returned so
 *  the seed knows exactly what to create. The URL maps come back keyed by these. */
export const ASSESSMENT_MEDIA = {
  photos: [
    { key: 'asmt-tower-a-electrical', title: 'Overloaded distribution board, Level 6 riser' },
    { key: 'asmt-tower-a-extinguisher', title: 'CO2 extinguisher, ground floor lobby' },
    { key: 'asmt-tower-b-signage', title: 'Missing directional sign, basement stair' },
    { key: 'asmt-lodge-detection', title: 'Detector head, first floor corridor' },
  ],
  flags: [
    {
      key: 'asmt-tower-a-flag-escape',
      planId: PLAN.towerAGround,
      pins: [
        { x: 0.32, y: 0.41, severity: 'H' as Severity },
        { x: 0.68, y: 0.55, severity: 'M' as Severity },
      ],
    },
  ],
} as const;

export interface SeedAssessment {
  id: string;
  assessment: Assessment;
  /** Answers keyed by template question id. */
  answers: Record<string, AssessmentAnswer>;
}

/** Deep-clone the published template so each assessment carries its own immutable
 *  snapshot (a shared reference would let one assessment's snapshot mutate
 *  another's). */
function snapshot(): Template {
  return JSON.parse(JSON.stringify(PAS79_TEMPLATE)) as Template;
}

interface MediaUrls {
  photoUrls: Record<string, string>; // photo key -> url
  flagUrls: Record<string, string>; // flag key -> composite url
}

// --- Answer helpers ----------------------------------------------------------
function answer(partial: AssessmentAnswer): AssessmentAnswer {
  return { updatedAt: NOW, ...partial };
}

function nonConformity(
  severity: Severity,
  observation: string,
  extra: Partial<AssessmentAnswer> = {},
): AssessmentAnswer {
  return answer({ value: false, severity, observation, ...extra });
}

// --- Tower A (released, rich) ------------------------------------------------
function towerA(urls: MediaUrls): SeedAssessment {
  const conductedAt = days(-21);
  const submittedAt = days(-20);
  const releasedAt = days(-18);

  const flag = ASSESSMENT_MEDIA.flags[0];
  const answers: Record<string, AssessmentAnswer> = {
    'q-01-occupant-profile': answer({
      text: 'Predominantly office workers across fourteen floors, with reception staff, cleaning and maintenance contractors, and visitors throughout the working day. Peak occupancy mid-morning and mid-afternoon.',
    }),
    'q-01-peak-occupancy': answer({ text: '420', value: '420' }),
    'q-01-vulnerable-persons': answer({
      value: ['Persons with mobility impairment', 'Members of the public unfamiliar with the premises'],
    }),
    'q-01-sleeping-risk': answer({ value: false }),
    'q-01-peeps-shortfall': nonConformity(
      'M',
      'Two registered wheelchair users on Level 9 without current PEEPs. Generic plans only.',
    ),
    'q-02-ignition-sources': answer({
      value: ['Electrical equipment and installations', 'Cooking appliances', 'Heating appliances'],
    }),
    'q-02-electrical-condition': nonConformity(
      'H',
      'Distribution board on the Level 6 riser is overloaded with daisy-chained extension leads serving comms equipment. Immediate overheating risk.',
      {
        photos: [
          { path: urls.photoUrls['asmt-tower-a-electrical'] ?? '', title: ASSESSMENT_MEDIA.photos[0].title },
        ],
        flags: [
          {
            planId: flag.planId,
            pins: flag.pins.map((p) => ({ ...p })),
            flagImageUrl: urls.flagUrls[flag.key] ?? '',
          },
        ],
      },
    ),
    'q-02-pat-testing': answer({ value: true }),
    'q-05-escape-routes-adequate': nonConformity(
      'H',
      'Single-direction escape from the east end of Level 6 exceeds the recommended travel distance to the protected stair.',
      {
        flags: [
          {
            planId: flag.planId,
            pins: flag.pins.map((p) => ({ ...p })),
            flagImageUrl: urls.flagUrls[flag.key] ?? '',
          },
        ],
      },
    ),
    'q-05-routes-unobstructed': nonConformity(
      'M',
      'Stored furniture obstructing the Level 3 escape corridor at the time of inspection.',
    ),
    'q-05-final-exits-openable': answer({ value: true }),
    'q-05-evacuation-strategy': answer({ value: 'Simultaneous evacuation' }),
    'q-06-extinguishers-provision': answer({
      value: true,
      photos: [
        { path: urls.photoUrls['asmt-tower-a-extinguisher'] ?? '', title: ASSESSMENT_MEDIA.photos[1].title },
      ],
    }),
    'q-06-extinguisher-service': answer({ value: true }),
    'q-07-alarm-category': answer({ value: 'L2' }),
    'q-07-system-adequate': answer({ value: true }),
    'q-07-weekly-test': answer({ value: true }),
    'q-08-provision-adequate': nonConformity(
      'L',
      'One non-maintained emergency luminaire failed the duration test on the Level 11 lobby. Otherwise satisfactory.',
    ),
    'q-08-monthly-test': answer({ value: true }),
    'q-10-responsible-person': answer({ text: 'Helen Carter, Facilities Director' }),
    'q-10-policy-in-place': answer({ value: true }),
    'q-10-staff-training': answer({ value: true }),
    'q-10-logbook-maintained': answer({ value: true }),
    'q-11-escape-signage': nonConformity(
      'L',
      'Two photoluminescent signs faded at basement level and due for replacement.',
    ),
    'q-11-fire-action-notices': answer({ value: true }),
  };

  return {
    id: ASSESSMENT.towerA,
    assessment: {
      jobId: JOB.towerA,
      buildingId: BUILDING.meridianTowerA,
      customerId: CUSTOMER.meridian,
      templateSnapshot: snapshot(),
      conductedBy: UID.assessor,
      conductedAt,
      narrative: {
        summary:
          'Tower A presents an overall HIGH risk pending remediation of an overloaded electrical riser and a single-direction escape shortfall on Level 6. Management arrangements are otherwise sound and the alarm and emergency lighting provision is broadly adequate.',
        buildingDescription:
          'A fourteen-storey steel-framed commercial office tower with two protected stair cores and a single passenger lift bank.',
        premisesCovered:
          'All common parts, plant rooms, risers and a representative sample of occupied office floors.',
        incidentHistory:
          'One recorded false alarm in the past twelve months, attributed to cooking fumes on Level 2. No fires recorded.',
        riskOpinion:
          'High until the Level 6 electrical and escape findings are resolved, at which point the building would reduce to medium.',
      },
      workflow: {
        submittedAt,
        checkedBy: UID.auditor,
        validatedBy: UID.auditor,
        acceptedAt: releasedAt - 60 * 60 * 1000,
        releasedAt,
      },
      status: 'released',
    },
    answers,
  };
}

// --- Tower B (released, mostly green) ----------------------------------------
function towerB(urls: MediaUrls): SeedAssessment {
  const conductedAt = days(-34);
  const answers: Record<string, AssessmentAnswer> = {
    'q-01-occupant-profile': answer({
      text: 'Mixed office and ground-floor retail occupancy. No sleeping risk.',
    }),
    'q-01-peak-occupancy': answer({ text: '360', value: '360' }),
    'q-01-sleeping-risk': answer({ value: false }),
    'q-03-housekeeping': answer({ value: 'Good' }),
    'q-05-escape-routes-adequate': answer({ value: true }),
    'q-05-final-exits-openable': answer({ value: true }),
    'q-05-evacuation-strategy': answer({ value: 'Simultaneous evacuation' }),
    'q-06-extinguisher-service': answer({ value: true }),
    'q-07-alarm-category': answer({ value: 'L2' }),
    'q-07-system-adequate': answer({ value: true }),
    'q-07-weekly-test': answer({ value: true }),
    'q-08-monthly-test': answer({ value: true }),
    // The single red item in an otherwise green building.
    'q-11-escape-signage': nonConformity(
      'H',
      'No directional escape signage at the basement stair head; occupants unfamiliar with the route could be misdirected.',
      {
        photos: [
          { path: urls.photoUrls['asmt-tower-b-signage'] ?? '', title: ASSESSMENT_MEDIA.photos[2].title },
        ],
      },
    ),
    'q-11-fire-action-notices': answer({ value: true }),
    'q-10-responsible-person': answer({ text: 'Helen Carter, Facilities Director' }),
    'q-10-policy-in-place': answer({ value: true }),
    'q-10-logbook-maintained': answer({ value: true }),
  };

  return {
    id: ASSESSMENT.towerB,
    assessment: {
      jobId: JOB.towerB,
      buildingId: BUILDING.meridianTowerB,
      customerId: CUSTOMER.meridian,
      templateSnapshot: snapshot(),
      conductedBy: UID.assessor,
      conductedAt,
      narrative: {
        summary:
          'Tower B is a well-managed building presenting an overall LOW risk. A single significant finding relates to missing basement escape signage; all other provisions are satisfactory.',
        buildingDescription:
          'A thirteen-storey commercial tower with ground-floor retail and twelve occupied office floors.',
        riskOpinion:
          'Low. The proportional finding distribution is overwhelmingly green with one red item to address.',
      },
      workflow: {
        submittedAt: days(-33),
        checkedBy: UID.auditor,
        validatedBy: UID.auditor,
        acceptedAt: days(-31),
        releasedAt: days(-31),
      },
      status: 'released',
    },
    answers,
  };
}

// --- Riverside Mill (readyForValidation, mid-lifecycle) ----------------------
function riversideMill(): SeedAssessment {
  return {
    id: ASSESSMENT.riversideMill,
    assessment: {
      jobId: JOB.riversideMill,
      buildingId: BUILDING.riversideMill,
      customerId: CUSTOMER.meridian,
      templateSnapshot: snapshot(),
      conductedBy: UID.assessor,
      conductedAt: days(-4),
      narrative: {
        summary:
          'Assessment of Riverside Mill complete and submitted for validation. Two notable findings relate to flammable storage and a fire-door defect.',
        riskOpinion: 'Medium, pending auditor validation.',
      },
      workflow: {
        // Submitted, awaiting the auditor - no checkedBy/validatedBy yet.
        submittedAt: days(-3),
      },
      status: 'readyForValidation',
    },
    answers: {
      'q-01-occupant-profile': answer({
        text: 'Light-industrial workshop staff across five floors, with occasional delivery drivers.',
      }),
      'q-01-peak-occupancy': answer({ text: '180', value: '180' }),
      'q-01-sleeping-risk': answer({ value: false }),
      'q-03-housekeeping': answer({ value: 'Satisfactory' }),
      'q-03-flammable-storage': nonConformity(
        'M',
        'Flammable solvents stored in excess of the recommended workplace quantity outside a fire-rated cabinet on Level 2.',
      ),
      'q-04-fire-doors': nonConformity(
        'M',
        'Self-closer disconnected on the Level 3 cross-corridor fire door.',
      ),
      'q-05-escape-routes-adequate': answer({ value: true }),
      'q-05-final-exits-openable': answer({ value: true }),
      'q-05-evacuation-strategy': answer({ value: 'Simultaneous evacuation' }),
      'q-07-alarm-category': answer({ value: 'L3' }),
      'q-07-system-adequate': answer({ value: true }),
      'q-07-weekly-test': answer({ value: true }),
      'q-08-monthly-test': answer({ value: true }),
      'q-10-responsible-person': answer({ text: 'Marcus Hill, Building Manager' }),
      'q-10-policy-in-place': answer({ value: true }),
      'q-10-logbook-maintained': answer({ value: true }),
      'q-11-fire-action-notices': answer({ value: true }),
    },
  };
}

// --- Lodge House (infoRequired, OPEN infoRequest) ----------------------------
function lodgeHouse(urls: MediaUrls): SeedAssessment {
  return {
    id: ASSESSMENT.lodgeHouse,
    assessment: {
      jobId: JOB.lodgeHouse,
      buildingId: BUILDING.northgateLodgeHouse,
      customerId: CUSTOMER.northgate,
      templateSnapshot: snapshot(),
      conductedBy: UID.assessor,
      conductedAt: days(-9),
      narrative: {
        summary:
          'Care-home assessment submitted; the auditor has requested clarification on the detection coverage before validation can proceed.',
        riskOpinion: 'Medium, subject to the outstanding information request being resolved.',
      },
      workflow: {
        submittedAt: days(-8),
        checkedBy: UID.auditor,
      },
      status: 'infoRequired',
    },
    answers: {
      'q-01-occupant-profile': answer({
        text: 'Residential care for up to sixty-four elderly residents, many with limited mobility. Twenty-four-hour staffing.',
      }),
      'q-01-peak-occupancy': answer({ text: '64', value: '64' }),
      'q-01-vulnerable-persons': answer({
        value: ['Elderly residents', 'Persons with mobility impairment', 'Sleeping occupants'],
      }),
      'q-01-sleeping-risk': answer({ value: true }),
      'q-05-evacuation-strategy': answer({ value: 'Progressive horizontal evacuation' }),
      'q-05-final-exits-openable': answer({ value: true }),
      'q-07-alarm-category': answer({ value: 'L1' }),
      // The OPEN info request lives on this answer (story 1050). No resolvedAt,
      // no response yet - exactly the state the respond-to-info flow consumes.
      'q-07-system-adequate': answer({
        value: true,
        photos: [
          { path: urls.photoUrls['asmt-lodge-detection'] ?? '', title: ASSESSMENT_MEDIA.photos[3].title },
        ],
        infoRequest: {
          byUid: UID.auditor,
          message:
            'Please confirm whether the detection on the first-floor corridor extends into the individual resident rooms, or provide the room-level coverage detail for the L1 claim.',
        },
      }),
      'q-07-weekly-test': answer({ value: true }),
      'q-08-provision-adequate': answer({ value: true }),
      'q-08-monthly-test': answer({ value: true }),
      'q-10-responsible-person': answer({ text: 'Raymond Ellis, Registered Manager' }),
      'q-10-policy-in-place': answer({ value: true }),
      'q-10-logbook-maintained': answer({ value: true }),
      'q-11-fire-action-notices': answer({ value: true }),
    },
  };
}

/** Build all assessments given the uploaded media URL maps. */
export function buildAssessments(urls: MediaUrls): SeedAssessment[] {
  return [towerA(urls), towerB(urls), riversideMill(), lodgeHouse(urls)];
}

export type { MediaUrls };
