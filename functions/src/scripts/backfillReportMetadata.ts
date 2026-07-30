// ============================================================================
// backfillReportMetadata - one-off operator script for the portal launch.
//
// SUPERSEDED AS A REPAIR, KEPT AS AN AUDIT. Portal downloads no longer depend
// on this stamp: getReportDownloadUrl re-derives ownership from live database
// state per request and the Storage rule grants a portal token nothing. So
// running this NEVER restores anybody's access - if a customer cannot open a
// report, the answer is in the callable's denial, not in the object's metadata.
// What it still does usefully is find objects whose recorded provenance is
// missing or disagrees with the current owner, which is the fingerprint of a
// stale /buildingCustomerIndex or a building that changed hands.
//
// It walks every recorded report, resolves the owning customer via
// /{env}/buildingCustomerIndex, and stamps customMetadata.customerId onto the
// Storage object WHERE IT IS ABSENT OR EMPTY. Already-stamped objects are never
// touched, so re-running is safe.
//
// The PDF is never re-rendered: custom metadata is updated IN PLACE with the
// Admin SDK, so the stored document, its generation date and the customer's
// recorded acceptance are all untouched. That matters - regenerating instead
// would mint a NEW report record with no acceptance on it, and the customer
// would be asked to sign off again.
//
// DRY RUN BY DEFAULT: without the --apply flag it only reports what it WOULD
// change. Run it once dry, eyeball the summary, then re-run with --apply.
// Re-running is safe: an object already carrying a non-empty customerId is
// counted and skipped, never rewritten.
//
// Both environments are walked by default (test and live are separate trees in
// the same project); pass --env=live or --env=test to narrow.
//
// Run (from functions/, credentials as grantSuperAdmin - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   FIREBASE_DATABASE_URL=<rtdb url> FIREBASE_STORAGE_BUCKET=<bucket> \
//     npx ts-node src/scripts/backfillReportMetadata.ts [--env=live] [--apply]
// ============================================================================

import { db, storage } from '../admin';
import { forEnv } from '../shared/paths';
import type {
  Building,
  Environment,
  Report,
  ReportScope,
  Keyed,
} from '../shared/types';

const ALL_ENVIRONMENTS: Environment[] = ['live', 'test'];

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const envArg = process.argv.find((a) => a.startsWith('--env='))?.split('=')[1];
  if (envArg && envArg !== 'live' && envArg !== 'test') {
    console.error(`Unknown --env=${envArg}. Use --env=live or --env=test.`);
    process.exit(1);
  }
  const environments = envArg
    ? [envArg as Environment]
    : ALL_ENVIRONMENTS;
  console.log(
    apply
      ? 'APPLY mode: object metadata WILL be written.'
      : 'DRY RUN (default): no metadata will be written. Re-run with --apply to write.',
  );
  console.log(`  environments: ${environments.join(', ')}`);

  const bucket = storage.bucket();
  let examined = 0;
  let alreadyStamped = 0;
  let stamped = 0;
  let noIndexEntry = 0;
  let missingObject = 0;
  let mismatched = 0;

  for (const env of environments) {
    const paths = forEnv(env);
    // The whole reports tree for the env:
    // { orgId: { scope: { scopeId: { reportId: Report } } } }.
    const snap = await db.ref(`${env}/reports`).get();
    if (!snap.exists()) {
      continue;
    }
    const byOrg = snap.val() as Keyed<
      Partial<Record<ReportScope, Keyed<Keyed<Report>>>>
    >;

    for (const [orgId, scopes] of Object.entries(byOrg)) {
      // One index read per org: buildingId -> customerId.
      const indexSnap = await db
        .ref(paths.db.buildingCustomerIndex(orgId))
        .get();
      const index = (indexSnap.val() as Keyed<string> | null) ?? {};

      // The building records themselves, flattened to buildingId -> customerId.
      // A report is stamped blank precisely BECAUSE the index entry was missing
      // when it was generated, so resolving from the index alone would refuse to
      // repair the very reports this script exists for. `Building.customerId` is
      // the field manageBuilding derives the index from, so this is the same
      // answer from one step closer to the source. Run
      // backfillBuildingCustomerIndex too where this branch fires - the missing
      // entry also denies the portal's RTDB reads.
      const buildingsSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
      const owners = new Map<string, string>();
      for (const buildings of Object.values(
        (buildingsSnap.val() as Keyed<Keyed<Building>> | null) ?? {},
      )) {
        for (const [buildingId, building] of Object.entries(buildings ?? {})) {
          if (building?.customerId) {
            owners.set(buildingId, building.customerId);
          }
        }
      }

      for (const [scope, scopeIds] of Object.entries(scopes ?? {})) {
        for (const [scopeId, reports] of Object.entries(scopeIds ?? {})) {
          for (const [reportId, report] of Object.entries(reports ?? {})) {
            const pdfPath = report?.pdfPath;
            if (typeof pdfPath !== 'string' || pdfPath.length === 0) {
              continue;
            }
            examined += 1;

            // Reports are building-scoped today (generateAndStore); the owning
            // customer is the building's index entry, or the building record
            // when the index has none. A report under another scope has no
            // building to resolve - skip and count it.
            const customerId =
              scope === 'building'
                ? (index[scopeId] ?? owners.get(scopeId))
                : undefined;
            if (!customerId) {
              noIndexEntry += 1;
              console.log(
                `  no customer resolvable: ${env}/${orgId}/${scope}/${scopeId}/${reportId}`,
              );
              continue;
            }
            if (!index[scopeId]) {
              console.warn(
                `  index entry missing for building ${scopeId} (${orgId}); resolved from the building record - run backfillBuildingCustomerIndex`,
              );
            }

            const file = bucket.file(pdfPath);
            const [exists] = await file.exists();
            if (!exists) {
              missingObject += 1;
              console.log(`  object missing in Storage: ${pdfPath}`);
              continue;
            }
            const [meta] = await file.getMetadata();
            const current = (meta.metadata ?? {})['customerId'];
            if (typeof current === 'string' && current.length > 0) {
              alreadyStamped += 1;
              if (current !== customerId) {
                // Reported, never rewritten. A stamp naming a DIFFERENT
                // customer is the fingerprint of a building that changed hands:
                // the index followed it, the historical objects did not. Who
                // may read an old report after a transfer is an ownership
                // decision, not a repair, so it is escalated rather than
                // guessed at by a script.
                mismatched += 1;
                console.warn(
                  `  stamp disagrees with the owner: ${pdfPath} has ${current}, index/building says ${customerId}`,
                );
              }
              continue;
            }

            stamped += 1;
            if (apply) {
              // setMetadata MERGES the custom metadata map, so nothing else on
              // the object (cacheControl, contentType) is disturbed, and the
              // bytes are never rewritten.
              await file.setMetadata({ metadata: { customerId } });
              console.log(`  stamped ${pdfPath} -> customerId=${customerId}`);
            } else {
              console.log(
                `  would stamp ${pdfPath} -> customerId=${customerId}`,
              );
            }
          }
        }
      }
    }
  }

  console.log('\nSummary');
  console.log(`  reports examined:        ${examined}`);
  console.log(`  already stamped:         ${alreadyStamped}`);
  console.log(
    `  ${apply ? 'stamped' : 'would stamp'}:            ${stamped}`,
  );
  console.log(`  no customer resolvable:  ${noIndexEntry}`);
  console.log(`  object missing:          ${missingObject}`);
  console.log(`  stamp disagrees:         ${mismatched} (reported only)`);
  if (!apply && stamped > 0) {
    console.log('\nDry run only. Re-run with --apply to write the metadata.');
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error('backfillReportMetadata failed:', error);
  process.exit(1);
});
