// ============================================================================
// migrateBs9792ToV1 - collapse the BS 9792 base template's development history.
//
// The template ran to v3 in /test, because its number had been tracking OUR
// revisions of the seed during development: the deployed copy drifted to 2, and
// the section 34 matrix estimator was a content change on top of that. No
// customer has ever seen any of it.
//
// This is a new product going to new organisations. A base template arriving at
// v3 invites the obvious question of where 1 and 2 went, and the honest answer -
// "they were our drafts" - is not something a tenant should have to be told. So
// the CONTENT stays exactly as it is and only the number resets, along with the
// three things that would otherwise be left pointing at a version that no longer
// exists:
//
//   1. the template itself, republished at v1 into every organisation;
//   2. every JOB pinned to the old version - a pin is how a job remembers which
//      question set it was scheduled against, so a stale one would compare wrong
//      against the live template for the rest of that job's life;
//   3. the /templateVersions archive entry for the intermediate version, which
//      is an archive of drafts and would otherwise be the only surviving
//      evidence of a history we are deliberately removing.
//
// ASSESSMENTS ARE DELIBERATELY UNTOUCHED. An assessment carries a full
// templateSnapshot - the questions it was actually answered against - and is not
// re-derived from the template. None of them carry a templateVersion at all
// (verified before writing this), so there is nothing to repoint and no answer
// can be disturbed by any of the above.
//
// TEST ROOT ONLY, idempotent, dry run by default:
//   npx ts-node src/seed/migrateBs9792ToV1.ts
//   npx ts-node src/seed/migrateBs9792ToV1.ts --apply
// ============================================================================

import * as admin from 'firebase-admin';
import { forEnv } from '../shared/paths';
import type { Job, Keyed, Template } from '../shared/types';
import { BS9792_TEMPLATE_ID, BS9792_TEMPLATE_VERSION } from './ids';
import { BS9792_TEMPLATE } from './data/bs9792Template';

const APPLY = process.argv.includes('--apply');

function initAdmin(): void {
  if (admin.apps.length > 0) {
    return;
  }
  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'safentia-tech';
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL:
      process.env.FIREBASE_DATABASE_URL ||
      `https://${projectId}-default-rtdb.europe-west1.firebasedatabase.app`,
    projectId,
  });
}

function assertTest(path: string): string {
  if (!path.startsWith('test/')) {
    throw new Error(`SAFETY GUARD: refusing to write outside /test: "${path}"`);
  }
  return path;
}

async function run(): Promise<void> {
  initAdmin();
  const p = forEnv('test');
  const db = admin.database();

  console.log(
    APPLY
      ? `APPLY: BS 9792 will be republished at v${BS9792_TEMPLATE_VERSION} across /test.`
      : `DRY RUN: nothing will be written. Re-run with --apply.`,
  );

  if (BS9792_TEMPLATE.version !== BS9792_TEMPLATE_VERSION) {
    throw new Error(
      `Template constant is v${BS9792_TEMPLATE.version} but the id constant says ` +
        `v${BS9792_TEMPLATE_VERSION}; they are meant to be the same number.`,
    );
  }
  if (!BS9792_TEMPLATE.sections?.length) {
    throw new Error('Refusing to run: the BS 9792 constant has no sections.');
  }

  const update: Record<string, unknown> = {};
  const orgsSnap = await db.ref(p.db.organisationsRoot()).get();
  const orgIds = Object.keys((orgsSnap.val() ?? {}) as Record<string, unknown>);

  // 1. The template, in every org that holds it.
  let republished = 0;
  for (const orgId of orgIds) {
    const snap = await db.ref(p.db.template(orgId, BS9792_TEMPLATE_ID)).get();
    const current = snap.val() as Template | null;
    if (!current) {
      continue;
    }
    if (current.version === BS9792_TEMPLATE_VERSION) {
      continue;
    }
    update[assertTest(p.db.template(orgId, BS9792_TEMPLATE_ID))] = BS9792_TEMPLATE;
    republished += 1;
  }
  console.log(`  templates to republish at v${BS9792_TEMPLATE_VERSION}: ${republished}`);

  // 2. Job pins. Only jobs on THIS template, and only where the number differs.
  //    Read per organisation, because that is the shape the path builders expose
  //    - there is no global jobs root to walk.
  let repinned = 0;
  for (const orgId of orgIds) {
    const jobsSnap = await db.ref(p.db.jobs(orgId)).get();
    const jobs = (jobsSnap.val() ?? {}) as Keyed<Job>;
    for (const [jobId, job] of Object.entries(jobs)) {
      if (job?.templateId !== BS9792_TEMPLATE_ID) {
        continue;
      }
      if (job.templateVersion === BS9792_TEMPLATE_VERSION) {
        continue;
      }
      update[assertTest(`${p.db.job(orgId, jobId)}/templateVersion`)] =
        BS9792_TEMPLATE_VERSION;
      repinned += 1;
    }
  }
  console.log(`  job pins to move to v${BS9792_TEMPLATE_VERSION}: ${repinned}`);

  // 3. The archive of intermediate versions. Removed entirely for this template:
  //    every entry in it is a draft of ours, and keeping any of them would leave
  //    the history this migration exists to remove.
  let archivesRemoved = 0;
  for (const orgId of orgIds) {
    const archiveSnap = await db
      .ref(p.db.templateVersions(orgId, BS9792_TEMPLATE_ID))
      .get();
    const archive = (archiveSnap.val() ?? null) as Record<string, unknown> | null;
    if (!archive) {
      continue;
    }
    for (const version of Object.keys(archive)) {
      update[
        assertTest(p.db.templateVersion(orgId, BS9792_TEMPLATE_ID, Number(version)))
      ] = null;
      archivesRemoved += 1;
      console.log(`  archive to remove: ${orgId} / v${version}`);
    }
  }
  console.log(`  archived versions to remove: ${archivesRemoved}`);

  const total = Object.keys(update).length;
  if (total === 0) {
    console.log('\nNothing to do - already migrated.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`\nDry run only: ${total} write(s) queued.`);
    process.exit(0);
  }

  // Chunked: the template body is large, so one update carrying a copy for every
  // org would exceed the payload ceiling. Each chunk is an atomic write.
  const entries = Object.entries(update);
  const CHUNK = 10;
  for (let i = 0; i < entries.length; i += CHUNK) {
    await db.ref().update(Object.fromEntries(entries.slice(i, i + CHUNK)));
    console.log(`  written ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
  }
  console.log('\nDone.');
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
