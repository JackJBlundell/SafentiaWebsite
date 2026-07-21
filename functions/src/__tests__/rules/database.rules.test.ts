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
