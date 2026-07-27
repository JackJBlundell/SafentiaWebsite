// ============================================================================
// backfillEmailVerified - one-off operator script, run BEFORE the console's
// email-verification gate ships.
//
// acceptInvitation historically created Auth users without setting
// emailVerified, so every account minted by the invite flow is recorded as
// UNVERIFIED even though its owner proved the address by round-tripping a
// single-use token that was emailed only to them. The callable now stamps the
// flag; this script repairs the accounts created before it did. The console
// gate (fireritesite/src/console/ConsoleRoute.tsx) locks out anyone still
// unverified, so this MUST be applied first or existing users are stranded.
//
// SCOPE: an account is only stamped when it demonstrably holds a membership in
// either env root - it appears under /{env}/orgMembers/{orgId}/{uid}, under
// /{env}/customerMembers/{orgId}/{customerId}/{uid}, or as the linked `uid` of
// a CustomerContact. An Auth user with no membership anywhere proved nothing to
// us, so it is left alone and reported rather than silently blessed.
//
// DRY RUN BY DEFAULT: without the --apply flag it only reports what it WOULD
// change. Run it once dry, eyeball the summary, then re-run with --apply.
//
// Run (from functions/, credentials as grantSuperAdmin - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   FIREBASE_DATABASE_URL=<rtdb url> \
//     npx ts-node src/scripts/backfillEmailVerified.ts [--apply]
// ============================================================================

import { auth, db } from '../admin';
import { forEnv } from '../shared/paths';
import type {
  CustomerContact,
  Environment,
  Keyed,
  OrgMember,
} from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/**
 * Every uid that holds a membership anywhere, in either env root. Built once up
 * front so the per-user decision below is a set lookup rather than a database
 * round trip per Auth user (Auth pages are large; the membership tree is not).
 */
async function collectMemberUids(): Promise<Set<string>> {
  const uids = new Set<string>();

  for (const env of ENVIRONMENTS) {
    const paths = forEnv(env);
    const orgsSnap = await db.ref(paths.db.organisationsRoot()).get();
    if (!orgsSnap.exists()) {
      continue;
    }
    const orgIds = Object.keys(orgsSnap.val() as Keyed<unknown>);

    for (const orgId of orgIds) {
      // Staff memberships: the uid IS the key.
      const membersSnap = await db.ref(paths.db.orgMembers(orgId)).get();
      for (const uid of Object.keys(
        (membersSnap.val() as Keyed<OrgMember> | null) ?? {},
      )) {
        uids.add(uid);
      }

      const customersSnap = await db.ref(paths.db.customers(orgId)).get();
      const customerIds = Object.keys(
        (customersSnap.val() as Keyed<unknown> | null) ?? {},
      );
      for (const customerId of customerIds) {
        // Portal memberships are also keyed by uid.
        const portalSnap = await db
          .ref(paths.db.customerMembers(orgId, customerId))
          .get();
        for (const uid of Object.keys(
          (portalSnap.val() as Keyed<unknown> | null) ?? {},
        )) {
          uids.add(uid);
        }
        // A contact carries the linked account on a `uid` field, not as its key.
        const contactsSnap = await db
          .ref(paths.db.customerContacts(orgId, customerId))
          .get();
        const contacts =
          (contactsSnap.val() as Keyed<CustomerContact> | null) ?? {};
        for (const contact of Object.values(contacts)) {
          if (typeof contact?.uid === 'string' && contact.uid.length > 0) {
            uids.add(contact.uid);
          }
        }
      }
    }
  }

  return uids;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(
    apply
      ? 'APPLY mode: emailVerified WILL be written.'
      : 'DRY RUN (default): nothing will be written. Re-run with --apply to write.',
  );

  const memberUids = await collectMemberUids();
  console.log(`Members found across both env roots: ${memberUids.size}`);

  let total = 0;
  let alreadyVerified = 0;
  let changed = 0;
  let skippedNoMembership = 0;

  // listUsers returns at most 1000 accounts per call, so the page token is
  // followed to exhaustion; a single call would silently miss the tail.
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      total += 1;
      if (user.emailVerified) {
        alreadyVerified += 1;
        continue;
      }
      if (!memberUids.has(user.uid)) {
        skippedNoMembership += 1;
        // The uid alone identifies the account for an operator without putting
        // an email address in the log (CONVENTIONS section 5).
        console.log(`  no membership, left unverified: ${user.uid}`);
        continue;
      }
      changed += 1;
      if (apply) {
        await auth.updateUser(user.uid, { emailVerified: true });
        console.log(`  verified ${user.uid}`);
      } else {
        console.log(`  would verify ${user.uid}`);
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  console.log('\nSummary');
  console.log(`  total Auth users:        ${total}`);
  console.log(`  already verified:        ${alreadyVerified}`);
  console.log(
    `  ${apply ? 'verified' : 'would verify'}:            ${changed}`,
  );
  console.log(`  skipped (no membership): ${skippedNoMembership}`);
  if (!apply && changed > 0) {
    console.log('\nDry run only. Re-run with --apply to write the flag.');
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error('backfillEmailVerified failed:', error);
  process.exit(1);
});
