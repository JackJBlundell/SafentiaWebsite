// ============================================================================
// Per-person ROLE SPACES - a private organisation per role, per tester.
//
// Everyone on the trial gets their own set of spaces named for the role they
// hold in each one: "Admin Space", "Assessor Space", "Auditor Space" and a
// "Customer Space" portal. They switch between them with the picker that
// already exists (setActiveOrganisation), so this script writes DATA only -
// there is no new switching mechanism, and nothing here is app or console code.
//
// PRIVATE, not shared. Each space is an organisation only ONE person belongs
// to, so a tester can create, edit, release and sign off freely without another
// tester's screen changing underneath them. That is the whole point: the shared
// demo world (org-firerite-demo) cannot show what an admin's estate looks like
// while thirteen people are editing it.
//
// A ROLE, not a permission flag. Each space differs in what its data is POSED
// at, because that is what makes a role legible:
//   Admin    - a populated estate: two customers, five buildings, work assigned
//              across two assessors, released reports, an open action plan.
//   Assessor - jobs assigned to THEM, spanning scheduled / in progress /
//              submitted, plus one released building so history is not empty.
//   Auditor  - assessments queued for validation, one already sent back for
//              information, one released - the auditor's actual working set.
//   Customer - the portal half: a released report to accept and an action plan
//              with work outstanding.
//
// The counterparts (the assessors whose work an admin oversees, the assessor
// whose submission an auditor validates) are member records with no Auth
// account. They exist to be named and attributed, never to sign in, so the only
// real credentials this script creates are the testers' own.
//
// SUPPRESSED RELEASE SIDE EFFECTS. A released assessment normally fires
// onAssessmentStageChange, which emails every customer contact. Provisioning
// fourteen people at once would post a few hundred of those to real mailboxes,
// so the once-only marker is written FIRST and the report is generated here, by
// the same shared core the callable uses. The stored PDF is genuinely rendered
// from the seeded assessment - not a placeholder - so "download report" works
// in the customer space on the first click.
//
// Everything lands under the ISOLATED /test root (brief 4.8): these are
// testMode accounts and can never read or write live data.
//
// IDEMPOTENT: every id derives from the person's email slug and the space kind,
// and every write is a set()/update() at a fixed path. Re-running restores the
// same world rather than adding a second copy of it.
//
// Run against live `safentia-tech`:
//   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.safentia-tech.json \
//   FIREBASE_PROJECT_ID=safentia-tech \
//   npx ts-node src/seed/roleSpaces.ts
//
// Limit to one person while checking a change:
//   ... npx ts-node src/seed/roleSpaces.ts --only=jackjblundell@gmail.com
// ============================================================================

import * as admin from 'firebase-admin';

import { forEnv, portalSpaceKey, type EnvPaths } from '../shared/paths';
import type {
  Action,
  Assessment,
  AssessmentAnswer,
  Building,
  Customer,
  CustomerContact,
  CustomerMember,
  Environment,
  FloorPlan,
  Job,
  LogBookEntry,
  OrgMember,
  OrgRole,
  Organisation,
  RagDistribution,
  Severity,
  Site,
  Template,
} from '../shared/types';
import { DUE_WINDOW_DAYS } from '../shared/types';
import { PAS79_TEMPLATE } from './data/pas79Template';
import { PAS79_TEMPLATE_ID, PAS79_TEMPLATE_VERSION } from './ids';
import { solidTile, floorPlan as floorPlanPng } from './png';

// --- Fixed context -----------------------------------------------------------
const ENV: Environment = 'test';
const TEST_ROOT = 'test/';
/** The ONE non-/test path this script may touch: the server-internal marker that
 *  suppresses release side effects. It is env-scoped to `test` in its own path,
 *  so allowing it does not widen the blast radius beyond the test world. */
const OPS_ROOT = `ops/releaseSideEffects/${ENV}/`;
const PASSWORD = 'Firerite-Test-2026!'; // as used by the existing test accounts

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const days = (n: number): number => NOW + n * DAY;

/** Per-run download token for the shared media, so a URL is never guessable. */
const MEDIA_TOKEN = `rolespaces-${Math.random().toString(36).slice(2, 14)}`;

// --- The people --------------------------------------------------------------
// Everyone who needs their own spaces: the Firerite field testers and the
// project owner. Emails are the identity - the slug behind every id is derived
// from the local part, so adding a person here is the whole change needed to
// provision them.
interface Person {
  name: string;
  email: string;
}

const PEOPLE: Person[] = [
  { name: 'Jack Blundell', email: 'jackjblundell@gmail.com' },
  { name: 'Gareth Selway', email: 'gareth@firerite.co.uk' },
  { name: 'Gareth Evans', email: 'gevans@firerite.co.uk' },
  { name: 'Owen Jayne', email: 'OwenJayne@firerite.co.uk' },
  { name: 'Tony Ryder', email: 'Tony.ryder@firerite.co.uk' },
  { name: 'Geraint Parry', email: 'Geraint@firerite.co.uk' },
  { name: 'Carl Evans', email: 'Carl@firerite.co.uk' },
  { name: 'John Keenan', email: 'John.Keenan@firerite.co.uk' },
  { name: 'Nick Suller', email: 'nick.suller@firerite.co.uk' },
  { name: 'Phill Pinches', email: 'phill@firerite.co.uk' },
  { name: 'Craig Evans', email: 'Craig.Evans@firerite.co.uk' },
  { name: 'Neil Griffiths', email: 'Neil.Griffiths@firerite.co.uk' },
  { name: 'James Murray', email: 'James.Murray@firerite.co.uk' },
  { name: 'Mal Simons', email: 'mal@firerite.co.uk' },
];

/** A stable, path-safe key for a person. Derived from the email's local part so
 *  it survives a display-name change and can never collide between two people
 *  who happen to share a name (there are two Gareths and two Evanses here). */
function slugFor(email: string): string {
  return email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- The spaces --------------------------------------------------------------
type SpaceKind = 'admin' | 'assessor' | 'auditor' | 'customer';

interface SpaceConfig {
  kind: SpaceKind;
  /** Shown in the switcher. For the portal space this is the CUSTOMER's name,
   *  because that is what the picker labels a portal space with. */
  label: string;
  /** The org's own name. For staff spaces it IS the label (the switcher reads
   *  the org profile); the portal space's org is the assessing firm behind it. */
  orgName: string;
  /** Distinct brand fill so the spaces are told apart by colour at a glance.
   *  All kept clear of the RAG palette, which brand tokens must never mimic. */
  brand: { primary: string; secondary: string };
  /** The staff role the person holds. Absent for the portal space, where they
   *  are a customer contact rather than staff. */
  role?: OrgRole;
}

const SPACES: SpaceConfig[] = [
  {
    kind: 'admin',
    label: 'Admin Space',
    orgName: 'Admin Space',
    brand: { primary: '#1F4E79', secondary: '#8C6D1F' },
    role: 'admin',
  },
  {
    kind: 'assessor',
    label: 'Assessor Space',
    orgName: 'Assessor Space',
    brand: { primary: '#2C6E63', secondary: '#7A4E8C' },
    role: 'assessor',
  },
  {
    kind: 'auditor',
    label: 'Auditor Space',
    orgName: 'Auditor Space',
    brand: { primary: '#5B3A8C', secondary: '#1F6E8C' },
    role: 'auditor',
  },
  {
    kind: 'customer',
    label: 'Customer Space',
    // The portal space's own organisation is the firm that assessed the
    // buildings - shown as context beside the customer name in the picker.
    orgName: 'Safentia Demo Assessors',
    brand: { primary: '#8C3A2C', secondary: '#1F6E4E' },
  },
];

// --- Deterministic ids -------------------------------------------------------
// Everything a space owns is keyed off (slug, kind), so two spaces never share a
// node and a re-run overwrites exactly what it wrote last time.
const orgIdFor = (slug: string, kind: SpaceKind): string =>
  `org-space-${slug}-${kind}`;
const idIn = (slug: string, kind: SpaceKind, what: string): string =>
  `${what}-${slug}-${kind}`;

/**
 * The counterpart staff: the assessors an admin oversees, the reviewer whose
 * validation released a report.
 *
 * THREE uids for the whole world, not three per space. They are fictional
 * colleagues at a demo firm, so one Rhys Morgan appearing in everyone's spaces
 * is honest - and the alternative is 168 uids with no Auth account behind them,
 * every one of which makes onMembershipChange fail to mint claims for a user
 * that does not exist, then retry. Real (if unusable) accounts back these three
 * instead, so the membership trigger succeeds wherever they are named.
 */
const COUNTERPARTS: Array<{
  uid: string;
  name: string;
  email: string;
  role: OrgRole;
}> = [
  {
    uid: 'spacestaff-rhys-morgan',
    name: 'Rhys Morgan',
    email: 'rhys.morgan@firerite-demo.test',
    role: 'assessor',
  },
  {
    uid: 'spacestaff-anna-lewis',
    name: 'Anna Lewis',
    email: 'anna.lewis@firerite-demo.test',
    role: 'assessor',
  },
  {
    uid: 'spacestaff-sian-roberts',
    name: 'Sian Roberts',
    email: 'sian.roberts@firerite-demo.test',
    role: 'auditor',
  },
];
const [FIELD_ASSESSOR, SECOND_ASSESSOR, REVIEWER] = COUNTERPARTS;

// --- App init ----------------------------------------------------------------
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

// --- Hard safety guard -------------------------------------------------------
function assertWritable(path: string): string {
  if (!path.startsWith(TEST_ROOT) && !path.startsWith(OPS_ROOT)) {
    throw new Error(
      `SAFETY GUARD: refusing to write to "${path}". This script may only ever ` +
        `write under /${TEST_ROOT} or /${OPS_ROOT}.`,
    );
  }
  return path;
}

/**
 * Apply a batch of absolute-path writes as ONE multi-location update.
 *
 * The alternative - a set() per node - is thousands of sequential round trips
 * for fourteen people, which is both slow and non-atomic halfway through.
 * Batched in chunks because a single update carrying every assessment snapshot
 * at once is a payload the API will refuse.
 */
async function applyWrites(writes: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(writes);
  for (const [path] of entries) {
    assertWritable(path);
  }
  const CHUNK = 200;
  for (let i = 0; i < entries.length; i += CHUNK) {
    await admin
      .database()
      .ref()
      .update(Object.fromEntries(entries.slice(i, i + CHUNK)));
  }
}

// --- Shared media ------------------------------------------------------------
// Uploaded ONCE per run and referenced by every space. These are Firebase
// download URLs carrying a token, so the object is reachable regardless of which
// org the viewer's claims name - which is what lets one upload serve all
// fifty-six organisations instead of re-uploading the same tile per org.
interface SharedMedia {
  /** Space-kind -> org logo tile in that space's brand colour. */
  logos: Record<SpaceKind, string>;
  buildingPhoto: string;
  planImage: string;
}

async function uploadPng(key: string, bytes: Buffer): Promise<string> {
  assertWritable(key);
  if (process.env.SKIP_STORAGE === 'true') {
    return '';
  }
  const bucket = admin.storage().bucket();
  const file = bucket.file(key);
  await file.save(bytes, {
    contentType: 'image/png',
    resumable: false,
    metadata: { metadata: { firebaseStorageDownloadTokens: MEDIA_TOKEN } },
  });
  return (
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(key)}?alt=media&token=${MEDIA_TOKEN}`
  );
}

async function uploadSharedMedia(): Promise<SharedMedia> {
  const base = `${TEST_ROOT}roleSpaces/media`;
  const logos = {} as Record<SpaceKind, string>;
  for (const space of SPACES) {
    logos[space.kind] = await uploadPng(
      `${base}/logo-${space.kind}.png`,
      // The secondary as an accent band, so the four marks differ by more than
      // a single fill and are told apart at badge size in the switcher.
      solidTile(512, 512, space.brand.primary, space.brand.secondary),
    );
  }
  return {
    logos,
    buildingPhoto: await uploadPng(
      `${base}/building.png`,
      solidTile(1024, 768, '#6C7A89'),
    ),
    planImage: await uploadPng(`${base}/plan.png`, floorPlanPng(1400, 990)),
  };
}

// --- Auth --------------------------------------------------------------------
/** Create or reuse the person's real account. Reuse-by-email first: several of
 *  these already exist from the field-test provisioning and must keep their uid,
 *  or their existing jobs and assessments would be orphaned. */
async function ensureUser(person: Person, slug: string): Promise<string> {
  const auth = admin.auth();
  try {
    const existing = await auth.getUserByEmail(person.email);
    await auth.updateUser(existing.uid, {
      emailVerified: true,
      displayName: person.name,
    });
    return existing.uid;
  } catch {
    // No account yet - create one with a deterministic uid.
  }
  const uid = `spaceuser-${slug}`;
  try {
    await auth.createUser({
      uid,
      email: person.email,
      emailVerified: true,
      password: PASSWORD,
      displayName: person.name,
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/uid-already-exists') {
      throw err;
    }
    await auth.updateUser(uid, {
      email: person.email,
      emailVerified: true,
      displayName: person.name,
    });
  }
  return uid;
}

/**
 * Back the three counterparts with real Auth accounts.
 *
 * NO PASSWORD is set, so nobody can sign in as them - they exist purely so
 * onMembershipChange has a user to mint claims for when their membership is
 * written into each of the fifty-six organisations. Without them every one of
 * those writes ends in a failed trigger and a retry.
 */
async function ensureCounterpartAccounts(): Promise<void> {
  const auth = admin.auth();
  for (const c of COUNTERPARTS) {
    try {
      await auth.getUser(c.uid);
      continue;
    } catch {
      // Not created yet.
    }
    try {
      await auth.createUser({
        uid: c.uid,
        email: c.email,
        emailVerified: false,
        displayName: c.name,
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'auth/email-already-exists') {
        throw err;
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Space content
// ----------------------------------------------------------------------------

/** A deep clone per assessment: a snapshot is the questions AS THEY WERE, so
 *  sharing one object across assessments would let a later edit rewrite an
 *  earlier assessment's history. */
function templateSnapshot(): Template {
  return JSON.parse(JSON.stringify(PAS79_TEMPLATE)) as Template;
}

function answer(partial: AssessmentAnswer): AssessmentAnswer {
  return { updatedAt: NOW, ...partial };
}

function nonConformity(
  severity: Severity,
  observation: string,
): AssessmentAnswer {
  return answer({ value: false, severity, observation });
}

/**
 * A representative answer set against the published PAS 79 template.
 *
 * Deliberately spans every answer TYPE the app renders - free text, numeric,
 * boolean, single select, multi select, and non-conformities at each severity -
 * because a space whose answers are all one shape proves nothing about the
 * screens that render them. `findings` decides how many non-conformities the
 * building carries, which is what makes one building read green and another red.
 */
function answersFor(findings: 'clean' | 'some' | 'many'): Record<
  string,
  AssessmentAnswer
> {
  const base: Record<string, AssessmentAnswer> = {
    'q-01-occupant-profile': answer({
      text: 'Office occupancy across the upper floors with ground-floor reception. Cleaning and maintenance contractors attend outside core hours. No sleeping accommodation.',
    }),
    'q-01-peak-occupancy': answer({ text: '180', value: '180' }),
    'q-01-vulnerable-persons': answer({
      value: ['Persons with mobility impairment'],
    }),
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
    'q-11-escape-signage': answer({ value: true }),
  };
  if (findings === 'clean') {
    return base;
  }
  base['q-11-escape-signage'] = nonConformity(
    'L',
    'Directional escape signage missing at the basement stair head. Occupants unfamiliar with the route could be misdirected.',
  );
  base['q-08-monthly-test'] = nonConformity(
    'M',
    'Emergency lighting monthly function test has not been recorded since the change of managing agent.',
  );
  if (findings === 'many') {
    base['q-05-escape-routes-adequate'] = nonConformity(
      'H',
      'Protected stair on the top floor is being used to store furniture and cardboard, obstructing the escape route and adding fire loading.',
    );
    base['q-06-extinguisher-service'] = nonConformity(
      'M',
      'Two extinguishers on the second floor are outside their annual service date.',
    );
  }
  return base;
}

/** The distribution is TRUE counts of findings by severity, and the risk meter
 *  renders straight off it - so these are counted from the answer set above
 *  rather than chosen. Change one and you must change the other. */
function ragFor(findings: 'clean' | 'some' | 'many'): RagDistribution {
  if (findings === 'clean') {
    return { low: 0, medium: 0, high: 0 };
  }
  if (findings === 'some') {
    // q-11 signage (L) + q-08 emergency lighting (M).
    return { low: 1, medium: 1, high: 0 };
  }
  // ...plus q-05 obstructed stair (H) + q-06 extinguisher service (M).
  return { low: 1, medium: 2, high: 1 };
}

/** Headline risk implied by those counts: a High finding makes a building high
 *  risk, any finding at all makes it medium, none makes it low. */
function riskFor(findings: 'clean' | 'some' | 'many'): 'low' | 'medium' | 'high' {
  return findings === 'many' ? 'high' : findings === 'clean' ? 'low' : 'medium';
}

interface BuildingBlueprint {
  key: string;
  name: string;
  address: string;
  area: number;
  floors: number;
  occupants: number;
  alarmCategory: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'M' | 'P1' | 'P2';
  findings: 'clean' | 'some' | 'many';
}

/** The estate every space is cut from. Spaces take the first N, so an assessor's
 *  space is a slice of the same world an admin sees the whole of. */
const ESTATE: BuildingBlueprint[] = [
  {
    key: 'tower',
    name: 'Cardiff Gate Tower',
    address: 'Malthouse Avenue, Cardiff, CF23 8RS',
    area: 5400,
    floors: 9,
    occupants: 260,
    alarmCategory: 'L2',
    findings: 'many',
  },
  {
    key: 'lodge',
    name: 'Riverside Care Lodge',
    address: 'Taff Embankment, Cardiff, CF11 8AL',
    area: 2400,
    floors: 3,
    occupants: 62,
    alarmCategory: 'L1',
    findings: 'some',
  },
  {
    key: 'retail',
    name: 'Quayside Retail Unit',
    address: 'Ocean Way, Cardiff, CF24 5PJ',
    area: 1800,
    floors: 2,
    occupants: 40,
    alarmCategory: 'M',
    findings: 'clean',
  },
  {
    key: 'depot',
    name: 'Newport Road Depot',
    address: 'Newport Road, Cardiff, CF24 1RZ',
    area: 6200,
    floors: 1,
    occupants: 35,
    alarmCategory: 'P2',
    findings: 'some',
  },
  {
    key: 'chambers',
    name: 'Westgate Chambers',
    address: 'Westgate Street, Cardiff, CF10 1DD',
    area: 3100,
    floors: 4,
    occupants: 120,
    alarmCategory: 'L3',
    findings: 'clean',
  },
];

/** How much of the estate each kind of space carries, and how its work is posed.
 *  This table IS the difference between the four spaces. */
const SHAPE: Record<
  SpaceKind,
  {
    buildings: number;
    /** Two customers for the admin space so the customer list is worth opening. */
    customers: 1 | 2;
    /** Assessment status per building index, in estate order. */
    stages: Array<Assessment['status'] | 'none'>;
  }
> = {
  admin: {
    buildings: 5,
    customers: 2,
    stages: ['released', 'released', 'readyForValidation', 'inProgress', 'none'],
  },
  assessor: {
    buildings: 4,
    customers: 1,
    stages: ['released', 'inProgress', 'none', 'none'],
  },
  auditor: {
    buildings: 4,
    customers: 1,
    stages: [
      'readyForValidation',
      'readyForValidation',
      'infoRequired',
      'released',
    ],
  },
  customer: {
    buildings: 3,
    customers: 1,
    stages: ['released', 'released', 'none'],
  },
};

interface SpaceBuild {
  orgId: string;
  writes: Record<string, unknown>;
  /** Assessments whose report this run must render, in (orgId, id) form. */
  released: Array<{ orgId: string; assessmentId: string; actorUid: string }>;
  /** Present only for the portal space: what the person is a member of. */
  portal?: { orgId: string; customerId: string };
}

/**
 * Build one complete space as a flat set of absolute-path writes.
 *
 * Returned rather than written so the caller controls batching and ordering -
 * in particular, the release-suppression markers must land before the assessment
 * statuses that would otherwise trigger the email fan-out.
 */
function buildSpace(
  person: Person,
  slug: string,
  uid: string,
  config: SpaceConfig,
  media: SharedMedia,
  p: EnvPaths,
): SpaceBuild {
  const { kind } = config;
  const orgId = orgIdFor(slug, kind);
  const shape = SHAPE[kind];
  const writes: Record<string, unknown> = {};
  const released: SpaceBuild['released'] = [];

  const fieldAssessorUid = FIELD_ASSESSOR.uid;
  const secondAssessorUid = SECOND_ASSESSOR.uid;
  const reviewerUid = REVIEWER.uid;

  // --- Organisation -----------------------------------------------------------
  const organisation: Organisation = {
    profile: {
      name: config.orgName,
      logoUrl: media.logos[kind],
      brand: { ...config.brand },
      fontFamily: 'Inter',
      contact: {
        name: `${config.orgName} Operations`,
        email: 'assessments@firerite.co.uk',
        phone: '+44 1656 000000',
        address: 'Bridgend, CF31 3TP',
      },
    },
    usage: {
      staffCount: COUNTERPARTS.length + (config.role ? 1 : 0),
      customerCount: shape.customers,
      notificationsThisMonth: 0,
    },
  };
  writes[p.db.organisation(orgId)] = organisation;

  // --- Members ----------------------------------------------------------------
  for (const c of COUNTERPARTS) {
    const member: OrgMember = {
      roles: { [c.role]: true },
      testMode: true,
      name: c.name,
      email: c.email,
      status: 'active',
    };
    writes[p.db.orgMember(orgId, c.uid)] = member;
  }
  if (config.role) {
    const member: OrgMember = {
      roles: { [config.role]: true },
      testMode: true,
      name: person.name,
      email: person.email,
      status: 'active',
    };
    writes[p.db.orgMember(orgId, uid)] = member;
    // The staff reverse index - this is what puts the space in their switcher.
    writes[p.db.userOrg(uid, orgId)] = true;
  }

  // --- Template ---------------------------------------------------------------
  // Its own copy per org: templates are tenant data, and a job pins
  // { templateId, version } within its own organisation.
  writes[p.db.template(orgId, PAS79_TEMPLATE_ID)] = PAS79_TEMPLATE;

  // --- Customers, contacts, sites --------------------------------------------
  // The portal space's customer carries the space's LABEL, because the picker
  // names a portal space after the customer rather than the organisation.
  const primaryCustomerId = idIn(slug, kind, 'cust-primary');
  const secondCustomerId = idIn(slug, kind, 'cust-second');
  const primaryCustomerName =
    kind === 'customer' ? config.label : 'Meridian Housing Group';

  const dutyHolderId = idIn(slug, kind, 'contact-duty');
  const deputyId = idIn(slug, kind, 'contact-deputy');

  const primaryCustomer: Customer = {
    name: primaryCustomerName,
    address: 'Cathedral Road, Cardiff, CF11 9LJ',
    email: 'facilities@meridian-housing.test',
    phone: '+44 29 2000 0100',
    score: 72,
    status: 'active',
  };
  writes[p.db.customer(orgId, primaryCustomerId)] = primaryCustomer;

  // The duty holder is the person's OWN address in the portal space, so the
  // notifications a customer would receive actually arrive somewhere they can
  // read them. In the staff spaces it stays a fictional mailbox: an admin
  // releasing a report should not post mail to themselves as the customer.
  const dutyHolder: CustomerContact = {
    name: kind === 'customer' ? person.name : 'Helen Carter',
    jobTitle: 'Facilities Director',
    email: kind === 'customer' ? person.email : 'helen.carter@meridian-housing.test',
    phone: '+44 29 2000 0101',
    isPrimary: true,
    receivesReports: true,
    portalRoles: { admin: true },
    createdAt: days(-120),
  };
  writes[p.db.customerContact(orgId, primaryCustomerId, dutyHolderId)] =
    dutyHolder;

  const deputy: CustomerContact = {
    name: 'Marcus Webb',
    jobTitle: 'Building Manager',
    email: 'marcus.webb@meridian-housing.test',
    phone: '+44 29 2000 0102',
    receivesReports: false,
    createdAt: days(-100),
  };
  writes[p.db.customerContact(orgId, primaryCustomerId, deputyId)] = deputy;

  if (shape.customers === 2) {
    const second: Customer = {
      name: 'Northgate Care Trust',
      address: 'Cowbridge Road, Cardiff, CF5 1JJ',
      email: 'estates@northgate-care.test',
      phone: '+44 29 2000 0200',
      score: 58,
      status: 'active',
    };
    writes[p.db.customer(orgId, secondCustomerId)] = second;
    const secondContact: CustomerContact = {
      name: 'Raymond Ellis',
      jobTitle: 'Registered Manager',
      email: 'raymond.ellis@northgate-care.test',
      phone: '+44 29 2000 0201',
      isPrimary: true,
      receivesReports: true,
      createdAt: days(-80),
    };
    writes[
      p.db.customerContact(orgId, secondCustomerId, idIn(slug, kind, 'contact-second'))
    ] = secondContact;
  }

  const primarySiteId = idIn(slug, kind, 'site-primary');
  const secondSiteId = idIn(slug, kind, 'site-second');
  const primarySite: Site = {
    name: 'Cardiff Central Portfolio',
    address: 'Cathedral Road, Cardiff, CF11 9LJ',
    geo: { lat: 51.4816, lng: -3.1791 },
    contactId: dutyHolderId,
  };
  writes[p.db.site(orgId, primaryCustomerId, primarySiteId)] = primarySite;
  if (shape.customers === 2) {
    const second: Site = {
      name: 'Northgate Care Sites',
      address: 'Cowbridge Road, Cardiff, CF5 1JJ',
      geo: { lat: 51.4796, lng: -3.2043 },
      contactId: idIn(slug, kind, 'contact-second'),
    };
    writes[p.db.site(orgId, secondCustomerId, secondSiteId)] = second;
  }

  // --- Buildings, plans, jobs, assessments, actions ---------------------------
  const blueprints = ESTATE.slice(0, shape.buildings);

  blueprints.forEach((bp, index) => {
    // The last building of a two-customer space belongs to the second customer,
    // so an admin's estate genuinely spans more than one client.
    const useSecond = shape.customers === 2 && index === blueprints.length - 1;
    const customerId = useSecond ? secondCustomerId : primaryCustomerId;
    const siteId = useSecond ? secondSiteId : primarySiteId;
    const contactId = useSecond
      ? idIn(slug, kind, 'contact-second')
      : dutyHolderId;
    const contactName = useSecond ? 'Raymond Ellis' : dutyHolder.name;

    const buildingId = idIn(slug, kind, `bld-${bp.key}`);
    const stage = shape.stages[index] ?? 'none';
    const assessed = stage !== 'none';
    const rag = ragFor(bp.findings);

    const building: Building = {
      name: bp.name,
      customerId,
      address: bp.address,
      details: {
        area: bp.area,
        floors: bp.floors,
        occupiedFloors: bp.floors,
        occupants: bp.occupants,
        isLandlord: true,
        alarmType: 'Addressable analogue',
        alarmCategory: bp.alarmCategory,
      },
      responsibleParty: {
        name: contactName,
        role: useSecond ? 'Registered Manager' : 'Facilities Director',
        email: useSecond ? 'raymond.ellis@northgate-care.test' : dutyHolder.email,
        phone: '+44 29 2000 0101',
        contactId,
      },
      article53Persons: [primaryCustomerName],
      photoUrl: media.buildingPhoto,
      // A never-assessed building has NO distribution at all - zeroed counts
      // would render as a real, all-green result it has not earned.
      ...(stage === 'released'
        ? { riskLevel: riskFor(bp.findings), ragDistribution: rag }
        : { riskLevel: 'pending' as const }),
      serviceSchedule: {
        fireAlarmService: { nextDue: days(45 + index * 5) },
        fireMarshalTraining: { nextDue: days(120) },
        fireSafetyTraining: { nextDue: days(90) },
        fireDrill: { nextDue: days(70) },
        pat: { nextDue: days(160) },
        extinguisherMaintenance: { nextDue: days(30 + index * 4) },
        // One review deliberately falls due inside the reminder window, so the
        // review-due notification has something real to fire on.
        fraReview: { nextDue: index === 0 ? days(12) : days(280) },
      },
    };
    writes[p.db.building(orgId, siteId, buildingId)] = building;
    writes[p.db.buildingCustomer(orgId, buildingId)] = customerId;

    // A plan on all but the last building, so "no plan yet" is represented too -
    // an assessor needs the empty case as much as the populated one.
    if (index < blueprints.length - 1) {
      const plan: FloorPlan = {
        name: 'Ground floor',
        description: 'General arrangement, ground floor',
        imageUrl: media.planImage,
        // An image plan, not a PDF: only image plans support the flattened
        // flag composite, which is what makes flagging demonstrable here.
        kind: 'image',
        order: 1,
      };
      writes[
        p.db.floorPlan(orgId, buildingId, idIn(slug, kind, `plan-${bp.key}`))
      ] = plan;
    }

    // --- Job. In the assessor space the work is THEIRS; elsewhere it belongs to
    // a counterpart, because an admin's or auditor's screens are about other
    // people's work.
    const assessorUid =
      kind === 'assessor'
        ? uid
        : index % 2 === 0
        ? fieldAssessorUid
        : secondAssessorUid;
    const jobId = idIn(slug, kind, `job-${bp.key}`);
    // The job mirrors its assessment's stage - they are the same piece of work
    // seen from the schedule and from the form, and a job left 'scheduled' under
    // a submitted assessment is what makes a jobs list lie.
    const jobStatus: Job['status'] = assessed
      ? (stage as Job['status'])
      : 'scheduled';
    const job: Job = {
      templateId: PAS79_TEMPLATE_ID,
      templateVersion: PAS79_TEMPLATE_VERSION,
      customerId,
      siteId,
      buildingId,
      assessorUid,
      scheduledFor: assessed ? days(-30 + index * 3) : days(2 + index * 2),
      status: jobStatus,
    };
    writes[p.db.job(orgId, jobId)] = job;
    writes[p.db.assessorJob(orgId, assessorUid, jobId)] = jobStatus;

    if (!assessed) {
      return;
    }

    // --- Assessment. The id scheme is fixed by contract (`job-<jobId>`): the
    // client, the startAssessment callable and the security rules all derive it
    // that way, so a seeded assessment must match or resume would mint a second
    // empty one for the same job.
    const assessmentId = `job-${jobId}`;
    const conductedAt = days(-28 + index * 3);
    const assessment: Assessment = {
      jobId,
      buildingId,
      customerId,
      templateSnapshot: templateSnapshot(),
      conductedBy: assessorUid,
      conductedAt,
      responsibleParty: {
        name: contactName,
        role: useSecond ? 'Registered Manager' : 'Facilities Director',
        email: useSecond ? 'raymond.ellis@northgate-care.test' : dutyHolder.email,
        phone: '+44 29 2000 0101',
        contactId,
      },
      narrative: {
        premisesCovered:
          'All common parts, plant rooms, risers and a representative sample of occupied floors.',
        incidentHistory:
          'No fires recorded in the past twelve months. One false alarm attributed to cooking fumes.',
        riskOpinion:
          bp.findings === 'many'
            ? 'High until the escape-route obstruction and extinguisher servicing are resolved, after which the building would reduce to medium.'
            : 'Medium, with the outstanding items presenting no immediate risk to life.',
      },
      status: stage as Assessment['status'],
    };

    // The workflow block records how far the assessment actually got. Each stage
    // carries only the stamps it has genuinely earned - an assessment awaiting
    // validation has been submitted but not checked, and writing a checkedBy on
    // it would claim work nobody did.
    if (stage === 'readyForValidation' || stage === 'infoRequired') {
      assessment.workflow = { submittedAt: conductedAt + DAY };
    }
    if (stage === 'released') {
      assessment.workflow = {
        submittedAt: conductedAt + DAY,
        checkedBy: reviewerUid,
        validatedBy: reviewerUid,
        acceptedAt: conductedAt + 2 * DAY,
        releasedAt: conductedAt + 3 * DAY,
        releasedBy: reviewerUid,
      };
    }
    writes[p.db.assessment(orgId, assessmentId)] = assessment;

    const answers = answersFor(bp.findings);
    for (const [questionId, value] of Object.entries(answers)) {
      writes[p.db.assessmentAnswer(orgId, assessmentId, questionId)] = value;
    }

    if (stage === 'released') {
      released.push({ orgId, assessmentId, actorUid: reviewerUid });

      // --- Actions from THIS assessment's non-conformities. Every one is linked
      // to a contact by id, never a typed name: the assignment mail and the
      // overdue chase resolve their recipient through the link, so an action
      // carrying only a name is one nobody is ever told about.
      const findings: Array<{
        key: string;
        section: string;
        question: string;
        observation: string;
        severity: Severity;
        life: boolean;
      }> = [];
      if (bp.findings !== 'clean') {
        findings.push({
          key: 'signage',
          section: '11',
          question: 'Is escape route signage adequate and correctly sited?',
          observation:
            'Directional escape signage missing at the basement stair head.',
          severity: 'L',
          life: false,
        });
        findings.push({
          key: 'emlight',
          section: '08',
          question: 'Is emergency lighting tested and recorded monthly?',
          observation:
            'Emergency lighting monthly function test has not been recorded since the change of managing agent.',
          severity: 'M',
          life: false,
        });
      }
      if (bp.findings === 'many') {
        findings.push({
          key: 'stair',
          section: '05',
          question: 'Are escape routes free from obstruction and fire loading?',
          observation:
            'Protected stair on the top floor is being used to store furniture and cardboard.',
          severity: 'H',
          life: true,
        });
        findings.push({
          key: 'exting',
          section: '06',
          question: 'Are extinguishers within their annual service date?',
          observation:
            'Two extinguishers on the second floor are outside their annual service date.',
          severity: 'M',
          life: false,
        });
      }

      findings.forEach((f, fi) => {
        const action: Action = {
          assessmentId,
          sectionCode: f.section,
          question: f.question,
          observation: f.observation,
          severity: f.severity,
          responsible: contactName,
          responsibleContactId: contactId,
          // Anchored to the release, so a High is already close to (or past) its
          // seven-day window - which is what gives the overdue view something to
          // show without hand-set dates.
          dueBy: conductedAt + 3 * DAY + DUE_WINDOW_DAYS[f.severity] * DAY,
          lifeProtection: f.life,
          // The last Low on the first building is already closed, so the plan
          // shows a completed item beside the outstanding ones.
          ...(fi === 0 && index === 1
            ? {
                status: 'signedOff' as const,
                signedOffBy: reviewerUid,
                signedOffAt: days(-4),
                completionNote:
                  'Directional signage installed at the stair head and photographed.',
              }
            : { status: 'open' as const }),
        };
        writes[p.db.action(orgId, buildingId, idIn(slug, kind, `act-${bp.key}-${f.key}`))] =
          action;
      });

      // --- Log book. The statutory record behind a completed assessment, plus
      // the routine entries a building accrues between visits.
      const logs: Array<[string, LogBookEntry]> = [
        [
          `log-${bp.key}-fra`,
          {
            type: 'fraCompleted',
            payload: {
              summary:
                'Fire risk assessment completed and released to the customer.',
            },
            byUid: reviewerUid,
            at: conductedAt + 3 * DAY,
          },
        ],
        [
          `log-${bp.key}-service`,
          {
            type: 'serviceConfirmed',
            payload: {
              service: 'fireAlarmService',
              contractor: 'Cambrian Fire Systems Ltd',
              outcome: 'Pass',
              certificateRef: `CFS-2026-${1000 + index}`,
            },
            byUid: fieldAssessorUid,
            at: days(-35),
          },
        ],
        [
          `log-${bp.key}-drill`,
          {
            type: 'assessorAction',
            payload: {
              action: 'Fire drill observed',
              evacuationTime: '3 minutes 40 seconds',
              participants: String(bp.occupants),
              summary: 'Full evacuation, all floors cleared, no issues raised.',
            },
            byUid: fieldAssessorUid,
            at: days(-22),
          },
        ],
      ];
      for (const [logId, entry] of logs) {
        writes[p.db.logBookEntry(orgId, buildingId, idIn(slug, kind, logId))] =
          entry;
      }
    }
  });

  // --- Portal membership ------------------------------------------------------
  if (kind === 'customer') {
    const portalMember: CustomerMember = {
      roles: { admin: true },
      name: person.name,
      email: person.email,
      status: 'active',
      jobTitle: 'Facilities Director',
      phone: '+44 29 2000 0101',
    };
    writes[p.db.customerMember(orgId, primaryCustomerId, uid)] = portalMember;
    // Keyed exactly as acceptInvitation writes it, so the picker reads a seeded
    // portal space and an invited one the same way.
    writes[
      p.db.customerUserIndexEntry(uid, portalSpaceKey(orgId, primaryCustomerId))
    ] = { orgId, customerId: primaryCustomerId };
  }

  return {
    orgId,
    writes,
    released,
    ...(kind === 'customer'
      ? { portal: { orgId, customerId: primaryCustomerId } }
      : {}),
  };
}

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------

/** Pre-write the once-only release marker so onAssessmentStageChange treats the
 *  seeded release as already-emitted. Without this, provisioning would post a
 *  release email to every seeded contact on every space, for every person. */
async function suppressReleaseSideEffects(
  entries: Array<{ orgId: string; assessmentId: string }>,
): Promise<void> {
  const writes: Record<string, unknown> = {};
  for (const { orgId, assessmentId } of entries) {
    writes[`${OPS_ROOT}${orgId}/${assessmentId}`] = {
      seededBy: 'roleSpaces',
      at: NOW,
    };
  }
  await applyWrites(writes);
}

async function run(): Promise<void> {
  initAdmin();
  const p = forEnv(ENV);

  const only = process.argv
    .find((a) => a.startsWith('--only='))
    ?.slice('--only='.length)
    .toLowerCase();
  const people = only
    ? PEOPLE.filter((x) => x.email.toLowerCase() === only)
    : PEOPLE;
  if (people.length === 0) {
    throw new Error(`--only=${only} matched nobody in PEOPLE.`);
  }

  console.log(
    `Provisioning ${SPACES.length} role spaces for ${people.length} people ` +
      `(${people.length * SPACES.length} organisations) under /${ENV}...`,
  );

  const media = await uploadSharedMedia();
  console.log('Shared media uploaded.');
  await ensureCounterpartAccounts();

  const summary: Array<{ person: string; email: string; spaces: string[] }> = [];
  const allReleased: SpaceBuild['released'] = [];
  const landings: Array<{ uid: string; slug: string }> = [];

  for (const person of people) {
    const slug = slugFor(person.email);
    const uid = await ensureUser(person, slug);
    const built: SpaceBuild[] = SPACES.map((config) =>
      buildSpace(person, slug, uid, config, media, p),
    );

    // Markers FIRST: the trigger fires on the assessment status write, and it
    // must find the marker already there or it will emit the release fan-out.
    await suppressReleaseSideEffects(built.flatMap((b) => b.released));
    for (const space of built) {
      await applyWrites(space.writes);
      allReleased.push(...space.released);
    }

    landings.push({ uid, slug });
    summary.push({
      person: person.name,
      email: person.email,
      spaces: SPACES.map((s) => s.label),
    });
    console.log(`  ${person.email} -> ${SPACES.length} spaces (uid ${uid})`);
  }

  // --- Reports. Rendered by the SAME core the callable uses, so what a customer
  // downloads in their space is a real report of their own seeded assessment
  // rather than a placeholder file.
  console.log(`Rendering ${allReleased.length} reports...`);
  const { generateAndStoreReport } = await import('../report/generateAndStore');
  const { createLogger } = await import('../lib/logging');
  const logger = createLogger({ fn: 'roleSpaces' });
  let rendered = 0;
  let failed = 0;
  for (const { orgId, assessmentId, actorUid } of allReleased) {
    try {
      await generateAndStoreReport({
        paths: p,
        orgId,
        assessmentId,
        actorUid,
        logger,
      });
      rendered += 1;
    } catch (err) {
      // One report failing must not cost the other fifty-five their space. The
      // building still shows its assessment; only the PDF is missing, and a
      // re-run regenerates it.
      failed += 1;
      console.warn(`  report failed for ${orgId}/${assessmentId}: ${String(err)}`);
    }
  }

  // --- Landing space. onMembershipChange re-mints a user's claims on EVERY
  // membership write, always to the org whose record changed - so whichever of
  // a person's four memberships the trigger handled last would otherwise decide
  // where they land. We wait for that fan-out to drain, then write the landing
  // claims ourselves, so everyone opens in their Assessor Space: the one whose
  // first screen (their own jobs) can be acted on immediately.
  //
  // A straggling trigger can still land after this and move someone. That is
  // recoverable in one tap from the Account screen, and re-running this script
  // re-settles it - which is why it is worth a wait but not a locking scheme.
  console.log('Waiting for membership triggers to drain before setting claims...');
  await new Promise((resolve) => setTimeout(resolve, 45_000));
  for (const { uid, slug } of landings) {
    await admin.auth().setCustomUserClaims(uid, {
      orgId: orgIdFor(slug, 'assessor'),
      roles: { assessor: true },
      testMode: true,
    });
  }

  console.log('\n--- Role spaces provisioned -------------------------------');
  for (const row of summary) {
    console.log(`${row.person} <${row.email}>`);
    console.log(`   ${row.spaces.join('  |  ')}`);
  }
  console.log(
    `\nReports rendered: ${rendered}${failed ? ` (${failed} failed)` : ''}`,
  );
  console.log(`Password for accounts created here: ${PASSWORD}`);
  console.log(
    'Everyone lands in their Assessor Space; the Account screen switches spaces.',
  );
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
