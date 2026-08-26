// ============================================================================
// deleteOrganisation - operator tool: immediately and PERMANENTLY erase ALL of
// one organisation's data (DECISIONS §8, immediate-deletion-on-request).
//
// This is the manual counterpart to the nightly cleanupExpiredOrgs sweep: it
// runs the SAME shared deleteOrgData core, but with NO retention-clock gate - a
// customer has asked for their data to be deleted now, so the 12-month clock
// does not apply. There is no self-service deletion; only an operator runs this.
//
// It is a DRY RUN by default: it prints exactly what it would erase and writes
// nothing. Pass --apply to actually delete. Because the erase is irreversible,
// take (or confirm) a fresh export first with exportOrgData.ts, and prefer
// running the dry run and reading its report before adding --apply.
//
// What it erases (via deleteOrgData): every org-scoped RTDB subtree, the org's
// per-user reverse-index entries (userOrgs, customerUserIndex), the Stripe
// reverse markers, and the whole `{env}/orgs/{orgId}/` Storage prefix. Firebase
// Auth accounts are LEFT INTACT (a person may belong to other orgs); their
// claims are stripped of this org when they still point at it. One `org_deleted`
// entry is appended to the super-admin finance feed.
//
// Run (from functions/, credentials as the other scripts - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> FIREBASE_DATABASE_URL=<rtdb-url> \
//     npx ts-node src/scripts/deleteOrganisation.ts --org <orgId> \
//       [--env live|test] [--apply]
//
// --env defaults to live. Without --apply it is a dry run.
// ============================================================================

import { createLogger } from '../lib/logging';
import { deleteOrgData } from '../lib/deleteOrgData';
import type { Environment } from '../shared/types';

function readFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`deleteOrganisation: ${message}.`);
  console.error(
    'Usage: npx ts-node src/scripts/deleteOrganisation.ts --org <orgId> ' +
      '[--env live|test] [--apply]',
  );
  process.exit(1);
}

function parseArgs(argv: string[]): {
  orgId: string;
  env: Environment;
  apply: boolean;
} {
  const orgId = readFlag(argv, '--org');
  const envArg = readFlag(argv, '--env') ?? 'live';
  const apply = argv.includes('--apply');
  if (!orgId) {
    fail('a --org <orgId> argument is required');
  }
  if (envArg !== 'live' && envArg !== 'test') {
    fail(`--env must be "live" or "test" (got "${envArg}")`);
  }
  return { orgId, env: envArg, apply };
}

async function main(): Promise<void> {
  const { orgId, env, apply } = parseArgs(process.argv.slice(2));
  const logger = createLogger({ fn: 'deleteOrganisation' });

  console.log(
    `deleteOrganisation: ${apply ? 'APPLY (destructive)' : 'DRY RUN'} - ` +
      `org ${orgId} (${env}).`,
  );

  const report = await deleteOrgData(env, orgId, logger, { apply });

  console.log(
    `${apply ? 'Deleted' : 'Would delete'} org ${report.orgId} (${env})` +
      `${report.orgName ? ` "${report.orgName}"` : ''}:`,
  );
  console.log(`  RTDB subtree roots: ${report.rtdbRoots.length}`);
  console.log(`    ${report.rtdbRoots.join(', ')}`);
  console.log(
    `  Storage prefix:     ${report.storagePrefix} (${report.storageObjects} objects)`,
  );
  console.log(`  Staff members:      ${report.staffMembers}`);
  console.log(`  Portal members:     ${report.portalMembers}`);
  if (apply) {
    console.log(`  Auth claims cleared: ${report.claimsCleared}`);
  }
  if (!apply) {
    console.log('\nDry run only - nothing was changed. Re-run with --apply to delete.');
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error('deleteOrganisation failed:', error);
  process.exit(1);
});
