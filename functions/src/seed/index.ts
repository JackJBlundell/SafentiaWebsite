// ============================================================================
// Safentia Phase 1 seed (stories 1014 + 1015).
//
// Creates the single shared, canonical demo world under the ISOLATED /test root
// (brief 4.8 + 10): one organisation with brand, members across every role
// (incl. a multi-role user and a sign-in-able assessor), customers -> sites ->
// buildings, floor plans (some, and none on at least one), the published PAS 79
// template, jobs across the lifecycle, assessments in every state (released,
// readyForValidation, infoRequired with an open info request, and pending), the
// matching answers with photos and a flag, actions across L/M/H with Life
// Protection and flag composites, and a varied log book. Real PNG media is
// generated and uploaded so the app's galleries, floor-plan viewer and flag
// feature have something to show.
//
// SAFETY: a hard guard asserts EVERY RTDB path and EVERY Storage object key
// begins with the `test/` root before any write happens. If anything would touch
// /live the seed refuses to run and exits non-zero (brief 10: never write live).
//
// IDEMPOTENT: every record has a deterministic id and is written with set(), so
// re-running overwrites in place with no duplicates (story 1014 AC2).
//
// Run: USE_EMULATOR=true npm run seed   (emulators), or with
//      GOOGLE_APPLICATION_CREDENTIALS set for a real project (safentia-tech).
// ============================================================================

import { randomUUID } from 'node:crypto';
import * as admin from 'firebase-admin';

// A cryptographically-random download token generated ONCE per seed run. Shared
// by every object uploaded in the run so their public URLs are internally
// consistent, but unpredictable (never the old hardcoded 'seed-token', which gave
// guessable public URLs). A re-run re-uploads with a fresh token and overwrites
// the URL on each record, so idempotency is preserved.
const SEED_DOWNLOAD_TOKEN = randomUUID();

import { forEnv, portalSpaceKey } from '../shared/paths';
import type { Environment } from '../shared/types';

import {
  ORG_ID,
  ORG2_ID,
  ORG2,
  NOW,
  SEED_PASSWORD,
  EMAIL_DOMAIN,
  PAS79_TEMPLATE_ID,
} from './ids';
import {
  solidTile,
  floorPlan as floorPlanPng,
  flagComposite,
} from './png';
import { PAS79_TEMPLATE } from './data/pas79Template';
import { buildOrganisation } from './data/org';
import { SEED_MEMBERS, PRIMARY_ASSESSOR } from './data/members';
import {
  buildOrganisation2,
  buildOrg2Building,
  ORG2_BRAND,
  ORG2_MEMBERS,
  ORG2_CUSTOMER,
  ORG2_CONTACT,
  ORG2_CONTACT_ID,
  ORG2_SITE,
  ORG2_JOB,
} from './data/org2';
import {
  SEED_CUSTOMERS,
  SEED_CUSTOMER_CONTACTS,
  SEED_CUSTOMER_MEMBERS,
  SEED_SITES,
  buildBuildings,
  BUILDING_PHOTO_KEYS,
} from './data/customers';
import { SEED_FLOOR_PLANS } from './data/floorPlans';
import { SEED_JOBS } from './data/jobs';
import {
  buildAssessments,
  ASSESSMENT_MEDIA,
  type MediaUrls,
} from './data/assessments';
import { buildActions } from './data/actions';
import { SEED_LOG_ENTRIES } from './data/logbook';
import {
  buildInvitations,
  SEED_STANDARD_PARAGRAPHS,
  DRAFT_TEMPLATE_ID,
  DRAFT_TEMPLATE,
  VERSIONED_TEMPLATE_ID,
  VERSIONED_TEMPLATE_LIVE,
  VERSIONED_TEMPLATE_ARCHIVE,
  OVERDUE_ACTION_ID,
  OVERDUE_ACTION,
  FRA_REVIEW_OVERRIDES,
} from './data/phase2';
import { CUSTOMER } from './ids';

// The seed targets the TEST environment exclusively (brief 4.8 + 10).
const ENV: Environment = 'test';
const TEST_ROOT = 'test/';

// --- App initialisation ------------------------------------------------------
// Supports two modes from .env.example: local emulators (USE_EMULATOR /
// *_EMULATOR_HOST) and a real project (GOOGLE_APPLICATION_CREDENTIALS).
function initAdmin(): void {
  const useEmulator =
    process.env.USE_EMULATOR === 'true' ||
    !!process.env.DATABASE_EMULATOR_HOST ||
    !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    'safentia-tech';

  const databaseURL =
    process.env.FIREBASE_DATABASE_URL ||
    (useEmulator
      ? `http://${process.env.DATABASE_EMULATOR_HOST || '127.0.0.1:9000'}?ns=${projectId}`
      : `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`);

  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`;

  if (useEmulator) {
    // The emulator host vars make the admin SDK talk to local emulators; no
    // credentials are needed or used in this mode.
    if (!process.env.DATABASE_EMULATOR_HOST) {
      process.env.DATABASE_EMULATOR_HOST = '127.0.0.1:9000';
    }
    if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    }
    if (!process.env.STORAGE_EMULATOR_HOST) {
      process.env.STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
    }
    admin.initializeApp({ projectId, databaseURL, storageBucket });
  } else {
    // Real project: GOOGLE_APPLICATION_CREDENTIALS is picked up automatically by
    // applicationDefault().
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL,
      storageBucket,
    });
  }
}

// --- Hard safety guard -------------------------------------------------------
// Every RTDB path and Storage key passes through here. If anything does not
// start with the test root we throw, which aborts the run with a non-zero exit
// before a single byte is written outside /test.
function assertTest(path: string): string {
  if (!path.startsWith(TEST_ROOT)) {
    throw new Error(
      `SEED SAFETY GUARD: refusing to write to a non-test path: "${path}". ` +
        'The seed may only ever write under the /test root (brief 4.8 + 10).',
    );
  }
  return path;
}

// --- Write helpers -----------------------------------------------------------
// All writes go through set() at a guarded path, keeping the seed idempotent.
async function setDb(path: string, value: unknown): Promise<void> {
  await admin.database().ref(assertTest(path)).set(value);
}

async function uploadPng(key: string, bytes: Buffer): Promise<string> {
  assertTest(key);
  // SKIP_STORAGE lets the seed run before Cloud Storage is provisioned on a
  // project (RTDB + Auth still seed fully). Records get an empty media URL; the
  // app renders its graceful "image unavailable" state until a later run with
  // Storage enabled fills them in.
  if (process.env.SKIP_STORAGE === 'true') {
    return '';
  }
  const bucket = admin.storage().bucket();
  const file = bucket.file(key);
  await file.save(bytes, {
    contentType: 'image/png',
    resumable: false,
    // A per-run random download token (see SEED_DOWNLOAD_TOKEN): consistent within
    // a run, unpredictable across runs - never a guessable public URL.
    metadata: { metadata: { firebaseStorageDownloadTokens: SEED_DOWNLOAD_TOKEN } },
  });
  const bucketName = bucket.name;
  // Firebase download-style URL, using the run's random token.
  const encoded = encodeURIComponent(key);
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encoded}?alt=media&token=${SEED_DOWNLOAD_TOKEN}`;
}

// ----------------------------------------------------------------------------
// Auth users: deterministic uids + known passwords so a human can sign in.
// Catches the already-exists case so re-runs are idempotent; updates the record
// each run to keep email/name/password in sync with the member data.
// ----------------------------------------------------------------------------
async function ensureAuthUser(
  uid: string,
  email: string,
  displayName: string,
): Promise<void> {
  const auth = admin.auth();
  try {
    await auth.createUser({
      uid,
      email,
      emailVerified: true,
      password: SEED_PASSWORD,
      displayName,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      // Idempotent re-run: bring the existing user back in line with the seed.
      await auth.updateUser(uid, {
        email,
        emailVerified: true,
        password: SEED_PASSWORD,
        displayName,
      });
    } else {
      throw err;
    }
  }
}

/** True for the demo accounts on the `@firerite-demo.test` domain (as opposed to
 *  a real external account such as the project owner's Google email). */
function isDemoEmail(email: string): boolean {
  return email.endsWith(`@${EMAIL_DOMAIN}`);
}

/**
 * Resolve the Firebase Auth uid a member's records should be keyed under, and
 * make sure that auth user exists.
 *
 * - Demo accounts (`@firerite-demo.test`): created/updated with the shared seed
 *   uid and password, exactly as before.
 * - A REAL external account (the owner's own email): we never touch their
 *   password. We remove the placeholder duplicate the bootstrap may have created
 *   under the seed uid, then bind to their existing account by email (or create a
 *   passwordless one they can claim via password reset if none exists yet).
 *
 * Returns the effective uid so claims and `/orgMembers` are written against the
 * account the person actually signs in with.
 */
async function resolveMemberUid(
  seedUid: string,
  email: string,
  name: string,
): Promise<string> {
  const auth = admin.auth();
  if (isDemoEmail(email)) {
    await ensureAuthUser(seedUid, email, name);
    return seedUid;
  }
  // Real account: clear the placeholder duplicate (if the bootstrap created one
  // under the seed uid for this same email) so there is one account per email.
  try {
    const placeholder = await auth.getUser(seedUid);
    if (placeholder.email === email) {
      await auth.deleteUser(seedUid);
    }
  } catch {
    // No placeholder under the seed uid - nothing to clean up.
  }
  try {
    const existing = await auth.getUserByEmail(email);
    return existing.uid;
  } catch {
    // No account yet: create a passwordless one. The person sets a password via
    // the in-app reset to their real inbox (or signs in with Google).
    const created = await auth.createUser({ email, emailVerified: true, displayName: name });
    return created.uid;
  }
}

// --- The seed ----------------------------------------------------------------
async function seed(): Promise<void> {
  initAdmin();
  const p = forEnv(ENV);

  // Sanity: the path builders must be producing /test paths. If this ever fails
  // the contract changed and the seed must not proceed.
  assertTest(p.db.organisation(ORG_ID));

  console.log('Seeding Safentia demo world under the /test root...');

  // --- 1. Media: generate and upload all PNGs first, collecting their URLs ---
  // Org logo (brand-coloured tile so whitelabel theming is demonstrable). It is
  // org-level brand media, so it lives directly under the org Storage root. The
  // colours are the demo TENANT's own pair from seed/data/org.ts, kept distinct
  // from the platform default for the reason stated there.
  const logoUrl = await uploadPng(
    `${ENV}/orgs/${ORG_ID}/brand/logo.png`,
    solidTile(512, 512, '#2563EB', '#1E3A8A'),
  );

  // Building photos.
  const buildingPhotoUrls: Record<string, string> = {};
  for (const { buildingId, key } of BUILDING_PHOTO_KEYS) {
    const storageKey = p.storage.photo(ORG_ID, buildingId, key);
    buildingPhotoUrls[buildingId] = await uploadPng(
      storageKey,
      solidTile(640, 480, '#dbe3ec', '#1f4e79'),
    );
  }

  // Floor plans.
  const floorPlanUrls: Record<string, string> = {};
  for (const fp of SEED_FLOOR_PLANS) {
    const storageKey = p.storage.floorPlan(ORG_ID, fp.buildingId, fp.storageKey);
    floorPlanUrls[fp.planId] = await uploadPng(
      storageKey,
      floorPlanPng(800, 600),
    );
  }

  // Assessment answer photos.
  const answerPhotoUrls: Record<string, string> = {};
  for (const photo of ASSESSMENT_MEDIA.photos) {
    // Photos are keyed under the building they document via their assessment;
    // we store them under the Tower A / B / Lodge buildings as appropriate by
    // mapping the key prefix back to a building - but a single shared key space
    // is fine for the seed, so we store them under the org photos namespace
    // keyed by the photo key for simplicity and determinism.
    const storageKey = p.storage.photo(ORG_ID, 'assessment-media', photo.key);
    answerPhotoUrls[photo.key] = await uploadPng(
      storageKey,
      solidTile(640, 480, '#eef1f4', '#d92d20'),
    );
  }

  // Flag composites (floor plan flattened with R/A/G pins - brief 8).
  const flagUrls: Record<string, string> = {};
  for (const flag of ASSESSMENT_MEDIA.flags) {
    const storageKey = p.storage.flagComposite(ORG_ID, 'assessment-media', flag.key);
    flagUrls[flag.key] = await uploadPng(
      storageKey,
      flagComposite(
        800,
        600,
        flag.pins.map((pin) => ({ x: pin.x, y: pin.y, severity: pin.severity })),
      ),
    );
  }

  const mediaUrls: MediaUrls = { photoUrls: answerPhotoUrls, flagUrls };

  // --- 2. Organisation + members --------------------------------------------
  await setDb(p.db.organisation(ORG_ID), buildOrganisation(logoUrl));

  for (const { uid, member } of SEED_MEMBERS) {
    // Resolve the real auth uid (demo uid for demo accounts; the owner's own
    // account for a real email) and ensure that auth user exists.
    const authUid = await resolveMemberUid(uid, member.email, member.name);
    // Set custom claims DIRECTLY here so logins work even when onMembershipChange
    // is not deployed (a fresh project for testing). In production the trigger
    // maintains these; the values it would write are identical to these.
    await admin.auth().setCustomUserClaims(authUid, {
      orgId: ORG_ID,
      roles: member.roles,
      testMode: true,
    });
    await setDb(p.db.orgMember(ORG_ID, authUid), member);
    // Reverse login index so the app can route the user to this org.
    await setDb(p.db.userOrg(authUid, ORG_ID), true);
  }

  // --- 2b. Second organisation (multi-org / org-switch demo) ----------------
  // Alex belongs to this org too, with a DISTINCT brand, so the Account screen's
  // organisation switcher and per-org theming are demonstrable. We add Alex's
  // membership and a small complete slice (template + customer/site/building/job)
  // but DELIBERATELY do not touch his claims - he stays active in the main org and
  // switches into this one via setActiveOrganisation, which re-mints his claims.
  const org2LogoUrl = await uploadPng(
    `${ENV}/orgs/${ORG2_ID}/brand/logo.png`,
    solidTile(512, 512, ORG2_BRAND.primary, ORG2_BRAND.secondary),
  );
  await setDb(p.db.organisation(ORG2_ID), buildOrganisation2(org2LogoUrl));

  for (const { uid, member } of ORG2_MEMBERS) {
    // Same demo email -> same Auth user as in the main org: that is what makes
    // Alex a genuine member of two organisations.
    const authUid = await resolveMemberUid(uid, member.email, member.name);
    await setDb(p.db.orgMember(ORG2_ID, authUid), member);
    await setDb(p.db.userOrg(authUid, ORG2_ID), true);
  }

  // org2's own published template, customer, site, building and one scheduled
  // job for Alex, so the org is populated and themed the moment he switches in.
  await setDb(p.db.template(ORG2_ID, PAS79_TEMPLATE_ID), PAS79_TEMPLATE);
  await setDb(p.db.customer(ORG2_ID, ORG2.customer), ORG2_CUSTOMER);
  await setDb(
    p.db.customerContact(ORG2_ID, ORG2.customer, ORG2_CONTACT_ID),
    ORG2_CONTACT,
  );
  await setDb(p.db.site(ORG2_ID, ORG2.customer, ORG2.site), ORG2_SITE);
  const org2BuildingPhotoUrl = await uploadPng(
    p.storage.photo(ORG2_ID, ORG2.building, `photo-${ORG2.building}`),
    solidTile(640, 480, '#efe7f6', ORG2_BRAND.primary),
  );
  await setDb(
    p.db.building(ORG2_ID, ORG2.site, ORG2.building),
    buildOrg2Building(org2BuildingPhotoUrl),
  );
  await setDb(p.db.job(ORG2_ID, ORG2.job), ORG2_JOB);
  await setDb(
    p.db.assessorJob(ORG2_ID, ORG2_JOB.assessorUid, ORG2.job),
    ORG2_JOB.status,
  );

  // --- 3. Published PAS 79 template -----------------------------------------
  await setDb(p.db.template(ORG_ID, PAS79_TEMPLATE_ID), PAS79_TEMPLATE);

  // --- 4. Customers -> sites -> buildings -----------------------------------
  for (const { id, customer } of SEED_CUSTOMERS) {
    await setDb(p.db.customer(ORG_ID, id), customer);
  }
  // The customers' people (exactly one primary each); sites and buildings'
  // responsible-party snapshots reference these by contactId.
  for (const { id, customerId, contact } of SEED_CUSTOMER_CONTACTS) {
    await setDb(p.db.customerContact(ORG_ID, customerId, id), contact);
  }
  // The customer organisations' accounts (responsible-party candidates).
  for (const { customerId, uid, member } of SEED_CUSTOMER_MEMBERS) {
    await setDb(p.db.customerMember(ORG_ID, customerId, uid), member);
  }
  for (const { id, customerId, site } of SEED_SITES) {
    await setDb(p.db.site(ORG_ID, customerId, id), site);
  }
  const buildings = buildBuildings(buildingPhotoUrls);
  for (const b of buildings) {
    await setDb(p.db.building(ORG_ID, b.siteId, b.id), b.building);
  }

  // --- 5. Floor plans --------------------------------------------------------
  for (const fp of SEED_FLOOR_PLANS) {
    await setDb(p.db.floorPlan(ORG_ID, fp.buildingId, fp.planId), {
      ...fp.meta,
      imageUrl: floorPlanUrls[fp.planId],
    });
  }

  // --- 6. Jobs + assessor reverse index -------------------------------------
  for (const { id, job } of SEED_JOBS) {
    await setDb(p.db.job(ORG_ID, id), job);
    await setDb(p.db.assessorJob(ORG_ID, job.assessorUid, id), job.status);
  }

  // --- 7. Assessments + per-question answers --------------------------------
  const assessments = buildAssessments(mediaUrls);
  for (const a of assessments) {
    await setDb(p.db.assessment(ORG_ID, a.id), a.assessment);
    for (const [questionId, ans] of Object.entries(a.answers)) {
      await setDb(p.db.assessmentAnswer(ORG_ID, a.id, questionId), ans);
    }
  }

  // --- 8. Actions ------------------------------------------------------------
  const actions = buildActions(flagUrls, answerPhotoUrls);
  for (const a of actions) {
    await setDb(p.db.action(ORG_ID, a.buildingId, a.id), a.action);
  }

  // --- 9. Log book -----------------------------------------------------------
  for (const e of SEED_LOG_ENTRIES) {
    await setDb(p.db.logBookEntry(ORG_ID, e.buildingId, e.id), e.entry);
  }

  // --- 10. Phase 2 surfaces (story 2081) --------------------------------------

  // 10a. Building -> customer index. The PORTAL rules gate every per-building
  // read (actions, reports, log book) on this index, so EVERY seeded building
  // must have its entry or the portal shows nothing. The value is the owning
  // customerId, exactly as manageBuilding maintains it.
  for (const b of buildings) {
    await setDb(p.db.buildingCustomer(ORG_ID, b.id), b.building.customerId);
  }
  await setDb(p.db.buildingCustomer(ORG2_ID, ORG2.building), ORG2.customer);

  // 10b. A portal-ready customer account: Helen Carter (Meridian's Facilities
  // Director, portal admin). Her /customerMembers record is written in step 4;
  // here we make her SIGN-IN-ABLE: an auth user, the portal claims, and the
  // customerUserIndex entry the login routing reads. In the emulator (functions
  // running) the customerMembers write also fires onCustomerMembershipChange,
  // which mints these exact claims; setting them directly here means the portal
  // login works even on a project where the Functions are not yet deployed -
  // the same posture as the staff members above.
  const PORTAL_UID = 'custmbr-meridian-helen-carter';
  await ensureAuthUser(
    PORTAL_UID,
    'helen.carter@meridian-estates.test',
    'Helen Carter',
  );
  await admin.auth().setCustomUserClaims(PORTAL_UID, {
    portalOrgId: ORG_ID,
    customerId: CUSTOMER.meridian,
    customerRoles: { admin: true },
    testMode: true,
  });
  // One entry per portal space (Helen holds a single one), keyed exactly as
  // acceptInvitation writes it so the space picker reads seeded and invited
  // accounts the same way.
  await setDb(
    p.db.customerUserIndexEntry(
      PORTAL_UID,
      portalSpaceKey(ORG_ID, CUSTOMER.meridian),
    ),
    {
      orgId: ORG_ID,
      customerId: CUSTOMER.meridian,
    },
  );

  // 10c. Invitations in every non-accepted state (pending staff, pending
  // portal, revoked, expired). The bearer token lives ONLY on the unreadable
  // /invitations root; the admin-facing summary (no token) mirrors it under
  // /orgInvitations, exactly as createInvitation writes them.
  const invitations = buildInvitations();
  for (const inv of invitations) {
    await setDb(p.db.invitation(inv.id), inv.invitation);
    await setDb(p.db.orgInvitation(ORG_ID, inv.id), inv.summary);
  }

  // 10d. Standard Paragraphs, a template DRAFT, and a custom template with TWO
  // published versions in the archive (FR-E21: builder, publish, history).
  for (const { id, paragraph } of SEED_STANDARD_PARAGRAPHS) {
    await setDb(p.db.standardParagraph(ORG_ID, id), paragraph);
  }
  await setDb(p.db.templateDraft(ORG_ID, DRAFT_TEMPLATE_ID), DRAFT_TEMPLATE);
  await setDb(
    p.db.template(ORG_ID, VERSIONED_TEMPLATE_ID),
    VERSIONED_TEMPLATE_LIVE,
  );
  for (const { version, template } of VERSIONED_TEMPLATE_ARCHIVE) {
    await setDb(
      p.db.templateVersion(ORG_ID, VERSIONED_TEMPLATE_ID, version),
      template,
    );
  }

  // 10e. An extra OVERDUE, non-Life-Protection action (the H/LTP actions from
  // step 8 are already overdue), plus fraReview overrides: one building due
  // for review inside 30 days and one lapsed (FR-E20 review tracking).
  await setDb(
    p.db.action(ORG_ID, OVERDUE_ACTION.buildingId, OVERDUE_ACTION_ID),
    OVERDUE_ACTION.action,
  );
  for (const o of FRA_REVIEW_OVERRIDES) {
    await setDb(
      `${p.db.building(ORG_ID, o.siteId, o.buildingId)}/serviceSchedule/fraReview/nextDue`,
      o.nextDue,
    );
  }

  // --- Summary ---------------------------------------------------------------
  printSummary(buildings.length, assessments.length, actions.length + 1);
}

function printSummary(
  buildingCount: number,
  assessmentCount: number,
  actionCount: number,
): void {
  const a = PRIMARY_ASSESSOR.member;
  console.log('\n========================================================');
  console.log(' Safentia seed complete - all data under /test');
  console.log('========================================================');
  console.log(` Organisation : ${ORG_ID} (Safentia Fire Safety)`);
  console.log(` Members      : ${SEED_MEMBERS.length} (every role + 1 multi-role)`);
  console.log(` Template     : ${PAS79_TEMPLATE_ID} (PAS 79, published v1, 12 sections)`);
  console.log(` Customers    : ${SEED_CUSTOMERS.length}`);
  console.log(` Contacts     : ${SEED_CUSTOMER_CONTACTS.length}`);
  console.log(` Sites        : ${SEED_SITES.length}`);
  console.log(` Buildings    : ${buildingCount}`);
  console.log(` Floor plans  : ${SEED_FLOOR_PLANS.length} (2 buildings have none)`);
  console.log(` Jobs         : ${SEED_JOBS.length} (scheduled..released)`);
  console.log(` Assessments  : ${assessmentCount} (released, readyForValidation, infoRequired)`);
  console.log(` Actions      : ${actionCount} (L/M/H, Life Protection, flag composites)`);
  console.log(` Log entries  : ${SEED_LOG_ENTRIES.length} (all six types)`);
  console.log(' Phase 2      : invitations (pending/portal/revoked/expired),');
  console.log('                template draft + 2-version history, standard');
  console.log('                paragraphs, buildingCustomerIndex, portal login,');
  console.log('                overdue action, fraReview due-soon + lapsed');
  console.log(` Run anchor   : ${new Date(NOW).toISOString()}`);
  console.log('--------------------------------------------------------');
  console.log(' SIGN IN AS THE SEEDED ASSESSOR:');
  console.log(`   email    : ${a.email}`);
  console.log(`   password : ${SEED_PASSWORD}`);
  console.log(' SIGN IN AS THE PORTAL CUSTOMER:');
  console.log(`   email    : helen.carter@meridian-estates.test`);
  console.log(`   password : ${SEED_PASSWORD}`);
  console.log('========================================================\n');
}

// Entry point. Any failure exits non-zero so CI / the operator sees it clearly.
seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('SEED FAILED:', err);
    process.exit(1);
  });
