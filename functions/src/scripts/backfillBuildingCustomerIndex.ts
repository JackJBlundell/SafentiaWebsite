// ============================================================================
// backfillBuildingCustomerIndex - rebuild the building -> customer reverse index.
//
// `/{env}/buildingCustomerIndex/{orgId}/{buildingId}` = customerId is what the
// PORTAL security rules key on: a customer contact may read a building's reports
// and actions only when this index maps that building to their own customer.
// `manageBuilding` writes it on every create and keeps it in sync, but buildings
// created by other means (older seed/import paths) can lack it, and a portal user
// then sees denied reads that surface as blank or "could not be loaded" panels.
//
// The mapping is fully DERIVABLE and needs no external input: a building sits
// under a site (`/buildings/{orgId}/{siteId}`), and a site sits under its
// customer (`/sites/{orgId}/{customerId}/{siteId}`), so building -> site ->
// customer is unambiguous. That makes this safe to re-run: it only ever writes
// the value the data already implies, and it CORRECTS a wrong entry as well as
// filling a missing one.
//
// Dry run by default. Pass --apply to write. Targets `test` unless --env=live.
//
//   FIREBASE_DATABASE_URL=... npx ts-node src/scripts/backfillBuildingCustomerIndex.ts
//   FIREBASE_DATABASE_URL=... npx ts-node src/scripts/backfillBuildingCustomerIndex.ts --apply
// ============================================================================

import { db } from '../admin';
import { forEnv } from '../shared/paths';
import type { Building, Customer, Environment, Keyed, Site } from '../shared/types';

const apply = process.argv.includes('--apply');
const envArg = process.argv.find((a) => a.startsWith('--env='));
const env: Environment = envArg?.split('=')[1] === 'live' ? 'live' : 'test';

async function main(): Promise<void> {
  const paths = forEnv(env);

  console.log(apply ? 'APPLY mode: the index WILL be rewritten.' : 'DRY RUN: nothing will be written.');
  console.log(`  env: ${env}`);

  // Every org that has any customers, so the walk covers the whole tenant tree
  // rather than a single hard-coded org.
  const orgsSnap = await db.ref(paths.db.organisationsRoot()).get();
  const orgIds = Object.keys((orgsSnap.val() ?? {}) as Record<string, unknown>);

  let missing = 0;
  let corrected = 0;
  let alreadyRight = 0;
  const update: Record<string, string> = {};

  for (const orgId of orgIds) {
    // site -> customer. There is no all-sites-under-an-org path builder (sites
    // are addressed per customer), so walk each customer's sites via the
    // existing `sites(orgId, customerId)` builder rather than hand-typing a root.
    const customersSnap = await db.ref(paths.db.customers(orgId)).get();
    const customerIds = Object.keys(
      (customersSnap.val() ?? {}) as Record<string, Customer>,
    );
    const siteOwner = new Map<string, string>();
    for (const customerId of customerIds) {
      const custSitesSnap = await db.ref(paths.db.sites(orgId, customerId)).get();
      const custSites = (custSitesSnap.val() ?? {}) as Keyed<Site>;
      for (const siteId of Object.keys(custSites)) {
        siteOwner.set(siteId, customerId);
      }
    }

    const indexSnap = await db.ref(paths.db.buildingCustomerIndex(orgId)).get();
    const index = (indexSnap.val() ?? {}) as Record<string, string>;

    // building -> site, from /buildings/{orgId}/{siteId}.
    const buildingsSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
    const buildingsBySite = (buildingsSnap.val() ?? {}) as Keyed<Keyed<Building>>;

    for (const [siteId, buildings] of Object.entries(buildingsBySite)) {
      const owner = siteOwner.get(siteId);
      if (!owner) {
        // A building under a site with no customer is a deeper data fault the
        // index cannot paper over; report it rather than guessing an owner.
        console.warn(`  orphan site ${siteId} (no customer) in ${orgId}, skipped`);
        continue;
      }
      for (const buildingId of Object.keys(buildings ?? {})) {
        const current = index[buildingId];
        if (current === owner) {
          alreadyRight += 1;
          continue;
        }
        if (current === undefined) {
          missing += 1;
        } else {
          corrected += 1;
          console.warn(`  correcting ${buildingId}: ${current} -> ${owner}`);
        }
        update[paths.db.buildingCustomer(orgId, buildingId)] = owner;
      }
    }
  }

  console.log(`\n  already correct: ${alreadyRight}`);
  console.log(`  missing:         ${missing}`);
  console.log(`  corrected:       ${corrected}`);
  console.log(`  writes queued:   ${Object.keys(update).length}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.');
    process.exit(0);
  }

  if (Object.keys(update).length > 0) {
    await db.ref().update(update);
  }
  console.log(`\nDone. ${Object.keys(update).length} index entrie(s) written.`);
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
