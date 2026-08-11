// ============================================================================
// backfillUsage - one-off operator script, run at the Phase 3 counter deploy.
//
// organisations/{orgId}/usage existed in the schema before anything maintained
// it: createOrganisation now seeds it and the callables adjust it, but every
// org founded before that deploy carries a missing (or stale) node. This script
// re-derives the truth for every org in BOTH env roots from the source records:
//   - staffCount:    NON-ARCHIVED orgMembers (a locked member still holds their
//                    seat - lock blocks sign-in, it is not a departure),
//                    matching what the runtime adjusters maintain.
//   - customerCount: non-archived customers, same rule.
//   - notificationsThisMonth: the current month's value from the enforcement
//                    ledger (ops/notificationCounts), 0 when the org has not
//                    sent this month.
// The whole usage node is SET from those counts, so the script is idempotent -
// re-running it (or racing a live adjuster by one operation) converges on the
// derived truth rather than compounding.
//
// DRY RUN BY DEFAULT: without the --apply flag it only reports what it WOULD
// write. Run it once dry, eyeball the per-org lines, then re-run with --apply.
//
// Run (from functions/, credentials as grantSuperAdmin - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   FIREBASE_DATABASE_URL=<rtdb url> \
//     npx ts-node src/scripts/backfillUsage.ts [--apply]
// ============================================================================

import { db } from '../admin';
import { forEnv, paths } from '../lib/paths';
import { currentLedgerMonth } from '../lib/notifications';
import type {
  Customer,
  Environment,
  Keyed,
  OrgMember,
  OrgUsage,
} from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(
    apply
      ? 'APPLY mode: usage nodes WILL be written.'
      : 'DRY RUN (default): nothing will be written. Re-run with --apply to write.',
  );

  const month = currentLedgerMonth();
  console.log(`Notification month bucket: ${month}`);

  let orgsSeen = 0;
  for (const env of ENVIRONMENTS) {
    const envPaths = forEnv(env);
    const orgsSnap = await db.ref(envPaths.db.organisationsRoot()).get();
    if (!orgsSnap.exists()) {
      console.log(`[${env}] no organisations`);
      continue;
    }
    const orgIds = Object.keys(orgsSnap.val() as Keyed<unknown>);

    for (const orgId of orgIds) {
      orgsSeen += 1;

      // Staff seats: every member whose record has not been archived.
      const membersSnap = await db.ref(envPaths.db.orgMembers(orgId)).get();
      const members = (membersSnap.val() as Keyed<OrgMember> | null) ?? {};
      const staffCount = Object.values(members).filter(
        (member) => member?.status !== 'archived',
      ).length;

      // Customers: every record not archived (manually or by the contract sweep).
      const customersSnap = await db.ref(envPaths.db.customers(orgId)).get();
      const customers = (customersSnap.val() as Keyed<Customer> | null) ?? {};
      const customerCount = Object.values(customers).filter(
        (customer) => customer?.status !== 'archived',
      ).length;

      // This month's sends, from the enforcement ledger; absent means none yet.
      const ledgerSnap = await db
        .ref(paths.ops.notificationCount(env, orgId, month))
        .get();
      const ledgerValue = ledgerSnap.val();
      const notificationsThisMonth =
        typeof ledgerValue === 'number' ? ledgerValue : 0;

      const usage: OrgUsage = {
        staffCount,
        customerCount,
        notificationsThisMonth,
      };
      console.log(
        `  [${env}] ${orgId}: staff=${staffCount} customers=${customerCount} ` +
          `notifications=${notificationsThisMonth}${apply ? '' : ' (would write)'}`,
      );
      if (apply) {
        await db.ref(envPaths.db.orgUsage(orgId)).set(usage);
      }
    }
  }

  console.log('\nSummary');
  console.log(`  organisations ${apply ? 'written' : 'inspected'}: ${orgsSeen}`);
  if (!apply && orgsSeen > 0) {
    console.log('\nDry run only. Re-run with --apply to write the usage nodes.');
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error('backfillUsage failed:', error);
  process.exit(1);
});
