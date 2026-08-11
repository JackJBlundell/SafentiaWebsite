// ============================================================================
// grantTestMode - operator script for exercising the self-serve subscribe
// journey in Stripe TEST mode (Phase 3 §8).
//
// A brand-new account has no claims, so envFromTestMode defaults it to LIVE -
// deliberately: a real customer must never wander into the test environment.
// Testing the subscribe flow end-to-end therefore needs this one operator act
// on a fresh account, BEFORE it subscribes:
//
//   merges `testMode: true` into the account's existing custom claims, so
//   createSubscription derives env 'test' -> the TEST Stripe keyspace, the
//   /test tenant root, and the ?mode=test webhook. provisionOrganisation then
//   stamps testMode onto the founding member record, at which point membership
//   (onMembershipChange) carries the claim durably and this grant has done
//   its job.
//
// KNOWN INTERPLAY: same as grantSuperAdmin - a membership recompute REPLACES
// claims, but for the org-less account this script targets there is no
// membership to recompute until provisioning, which preserves the flag.
//
// Run (from functions/): GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   npx ts-node src/scripts/grantTestMode.ts someone@example.com
// ============================================================================

import { auth, db } from '../admin';
import { paths } from '../lib/paths';

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email || !email.includes('@')) {
    console.error(
      'Usage: npx ts-node src/scripts/grantTestMode.ts <account email>',
    );
    process.exit(1);
  }

  // Only a genuine not-found means "no account": any other failure (bad
  // credentials, wrong project, quota) must surface as itself - a swallowed
  // 403 once masqueraded as "no account exists" and cost a debugging session.
  const user = await auth.getUserByEmail(email).catch((error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === 'auth/user-not-found') return null;
    throw error;
  });
  if (!user) {
    console.error(`No account exists for ${email}. Nothing was changed.`);
    process.exit(1);
  }

  // Merge, never replace: the account keeps any claims it already holds.
  const merged = { ...(user.customClaims ?? {}), testMode: true };
  await auth.setCustomUserClaims(user.uid, merged);
  await db.ref(paths.platform.tokenRefresh(user.uid)).set(Date.now());

  console.log(`Test mode granted to ${email} (uid ${user.uid}).`);
  console.log(
    'Sign out and back in (or wait for the automatic token refresh), then the',
  );
  console.log(
    'subscribe journey runs entirely against Stripe TEST mode - card 4242 4242 4242 4242.',
  );
  process.exit(0);
}

void main().catch((error) => {
  console.error('grantTestMode failed:', error);
  process.exit(1);
});
