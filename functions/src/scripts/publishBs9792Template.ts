// ============================================================================
// publishBs9792Template - push the BS 9792 base template to an environment.
//
// Why this exists as its own script rather than a full `npm run seed`: the seed
// rewrites the entire demo world (orgs, members, jobs, assessments, log book).
// Correcting ONE template does not justify that blast radius, and re-seeding
// would discard real test-assessor work sitting in the same tree.
//
// The problem it fixes: the template in the database predates the matrix
// estimator (section 34), so "create a new template from the base template"
// copies a base that has no matrix in it. The seed SOURCE has been correct for a
// while; it had simply never been pushed.
//
// Job version pins are updated alongside, because a job pinning an older version
// than the template it points at makes startAssessment and onAssessmentCreate
// log a reconciliation warning on every start. Those two read the template by ID
// and snapshot whatever is CURRENT, so the pin is informational - which is
// exactly why leaving it stale would be noise rather than safety.
//
// Dry run by default. Pass --apply to write.
//
//   FIREBASE_DATABASE_URL=... npx ts-node src/scripts/publishBs9792Template.ts
//   FIREBASE_DATABASE_URL=... npx ts-node src/scripts/publishBs9792Template.ts --apply
//
// The environment defaults to `test`; pass --env=live to target production.
// ============================================================================

import { db } from '../admin';
import { forEnv } from '../shared/paths';
import { BS9792_TEMPLATE } from '../seed/data/bs9792Template';
import { BS9792_TEMPLATE_ID, BS9792_TEMPLATE_VERSION, ORG_ID } from '../seed/ids';
import type { Environment, Job } from '../shared/types';

const apply = process.argv.includes('--apply');
const envArg = process.argv.find((a) => a.startsWith('--env='));
const env: Environment = envArg?.split('=')[1] === 'live' ? 'live' : 'test';

async function main(): Promise<void> {
  const paths = forEnv(env);
  const templatePath = paths.db.template(ORG_ID, BS9792_TEMPLATE_ID);

  console.log(apply ? 'APPLY mode: the template WILL be written.' : 'DRY RUN: nothing will be written.');
  console.log(`  env:      ${env}`);
  console.log(`  org:      ${ORG_ID}`);
  console.log(`  template: ${BS9792_TEMPLATE_ID}`);

  const currentSnap = await db.ref(templatePath).get();
  const current = currentSnap.val() as { version?: number } | null;
  const matrixCount = BS9792_TEMPLATE.sections.reduce(
    (n, section) =>
      n + section.questions.filter((q) => q.type === 'matrix').length,
    0,
  );

  console.log(
    `  current version in database: ${current?.version ?? '(absent)'} -> writing ${BS9792_TEMPLATE_VERSION}`,
  );
  console.log(`  sections: ${BS9792_TEMPLATE.sections.length}`);
  console.log(`  matrix questions in the new content: ${matrixCount}`);

  if (matrixCount === 0) {
    // A guard, not a formality: pushing a base template that has silently lost
    // its estimator would recreate the exact fault this script exists to fix.
    console.error('\nRefusing to publish: the source template contains no matrix question.');
    process.exitCode = 1;
    return;
  }

  // Jobs pinned to this template, so their version pin can move with it.
  const jobsSnap = await db.ref(paths.db.jobs(ORG_ID)).get();
  const jobs = (jobsSnap.val() ?? {}) as Record<string, Job>;
  const stale = Object.entries(jobs).filter(
    ([, job]) =>
      job.templateId === BS9792_TEMPLATE_ID &&
      job.templateVersion !== BS9792_TEMPLATE_VERSION,
  );
  console.log(`  jobs pinned to an older version: ${stale.length}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.');
    // Explicit exit, as the sibling scripts do: the admin SDK holds an open
    // connection that keeps the event loop alive long after the work is done, so
    // without this the process hangs and piped output never flushes.
    process.exit(0);
  }

  // One multi-location update so the template and every pin it invalidates land
  // together: a half-applied run would leave jobs pointing at a version that no
  // longer exists anywhere.
  const update: Record<string, unknown> = {
    [templatePath]: BS9792_TEMPLATE,
  };
  for (const [jobId] of stale) {
    update[`${paths.db.job(ORG_ID, jobId)}/templateVersion`] =
      BS9792_TEMPLATE_VERSION;
  }
  await db.ref().update(update);

  console.log(`\nPublished. Template written and ${stale.length} job pin(s) updated.`);
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
