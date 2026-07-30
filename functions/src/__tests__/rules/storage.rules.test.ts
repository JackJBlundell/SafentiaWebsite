// ============================================================================
// Storage security-rules matrix (brief 4.3 / 4.4 / 4.8, stories 1011, 1076).
// Proves tenant + environment scoping, content-type and size validation, and the
// cross-org / cross-env deny cases for object storage.
//
// Uses the compat (namespaced) Storage handle returned by the test context
// (ctx.storage()).
//
// HISTORY (2026-07-14): this suite CAUGHT a production-severity rules bug -
// storage.rules read `request.auth.token.testMode` unguarded, and Storage rules
// (unlike RTDB) ERROR on absent properties, denying EVERY live user all Storage
// access (unnoticed in the field test because every test account carries
// testMode: true). The `'testMode' in request.auth.token` guard now in
// storage.rules is the fix; the whole matrix runs green against the emulator.
// ============================================================================

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { getTestEnv, contextFor, cleanup, type Actor } from './harness';

const orgAUser: Actor = { uid: 'uA', orgId: 'orgA', roles: { assessor: true } };
const orgBUser: Actor = { uid: 'uB', orgId: 'orgB', roles: { assessor: true } };
const testUser: Actor = { uid: 'uT', orgId: 'orgA', roles: { assessor: true }, testMode: true };

/** A byte payload of a given size. */
function bytes(size: number): Uint8Array {
  return new Uint8Array(size);
}

/** Compat storage handle for an actor. The `any` is the namespaced SDK surface;
 *  typing it fully is not worth a client-SDK type import in a server project. */
async function storageFor(actor: Actor | null): Promise<any> {
  const env = await getTestEnv();
  return contextFor(env, actor).storage();
}

afterAll(async () => {
  await cleanup();
});

describe('Building media (images, <= 10MB)', () => {
  test('an org member uploads a valid image to their own building (allow)', async () => {
    const s = await storageFor(orgAUser);
    await assertSucceeds(
      s.ref('live/orgs/orgA/buildings/b1/photos/p1').put(bytes(1024), { contentType: 'image/jpeg' }),
    );
  });

  test('a non-image upload to a photo path is rejected (deny)', async () => {
    const s = await storageFor(orgAUser);
    await assertFails(
      s.ref('live/orgs/orgA/buildings/b1/photos/p2').put(bytes(1024), { contentType: 'application/pdf' }),
    );
  });

  test('an oversized image (> 10MB) is rejected (deny)', async () => {
    const s = await storageFor(orgAUser);
    await assertFails(
      s.ref('live/orgs/orgA/buildings/b1/photos/p3').put(bytes(11 * 1024 * 1024), { contentType: 'image/jpeg' }),
    );
  });

  test('org B cannot upload into org A storage (cross-org deny)', async () => {
    const s = await storageFor(orgBUser);
    await assertFails(
      s.ref('live/orgs/orgA/buildings/b1/photos/p4').put(bytes(1024), { contentType: 'image/jpeg' }),
    );
  });
});

describe('Documents (any type, <= 25MB)', () => {
  test('a 20MB document uploads (allow)', async () => {
    const s = await storageFor(orgAUser);
    await assertSucceeds(
      s.ref('live/orgs/orgA/buildings/b1/documents/safetyPolicy/d1').put(bytes(20 * 1024 * 1024), { contentType: 'application/pdf' }),
    );
  });

  test('a 26MB document is rejected (deny)', async () => {
    const s = await storageFor(orgAUser);
    await assertFails(
      s.ref('live/orgs/orgA/buildings/b1/documents/safetyPolicy/d2').put(bytes(26 * 1024 * 1024), { contentType: 'application/pdf' }),
    );
  });
});

describe('Environment isolation in Storage (both directions)', () => {
  test('a live user cannot upload into the test prefix (deny)', async () => {
    const s = await storageFor(orgAUser);
    await assertFails(
      s.ref('test/orgs/orgA/buildings/b1/photos/p5').put(bytes(1024), { contentType: 'image/jpeg' }),
    );
  });

  test('a test user cannot upload into the live prefix (deny)', async () => {
    const s = await storageFor(testUser);
    await assertFails(
      s.ref('live/orgs/orgA/buildings/b1/photos/p6').put(bytes(1024), { contentType: 'image/jpeg' }),
    );
  });

  test('a test user CAN upload into their own test prefix (allow)', async () => {
    const s = await storageFor(testUser);
    await assertSucceeds(
      s.ref('test/orgs/orgA/buildings/b1/photos/p7').put(bytes(1024), { contentType: 'image/jpeg' }),
    );
  });
});

describe('Report PDFs (story 1076)', () => {
  test('a client cannot write a report PDF (server-only, deny)', async () => {
    const s = await storageFor(orgAUser);
    await assertFails(
      s.ref('live/orgs/orgA/reports/r1.pdf').put(bytes(1024), { contentType: 'application/pdf' }),
    );
  });

  test('an org member can read their org report PDF (allow)', async () => {
    // Seed the object with rules disabled (the report engine writes via admin SDK).
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s: any = ctx.storage();
      await s.ref('live/orgs/orgA/reports/r2.pdf').put(bytes(512), { contentType: 'application/pdf' });
    });
    const s = await storageFor(orgAUser);
    await assertSucceeds(s.ref('live/orgs/orgA/reports/r2.pdf').getDownloadURL());
  });

  test('org B cannot read org A report PDF (cross-org deny)', async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s: any = ctx.storage();
      await s.ref('live/orgs/orgA/reports/r3.pdf').put(bytes(512), { contentType: 'application/pdf' });
    });
    const s = await storageFor(orgBUser);
    await assertFails(s.ref('live/orgs/orgA/reports/r3.pdf').getDownloadURL());
  });
});

// ============================================================================
// Portal reads of the reports prefix: STAFF ONLY, no exceptions.
//
// The rule once granted a portal token on the customerId the generator stamps
// into the object's custom metadata. That branch is GONE (see storage.rules,
// the reports match): a write-time stamp is authorisation frozen at write time
// - it does not follow a building that changes hands, a locked portal seat or
// an archived customer, and a report generated while the building->customer
// index was missing was stamped empty and became permanently unopenable. A
// customer now opens their report through getReportDownloadUrl, which
// re-authorises against live database state on every request.
//
// So these cases pin the posture the rule actually holds: EVERY portal token is
// denied, stamped or not, and the stamp grants nothing. If a portal download
// breaks, fix the callable - do not restore a rules branch to paper over it.
// ============================================================================
describe('Report PDFs - customer portal is denied at the rules layer', () => {
  const portalC1: Actor = { uid: 'portalC1', portalOrgId: 'orgA', customerId: 'c1' };
  const portalC2: Actor = { uid: 'portalC2', portalOrgId: 'orgA', customerId: 'c2' };
  // Forged-claim attacker: matching customerId but a grant on the wrong org.
  const portalOrgB: Actor = { uid: 'portalB', portalOrgId: 'orgB', customerId: 'c1' };

  const STAMPED_PATH = 'live/orgs/orgA/reports/stamped-c1.pdf';

  /** Seed one report stamped for customer c1 (what generateReport does via the
   *  admin SDK, bypassing rules). The stamp is still written as defence in
   *  depth; nothing grants on it. */
  async function seedStampedReport(): Promise<void> {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s: any = ctx.storage();
      await s.ref(STAMPED_PATH).put(bytes(512), {
        contentType: 'application/pdf',
        customMetadata: { customerId: 'c1' },
      });
    });
  }

  test('the stamped customer cannot read their own report directly (deny - callable only)', async () => {
    await seedStampedReport();
    const s = await storageFor(portalC1);
    await assertFails(s.ref(STAMPED_PATH).getDownloadURL());
  });

  test('another customer of the SAME org cannot read it (deny)', async () => {
    await seedStampedReport();
    const s = await storageFor(portalC2);
    await assertFails(s.ref(STAMPED_PATH).getDownloadURL());
  });

  test('a portal user of another org cannot read it, even with a matching customerId (deny)', async () => {
    await seedStampedReport();
    const s = await storageFor(portalOrgB);
    await assertFails(s.ref(STAMPED_PATH).getDownloadURL());
  });

  test('a report with NO customer stamp is invisible to every portal user (deny)', async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s: any = ctx.storage();
      await s.ref('live/orgs/orgA/reports/unstamped.pdf').put(bytes(512), { contentType: 'application/pdf' });
    });
    const s = await storageFor(portalC1);
    await assertFails(s.ref('live/orgs/orgA/reports/unstamped.pdf').getDownloadURL());
  });

  test('a portal user cannot write into the reports prefix (deny)', async () => {
    const s = await storageFor(portalC1);
    await assertFails(
      s.ref('live/orgs/orgA/reports/forged.pdf').put(bytes(64), { contentType: 'application/pdf' }),
    );
  });

  test('a portal user cannot read building media (staff-only prefixes, deny)', async () => {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s: any = ctx.storage();
      await s.ref('live/orgs/orgA/buildings/b1/photos/px.jpg').put(bytes(64), { contentType: 'image/jpeg' });
    });
    const s = await storageFor(portalC1);
    await assertFails(s.ref('live/orgs/orgA/buildings/b1/photos/px.jpg').getDownloadURL());
  });

  test('org A staff still read the reports prefix directly (the branch that STAYED)', async () => {
    await seedStampedReport();
    const s = await storageFor(orgAUser);
    await assertSucceeds(s.ref(STAMPED_PATH).getDownloadURL());
  });
});

// ============================================================================
// Action sign-off evidence: the one prefix a portal token IS granted on, scoped
// by the customerId manageAction stamps from the buildingCustomerIndex (never
// from the uploading client). This block exists to prove the portal arm of that
// OR is REACHABLE, which is not obvious: the read is
//   ownOrg(orgId) || (portalOrgId == orgId && metadata.customerId == customerId)
// and a portal token carries NO orgId claim, so the left arm raises an absent-
// property error rather than returning false (the same Storage-rules behaviour
// that caused the testMode outage in HISTORY above). Emulator-proven here: the
// error is CONTAINED within the `||`, the right arm is still evaluated, and the
// owning customer gets their evidence. The `'orgId' in ...` guard in ownOrg
// makes that explicit rather than incidental - these cases are what would catch
// it if either the guard or the containment ever went away.
// ============================================================================
describe('Action evidence - portal read scoped by stamped customerId', () => {
  const portalC1: Actor = { uid: 'evC1', portalOrgId: 'orgA', customerId: 'c1' };
  const portalC2: Actor = { uid: 'evC2', portalOrgId: 'orgA', customerId: 'c2' };

  const EVIDENCE_PATH = 'live/orgs/orgA/buildings/b1/actionEvidence/ev1';

  async function seedEvidence(): Promise<void> {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const s: any = ctx.storage();
      await s.ref(EVIDENCE_PATH).put(bytes(256), {
        contentType: 'image/jpeg',
        customMetadata: { customerId: 'c1' },
      });
    });
  }

  test('the owning customer reads the evidence for their own building (allow)', async () => {
    await seedEvidence();
    const s = await storageFor(portalC1);
    await assertSucceeds(s.ref(EVIDENCE_PATH).getDownloadURL());
  });

  test('another customer of the same org cannot read it (deny)', async () => {
    await seedEvidence();
    const s = await storageFor(portalC2);
    await assertFails(s.ref(EVIDENCE_PATH).getDownloadURL());
  });

  test('the owning org staff read it too (allow)', async () => {
    await seedEvidence();
    const s = await storageFor(orgAUser);
    await assertSucceeds(s.ref(EVIDENCE_PATH).getDownloadURL());
  });

  test('a portal user cannot upload evidence (admin staff only, deny)', async () => {
    const s = await storageFor(portalC1);
    await assertFails(
      s.ref('live/orgs/orgA/buildings/b1/actionEvidence/forged').put(bytes(64), { contentType: 'image/jpeg' }),
    );
  });
});
