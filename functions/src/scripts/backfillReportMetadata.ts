// ============================================================================
// backfillReportMetadata - one-off operator script for the portal launch.
//
// Portal users read report PDFs through the Storage rule that checks the
// object's CUSTOM metadata: resource.metadata.customerId must equal the
// caller's customerId claim (storage.rules, reports match). generateAndStore
// stamps that metadata on every NEW report, but reports generated before the
// stamp existed carry none - so the owning customer's portal users would be
// denied their own historical reports. This script walks every recorded
// report, resolves the owning customer via /{env}/buildingCustomerIndex, and
// stamps customMetadata.customerId onto the Storage object WHERE IT IS ABSENT
// OR EMPTY. Already-stamped objects are never touched, so re-running is safe.
//
// DRY RUN BY DEFAULT: without the --apply flag it only reports what it WOULD
// change. Run it once dry, eyeball the summary, then re-run with --apply.
//
// Run (from functions/, credentials as grantSuperAdmin - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   FIREBASE_DATABASE_URL=<rtdb url> FIREBASE_STORAGE_BUCKET=<bucket> \
//     npx ts-node src/scripts/backfillReportMetadata.ts [--apply]
// ============================================================================

import { db, storage } from '../admin';
import { forEnv } from '../shared/paths';
import type { Environment, Report, ReportScope, Keyed } from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(
    apply
      ? 'APPLY mode: object metadata WILL be written.'
      : 'DRY RUN (default): no metadata will be written. Re-run with --apply to write.',
  );

  const bucket = storage.bucket();
  let examined = 0;
  let alreadyStamped = 0;
  let stamped = 0;
  let noIndexEntry = 0;
  let missingObject = 0;

  for (const env of ENVIRONMENTS) {
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

      for (const [scope, scopeIds] of Object.entries(scopes ?? {})) {
        for (const [scopeId, reports] of Object.entries(scopeIds ?? {})) {
          for (const [reportId, report] of Object.entries(reports ?? {})) {
            const pdfPath = report?.pdfPath;
            if (typeof pdfPath !== 'string' || pdfPath.length === 0) {
              continue;
            }
            examined += 1;

            // Reports are building-scoped today (generateAndStore); the owning
            // customer is the building's index entry. A report under another
            // scope has no building to resolve - skip and count it.
            const customerId =
              scope === 'building' ? index[scopeId] : undefined;
            if (!customerId) {
              noIndexEntry += 1;
              console.log(
                `  no customer resolvable: ${env}/${orgId}/${scope}/${scopeId}/${reportId}`,
              );
              continue;
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
              continue;
            }

            stamped += 1;
            if (apply) {
              // setMetadata MERGES the custom metadata map, so nothing else on
              // the object (cacheControl, contentType) is disturbed.
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
  if (!apply && stamped > 0) {
    console.log('\nDry run only. Re-run with --apply to write the metadata.');
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error('backfillReportMetadata failed:', error);
  process.exit(1);
});
