// ============================================================================
// Test-assessor provisioning (Firerite field-test rollout).
//
// Creates 13 REAL @firerite.co.uk assessor accounts in the existing Firerite
// organisation (org-firerite-demo, display name "Firerite Fire Safety") and
// gives each ONE unique building with a freshly-scheduled job, so every tester
// can start a PAS 79 assessment from scratch and carry it through to submission.
//
// Everything is written under the ISOLATED /test root (brief 4.8 + 10) - these
// are test-mode accounts (`testMode: true`) so they only ever read/write /test,
// never live production data. It reuses the already-published PAS 79 template
// (tmpl-pas79-default v1) that the main seed put in this org.
//
// IDEMPOTENT: deterministic uids/ids + set() everywhere and get-by-email reuse,
// so re-running overwrites in place and never creates a duplicate account.
//
// SAFETY: the same hard guard as the main seed - every RTDB path must begin with
// the test root or the run aborts before writing a byte.
//
// Run against live `safentia-tech`:
//   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.safentia-tech.json \
//   FIREBASE_PROJECT_ID=safentia-tech \
//   npx ts-node src/seed/testAssessors.ts
// ============================================================================

import * as admin from 'firebase-admin';

import { forEnv } from '../shared/paths';
import type {
  Environment,
  OrgMember,
  Job,
  Building,
  Customer,
  CustomerContact,
  Site,
  AlarmCategory,
} from '../shared/types';
import {
  PAS79_TEMPLATE_ID,
  PAS79_TEMPLATE_VERSION,
  BS9792_TEMPLATE_ID,
  BS9792_TEMPLATE_VERSION,
} from './ids';
import { BS9792_TEMPLATE } from './data/bs9792Template';

// --- Fixed context -----------------------------------------------------------
const ENV: Environment = 'test';
const TEST_ROOT = 'test/';
const ORG_ID = 'org-firerite-demo'; // the existing "Firerite Fire Safety" org
const PASSWORD = 'Firerite-Test-2026!'; // shared with the existing demo accounts

// One customer + site to hang the 13 test buildings under, with the customer's
// single (primary) contact the site points at.
const CUSTOMER_ID = 'cust-firerite-test';
const SITE_ID = 'site-firerite-test';
const CONTACT_ID = 'contact-firerite-operations';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const days = (n: number): number => NOW + n * DAY;

// --- The 13 testers ----------------------------------------------------------
// Each gets a deterministic uid/building/job derived from `slug`, and a distinct
// building so no two testers ever touch the same assessment.
interface Tester {
  name: string;
  email: string;
  slug: string;
  building: {
    name: string;
    address: string;
    area: number;
    floors: number;
    occupiedFloors: number;
    occupants: number;
    isLandlord: boolean;
    alarmType: string;
    alarmCategory: AlarmCategory;
    responsiblePartyName: string;
  };
  scheduledInDays: number;
}

const TESTERS: Tester[] = [
  {
    name: 'Gareth Selway', email: 'gareth@firerite.co.uk', slug: 'gareth-selway',
    building: { name: 'Maerdy Court', address: 'Maerdy Industrial Estate, Rhymney, NP22 5PY', area: 3200, floors: 3, occupiedFloors: 3, occupants: 90, isLandlord: true, alarmType: 'Addressable analogue', alarmCategory: 'L2', responsiblePartyName: 'Site Facilities Manager' },
    scheduledInDays: 2,
  },
  {
    name: 'Gareth Evans', email: 'gevans@firerite.co.uk', slug: 'gareth-evans',
    building: { name: 'Bridgend Retail House', address: 'Brackla Street, Bridgend, CF31 1BZ', area: 2100, floors: 2, occupiedFloors: 2, occupants: 55, isLandlord: false, alarmType: 'Conventional', alarmCategory: 'M', responsiblePartyName: 'Store Manager' },
    scheduledInDays: 3,
  },
  {
    name: 'Owen Jayne', email: 'OwenJayne@firerite.co.uk', slug: 'owen-jayne',
    building: { name: 'Taff Vale Chambers', address: 'Taff Street, Pontypridd, CF37 4TR', area: 4400, floors: 5, occupiedFloors: 4, occupants: 140, isLandlord: true, alarmType: 'Addressable analogue', alarmCategory: 'L3', responsiblePartyName: 'Building Manager' },
    scheduledInDays: 2,
  },
  {
    name: 'Tony Ryder', email: 'Tony.ryder@firerite.co.uk', slug: 'tony-ryder',
    building: { name: 'Newport Dock Warehouse', address: 'Alexandra Docks, Newport, NP20 2NP', area: 6800, floors: 1, occupiedFloors: 1, occupants: 45, isLandlord: true, alarmType: 'Addressable analogue', alarmCategory: 'P2', responsiblePartyName: 'Warehouse Supervisor' },
    scheduledInDays: 4,
  },
  {
    name: 'Geraint Parry', email: 'Geraint@firerite.co.uk', slug: 'geraint-parry',
    building: { name: 'Llanelli Care Lodge', address: 'Stepney Street, Llanelli, SA15 3YA', area: 2600, floors: 3, occupiedFloors: 3, occupants: 60, isLandlord: false, alarmType: 'Addressable analogue', alarmCategory: 'L1', responsiblePartyName: 'Registered Home Manager' },
    scheduledInDays: 3,
  },
  {
    name: 'Carl Evans', email: 'Carl@firerite.co.uk', slug: 'carl-evans',
    building: { name: 'Swansea Waterfront Offices', address: 'Kings Road, SA1 Swansea, SA1 8AS', area: 5200, floors: 6, occupiedFloors: 6, occupants: 210, isLandlord: true, alarmType: 'Addressable analogue', alarmCategory: 'L2', responsiblePartyName: 'Facilities Director' },
    scheduledInDays: 2,
  },
  {
    name: 'John Keenan', email: 'John.Keenan@firerite.co.uk', slug: 'john-keenan',
    building: { name: 'Merthyr Community Hall', address: 'High Street, Merthyr Tydfil, CF47 8DP', area: 1400, floors: 2, occupiedFloors: 2, occupants: 120, isLandlord: false, alarmType: 'Conventional', alarmCategory: 'M', responsiblePartyName: 'Hall Trustee' },
    scheduledInDays: 5,
  },
  {
    name: 'Nick Suller', email: 'nick.suller@firerite.co.uk', slug: 'nick-suller',
    building: { name: 'Cardiff Bay Apartments', address: 'Bute Crescent, Cardiff, CF10 5AN', area: 7400, floors: 9, occupiedFloors: 9, occupants: 300, isLandlord: true, alarmType: 'Addressable analogue', alarmCategory: 'L2', responsiblePartyName: 'Managing Agent' },
    scheduledInDays: 3,
  },
  {
    name: 'Phill Pinches', email: 'phill@firerite.co.uk', slug: 'phill-pinches',
    building: { name: 'Aberdare Trade Park Unit 4', address: 'Aberaman Industrial Estate, Aberdare, CF44 6DA', area: 3000, floors: 1, occupiedFloors: 1, occupants: 35, isLandlord: false, alarmType: 'Conventional', alarmCategory: 'P2', responsiblePartyName: 'Unit Tenant' },
    scheduledInDays: 4,
  },
  {
    name: 'Craig Evans', email: 'Craig.Evans@firerite.co.uk', slug: 'craig-evans',
    building: { name: 'Barry Seafront Hotel', address: 'The Esplanade, Barry, CF62 5TQ', area: 4800, floors: 4, occupiedFloors: 4, occupants: 160, isLandlord: true, alarmType: 'Addressable analogue', alarmCategory: 'L1', responsiblePartyName: 'General Manager' },
    scheduledInDays: 2,
  },
  {
    name: 'Neil Griffiths', email: 'Neil.Griffiths@firerite.co.uk', slug: 'neil-griffiths',
    building: { name: 'Caerphilly School Block', address: 'Nantgarw Road, Caerphilly, CF83 1AW', area: 5600, floors: 3, occupiedFloors: 3, occupants: 480, isLandlord: false, alarmType: 'Addressable analogue', alarmCategory: 'L2', responsiblePartyName: 'Site Business Manager' },
    scheduledInDays: 3,
  },
  {
    name: 'James Murray', email: 'James.Murray@firerite.co.uk', slug: 'james-murray',
    building: { name: 'Wrexham Logistics Depot', address: 'Wrexham Industrial Estate, Wrexham, LL13 9UG', area: 9200, floors: 1, occupiedFloors: 1, occupants: 70, isLandlord: true, alarmType: 'Addressable analogue', alarmCategory: 'P2', responsiblePartyName: 'Depot Manager' },
    scheduledInDays: 4,
  },
  {
    name: 'Mal Simons', email: 'mal@firerite.co.uk', slug: 'mal-simons',
    building: { name: 'Neath Enterprise Centre', address: 'Milland Road, Neath, SA11 1NJ', area: 3600, floors: 3, occupiedFloors: 2, occupants: 95, isLandlord: true, alarmType: 'Addressable analogue', alarmCategory: 'L3', responsiblePartyName: 'Centre Manager' },
    scheduledInDays: 3,
  },
];

// --- Housing blocks for the BS 9792 assessments ------------------------------
// Each tester also gets a SECOND job on a residential block, assessed under the
// BS 9792 Housing FRA template (aligned by index to TESTERS). BS 9792 covers
// blocks of flats, HMOs and specialised/sheltered housing - so these are all
// residential premises, distinct from the PAS 79 buildings above.
interface HousingBlock {
  name: string;
  address: string;
  premisesType: string; // BS 9792 "type of premises"
  area: number;
  floors: number;
  flats: number;
  occupants: number;
  alarmCategory: AlarmCategory;
  responsiblePartyName: string;
}

const HOUSING_BLOCKS: HousingBlock[] = [
  { name: 'Glan Terrace Flats', address: 'Glan Road, Rhymney, NP22 5DT', premisesType: 'Purpose-built block of flats (General Needs)', area: 2400, floors: 4, flats: 16, occupants: 40, alarmCategory: 'L3', responsiblePartyName: 'Housing Association Compliance Lead' },
  { name: 'Brackla House', address: 'Brackla Way, Bridgend, CF31 2AG', premisesType: 'Sheltered housing', area: 3100, floors: 3, flats: 24, occupants: 30, alarmCategory: 'L1', responsiblePartyName: 'Scheme Manager' },
  { name: 'Taff Court', address: 'Mill Street, Pontypridd, CF37 2SW', premisesType: 'Converted house to flats (HMO)', area: 900, floors: 3, flats: 6, occupants: 12, alarmCategory: 'L2', responsiblePartyName: 'Managing Landlord' },
  { name: 'Dock View Apartments', address: 'Dock Street, Newport, NP20 2DG', premisesType: 'Purpose-built block of flats (General Needs)', area: 5200, floors: 8, flats: 48, occupants: 110, alarmCategory: 'L3', responsiblePartyName: 'Managing Agent' },
  { name: 'Stepney Lodge', address: 'Stepney Road, Llanelli, SA15 3YB', premisesType: 'Extra care housing', area: 3800, floors: 4, flats: 32, occupants: 40, alarmCategory: 'L1', responsiblePartyName: 'Registered Care Manager' },
  { name: 'Kingsway Heights', address: 'Kingsway, Swansea, SA1 5JQ', premisesType: 'Purpose-built block of flats (General Needs)', area: 6400, floors: 11, flats: 66, occupants: 150, alarmCategory: 'L2', responsiblePartyName: 'Block Managing Agent' },
  { name: 'Georgetown Mews', address: 'Georgetown Road, Merthyr Tydfil, CF48 1AA', premisesType: 'Houses in multiple occupation', area: 1100, floors: 3, flats: 8, occupants: 16, alarmCategory: 'L2', responsiblePartyName: 'Landlord' },
  { name: 'Bute Court', address: 'Bute Street, Cardiff, CF10 5LE', premisesType: 'Purpose-built block of flats (General Needs)', area: 7800, floors: 12, flats: 72, occupants: 170, alarmCategory: 'L2', responsiblePartyName: 'Managing Agent' },
  { name: 'Cynon View', address: 'Cardiff Road, Aberdare, CF44 7DG', premisesType: 'Supported housing / assisted living', area: 2600, floors: 3, flats: 20, occupants: 26, alarmCategory: 'L1', responsiblePartyName: 'Support Services Manager' },
  { name: 'Esplanade Court', address: 'The Parade, Barry, CF62 5TR', premisesType: 'Sheltered housing', area: 3300, floors: 4, flats: 28, occupants: 34, alarmCategory: 'L1', responsiblePartyName: 'Scheme Manager' },
  { name: 'Castle Court Flats', address: 'Castle Street, Caerphilly, CF83 1NY', premisesType: 'Purpose-built block of flats (General Needs)', area: 4100, floors: 6, flats: 36, occupants: 80, alarmCategory: 'L3', responsiblePartyName: 'Housing Officer' },
  { name: 'Chester View', address: 'Chester Road, Wrexham, LL11 2SA', premisesType: 'Converted house to flats', area: 1000, floors: 3, flats: 7, occupants: 14, alarmCategory: 'L2', responsiblePartyName: 'Managing Landlord' },
  { name: 'Milland House', address: 'Milland Road, Neath, SA11 1NL', premisesType: 'Supported housing / assisted living', area: 2900, floors: 4, flats: 22, occupants: 28, alarmCategory: 'L1', responsiblePartyName: 'Support Services Manager' },
];

// --- App init (mirrors the main seed's real-project path) --------------------
function initAdmin(): void {
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    'safentia-tech';
  const databaseURL =
    process.env.FIREBASE_DATABASE_URL ||
    `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`;
  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`;
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL,
    storageBucket,
  });
}

// --- Hard safety guard (identical intent to the main seed) -------------------
function assertTest(path: string): string {
  if (!path.startsWith(TEST_ROOT)) {
    throw new Error(
      `SAFETY GUARD: refusing to write to a non-test path: "${path}". ` +
        'This provisioning script may only ever write under /test.',
    );
  }
  return path;
}

async function setDb(path: string, value: unknown): Promise<void> {
  await admin.database().ref(assertTest(path)).set(value);
}

/** Create (or reuse-by-email) a real assessor Auth account, returning its uid. */
async function ensureUser(
  seedUid: string,
  email: string,
  name: string,
): Promise<string> {
  const auth = admin.auth();
  // Never create a duplicate: if the email already has an account, reuse it.
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, {
      email,
      emailVerified: true,
      password: PASSWORD,
      displayName: name,
    });
    return existing.uid;
  } catch {
    // Fall through to create.
  }
  try {
    await auth.createUser({
      uid: seedUid,
      email,
      emailVerified: true,
      password: PASSWORD,
      displayName: name,
    });
    return seedUid;
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/uid-already-exists') {
      await auth.updateUser(seedUid, {
        email,
        emailVerified: true,
        password: PASSWORD,
        displayName: name,
      });
      return seedUid;
    }
    throw err;
  }
}

async function run(): Promise<void> {
  initAdmin();
  const p = forEnv(ENV);
  assertTest(p.db.organisation(ORG_ID)); // path-builder sanity

  console.log(
    `Provisioning ${TESTERS.length} Firerite test assessors under /test (org ${ORG_ID})...`,
  );

  // 1. Shared customer + its primary contact + site the test buildings live
  //    under. The site names the contact by id (the contacts model); person
  //    details live only on the contact record.
  const customer: Customer = {
    name: 'Firerite Test Portfolio',
    email: 'assessments@firerite.co.uk',
    phone: '+44 1656 000000',
    status: 'active',
  };
  await setDb(p.db.customer(ORG_ID, CUSTOMER_ID), customer);

  const contact: CustomerContact = {
    name: 'Firerite Operations',
    email: 'assessments@firerite.co.uk',
    phone: '+44 1656 000000',
    jobTitle: 'Operations Team',
    portalRoles: { admin: true },
    isPrimary: true,
    createdAt: Date.now(),
  };
  await setDb(p.db.customerContact(ORG_ID, CUSTOMER_ID, CONTACT_ID), contact);

  const site: Site = {
    name: 'Firerite Test Sites',
    address: 'Firerite House, Bridgend, CF31 3TP',
    contactId: CONTACT_ID,
  };
  await setDb(p.db.site(ORG_ID, CUSTOMER_ID, SITE_ID), site);

  // 1b. Publish the BS 9792 Housing base template into the org. (The PAS 79 base
  // template is already published in this org.) An org arrives with BOTH base
  // templates available; jobs pin the exact template + version they use.
  await setDb(p.db.template(ORG_ID, BS9792_TEMPLATE_ID), BS9792_TEMPLATE);

  // 2. One tester at a time: account -> claims -> membership -> TWO buildings +
  //    TWO scheduled jobs (a PAS 79 assessment and a BS 9792 housing assessment).
  for (let i = 0; i < TESTERS.length; i++) {
    const t = TESTERS[i];
    const h = HOUSING_BLOCKS[i];
    const uid = await ensureUser(`test-assessor-${t.slug}`, t.email, t.name);

    // Custom claims so login routes to /test with the assessor role. In prod the
    // onMembershipChange trigger maintains these; we set them directly so the
    // account works the instant it is created (identical values).
    await admin.auth().setCustomUserClaims(uid, {
      orgId: ORG_ID,
      roles: { assessor: true },
      testMode: true,
    });

    const member: OrgMember = {
      roles: { assessor: true },
      testMode: true,
      name: t.name,
      email: t.email,
      status: 'active',
    };
    await setDb(p.db.orgMember(ORG_ID, uid), member);
    await setDb(p.db.userOrg(uid, ORG_ID), true);

    const buildingId = `bld-fr-${t.slug}`;
    const building: Building = {
      name: t.building.name,
      customerId: CUSTOMER_ID,
      address: t.building.address,
      details: {
        area: t.building.area,
        floors: t.building.floors,
        occupiedFloors: t.building.occupiedFloors,
        occupants: t.building.occupants,
        isLandlord: t.building.isLandlord,
        alarmType: t.building.alarmType,
        alarmCategory: t.building.alarmCategory,
      },
      responsibleParty: { name: t.building.responsiblePartyName },
      article53Persons: ['Firerite Test Portfolio'],
      photoUrl: '',
      // Never assessed yet - the pending state, ready for a fresh assessment.
      riskLevel: 'pending',
      serviceSchedule: {
        fireAlarmService: { nextDue: days(60) },
        fireDrill: { nextDue: days(90) },
        extinguisherMaintenance: { nextDue: days(30) },
        fraReview: { nextDue: days(340) },
      },
    };
    await setDb(p.db.building(ORG_ID, SITE_ID, buildingId), building);

    const jobId = `job-fr-${t.slug}`;
    const job: Job = {
      templateId: PAS79_TEMPLATE_ID,
      templateVersion: PAS79_TEMPLATE_VERSION,
      customerId: CUSTOMER_ID,
      siteId: SITE_ID,
      buildingId,
      assessorUid: uid,
      scheduledFor: days(t.scheduledInDays),
      status: 'scheduled',
    };
    await setDb(p.db.job(ORG_ID, jobId), job);
    await setDb(p.db.assessorJob(ORG_ID, uid, jobId), 'scheduled');

    // --- Second building + BS 9792 Housing job ---
    const housingId = `bld-frh-${t.slug}`;
    const housing: Building = {
      name: h.name,
      customerId: CUSTOMER_ID,
      address: `${h.address} - ${h.premisesType}`,
      details: {
        area: h.area,
        floors: h.floors,
        occupiedFloors: h.floors,
        occupants: h.occupants,
        isLandlord: true,
        alarmType: 'Addressable analogue',
        alarmCategory: h.alarmCategory,
      },
      responsibleParty: { name: h.responsiblePartyName },
      article53Persons: ['Firerite Test Portfolio'],
      photoUrl: '',
      riskLevel: 'pending',
      serviceSchedule: {
        fireAlarmService: { nextDue: days(60) },
        fireDrill: { nextDue: days(90) },
        extinguisherMaintenance: { nextDue: days(30) },
        fraReview: { nextDue: days(340) },
      },
    };
    await setDb(p.db.building(ORG_ID, SITE_ID, housingId), housing);

    const housingJobId = `job-frh-${t.slug}`;
    const housingJob: Job = {
      templateId: BS9792_TEMPLATE_ID,
      templateVersion: BS9792_TEMPLATE_VERSION,
      customerId: CUSTOMER_ID,
      siteId: SITE_ID,
      buildingId: housingId,
      assessorUid: uid,
      scheduledFor: days(t.scheduledInDays + 1),
      status: 'scheduled',
    };
    await setDb(p.db.job(ORG_ID, housingJobId), housingJob);
    await setDb(p.db.assessorJob(ORG_ID, uid, housingJobId), 'scheduled');

    console.log(
      `  ✓ ${t.name.padEnd(16)} ${t.email.padEnd(30)} -> PAS79: ${t.building.name} | BS9792: ${h.name}`,
    );
  }

  console.log('\n========================================================');
  console.log(' Test-assessor provisioning complete (all under /test)');
  console.log('========================================================');
  console.log(` Organisation : ${ORG_ID} (Firerite Fire Safety)`);
  console.log(` Accounts     : ${TESTERS.length} assessors`);
  console.log(` Password     : ${PASSWORD}  (shared)`);
  console.log(` Templates    : PAS 79 (default) + BS 9792 (housing)`);
  console.log(` Each has     : 2 scheduled jobs (1 PAS 79 + 1 BS 9792) to complete`);
  console.log('========================================================\n');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('TEST-ASSESSOR PROVISIONING FAILED:', err);
    process.exit(1);
  });
