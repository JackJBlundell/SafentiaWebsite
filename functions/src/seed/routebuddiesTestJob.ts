// ============================================================================
// RouteBuddies test job - one fully-answered BS 9792 Housing FRA.
//
// Provisions, for the existing routebuddiesapp@gmail.com account in the existing
// "RouteBuddies" organisation, a complete BS 9792 assessment to test against:
// the BS 9792 base template (current source version), a customer + contacts +
// site + residential block, a job pinned to that template, and an assessment
// carrying an answer for EVERY question in the template.
//
// The account is admin-only today. A job is assigned to an ASSESSOR, and the
// rules only let an assessor write assessment answers, so the membership gains
// `assessor` ALONGSIDE `admin` (additive - nothing is taken away).
//
// The answers describe one coherent, plausible building rather than a uniform
// fill: a 1970s Cardiff block of flats on a stay put strategy, generally well
// managed, with ten genuine findings (1 high, 4 medium, 5 low) and a number of
// items honestly recorded as not applicable. A completeness assertion runs
// before a byte is written: every question in the template must have an answer.
//
// IDEMPOTENT: deterministic ids + set() everywhere, so re-running overwrites in
// place. TEST ROOT ONLY - every path is asserted to sit under /test.
//
//   GOOGLE_APPLICATION_CREDENTIALS=../../safentia-tech-firebase-adminsdk-*.json \
//   npx ts-node src/seed/routebuddiesTestJob.ts
// ============================================================================

import * as admin from 'firebase-admin';

import { forEnv } from '../shared/paths';
import type {
  AssessmentAnswer,
  Assessment,
  Building,
  Customer,
  CustomerContact,
  Environment,
  Job,
  Keyed,
  OrgMember,
  Site,
} from '../shared/types';
import { computeClaims, writeClaims } from '../lib/claims';
import { BS9792_TEMPLATE_ID, BS9792_TEMPLATE_VERSION } from './ids';
import { BS9792_TEMPLATE } from './data/bs9792Template';

// --- Fixed context -----------------------------------------------------------
const ENV: Environment = 'test';
const TEST_ROOT = 'test/';
const ORG_ID = '-Ozl9ph9RWbsZZkuwd0C'; // "RouteBuddies"
const UID = 'qKJ49NoryRRBfuA05H0eu73uYRW2'; // routebuddiesapp@gmail.com
const EMAIL = 'routebuddiesapp@gmail.com';
const NAME = 'Jack Blundell';

const CUSTOMER_ID = 'cust-rb-penylan-housing';
const CONTACT_PRIMARY = 'contact-rb-rhian-morgan';
const CONTACT_PARTY = 'contact-rb-owain-davies';
const SITE_ID = 'site-rb-penylan';
const BUILDING_ID = 'bld-rb-penylan-court';
const JOB_ID = 'job-rb-penylan-court';
const ASSESSMENT_ID = `job-${JOB_ID}`;

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const days = (n: number): number => NOW + n * DAY;

// The building's responsible party - the person every finding is chased through.
const PARTY_NAME = 'Owain Davies';
const PARTY_ROLE = 'Head of Building Safety';

// --- Answer helpers ----------------------------------------------------------
const text = (value: string): AssessmentAnswer => ({ text: value, updatedAt: NOW });
const choice = (value: string): AssessmentAnswer => ({ value, updatedAt: NOW });
const multi = (value: string[]): AssessmentAnswer => ({ value, updatedAt: NOW });
const bool = (value: boolean): AssessmentAnswer => ({ value, updatedAt: NOW });
const cell = (row: string, column: string, outcome: string): AssessmentAnswer => ({
  value: { row, column, outcome },
  updatedAt: NOW,
});
/**
 * A non-conformity assessed and found satisfactory: no remedial action.
 *
 * The observation is NOT decoration. `actionRequired: false` alone renders
 * exactly as an untouched question does - no severity chip lit and the "Action
 * required" toggle reading "No", which is also its default - so an item the
 * assessor considered and cleared would be indistinguishable on screen from one
 * they never reached. Writing what was found is what makes the decision visible,
 * and it is what an assessor puts against a satisfactory Obs/Rec row anyway.
 *
 * It stays a non-finding: the action plan is built from `severity`, which this
 * has none of, and `isNonConformityNoAction` keeps it clear of the started-
 * finding rule that would otherwise demand one.
 */
const ok = (
  observation = 'Considered at the time of the assessment. No deficiency identified.',
): AssessmentAnswer => ({
  observation,
  value: { actionRequired: false },
  updatedAt: NOW,
});
/** An item that does not apply to these premises. */
const na = (): AssessmentAnswer => ({ notApplicable: true, updatedAt: NOW });
/** An optional photo question left without evidence (counts as answered). */
const noPhoto = (): AssessmentAnswer => ({ updatedAt: NOW });
/** A real finding: severity + observation, carried into the action plan. */
const finding = (
  severity: 'L' | 'M' | 'H',
  observation: string,
  lifeProtection = false,
): AssessmentAnswer => ({
  severity,
  observation,
  value: {
    actionRequired: true,
    lifeProtection,
    responsible: PARTY_NAME,
    responsibleContactId: CONTACT_PARTY,
    dueBy: days(severity === 'H' ? 7 : severity === 'M' ? 30 : 90),
  },
  updatedAt: NOW,
});

// --- The answers, one per question ------------------------------------------
const ANSWERS: Keyed<AssessmentAnswer> = {
  // 01 General Information
  'q-01-fra-type': choice('Type 1 - Communal areas, non-intrusive'),
  'q-01-persons-consulted': text('Managing agent and caretaker'),

  // 02 The Premises
  'q-02-floor-area': text('1850'),
  'q-02-number-of-floors': text(
    '(i) 5 storeys at ground level and above; (ii) none entirely below ground level; (iii) no car parking is provided within the building, residents parking being at surface level to the rear.',
  ),
  'q-02-number-of-flats': text('24'),
  'q-02-construction-age': text(
    'Purpose-built block of traditional masonry construction with concrete floors, circa 1960s-1970s.',
  ),
  'q-02-escape-stairs': text('One protected internal escape stair serving all floors'),
  'q-02-lifts': text('One passenger lift; no firefighting or evacuation lift is provided'),
  'q-02-premises-type': multi(['General needs']),
  'q-02-other-matters': text(
    'A caretaker attends on weekdays only; there is no staff presence at night or at weekends.',
  ),

  // 03 The Occupants
  'q-03-employees': text('1 - caretaker/concierge present during weekday working hours'),
  'q-03-residents-visitors': text('58'),

  // 04 Occupants Especially at Risk from Fire
  'q-04-sleeping-occupants': bool(true),
  'q-04-remote-lone-workers': bool(false),
  'q-04-mobility-impairment': bool(true),
  'q-04-pcfra-carried-out': bool(true),
  'q-04-other-at-risk': text(
    'Four residents are recorded as having limited mobility and would require assistance to evacuate. Two residents receive oxygen therapy within their flats. The managing agent maintains a vulnerable persons register, reviewed quarterly.',
  ),
  'q-04-pcfra-shortfall': ok(),

  // 05 Fire Loss Experience
  'q-05-fire-loss-recorded': choice('No fire loss incidents recorded'),
  'q-05-fire-loss-details': text(
    'No fire loss incidents have been reported by the responsible person or the managing agent.',
  ),

  // 06 Other Relevant Information
  'q-06-other-information': text(
    'The building operates a stay put evacuation strategy. The external walls are of traditional masonry construction with no attached cladding or rainscreen system, so a fire risk appraisal of the external wall is not considered to be warranted.',
  ),

  // 07 Relevant Fire Safety Legislation
  'q-07-legislation-applies': text(
    'The Regulatory Reform (Fire Safety) Order 2005, as amended by the Fire Safety Act 2021 and the Building Safety Act 2022.',
  ),
  'q-07-enforcing-authority': text('South Wales Fire and Rescue Service'),
  'q-07-other-legislation': text(
    'The Housing Act 2004 (Housing Health and Safety Rating System), in respect of the individually occupied dwellings.',
  ),
  'q-07-other-enforced-by': text('Cardiff Council as local housing authority'),
  'q-07-alterations-notice': bool(false),
  'q-07-prohibition-notice': bool(false),
  'q-07-assessor-summary': text(
    'The premises are a purpose-built block of flats served by a single protected stair and operating a stay put evacuation strategy. The standard of fire precautions within the communal parts was found to be generally satisfactory and the common parts were well managed. Deficiencies were identified in the sealing of service penetrations within the electrical riser, in the condition of a sample of flat entrance doors and in the recording of routine fire door inspection; these are set out in the action plan and should be addressed within the timescales given.',
  ),

  // 08 Electrical Sources of Ignition
  'q-08-measures-electrical': bool(true),
  'q-08-fixed-installation-testing': finding(
    'M',
    'The most recent electrical installation condition report for the landlord’s supply serving the communal areas is dated more than five years ago and no evidence of a subsequent periodic inspection was available at the time of the assessment.',
  ),
  'q-08-pat-testing': ok(),
  'q-08-extension-leads': ok(),
  'q-08-unprotected-stairway': ok(),
  'q-08-fixed-heating': ok(),
  'q-08-tumble-dryer': na(),
  'q-08-pv-installed': bool(false),
  'q-08-pv-isolation': bool(false),
  'q-08-pv-management': na(),
  'q-08-pv-isolation-shortfall': na(),

  // 09 Gas Installation
  'q-09-mains-gas': bool(true),
  'q-09-gas-inspection': ok(),
  'q-09-temporary-gas-appliances': ok(),

  // 10 Smoking
  'q-10-measures-smoking': choice('Yes'),
  'q-10-smoking-prohibited': bool(true),
  'q-10-smoking-arrangements': bool(true),
  'q-10-smoking-policy-observed': bool(true),
  'q-10-smoking-unauthorised': ok(),

  // 11 Arson
  'q-11-measures-arson': bool(true),
  'q-11-fire-load-proximity': ok(),
  'q-11-arson-policy': ok(),
  'q-11-visitor-access-control': ok(),

  // 12 Portable Heaters and Heating and Ventilation Installations
  'q-12-control-portable-heaters': choice('Yes'),
  'q-12-heaters-prejudice-escape': ok(),
  'q-12-heaters-maintenance': ok(),
  'q-12-heaters-combustibles': ok(),

  // 13 Cooking (no communal cooking facilities)
  'q-13-measures-cooking': choice('Not applicable'),
  'q-13-duct-cleaning': na(),
  'q-13-shutdown-device': na(),

  // 14 Lightning
  'q-14-lps-present': bool(false),
  'q-14-lps-last-inspection': na(),
  'q-14-lightning-risk': ok(),

  // 15 Housekeeping
  'q-15-housekeeping-adequate': bool(true),
  'q-15-combustibles-ignition': ok(),
  'q-15-accumulation-combustibles': ok(),
  'q-15-combustibles-escape-routes': finding(
    'M',
    'Residents’ belongings, including a bicycle, a pushchair and bagged refuse, were being stored on the second and third floor common landings, within the protected escape route.',
    true,
  ),
  'q-15-meter-cupboards': ok(),
  'q-15-floor-covering-trip': ok(),
  'q-15-mobility-scooter-policy': choice('Yes'),

  // 16 Hazards Introduced by Outside Contractors and Building Works
  'q-16-control-contractors': choice('Yes'),
  'q-16-contractors-awareness': ok(),
  'q-16-building-control-approval': ok(),

  // 17 Dangerous Substances
  'q-17-precautions-dangerous-substances': choice('Not applicable'),
  'q-17-flammable-liquids-storage': na(),
  'q-17-lpg-storage': na(),
  'q-17-heating-oil': na(),

  // 18 Flammable, Combustible Items and Other Dangerous Materials
  'q-18-items-identified': bool(true),
  'q-18-furniture-regs': na(),
  'q-18-curtains-fire-retardant': na(),

  // 19 Fire Protection Measures - Construction
  'q-19-compartmentation-adequate': choice('Yes'),
  'q-19-separating-floors-walls': ok(),
  'q-19-breaches-walls-ceiling': ok(),
  'q-19-services-penetrations': finding(
    'H',
    'Unsealed penetrations were observed where electrical services pass through the compartment floor within the riser cupboard at second and fourth floor level. The openings are of a size that would permit the passage of fire and smoke between storeys and undermine the stay put strategy.',
    true,
  ),
  'q-19-unable-ascertain-fr': ok(),
  'q-19-glazing-standard': ok(),
  'q-19-stairways-enclosed': ok(),
  'q-19-stairways-final-exit': ok(),
  'q-19-external-stairway': na(),
  'q-19-roof-compartmentation': finding(
    'L',
    'This is a Type 1, non-intrusive assessment and the roof void was not opened. It could not therefore be determined whether reasonable compartmentation is present within the roof space above the top floor flats.',
  ),
  'q-19-fire-dampers': na(),
  'q-19-surface-spread-flame': ok(),
  'q-19-uninsulated-glazing': ok(),
  'q-19-separation-adjacent': ok(),

  // 20 Means of Escape
  'q-20-travel-distance-adequate': choice('Yes'),
  'q-20-excessive-travel-distance': ok(),
  'q-20-single-direction-travel': ok(),
  'q-20-exits-provision': ok(),
  'q-20-exit-direction': ok(),
  'q-20-doors-staircase-fr': ok(),
  'q-20-doors-meter-cupboards': ok(),
  'q-20-flat-entrance-doors': finding(
    'M',
    'A sample of eight flat entrance doors was viewed from the communal side. Two were found not to close fully into the rebate under the action of their self-closing device, and one had been fitted with a letter plate of unknown fire performance.',
    true,
  ),
  'q-20-self-closing-devices': ok(),
  'q-20-smoke-control': ok(),
  'q-20-routes-obstructions': ok(),
  'q-20-exits-openable': ok(),
  'q-20-disabled-evacuation': ok(),
  'q-20-fire-doors-wedged': ok(),
  'q-20-fire-door-gaps': ok(),
  'q-20-fire-doors-heavy-use': ok(),
  'q-20-means-of-escape-photo': noPhoto(),

  // 21 External Cladding (PAS 9980)
  'q-21-fraew-warranted': choice('No'),
  'q-21-combustible-external-walls': ok(),
  'q-21-cavities-closed': ok(),
  'q-21-cavity-barriers': ok(),
  'q-21-balconies': na(),

  // 22 Emergency Escape Lighting
  'q-22-escape-lighting-adequate': choice('Yes'),
  'q-22-lighting-damaged': ok(),
  'q-22-no-lighting-system': ok(),
  'q-22-lighting-deficient': finding(
    'L',
    'No emergency escape lighting is provided within the ground floor bin store lobby, which is windowless and forms part of the route to the rear external door.',
  ),
  'q-22-external-lighting': ok(),
  'q-22-windowless-lighting': ok(),
  'q-22-lighting-photo': noPhoto(),

  // 23 Fire Safety Signs and Notices
  'q-23-signs-adequate': choice('Yes'),
  'q-23-keep-shut-sign': ok(),
  'q-23-keep-locked-sign': ok(),
  'q-23-push-bar-sign': ok(),
  'q-23-fire-exit-sign': ok(),
  'q-23-directional-signs': ok(),
  'q-23-keep-clear-sign': ok(),
  'q-23-fire-action-notices': finding(
    'L',
    'Fire action notices setting out the stay put strategy are displayed at ground and first floor level but are missing from the third and fourth floor landings.',
  ),
  'q-23-signage-photo': noPhoto(),

  // 24 Means of Giving Warning in Case of Fire
  'q-24-alarm-adequate': choice('Yes'),
  'q-24-alarm-method-unsuitable': ok(),
  'q-24-afd-not-suitable': ok(),
  'q-24-afd-insufficient': ok(),
  'q-24-l1-detection-missing': na(),
  'q-24-detector-covered': ok(),
  'q-24-insufficient-call-points': na(),
  'q-24-call-points-obscured': na(),
  'q-24-no-zone-plan': ok(),
  'q-24-false-alarm-records': ok(),

  // 25 Manual Fire Extinguishing Appliances
  'q-25-extinguishers-adequate': choice('Yes'),
  'q-25-insufficient-equipment': ok(),
  'q-25-equipment-siting': ok(),
  'q-25-equipment-standards': ok(),
  'q-25-equipment-obstructed': ok(),
  'q-25-extinguisher-photo': noPhoto(),

  // 26 Relevant Automatic Fire Extinguishing Systems
  'q-26-fixed-system-type': text(
    'No fixed automatic fire extinguishing system is installed within the building.',
  ),
  'q-26-sprinklers': choice('Not applicable'),
  'q-26-extinguishing-systems': choice('Not applicable'),
  'q-26-pav-voice-systems': choice('Not applicable'),
  'q-26-engineered-system-maintenance': na(),

  // 27 Facilities and Arrangements for Firefighters
  'q-27-facilities-maintained': choice('Yes'),
  'q-27-access-firefighters': ok(),
  'q-27-safeguard-firefighters': ok(),
  'q-27-water-supplies': ok(),
  'q-27-rising-mains': na(),
  'q-27-evacuation-alert-system': choice('Not applicable'),
  'q-27-wayfinding-signage': choice('Not applicable'),

  // 28 Procedures and Arrangements
  'q-28-competent-person-appointed': choice('Yes'),
  'q-28-managed-by': text('Rhian Morgan, Property Manager, Pen-y-lan Housing Association'),
  'q-28-no-record-arrangements': ok(),
  'q-28-evacuation-strategy': choice('Stay Put'),
  'q-28-fire-procedures': ok(),
  'q-28-peep-considered': ok(),
  'q-28-liaison-nominated': ok(),
  'q-28-fire-strategy': choice('Yes'),
  'q-28-disabled-assistance': ok(),

  // 29 Training and Drills
  'q-29-training-adequate': choice('Yes'),
  'q-29-induction-training': ok(),
  'q-29-ongoing-training': ok(),
  'q-29-fire-marshals-nominated': na(),
  'q-29-fire-marshals-trained': na(),
  'q-29-drill-6-months': na(),
  'q-29-training-records': ok(),
  'q-29-contractors-familiar': ok(),
  'q-29-disabled-strategy-training': ok(),

  // 30 Testing and Maintenance
  'q-30-maintenance-adequate': choice('Yes'),
  'q-30-alarm-testing': ok(),
  'q-30-lighting-testing': ok(),
  'q-30-extinguisher-maintenance': ok(),
  'q-30-rising-mains-testing': na(),
  'q-30-evacuation-lift-testing': na(),
  'q-30-fire-door-testing': finding(
    'M',
    'No routine programme of inspection for the communal and flat entrance fire doors is in place, and no records of any such inspection were available.',
  ),

  // 31 Records
  'q-31-records-appropriate': bool(true),
  'q-31-alarm-records': ok(),
  'q-31-lighting-records': ok(),
  'q-31-extinguisher-records': ok(),

  // 32 Premises Information Box
  'q-32-pib-present': choice('No'),
  'q-32-pib-maintenance': finding(
    'L',
    'No premises information box is provided. Whilst not a statutory requirement for these premises, one would assist the fire and rescue service on arrival, particularly given the presence of residents who would require assistance to evacuate.',
  ),

  // 33 Engagement with Residents
  'q-33-info-disseminated': choice('Yes'),
  'q-33-resident-info': finding(
    'L',
    'Fire safety information explaining the stay put strategy was last issued to residents more than two years ago and has not been reissued following recent changes of tenancy.',
  ),
  'q-33-fire-strategy-in-place': ok(),

  // 34 Fire Risk Evaluation and Summary
  'q-34-risk-to-life': cell('Low', 'Extreme harm', 'Moderate'),
  'q-34-assessor-comments': text(
    'Taking into account the fire precautions observed and the nature of the premises and their occupants, the risk to life from fire is considered to be moderate. The high priority recommendation regarding the sealing of service penetrations within the riser should be actioned without delay, as the stay put strategy depends upon the integrity of the compartmentation. The remaining recommendations should be implemented within the timescales stated. This assessment should be reviewed within 12 months, or sooner in the event of a material change to the building, its occupants or its fire precautions.',
  ),
  'q-34-target-risk-level': choice('Tolerable'),
};

// --- Infrastructure ----------------------------------------------------------
function initAdmin(): void {
  if (admin.apps.length > 0) return;
  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'safentia-tech';
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`,
    projectId,
  });
}

function assertTest(path: string): string {
  if (!path.startsWith(TEST_ROOT)) {
    throw new Error(`SAFETY GUARD: refusing to write outside /test: "${path}"`);
  }
  return path;
}

/** Every question in the template must have an answer, and no answer may exist
 *  for a question the template does not have. Checked BEFORE anything is
 *  written, so a partly-answered assessment can never be provisioned. */
function assertEveryQuestionAnswered(): number {
  const ids = new Set<string>();
  for (const section of BS9792_TEMPLATE.sections) {
    for (const question of section.questions) ids.add(question.id);
  }
  const missing = [...ids].filter((id) => !ANSWERS[id]);
  const extra = Object.keys(ANSWERS).filter((id) => !ids.has(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Answer set does not match the template.\n  missing (${missing.length}): ${missing.join(', ')}\n  unknown (${extra.length}): ${extra.join(', ')}`,
    );
  }
  return ids.size;
}

async function run(): Promise<void> {
  const answeredCount = assertEveryQuestionAnswered();
  initAdmin();
  const p = forEnv(ENV);
  const db = admin.database();

  const update: Record<string, unknown> = {};
  const put = (path: string, value: unknown): void => {
    update[assertTest(path)] = value;
  };

  // 1. The account gains the assessor role alongside admin (membership + claims).
  const member: OrgMember = {
    roles: { admin: true, assessor: true },
    testMode: true,
    name: NAME,
    email: EMAIL,
    status: 'active',
  };
  put(p.db.orgMember(ORG_ID, UID), member);
  put(p.db.userOrg(UID, ORG_ID), true);

  // 2. The BS 9792 base template, at the current source version.
  put(p.db.template(ORG_ID, BS9792_TEMPLATE_ID), BS9792_TEMPLATE);

  // 3. Customer, its contacts, and the site.
  const customer: Customer = {
    name: 'Pen-y-lan Housing Association',
    address: '114 Pen-y-lan Road, Cardiff, CF23 5RL',
    email: 'routebuddiesapp@gmail.com',
    phone: '+44 29 2000 0000',
    status: 'active',
  };
  put(p.db.customer(ORG_ID, CUSTOMER_ID), customer);

  const primary: CustomerContact = {
    name: 'Rhian Morgan',
    jobTitle: 'Property Manager',
    email: 'routebuddiesapp@gmail.com',
    phone: '+44 29 2000 0001',
    portalRoles: { admin: true },
    isPrimary: true,
    createdAt: NOW,
  };
  put(p.db.customerContact(ORG_ID, CUSTOMER_ID, CONTACT_PRIMARY), primary);

  const party: CustomerContact = {
    name: PARTY_NAME,
    jobTitle: PARTY_ROLE,
    email: 'routebuddiesapp@gmail.com',
    phone: '+44 29 2000 0002',
    createdAt: NOW,
  };
  put(p.db.customerContact(ORG_ID, CUSTOMER_ID, CONTACT_PARTY), party);

  const site: Site = {
    name: 'Pen-y-lan',
    address: 'Pen-y-lan Road, Cardiff, CF23 5RL',
    contactId: CONTACT_PRIMARY,
  };
  put(p.db.site(ORG_ID, CUSTOMER_ID, SITE_ID), site);

  // 4. The residential block the assessment is about.
  const building: Building = {
    name: 'Pen-y-lan Court',
    customerId: CUSTOMER_ID,
    address: '116 Pen-y-lan Road, Cardiff, CF23 5RL',
    details: {
      area: 1850,
      floors: 5,
      occupiedFloors: 5,
      occupants: 58,
      isLandlord: true,
      alarmType: 'Addressable analogue (communal parts)',
      alarmCategory: 'L3',
    },
    responsibleParty: {
      name: PARTY_NAME,
      role: PARTY_ROLE,
      email: 'routebuddiesapp@gmail.com',
      phone: '+44 29 2000 0002',
      contactId: CONTACT_PARTY,
    },
    article53Persons: ['Pen-y-lan Housing Association'],
    photoUrl: '',
    riskLevel: 'pending',
    serviceSchedule: {
      fireAlarmService: { nextDue: days(45) },
      fireDrill: { nextDue: days(120) },
      extinguisherMaintenance: { nextDue: days(20) },
      fraReview: { nextDue: days(365) },
    },
  };
  put(p.db.building(ORG_ID, SITE_ID, BUILDING_ID), building);
  put(p.db.buildingCustomer(ORG_ID, BUILDING_ID), CUSTOMER_ID);

  // 5. The job, pinned to BS 9792, assigned to this account and already open.
  const job: Job = {
    templateId: BS9792_TEMPLATE_ID,
    templateVersion: BS9792_TEMPLATE_VERSION,
    customerId: CUSTOMER_ID,
    siteId: SITE_ID,
    buildingId: BUILDING_ID,
    assessorUid: UID,
    scheduledFor: days(-1),
    status: 'inProgress',
  };
  put(p.db.job(ORG_ID, JOB_ID), job);
  put(p.db.assessorJob(ORG_ID, UID, JOB_ID), 'inProgress');

  // 6. The assessment itself, plus an answer for every question.
  const assessment: Assessment = {
    jobId: JOB_ID,
    buildingId: BUILDING_ID,
    customerId: CUSTOMER_ID,
    templateSnapshot: BS9792_TEMPLATE,
    conductedBy: UID,
    conductedAt: days(-1),
    responsibleParty: building.responsibleParty,
    narrative: {
      summary:
        'Pen-y-lan Court is a five-storey purpose-built block of 24 flats operating a stay put evacuation strategy. The communal parts were found to be well managed and the general standard of fire precautions is satisfactory. Ten deficiencies were recorded, of which one - unsealed service penetrations within the electrical riser - is high priority because the stay put strategy depends on the compartmentation it undermines.',
      buildingDescription:
        'A five-storey purpose-built block of traditional masonry construction with concrete floors, circa 1960s-1970s, containing 24 general needs flats served by a single protected escape stair and one passenger lift.',
      premisesCovered:
        'All communal parts, including the entrance hall, protected stair, landings, bin store, riser cupboards and external areas, together with a sample of eight flat entrance doors viewed from the communal side. This is a Type 1 assessment; the interiors of the flats were not inspected.',
      incidentHistory:
        'No fire loss incidents have been reported by the responsible person or the managing agent. Two unwanted fire signals from the communal detection system were recorded in the past twelve months, both attributed to contractor activity.',
      riskOpinion:
        'Moderate. Resolving the riser penetrations and the flat entrance door defects would return the building to a tolerable risk to life from fire.',
    },
    status: 'inProgress',
  };
  put(p.db.assessment(ORG_ID, ASSESSMENT_ID), assessment);
  put(p.db.assessmentAnswers(ORG_ID, ASSESSMENT_ID), ANSWERS);

  // Chunked: the template body is written twice (template + snapshot), so one
  // update carrying everything is a payload the API refuses.
  const entries = Object.entries(update);
  for (const [path, value] of entries) {
    await db.ref(path).set(value);
  }

  // Claims last, so the account only gains the role once its data is in place.
  //
  // Via writeClaims + computeClaims - the platform's OWN path - never a raw
  // setCustomUserClaims. Three things ride on that and all three were lost when
  // this wrote the claim by hand:
  //   1. It trips the /platform/tokenRefresh marker the app's metadata listener
  //      watches, so the device force-refreshes its ID token immediately. Without
  //      it the phone keeps the old token for up to an hour and the account is
  //      told it lacks the role it was just granted.
  //   2. It re-applies a platform superAdmin grant, which setCustomUserClaims
  //      would silently strip (it replaces the whole claim object).
  //   3. The roles come from the STORED membership rather than a second, hand
  //      -typed copy that can drift from it.
  //
  // This also re-points the ACTIVE org at RouteBuddies. The account is a member
  // of more than one organisation and a token names exactly one, so provisioning
  // work here without switching the active space would leave the job invisible.
  const stored = (await db.ref(p.db.orgMember(ORG_ID, UID)).get()).val() as OrgMember;
  await writeClaims(UID, computeClaims(stored, ORG_ID));

  const findings = Object.values(ANSWERS).filter((a) => a.severity);
  console.log('\n=========================================================');
  console.log(' RouteBuddies test job provisioned (under /test)');
  console.log('=========================================================');
  console.log(` Organisation : ${ORG_ID} (RouteBuddies)`);
  console.log(` Account      : ${EMAIL} (admin + assessor)`);
  console.log(` Template     : ${BS9792_TEMPLATE.name} v${BS9792_TEMPLATE_VERSION}`);
  console.log(` Building     : ${building.name}, ${building.address}`);
  console.log(` Job          : ${JOB_ID} (${job.status})`);
  console.log(` Assessment   : ${ASSESSMENT_ID} (${assessment.status})`);
  console.log(` Answers      : ${answeredCount}/${answeredCount} questions answered`);
  console.log(
    ` Findings     : ${findings.length} (H ${findings.filter((f) => f.severity === 'H').length}, M ${findings.filter((f) => f.severity === 'M').length}, L ${findings.filter((f) => f.severity === 'L').length})`,
  );
  console.log(` Not applicable: ${Object.values(ANSWERS).filter((a) => a.notApplicable).length} items`);
  console.log('=========================================================\n');
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('ROUTEBUDDIES TEST JOB PROVISIONING FAILED:', error);
    process.exit(1);
  });
