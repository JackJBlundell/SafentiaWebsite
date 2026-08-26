// ============================================================================
// RTDB security-rules allow/deny matrix (brief 4.4 / 4.8, stories 1009-1013,
// 1031, 1066). THE most important test asset: it proves the tenancy, environment
// and role-union boundaries against the REAL deployed rules, including deliberate
// cross-org and cross-environment attack cases in both directions, append-only
// enforcement, and published-template immutability.
//
// Actors are defined by their custom claims (the claims onMembershipChange writes).
// Fixtures are written with rules disabled so a test never depends on the rule it
// is proving. assertSucceeds / assertFails make each case read as allow / deny.
//
// EXECUTION: this suite runs ONLY under the Firebase emulator (CI rules-tests
// job): from the repo root,
//   npx firebase-tools emulators:exec --only database,storage \
//     --project safentia-tech 'npm --prefix functions run test:rules'
// A plain `npx jest` run excludes it (see jest.config.js / jest.rules.config.js).
//
// RULES-EXPRESSIVENESS NOTES (honest limits, per the C1/M1 fix — RTDB
// `.validate` evaluates only at the write location and BELOW, while `.write`
// cascades down, so ancestor validates do NOT run for deep writes):
// - Whole-document invariants (hasChildren, per-field type/length caps on the
//   merged document, the invitation enabled-lock, templateId existence, the
//   50-block cap) are enforced for writes at ANY depth by conditions on the
//   merged `newData` inside the granting `.write` rule itself — the one rule
//   that always runs. Leaf `.validate` rules additionally catch direct writes
//   at each leaf.
// - Unknown-key branches are denied by `$other: {.validate: false}` chains
//   nested THREE wildcard levels deep at each wildcard site. A write nested
//   MORE than three levels under an unknown key (e.g. junk/a/b/c/d) is not
//   expressible finitely in rules and would land; the server treats templates
//   as opaque and isRenderableTemplate rejects any malformed document at send
//   time (fallback to the built-in default), so this is a bounded storage
//   nuisance for an already-trusted org admin, not an auth or send-path hole.
// - Inside `blocks/$blockId`, per-block invariants (id/type present) hold for
//   writes at the block or above; a partial write below a block (e.g. text
//   alone) still hits the text leaf validate (cap 5000) but cannot re-prove
//   siblings — isRenderableTemplate is the documented backstop.
// - TEMPLATE COUNT per org is NOT cleanly expressible in rules (no child-count
//   operator; siblings are invisible to a $templateId write). Left to a future
//   callable-based create; the 50-block per-template cap IS enforced (arrays
//   serialise to numeric keys, so `!blocks.child('50').exists()` caps them).
// - consoleState is deliberately uid-keyed for ANY authenticated principal
//   (staff and portal both hold console prefs — ratified); with the per-leaf
//   boolean caps the node cannot exceed a handful of booleans.
// ============================================================================

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  getTestEnv,
  contextFor,
  seedAsAdmin,
  cleanup,
  clearDb,
  type Actor,
} from './harness';

// --- Fixture actors ---------------------------------------------------------
const adminA: Actor = { uid: 'adminA', orgId: 'orgA', roles: { admin: true } };
const assessorA: Actor = { uid: 'assessorA', orgId: 'orgA', roles: { assessor: true } };
const multiA: Actor = {
  uid: 'multiA',
  orgId: 'orgA',
  roles: { admin: true, assessor: true },
};
const viewerA: Actor = { uid: 'viewerA', orgId: 'orgA', roles: { viewer: true } };
const auditorA: Actor = { uid: 'auditorA', orgId: 'orgA', roles: { auditor: true } };
const orgBUser: Actor = { uid: 'userB', orgId: 'orgB', roles: { admin: true, assessor: true } };
const testUserA: Actor = {
  uid: 'testUserA',
  orgId: 'orgA',
  roles: { admin: true, assessor: true },
  testMode: true,
};
// A customer-portal user (portalOrgId + customerId, NEVER orgId) — the token
// shape onCustomerMembershipChange writes. Used to prove portal claims open
// no staff-side write and exactly the ratified platform reads.
const portalA: Actor = { uid: 'portalU', portalOrgId: 'orgA', customerId: 'c1' };

/** Seed the active member records the rules read for role/status checks. */
async function seedMembers(): Promise<void> {
  const env = await getTestEnv();
  await seedAsAdmin(env, {
    // Live org A members.
    'live/orgMembers/orgA/adminA': { roles: { admin: true }, name: 'Admin A', email: 'a@x', status: 'active' },
    'live/orgMembers/orgA/assessorA': { roles: { assessor: true }, name: 'Assessor A', email: 'as@x', status: 'active' },
    'live/orgMembers/orgA/multiA': { roles: { admin: true, assessor: true }, name: 'Multi A', email: 'm@x', status: 'active' },
    'live/orgMembers/orgA/viewerA': { roles: { viewer: true }, name: 'Viewer A', email: 'v@x', status: 'active' },
    'live/orgMembers/orgA/auditorA': { roles: { auditor: true }, name: 'Auditor A', email: 'au@x', status: 'active' },
    // Live org B member (the cross-org attacker).
    'live/orgMembers/orgB/userB': { roles: { admin: true, assessor: true }, name: 'User B', email: 'b@x', status: 'active' },
    // Test-root member, to prove the test/live boundary.
    'test/orgMembers/orgA/testUserA': { roles: { admin: true, assessor: true }, testMode: true, name: 'Test A', email: 't@x', status: 'active' },
  });
}

beforeEach(async () => {
  const env = await getTestEnv();
  await clearDb(env);
  await seedMembers();
});

afterAll(async () => {
  await cleanup();
});

/** Shorthand: get the rules-applied db handle for an actor. */
async function dbFor(actor: Actor | null) {
  const env = await getTestEnv();
  return contextFor(env, actor).database();
}

describe('Organisation isolation (stories 1009, 1010)', () => {
  test('a member reads their own org buildings (allow)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/buildings/orgA/site1/b1': { name: 'B1', customerId: 'c1', riskLevel: 'low' },
    });
    const db = await dbFor(assessorA);
    await assertSucceeds(db.ref('live/buildings/orgA/site1').once('value'));
  });

  test('org B cannot read org A buildings (cross-org read denied)', async () => {
    const db = await dbFor(orgBUser);
    await assertFails(db.ref('live/buildings/orgA/site1').once('value'));
  });

  test('org B cannot write into org A customers (cross-org write denied)', async () => {
    const db = await dbFor(orgBUser);
    await assertFails(db.ref('live/customers/orgA/c1').set({ name: 'X', status: 'active' }));
  });

  test('unauthenticated reads are denied everywhere', async () => {
    const db = await dbFor(null);
    await assertFails(db.ref('live/buildings/orgA/site1').once('value'));
  });
});

describe('Role union (story 1010)', () => {
  test('admin+assessor passes an admin-gated template draft write', async () => {
    const db = await dbFor(multiA);
    await assertSucceeds(
      db.ref('live/templateDrafts/orgA/t1').set({ name: 'T', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('admin+assessor passes an assessor-gated answer write', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/assessments/orgA/asmt1': { conductedBy: 'multiA', jobId: 'j1', buildingId: 'b1', customerId: 'c1', status: 'inProgress', templateSnapshot: { name: 'T', version: 1 }, conductedAt: 1 },
    });
    const db = await dbFor(multiA);
    await assertSucceeds(
      db.ref('live/assessmentAnswers/orgA/asmt1/q1').set({ text: 'ok', updatedAt: 1 }),
    );
  });

  test('viewer-only cannot write a template draft (deny)', async () => {
    const db = await dbFor(viewerA);
    await assertFails(
      db.ref('live/templateDrafts/orgA/t1').set({ name: 'T', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('viewer-only cannot write an answer (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/assessments/orgA/asmt1': { conductedBy: 'viewerA', jobId: 'j1', buildingId: 'b1', customerId: 'c1', status: 'inProgress', templateSnapshot: { name: 'T', version: 1 }, conductedAt: 1 },
    });
    const db = await dbFor(viewerA);
    await assertFails(db.ref('live/assessmentAnswers/orgA/asmt1/q1').set({ text: 'x', updatedAt: 1 }));
  });

  test('an auditor (not assessor) cannot write an answer (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/assessments/orgA/asmt1': { conductedBy: 'auditorA', jobId: 'j1', buildingId: 'b1', customerId: 'c1', status: 'inProgress', templateSnapshot: { name: 'T', version: 1 }, conductedAt: 1 },
    });
    const db = await dbFor(auditorA);
    await assertFails(db.ref('live/assessmentAnswers/orgA/asmt1/q1').set({ text: 'x', updatedAt: 1 }));
  });
});

describe('Environment isolation (story 4.8 - both directions)', () => {
  test('a live user cannot read the test root (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(db.ref('test/buildings/orgA/site1').once('value'));
  });

  test('a live user cannot write the test root (deny)', async () => {
    const db = await dbFor(multiA);
    await assertFails(
      db.ref('test/templateDrafts/orgA/t1').set({ name: 'T', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('a test user cannot read the live root (deny)', async () => {
    const db = await dbFor(testUserA);
    await assertFails(db.ref('live/buildings/orgA/site1').once('value'));
  });

  test('a test user CAN read their own test root (allow)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'test/buildings/orgA/site1/b1': { name: 'B1', customerId: 'c1', riskLevel: 'low' },
    });
    const db = await dbFor(testUserA);
    await assertSucceeds(db.ref('test/buildings/orgA/site1').once('value'));
  });

  test('a test user CAN write their own test-root template draft (allow)', async () => {
    const db = await dbFor(testUserA);
    await assertSucceeds(
      db.ref('test/templateDrafts/orgA/t1').set({ name: 'T', version: 1, status: 'draft', sections: [] }),
    );
  });
});

describe('Privileged paths route through Functions (stories 1040, 1049)', () => {
  test('a client cannot write /jobs directly (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/jobs/orgA/j1').set({ templateId: 't', templateVersion: 1, customerId: 'c', siteId: 's', buildingId: 'b', assessorUid: 'assessorA', scheduledFor: 1, status: 'scheduled' }),
    );
  });

  test('a client cannot write an assessment status directly (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/assessments/orgA/asmt1': { conductedBy: 'assessorA', jobId: 'j1', buildingId: 'b1', customerId: 'c1', status: 'inProgress', templateSnapshot: { name: 'T', version: 1 }, conductedAt: 1 },
    });
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/assessments/orgA/asmt1/status').set('readyForValidation'));
  });

  test('the conducting assessor CAN write narrative but NOT status (mixed)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/assessments/orgA/asmt1': { conductedBy: 'assessorA', jobId: 'j1', buildingId: 'b1', customerId: 'c1', status: 'inProgress', templateSnapshot: { name: 'T', version: 1 }, conductedAt: 1 },
    });
    const db = await dbFor(assessorA);
    await assertSucceeds(
      db.ref('live/assessments/orgA/asmt1/narrative/summary').set('A summary'),
    );
    await assertFails(db.ref('live/assessments/orgA/asmt1/workflow/submittedAt').set(1));
  });

  test('a client cannot read or write invitations (token is a server secret)', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('live/invitations/i1').once('value'));
    await assertFails(db.ref('live/invitations/i1').set({ token: 'x' }));
  });

  test('a client cannot write the notification ledger (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('live/notificationLedger/orgA/2026-06/x').set({ at: 1 }));
  });
});

describe('Template pipeline (story 1031: drafts client-side, live node server-only)', () => {
  // Authoring happens in /templateDrafts (admin-writable); the LIVE /templates
  // node is written exclusively by the publishTemplate callable via the admin
  // SDK, so EVERY client write there is denied - published or draft alike.
  test('a published template cannot be edited even by an admin (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/templates/orgA/pub1': { name: 'Pub', version: 1, status: 'published', sections: [] },
    });
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/templates/orgA/pub1').set({ name: 'Edited', version: 1, status: 'published', sections: [] }),
    );
  });

  test('a published template cannot be deleted (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/templates/orgA/pub1': { name: 'Pub', version: 1, status: 'published', sections: [] },
    });
    const db = await dbFor(adminA);
    await assertFails(db.ref('live/templates/orgA/pub1').remove());
  });

  test('even a draft-status LIVE template cannot be client-edited (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/templates/orgA/dr1': { name: 'Draft', version: 1, status: 'draft', sections: [] },
    });
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/templates/orgA/dr1').set({ name: 'Draft edited', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('an admin edits a template DRAFT in templateDrafts (allow)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/templateDrafts/orgA/dr2': { name: 'Draft', version: 1, status: 'draft', sections: [] },
    });
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('live/templateDrafts/orgA/dr2').set({ name: 'Draft edited', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('an assessor (non-admin) cannot write a template draft (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(
      db.ref('live/templateDrafts/orgA/dr3').set({ name: 'D', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('an org B admin cannot write an org A template draft (cross-org deny)', async () => {
    const db = await dbFor(orgBUser);
    await assertFails(
      db.ref('live/templateDrafts/orgA/dr4').set({ name: 'D', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('templateVersions is unwritable by any client, even an admin (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/templateVersions/orgA/t1/1').set({ name: 'T', version: 1, sections: [] }),
    );
  });
});

describe('Standard paragraphs (admin-curated, shape-validated)', () => {
  const validParagraph = {
    reference: 'BS9999-5.1',
    title: 'Means of escape',
    body: 'Escape routes must be kept clear at all times.',
    updatedAt: 1,
  };

  test('an admin writes a well-formed paragraph (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('live/standardParagraphs/orgA/p1').set(validParagraph));
  });

  test('a non-admin cannot write a paragraph (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/standardParagraphs/orgA/p2').set(validParagraph));
  });

  test('an unexpected extra child is rejected by validation (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/standardParagraphs/orgA/p3').set({ ...validParagraph, smuggled: 'x' }),
    );
  });

  test('an oversize body (>10000 chars) is rejected (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/standardParagraphs/orgA/p4').set({ ...validParagraph, body: 'x'.repeat(10001) }),
    );
  });
});

describe('Append-only log book and activity (story 1066)', () => {
  test('an active member CAN append a log-book entry stamped with their uid (allow)', async () => {
    const db = await dbFor(assessorA);
    await assertSucceeds(
      db.ref('live/logBook/orgA/b1/e1').set({ type: 'serviceConfirmed', payload: {}, byUid: 'assessorA', at: 1 }),
    );
  });

  test('a log-book entry cannot be edited once written (append-only, deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/logBook/orgA/b1/e1': { type: 'serviceConfirmed', payload: {}, byUid: 'assessorA', at: 1 },
    });
    const db = await dbFor(assessorA);
    await assertFails(
      db.ref('live/logBook/orgA/b1/e1').set({ type: 'falseAlarm', payload: {}, byUid: 'assessorA', at: 2 }),
    );
  });

  test('a log-book entry cannot be deleted (append-only, deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/logBook/orgA/b1/e1': { type: 'serviceConfirmed', payload: {}, byUid: 'assessorA', at: 1 },
    });
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/logBook/orgA/b1/e1').remove());
  });

  test('a member cannot append a log entry attributed to someone else (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(
      db.ref('live/logBook/orgA/b1/e2').set({ type: 'serviceConfirmed', payload: {}, byUid: 'someoneElse', at: 1 }),
    );
  });

  test('an activity entry cannot be edited once written (append-only, deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/activity/orgA/a1': { actorUid: 'assessorA', action: 'x', target: 't', at: 1 },
    });
    const db = await dbFor(assessorA);
    await assertFails(
      db.ref('live/activity/orgA/a1').set({ actorUid: 'assessorA', action: 'y', target: 't', at: 2 }),
    );
  });
});

describe('Per-assessor answer ownership (brief 12)', () => {
  test('an assessor cannot write answers for an assessment they did not conduct (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/assessments/orgA/asmtOther': { conductedBy: 'someoneElse', jobId: 'j', buildingId: 'b', customerId: 'c', status: 'inProgress', templateSnapshot: { name: 'T', version: 1 }, conductedAt: 1 },
    });
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/assessmentAnswers/orgA/asmtOther/q1').set({ text: 'x', updatedAt: 1 }));
  });
});

describe('Notifications (own-scope only)', () => {
  test('a user can mark their own notification read (type unchanged, allow)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/notifications/assessorA/n1': { type: 'jobAssigned', title: 'T', body: 'B' },
    });
    const db = await dbFor(assessorA);
    await assertSucceeds(
      db.ref('live/notifications/assessorA/n1').set({ type: 'jobAssigned', title: 'T', body: 'B', readAt: 1 }),
    );
  });

  test('a user cannot create their own notification (deny - server only)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(
      db.ref('live/notifications/assessorA/n2').set({ type: 'x', title: 'T', body: 'B' }),
    );
  });

  test('a user cannot read another user notifications (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/notifications/adminA/n1': { type: 'x', title: 'T', body: 'B' },
    });
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/notifications/adminA/n1').once('value'));
  });
});

describe('Assessor job index (own-scope only)', () => {
  test('an assessor reads their own job index (allow)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/assessorJobs/orgA/assessorA/j1': 'scheduled',
    });
    const db = await dbFor(assessorA);
    await assertSucceeds(db.ref('live/assessorJobs/orgA/assessorA').once('value'));
  });

  test('an assessor cannot read another assessor job index (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/assessorJobs/orgA/multiA/j1': 'scheduled',
    });
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/assessorJobs/orgA/multiA').once('value'));
  });
});

// ============================================================================
// Email templates (admin-only, shape-validated at every writable depth — the
// C1 fix). The fixture mirrors EXACTLY what emailEditorModel writes and
// isRenderableTemplate accepts: `blocks` is an ARRAY of typed blocks, each
// carrying id + type (the previous fixture's keyed object without id/type
// would have been rejected by the send path — M7).
// ============================================================================
describe('Email templates (admin-only, shape-validated)', () => {
  const validTemplate = {
    name: 'Chase letter',
    subject: 'Your fire risk assessment',
    heading: 'Action required',
    blocks: [{ id: 'b1', type: 'paragraph', text: 'Please review the attached findings.' }],
    updatedAt: 1,
    updatedBy: 'adminA',
  };

  test('an admin writes a well-formed template (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('live/emailTemplates/orgA/t1').set(validTemplate));
  });

  test('a non-admin cannot write a template (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/emailTemplates/orgA/t2').set(validTemplate));
  });

  test('a cross-org admin cannot write a template (deny)', async () => {
    const db = await dbFor(orgBUser);
    await assertFails(db.ref('live/emailTemplates/orgA/t2').set(validTemplate));
  });

  test('a portal-claims caller cannot write a template (deny)', async () => {
    const db = await dbFor(portalA);
    await assertFails(db.ref('live/emailTemplates/orgA/t2').set(validTemplate));
  });

  test('a test-claims admin cannot write a LIVE template (cross-env deny)', async () => {
    const db = await dbFor(testUserA);
    await assertFails(db.ref('live/emailTemplates/orgA/t2').set(validTemplate));
  });

  test('an unexpected extra child on a template is rejected (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailTemplates/orgA/t3').set({ ...validTemplate, smuggled: 'x' }),
    );
  });

  // --- C1 regressions: deep/partial writes can no longer dodge the guards ---
  test('C1: an admin deep-write to {id}/junk/x is DENIED (no unvalidated branches)', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertFails(db.ref('live/emailTemplates/orgA/t1/junk/x').set('smuggled'));
  });

  test('C1: an oversized text written DIRECTLY at blocks/0/text is DENIED', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailTemplates/orgA/t1/blocks/0/text').set('x'.repeat(5001)),
    );
  });

  test('C1: a valid PARTIAL text write at blocks/0/text is still allowed', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('live/emailTemplates/orgA/t1/blocks/0/text').set('Amended paragraph.'),
    );
  });

  test('C1: a deep write under a scalar leaf (name/junk) is DENIED (merged-shape .write)', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertFails(db.ref('live/emailTemplates/orgA/t1/name/junk').set('x'));
  });

  test('C1: deleting a required field via a partial write is DENIED', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertFails(db.ref('live/emailTemplates/orgA/t1/subject').remove());
  });

  test('a block missing id/type is rejected on a whole-block write (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailTemplates/orgA/t1/blocks/1').set({ text: 'typeless block' }),
    );
  });

  test('M1: a template with more than 50 blocks is DENIED (block-count cap)', async () => {
    const blocks = Array.from({ length: 51 }, (_, i) => ({
      id: `b${i}`,
      type: 'paragraph',
      text: 'p',
    }));
    const db = await dbFor(adminA);
    await assertFails(db.ref('live/emailTemplates/orgA/t4').set({ ...validTemplate, blocks }));
  });

  test('template deletion by an admin remains allowed', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('live/emailTemplates/orgA/t1').remove());
  });
});

// ============================================================================
// Email kind settings — the invitation lock and templateId-existence check now
// hold at LEAF depth too (C1: a direct child write previously skipped the
// node-level validate entirely).
// ============================================================================
describe('Email kind settings (admin-only, invitation lock at every depth)', () => {
  const validTemplate = {
    name: 'Chase letter',
    subject: 'Your fire risk assessment',
    heading: 'Action required',
    blocks: [{ id: 'b1', type: 'paragraph', text: 'Please review the attached findings.' }],
    updatedAt: 1,
    updatedBy: 'adminA',
  };

  test('an admin assigns an EXISTING template to a kind (whole-node allow)', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('live/emailSettings/orgA/kinds/review-reminder').set({ enabled: true, templateId: 't1' }),
    );
  });

  test('a non-admin cannot write kind settings (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/review-reminder').set({ enabled: false }),
    );
  });

  test('the invitation kind cannot be disabled by a whole-node write (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/invitation').set({ enabled: false }),
    );
  });

  test('C1: the invitation kind cannot be disabled by a DIRECT leaf write (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/invitation/enabled').set(false),
    );
  });

  test('a dangling templateId on a whole-node write is rejected (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/review-reminder').set({ templateId: 'no-such-doc' }),
    );
  });

  test('C1: a dangling templateId written DIRECTLY at the leaf is rejected (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/templateId').set('no-such-doc'),
    );
  });

  test('a valid direct enabled toggle is allowed (leaf allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/enabled').set(false),
    );
  });

  test('a valid direct templateId assignment at the leaf is allowed', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/templateId').set('t1'),
    );
  });

  test('deep junk under a kind is DENIED', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/junk/x').set('y'),
    );
  });

  // ==========================================================================
  // digestTemplateId — the bundled-copy slot (EMAIL_BUNDLING_PLAN.md §4.4).
  // A SECOND template pointer beside templateId, and it must be exactly as
  // hard to abuse: same string/length/no-slash shape, same "the template must
  // actually exist" existence check, same admin-only, same-org, same-env gate,
  // and the same C1 leaf-depth enforcement so a direct write to the leaf
  // cannot slip past the node-level validate. A dangling pointer here would
  // silently degrade every bundled send to the built-in default; a writable
  // one would let a non-admin choose the copy an org's customers receive.
  // ==========================================================================
  test('an admin assigns an EXISTING digest template beside the ordinary one (whole-node allow)', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/emailTemplates/orgA/t1': validTemplate,
      'live/emailTemplates/orgA/t2': validTemplate,
    });
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('live/emailSettings/orgA/kinds/review-reminder').set({
        enabled: true,
        templateId: 't1',
        digestTemplateId: 't2',
      }),
    );
  });

  test('a valid direct digestTemplateId assignment at the leaf is allowed', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId').set('t1'),
    );
  });

  test('a dangling digestTemplateId on a whole-node write is rejected (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db
        .ref('live/emailSettings/orgA/kinds/review-reminder')
        .set({ digestTemplateId: 'no-such-doc' }),
    );
  });

  test('C1: a dangling digestTemplateId written DIRECTLY at the leaf is rejected (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db
        .ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId')
        .set('no-such-doc'),
    );
  });

  test('a non-string digestTemplateId is rejected at the leaf (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId').set(7),
    );
  });

  test('a path-shaped digestTemplateId (contains a slash) is rejected (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db
        .ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId')
        .set('../../orgB/t1'),
    );
  });

  test('an over-long digestTemplateId is rejected (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db
        .ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId')
        .set('x'.repeat(201)),
    );
  });

  test('a non-admin cannot assign a digest template (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(assessorA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId').set('t1'),
    );
  });

  test('a cross-org admin cannot assign a digest template (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(orgBUser);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId').set('t1'),
    );
  });

  test('a cross-org digest template pointer is rejected: existence is checked in the OWNING org', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgB/t9': validTemplate });
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId').set('t9'),
    );
  });

  test('the invitation lock survives a write that also carries a valid digestTemplateId (deny)', async () => {
    await seedAsAdmin(await getTestEnv(), { 'live/emailTemplates/orgA/t1': validTemplate });
    const db = await dbFor(adminA);
    await assertFails(
      db
        .ref('live/emailSettings/orgA/kinds/invitation')
        .set({ enabled: false, digestTemplateId: 't1' }),
    );
  });

  test('deep junk under digestTemplateId is DENIED', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/emailSettings/orgA/kinds/review-reminder': { enabled: true },
    });
    const db = await dbFor(adminA);
    await assertFails(
      db
        .ref('live/emailSettings/orgA/kinds/review-reminder/digestTemplateId/junk')
        .set('y'),
    );
  });
});

// ============================================================================
// Console UI state (C2 fix) — uid-keyed for ANY authenticated principal
// (ratified: staff and portal users both hold console prefs), but the node is
// CAPPED: every allowed leaf is a boolean, everything else is invalid, so no
// storage abuse is possible. The C1 leaf-write hole (tourDone as a string) and
// deep-write hole (junk branches) are both closed.
// ============================================================================
describe('Console state (own-uid booleans only)', () => {
  test('owner writes gettingStartedDismissed=true (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('consoleState/adminA/gettingStartedDismissed').set(true));
  });

  test('owner writes tourDone/desktop=true (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('consoleState/adminA/tourDone/desktop').set(true));
  });

  test('owner writes gettingStarted/templatesVisited=true (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('consoleState/adminA/gettingStarted/templatesVisited').set(true),
    );
  });

  test('owner whole-node write of a valid shape (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(
      db.ref('consoleState/adminA').set({
        tourDone: { desktop: true, mobile: false },
        gettingStarted: { templatesVisited: true },
        gettingStartedDismissed: false,
      }),
    );
  });

  test('C1: tourDone written as a string LEAF is DENIED', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('consoleState/adminA/tourDone').set('done'));
  });

  test('C1: deep junk (consoleState/{uid}/junk/x) is DENIED', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('consoleState/adminA/junk/x').set('y'));
  });

  test('C1: a non-boolean under a known branch (tourDone/desktop/junk) is DENIED', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('consoleState/adminA/tourDone/desktop/junk').set(true));
  });

  test('writing ANOTHER user console state is DENIED', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('consoleState/assessorA/gettingStartedDismissed').set(true));
  });

  test('reading another user console state is DENIED', async () => {
    await seedAsAdmin(await getTestEnv(), {
      'consoleState/assessorA/gettingStartedDismissed': true,
    });
    const db = await dbFor(adminA);
    await assertFails(db.ref('consoleState/assessorA').once('value'));
  });
});

// ============================================================================
// Billing surfaces (3053): subscription + usage are ADMIN-read, server-write;
// profile stays member-readable (regression guard for the org read split).
// ============================================================================
describe('Organisation subscription and usage (admin-read, server-write)', () => {
  beforeEach(async () => {
    await seedAsAdmin(await getTestEnv(), {
      'live/organisations/orgA/profile': { name: 'Org A Fire Safety' },
      'live/organisations/orgA/subscription': { planId: 'silver', status: 'active' },
      'live/organisations/orgA/usage': { period: '2026-08', assessmentsUsed: 3 },
    });
  });

  test('an org admin reads subscription (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('live/organisations/orgA/subscription').once('value'));
  });

  test('an org admin reads usage (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('live/organisations/orgA/usage').once('value'));
  });

  test('a non-admin member cannot read subscription (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/organisations/orgA/subscription').once('value'));
  });

  test('a non-admin member cannot read usage (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(db.ref('live/organisations/orgA/usage').once('value'));
  });

  test('no client can write subscription — not even the org admin (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('live/organisations/orgA/subscription/planId').set('gold'),
    );
  });

  test('no client can write usage (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('live/organisations/orgA/usage/assessmentsUsed').set(0));
  });

  test('REGRESSION: a plain member still reads the org profile (allow)', async () => {
    const db = await dbFor(assessorA);
    await assertSucceeds(db.ref('live/organisations/orgA/profile').once('value'));
  });
});

// ============================================================================
// Platform tree (3053): plans are world-readable to any signed-in principal
// (including portal claims — ratified, they price the portal upsell), finance
// events are superAdmin-only, and everything is server-write.
// ============================================================================
describe('Platform plans and finance events', () => {
  const superAdmin: Actor = { uid: 'superU', superAdmin: true };

  beforeEach(async () => {
    await seedAsAdmin(await getTestEnv(), {
      'platform/superAdmins/superU': true,
      'platform/plans/bronze': { name: 'Bronze', pricePence: 4900 },
      'platform/financeEvents/live/evt1': { type: 'payment_succeeded', at: 1 },
    });
  });

  test('an authed staff user reads plans (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('platform/plans').once('value'));
  });

  test('a portal-claims user reads plans (allow — ratified)', async () => {
    const db = await dbFor(portalA);
    await assertSucceeds(db.ref('platform/plans').once('value'));
  });

  test('an unauthenticated caller cannot read plans (deny)', async () => {
    const db = await dbFor(null);
    await assertFails(db.ref('platform/plans').once('value'));
  });

  test('no client can write plans — not even a superAdmin (deny)', async () => {
    const db = await dbFor(superAdmin);
    await assertFails(db.ref('platform/plans/bronze/pricePence').set(1));
  });

  test('a listed superAdmin reads financeEvents (allow)', async () => {
    const db = await dbFor(superAdmin);
    await assertSucceeds(db.ref('platform/financeEvents/live').once('value'));
  });

  test('an org admin cannot read financeEvents (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('platform/financeEvents/live').once('value'));
  });

  test('no client can write financeEvents (deny)', async () => {
    const db = await dbFor(superAdmin);
    await assertFails(
      db.ref('platform/financeEvents/live/evt2').set({ type: 'x', at: 2 }),
    );
  });
});

// ============================================================================
// usersOnboarding (3053): own-uid read, server-only write.
// ============================================================================
describe('usersOnboarding (own-read, server-write)', () => {
  beforeEach(async () => {
    await seedAsAdmin(await getTestEnv(), {
      'usersOnboarding/adminA': { surveySeen: true },
    });
  });

  test('the owner reads their onboarding record (allow)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('usersOnboarding/adminA').once('value'));
  });

  test('another user cannot read it (deny)', async () => {
    const db = await dbFor(assessorA);
    await assertFails(db.ref('usersOnboarding/adminA').once('value'));
  });

  test('the owner cannot write it (deny — server only)', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('usersOnboarding/adminA/surveySeen').set(false));
  });
});

// ============================================================================
// ops/* (3053): server-internal (Stripe event claims, provisioning markers) —
// invisible and unwritable to EVERY client principal, superAdmin included.
// The .indexOn under ops/stripeEvents serves admin-SDK queries only.
// ============================================================================
describe('ops/* is fully closed to clients', () => {
  const superAdmin: Actor = { uid: 'superU', superAdmin: true };

  beforeEach(async () => {
    await seedAsAdmin(await getTestEnv(), {
      'platform/superAdmins/superU': true,
      'ops/stripeEvents/live/evt1': { status: 'done', receivedAt: 1 },
    });
  });

  test('a superAdmin cannot read ops/stripeEvents (deny)', async () => {
    const db = await dbFor(superAdmin);
    await assertFails(db.ref('ops/stripeEvents/live').once('value'));
  });

  test('an org admin cannot read ops (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('ops/stripeEvents/live/evt1').once('value'));
  });

  test('no client can write ops (deny)', async () => {
    const db = await dbFor(adminA);
    await assertFails(
      db.ref('ops/stripeEvents/live/evt9').set({ status: 'done', receivedAt: 2 }),
    );
  });
});
