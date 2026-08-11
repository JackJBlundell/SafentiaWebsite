// ============================================================================
// grantSuperAdmin - operator script for FR-E24 (story 2067).
//
// Grants platform-oversight access to ONE existing account, by email:
//   1. merges `superAdmin: true` into the user's EXISTING custom claims (the
//      $env rules cascade reads `auth.token.superAdmin === true`). Merging, not
//      replacing, so the account keeps its org membership claims.
//   2. sets /platform/superAdmins/{uid} = true - the server-only marker the
//      /platform read rule checks, and the durable record of who holds the
//      grant (custom claims are not enumerable).
//   3. stamps the token-refresh marker so the signed-in client picks the claim
//      up within seconds (same mechanism as lib/claims writeClaims).
//
// KNOWN INTERPLAY: onMembershipChange recomputes claims from the member record
// and setCustomUserClaims REPLACES the object, so a later membership change to
// this account strips the claim. The /platform/superAdmins marker survives;
// re-run this script to re-grant. Kept deliberate: membership stays the single
// source of org claims, and a super-admin grant is a rare, logged operator act.
//
// Run (from functions/): GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   npx ts-node src/scripts/grantSuperAdmin.ts someone@example.com
// ============================================================================

import { auth, db } from '../admin';
import { paths } from '../lib/paths';

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email || !email.includes('@')) {
    console.error(
      'Usage: npx ts-node src/scripts/grantSuperAdmin.ts <account email>',
    );
    process.exit(1);
  }

  // Only a genuine not-found means "no account": any other failure (bad
  // credentials, wrong project, quota) must surface as itself, not be
  // mistaken for a missing user (see grantTestMode for the war story).
  const user = await auth.getUserByEmail(email).catch((error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === 'auth/user-not-found') return null;
    throw error;
  });
  if (!user) {
    console.error(`No account exists for ${email}. Nothing was changed.`);
    process.exit(1);
  }

  // Merge, never replace: the account keeps its orgId/roles claims.
  const merged = { ...(user.customClaims ?? {}), superAdmin: true };
  await auth.setCustomUserClaims(user.uid, merged);
  await db.ref(paths.platform.superAdmin(user.uid)).set(true);
  await db.ref(paths.platform.tokenRefresh(user.uid)).set(Date.now());

  console.log(`Super admin granted to ${email} (uid ${user.uid}).`);
  console.log(
    'The signed-in client refreshes its token automatically; a fresh sign-in also works.',
  );
  process.exit(0);
}

void main().catch((error) => {
  console.error('grantSuperAdmin failed:', error);
  process.exit(1);
});
