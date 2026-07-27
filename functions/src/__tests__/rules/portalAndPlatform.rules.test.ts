// ============================================================================
// Portal, platform and member-status boundaries in the RTDB rules matrix
// (findings 2061 + 2067 AC2). Extends database.rules.test.ts with the three
// newer token shapes:
//
//   1. PORTAL users - claims {portalOrgId, customerId, testMode?} and NEVER
//      orgId (written by onCustomerMembershipChange). The rules grant them
//      exactly their own customer's slice: customer record, sites, buildings
//      under an owned site, actions/reports/index entries via
//      buildingCustomerIndex, their customerContacts, and the assessing
//      organisation's PROFILE node (the portal's whitelabel brand source).
//      Everything else - another customer in the same org, any other staff
//      node, cross-org, cross-env, and EVERY write - must be denied.
//   2. PLATFORM operators - token {superAdmin: true} reads any org node across
//      the whole $env cascade (both live and test), and the /platform tree is
//      readable only when /platform/superAdmins/<uid> === true in the DB. No
//      write grant exists anywhere for the claim.
//   3. MEMBER STATUS - the staff read predicates require the caller's own
//      orgMembers record to have status === 'active', so a locked/archived
//      member's still-valid token no longer reads or writes org data.
//
// Fixtures are seeded with rules disabled (harness.seedAsAdmin) so no case
// depends on the rule it proves.
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

// --- Actors -----------------------------------------------------------------
// Portal users: customer c1 and c2 of orgA, a portal user of orgB, and a
// TEST-environment portal user for the env boundary. None carries orgId.
const portalC1: Actor = { uid: 'portalC1', portalOrgId: 'orgA', customerId: 'c1' };
// (Customer c2's slice is seeded as the ATTACK TARGET; portalC1 probing it is the
// same-org cross-customer case, so no second portal actor is needed.)
// The forged-claim attacker: right customerId, wrong org grant.
const portalWrongOrg: Actor = { uid: 'portalW', portalOrgId: 'orgB', customerId: 'c1' };
const portalTestC1: Actor = {
  uid: 'portalT',
  portalOrgId: 'orgA',
  customerId: 'c1',
  testMode: true,
};
// Customer c3 is seeded ARCHIVED: its portal users' still-valid tokens must be
// inert until the customer is restored (portal suspension follows archival).
const portalC3: Actor = { uid: 'portalC3', portalOrgId: 'orgA', customerId: 'c3' };

// Staff actors.
const adminA: Actor = { uid: 'adminA', orgId: 'orgA', roles: { admin: true } };
const adminB: Actor = { uid: 'adminB', orgId: 'orgB', roles: { admin: true } };
// A locked admin: the token still says admin (claims lag), but the member
// record's status is 'locked', which the active-status predicates check live.
const lockedAdminA: Actor = { uid: 'lockedA', orgId: 'orgA', roles: { admin: true } };

// Platform actors: the operator token, and the same uid is seeded into
// /platform/superAdmins so both the token-gated ($env) and DB-gated (/platform)
// predicates are provable.
const superAdmin: Actor = { uid: 'superU', superAdmin: true };

/** Seed org membership, the portal-visible slice for c1/c2, staff nodes and
 *  the platform operator list. */
async function seedFixtures(): Promise<void> {
  const env = await getTestEnv();
  await seedAsAdmin(env, {
    // Staff member records (active-status predicate source of truth).
    'live/orgMembers/orgA/adminA': { roles: { admin: true }, name: 'Admin A', email: 'a@x', status: 'active' },
    'live/orgMembers/orgA/lockedA': { roles: { admin: true }, name: 'Locked A', email: 'l@x', status: 'locked' },
    'live/orgMembers/orgB/adminB': { roles: { admin: true }, name: 'Admin B', email: 'b@x', status: 'active' },

    // Customers c1 and c2 of orgA, plus one customer of orgB.
    'live/customers/orgA/c1': { name: 'Customer One', status: 'active' },
    'live/customers/orgA/c2': { name: 'Customer Two', status: 'active' },
    'live/customers/orgB/c1': { name: 'Org B customer also keyed c1', status: 'active' },
    // Customer c3 is ARCHIVED: its portal grant is suspended until restore.
    'live/customers/orgA/c3': { name: 'Customer Three', status: 'archived' },
    'live/sites/orgA/c3/s3': { name: 'Site Three' },
    'live/buildings/orgA/s3/b3': { name: 'Building Three', customerId: 'c3', riskLevel: 'low' },
    'live/buildingCustomerIndex/orgA/b3': 'c3',
    'live/actions/orgA/b3/a3': { title: 'Archived customer action', severity: 'low', status: 'open', dueBy: 1 },
    'live/reports/orgA/building/b3/r3': { generatedAt: 1, storagePath: 'live/orgs/orgA/reports/r3.pdf' },
    'live/customerContacts/orgA/c3/k3': { name: 'Contact Three', role: 'facilities' },

    // Sites: c1 owns s1, c2 owns s2.
    'live/sites/orgA/c1/s1': { name: 'Site One' },
    'live/sites/orgA/c2/s2': { name: 'Site Two' },

    // Buildings under each site, and the customer index the portal grants pivot on.
    'live/buildings/orgA/s1/b1': { name: 'Building One', customerId: 'c1', riskLevel: 'low' },
    'live/buildings/orgA/s2/b2': { name: 'Building Two', customerId: 'c2', riskLevel: 'low' },
    'live/buildingCustomerIndex/orgA/b1': 'c1',
    'live/buildingCustomerIndex/orgA/b2': 'c2',

    // Actions and reports per building.
    'live/actions/orgA/b1/a1': { title: 'Fix door', severity: 'high', status: 'open', dueBy: 1 },
    'live/actions/orgA/b2/a2': { title: 'Other org action', severity: 'low', status: 'open', dueBy: 1 },
    'live/reports/orgA/building/b1/r1': { generatedAt: 1, storagePath: 'live/orgs/orgA/reports/r1.pdf' },
    'live/reports/orgA/building/b2/r2': { generatedAt: 1, storagePath: 'live/orgs/orgA/reports/r2.pdf' },

    // Customer contacts for both customers.
    'live/customerContacts/orgA/c1/k1': { name: 'Contact One', role: 'facilities' },
    'live/customerContacts/orgA/c2/k2': { name: 'Contact Two', role: 'facilities' },

    // Staff-only nodes a portal user must never see.
    'live/jobs/orgA/j1': { templateId: 't', customerId: 'c1', siteId: 's1', buildingId: 'b1', assessorUid: 'adminA', scheduledFor: 1, status: 'scheduled' },
    'live/assessments/orgA/asmt1': { conductedBy: 'adminA', jobId: 'j1', buildingId: 'b1', customerId: 'c1', status: 'inProgress', templateSnapshot: { name: 'T', version: 1 }, conductedAt: 1 },
    'live/templates/orgA/t1': { name: 'T', version: 1, status: 'published', sections: [] },
    'live/activity/orgA/act1': { actorUid: 'adminA', action: 'x', target: 't', at: 1 },
    'live/orgInvitations/orgA/i1': { email: 'x@x', status: 'pending' },

    // Test-environment mirror of c1, to prove the env boundary in both directions.
    'test/customers/orgA/c1': { name: 'Test Customer One', status: 'active' },
    'test/sites/orgA/c1/s1': { name: 'Test Site One' },

    // Org PROFILE (whitelabel brand) and a SIBLING node under the same
    // organisation, so the portal profile grant can be proved to be exactly
    // that node and not the organisation subtree.
    'live/organisations/orgA/profile': { name: 'Org A Fire Safety', logoUrl: 'https://example.test/a.png', brand: { primary: '#123456', secondary: '#654321' } },
    'live/organisations/orgA/settings': { ragConfig: { overdueDays: 30 } },
    'live/organisations/orgB/profile': { name: 'Org B Fire Safety', brand: { primary: '#000000', secondary: '#ffffff' } },
    'test/organisations/orgA/profile': { name: 'Org A Fire Safety (test)', brand: { primary: '#123456', secondary: '#654321' } },

    // Platform operator list (the DB half of the superAdmin predicate).
    'platform/superAdmins/superU': true,
    'platform/leads/lead1': { name: 'Lead', organisation: 'X', email: 'x@x', receivedAt: 1 },
  });
}

beforeEach(async () => {
  const env = await getTestEnv();
  await clearDb(env);
  await seedFixtures();
});

afterAll(async () => {
  await cleanup();
});

/** Shorthand: get the rules-applied db handle for an actor. */
async function dbFor(actor: Actor | null) {
  const env = await getTestEnv();
  return contextFor(env, actor).database();
}

// ============================================================================
// 1. Portal grants - exactly the caller's own customer slice (finding 2061).
// ============================================================================
describe('Portal access - own-customer grants (allow)', () => {
  test('a portal user reads their own customer record', async () => {
    const db = await dbFor(portalC1);
    await assertSucceeds(db.ref('live/customers/orgA/c1').once('value'));
  });

  test('a portal user reads their own sites', async () => {
    const db = await dbFor(portalC1);
    await assertSucceeds(db.ref('live/sites/orgA/c1').once('value'));
  });

  test('a portal user reads buildings under a site they own', async () => {
    const db = await dbFor(portalC1);
    await assertSucceeds(db.ref('live/buildings/orgA/s1').once('value'));
  });

  test('a portal user reads actions for their building (via buildingCustomerIndex)', async () => {
    const db = await dbFor(portalC1);
    await assertSucceeds(db.ref('live/actions/orgA/b1').once('value'));
  });

  test('a portal user reads building-scoped reports for their building', async () => {
    const db = await dbFor(portalC1);
    await assertSucceeds(db.ref('live/reports/orgA/building/b1').once('value'));
  });

  test('a portal user reads their own customerContacts', async () => {
    const db = await dbFor(portalC1);
    await assertSucceeds(db.ref('live/customerContacts/orgA/c1').once('value'));
  });

  test('a portal user reads their own buildingCustomerIndex entry', async () => {
    const db = await dbFor(portalC1);
    await assertSucceeds(db.ref('live/buildingCustomerIndex/orgA/b1').once('value'));
  });

  // The assessing organisation's PROFILE is the portal's whitelabel brand
  // source (logo, colours, font, trading name). It is the one staff node a
  // portal token may read, and only for the org that issued the token.
  test('a portal user reads the assessing organisation profile', async () => {
    const db = await dbFor(portalC1);
    await assertSucceeds(db.ref('live/organisations/orgA/profile').once('value'));
  });
});

describe('Portal access - the organisation profile grant is exactly that node', () => {
  test('cannot read the organisation node the profile hangs off', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/organisations/orgA').once('value'));
  });

  test('cannot read a sibling of profile under the same organisation', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/organisations/orgA/settings').once('value'));
  });

  test('cannot read another organisation profile', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/organisations/orgB/profile').once('value'));
  });

  test('cannot read the profile of the org it was NOT issued for', async () => {
    const db = await dbFor(portalWrongOrg);
    await assertFails(db.ref('live/organisations/orgA/profile').once('value'));
  });

  test('a live portal token cannot read the test-environment profile', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('test/organisations/orgA/profile').once('value'));
  });

  test('an archived customer portal user cannot read the profile', async () => {
    const db = await dbFor(portalC3);
    await assertFails(db.ref('live/organisations/orgA/profile').once('value'));
  });

  test('a signed-out caller cannot read the profile', async () => {
    const db = await dbFor(null);
    await assertFails(db.ref('live/organisations/orgA/profile').once('value'));
  });

  test('cannot write the profile', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/organisations/orgA/profile/name').set('Renamed'));
  });
});

describe('Portal access - another customer of the SAME org (deny)', () => {
  test('cannot read another customer record', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/customers/orgA/c2').once('value'));
  });

  test('cannot read the whole customers collection', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/customers/orgA').once('value'));
  });

  test('cannot read another customer sites', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/sites/orgA/c2').once('value'));
  });

  test('cannot read buildings under a site they do not own', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/buildings/orgA/s2').once('value'));
  });

  test('cannot read actions for another customer building', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/actions/orgA/b2').once('value'));
  });

  test('cannot read reports for another customer building', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/reports/orgA/building/b2').once('value'));
  });

  test('cannot read another customer customerContacts', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/customerContacts/orgA/c2').once('value'));
  });

  test('cannot read another customer buildingCustomerIndex entry', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/buildingCustomerIndex/orgA/b2').once('value'));
  });
});

describe('Portal access - staff nodes (deny)', () => {
  test('cannot read orgMembers', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/orgMembers/orgA').once('value'));
  });

  test('cannot read jobs', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/jobs/orgA').once('value'));
  });

  test('cannot read assessments (even their own building assessment)', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/assessments/orgA/asmt1').once('value'));
  });

  test('cannot read templates', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/templates/orgA').once('value'));
  });

  test('cannot read the activity log', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/activity/orgA').once('value'));
  });

  test('cannot read orgInvitations', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/orgInvitations/orgA').once('value'));
  });
});

// ============================================================================
// Archived customer -> portal suspension (product decision): archiving a
// customer suspends its portal users' reads across the whole granted slice,
// and restoring the customer lifts the suspension with no claim rewrite - the
// rules read the customer's live status, so the token itself stays valid.
// ============================================================================
describe('Archived customer - the portal grant is suspended (deny)', () => {
  test('an archived customer portal user cannot read their customer record', async () => {
    const db = await dbFor(portalC3);
    await assertFails(db.ref('live/customers/orgA/c3').once('value'));
  });

  test('an archived customer portal user cannot read their sites', async () => {
    const db = await dbFor(portalC3);
    await assertFails(db.ref('live/sites/orgA/c3').once('value'));
  });

  test('an archived customer portal user cannot read their buildings', async () => {
    const db = await dbFor(portalC3);
    await assertFails(db.ref('live/buildings/orgA/s3').once('value'));
  });

  test('an archived customer portal user cannot read their building actions', async () => {
    const db = await dbFor(portalC3);
    await assertFails(db.ref('live/actions/orgA/b3').once('value'));
  });

  test('an archived customer portal user cannot read their building reports', async () => {
    const db = await dbFor(portalC3);
    await assertFails(db.ref('live/reports/orgA/building/b3').once('value'));
  });

  test('an archived customer portal user cannot read their customerContacts', async () => {
    const db = await dbFor(portalC3);
    await assertFails(db.ref('live/customerContacts/orgA/c3').once('value'));
  });

  test('an archived customer portal user cannot read their buildingCustomerIndex entry', async () => {
    const db = await dbFor(portalC3);
    await assertFails(db.ref('live/buildingCustomerIndex/orgA/b3').once('value'));
  });

  test('restoring the customer re-allows the same reads (suspension auto-lifts)', async () => {
    const env = await getTestEnv();
    await seedAsAdmin(env, { 'live/customers/orgA/c3/status': 'active' });
    const db = await dbFor(portalC3);
    await assertSucceeds(db.ref('live/customers/orgA/c3').once('value'));
    await assertSucceeds(db.ref('live/sites/orgA/c3').once('value'));
    await assertSucceeds(db.ref('live/buildings/orgA/s3').once('value'));
    await assertSucceeds(db.ref('live/actions/orgA/b3').once('value'));
    await assertSucceeds(db.ref('live/reports/orgA/building/b3').once('value'));
    await assertSucceeds(db.ref('live/customerContacts/orgA/c3').once('value'));
    await assertSucceeds(db.ref('live/buildingCustomerIndex/orgA/b3').once('value'));
  });
});

describe('Portal access - cross-org and cross-env (deny)', () => {
  test('a portal grant on org B does not open the same customerId in org A', async () => {
    const db = await dbFor(portalWrongOrg);
    await assertFails(db.ref('live/customers/orgA/c1').once('value'));
  });

  test('a live portal user cannot read the test root', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('test/customers/orgA/c1').once('value'));
  });

  test('a test portal user cannot read the live root', async () => {
    const db = await dbFor(portalTestC1);
    await assertFails(db.ref('live/customers/orgA/c1').once('value'));
  });

  test('a test portal user CAN read their own test-root customer record', async () => {
    const db = await dbFor(portalTestC1);
    await assertSucceeds(db.ref('test/customers/orgA/c1').once('value'));
  });
});

describe('Portal access - a portal user cannot write ANYTHING (deny)', () => {
  test('cannot write their own customer record', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/customers/orgA/c1/name').set('Renamed'));
  });

  test('cannot write an action (e.g. mark it resolved)', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/actions/orgA/b1/a1/status').set('resolved'));
  });

  test('cannot write a site', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/sites/orgA/c1/s1/name').set('Renamed site'));
  });

  test('cannot forge a buildingCustomerIndex entry', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/buildingCustomerIndex/orgA/b2').set('c1'));
  });

  test('cannot write a report record', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/reports/orgA/building/b1/r9').set({ generatedAt: 2 }));
  });

  test('cannot write their own customerContacts', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('live/customerContacts/orgA/c1/k9').set({ name: 'New' }));
  });

  test('cannot append to a building log book', async () => {
    const db = await dbFor(portalC1);
    await assertFails(
      db.ref('live/logBook/orgA/b1/e1').set({ type: 'serviceConfirmed', byUid: 'portalC1', at: 1 }),
    );
  });
});

// ============================================================================
// 2. Staff vs portal - the portal-granted child reads do not leak to staff of
//    OTHER orgs (the grant is portalOrgId-scoped, not merely "authenticated").
// ============================================================================
describe('Staff cannot use portal grants across orgs (deny)', () => {
  test('an org B admin cannot read an org A customer record', async () => {
    const db = await dbFor(adminB);
    await assertFails(db.ref('live/customers/orgA/c1').once('value'));
  });

  test('an org B admin cannot read org A building actions', async () => {
    const db = await dbFor(adminB);
    await assertFails(db.ref('live/actions/orgA/b1').once('value'));
  });

  test('an org B admin cannot read org A building reports', async () => {
    const db = await dbFor(adminB);
    await assertFails(db.ref('live/reports/orgA/building/b1').once('value'));
  });

  test('an org B admin cannot read org A customerContacts', async () => {
    const db = await dbFor(adminB);
    await assertFails(db.ref('live/customerContacts/orgA/c1').once('value'));
  });
});

// ============================================================================
// 3. Member status - a locked member's valid token is inert (active-status
//    predicates read the member record live).
// ============================================================================
describe('Locked member (status !== active) is denied despite valid claims', () => {
  test('a locked admin cannot read customers', async () => {
    const db = await dbFor(lockedAdminA);
    await assertFails(db.ref('live/customers/orgA').once('value'));
  });

  test('a locked admin cannot read jobs', async () => {
    const db = await dbFor(lockedAdminA);
    await assertFails(db.ref('live/jobs/orgA').once('value'));
  });

  test('a locked admin cannot read actions', async () => {
    const db = await dbFor(lockedAdminA);
    await assertFails(db.ref('live/actions/orgA').once('value'));
  });

  test('a locked admin cannot write a template draft', async () => {
    const db = await dbFor(lockedAdminA);
    await assertFails(
      db.ref('live/templateDrafts/orgA/t9').set({ name: 'T', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('the same claims WITH an active record still read customers (control)', async () => {
    const db = await dbFor(adminA);
    await assertSucceeds(db.ref('live/customers/orgA').once('value'));
  });
});

// ============================================================================
// 4. Platform operators (finding 2067 AC2) - superAdmin reads everything,
//    writes nothing; /platform/superAdmins is invisible to everyone else.
// ============================================================================
describe('Platform superAdmin cascade', () => {
  test('a superAdmin token reads org A customers (live)', async () => {
    const db = await dbFor(superAdmin);
    await assertSucceeds(db.ref('live/customers/orgA').once('value'));
  });

  test('a superAdmin token reads org B data too (no org scoping)', async () => {
    const db = await dbFor(superAdmin);
    await assertSucceeds(db.ref('live/customers/orgB').once('value'));
  });

  test('a superAdmin token reads across the environment boundary (test root)', async () => {
    const db = await dbFor(superAdmin);
    await assertSucceeds(db.ref('test/customers/orgA').once('value'));
  });

  test('a listed superAdmin reads the /platform tree (DB-gated predicate)', async () => {
    const db = await dbFor(superAdmin);
    await assertSucceeds(db.ref('platform/superAdmins').once('value'));
  });

  test('an org admin (non-superAdmin) cannot read /platform/superAdmins', async () => {
    const db = await dbFor(adminA);
    await assertFails(db.ref('platform/superAdmins').once('value'));
  });

  test('a portal user cannot read /platform/superAdmins', async () => {
    const db = await dbFor(portalC1);
    await assertFails(db.ref('platform/superAdmins').once('value'));
  });

  test('a superAdmin still cannot WRITE an org node (customers)', async () => {
    const db = await dbFor(superAdmin);
    await assertFails(db.ref('live/customers/orgA/c1/name').set('Renamed by operator'));
  });

  test('a superAdmin still cannot WRITE an org node (templates)', async () => {
    const db = await dbFor(superAdmin);
    await assertFails(
      db.ref('live/templates/orgA/t2').set({ name: 'T', version: 1, status: 'draft', sections: [] }),
    );
  });

  test('a superAdmin cannot appoint another superAdmin (platform write deny)', async () => {
    const db = await dbFor(superAdmin);
    await assertFails(db.ref('platform/superAdmins/newOperator').set(true));
  });
});
