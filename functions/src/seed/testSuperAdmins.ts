// ============================================================================
// Grant (or revoke) platform super-admin for the Firerite field-test assessors.
//
// TEMPORARY, BY DESIGN. The trial needs the testers to reach the Super Admin
// Dashboard; this turns that on for the 13 accounts testAssessors.ts created, and
// turns it off again just as easily:
//
//   npx ts-node src/seed/testSuperAdmins.ts          # grant
//   npx ts-node src/seed/testSuperAdmins.ts --revoke # take it back
//
// Needs application-default credentials:
//   gcloud auth application-default login
//
// ----------------------------------------------------------------------------
// READ THIS BEFORE LEAVING IT ON
//
// Super admin is NOT environment-scoped, and cannot be made so from here. The
// database rules put the grant on `$env` itself:
//
//     "$env": { ".read": "auth != null && auth.token.superAdmin === true" }
//
// An RTDB read granted at a node CASCADES to everything beneath it and cannot be
// narrowed by a deeper rule, so `superAdmin: true` reads the WHOLE tree - `/live`
// as well as `/test` - bypassing the per-org and testMode boundaries that gate
// every other account. There is no "super admin in test mode only" in the data
// model; the platform screens simply have an environment toggle, which defaults
// to 'live'.
//
// That is harmless while `/live` is empty (it was null when this was written,
// 2026-07-30, and the console had never been deployed). It stops being harmless
// the moment real customer data lands in `/live`.
//
//   => REVOKE THIS BEFORE GO-LIVE, or make the $env rule env-aware first.
// ============================================================================

import * as admin from 'firebase-admin';

/** The 13 field-test accounts, by email - the stable identifier, since uids
 *  differ depending on whether the account pre-existed (see ensureUser in
 *  testAssessors.ts, which reuses an account when the email already exists). */
const TESTER_EMAILS = [
  'gareth@firerite.co.uk',
  'gevans@firerite.co.uk',
  'OwenJayne@firerite.co.uk',
  'Tony.ryder@firerite.co.uk',
  'Geraint@firerite.co.uk',
  'Carl@firerite.co.uk',
  'John.Keenan@firerite.co.uk',
  'nick.suller@firerite.co.uk',
  'phill@firerite.co.uk',
  'Craig.Evans@firerite.co.uk',
  'Neil.Griffiths@firerite.co.uk',
  'James.Murray@firerite.co.uk',
  'mal@firerite.co.uk',
] as const;

const REVOKE = process.argv.includes('--revoke');

function initAdmin(): void {
  if (admin.apps.length > 0) {
    return;
  }
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: 'https://safentia-tech-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'safentia-tech',
  });
}

async function run(): Promise<void> {
  initAdmin();
  const auth = admin.auth();
  const db = admin.database();

  console.log(
    `${REVOKE ? 'Revoking' : 'Granting'} platform super-admin for ${TESTER_EMAILS.length} test assessors...`,
  );

  let done = 0;
  for (const email of TESTER_EMAILS) {
    let user: admin.auth.UserRecord;
    try {
      user = await auth.getUserByEmail(email);
    } catch {
      console.log(`  - ${email}: NO ACCOUNT (skipped)`);
      continue;
    }

    // 1. The durable source of truth. computeClaims reads this node and re-adds
    //    superAdmin on every future claim recompute, so a later membership change
    //    cannot silently strip it (or, on revoke, silently restore it).
    await db.ref(`platform/superAdmins/${user.uid}`).set(REVOKE ? null : true);

    // 2. The token itself. Claims are only re-minted on a membership change, so
    //    without this the grant would not reach the session until something else
    //    happened to trigger a recompute. Existing claims are PRESERVED - orgId,
    //    roles and testMode all still matter; this only adds or removes the one
    //    flag.
    const existing = (user.customClaims ?? {}) as Record<string, unknown>;
    const next = { ...existing };
    if (REVOKE) {
      delete next.superAdmin;
    } else {
      next.superAdmin = true;
    }
    await auth.setCustomUserClaims(user.uid, next);

    done += 1;
    console.log(`  - ${email} (${user.uid}): ${REVOKE ? 'revoked' : 'granted'}`);
  }

  console.log(
    `\n${done}/${TESTER_EMAILS.length} updated.` +
      (REVOKE
        ? ''
        : '\nTesters must SIGN OUT AND BACK IN for the new token to take effect.'),
  );
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
