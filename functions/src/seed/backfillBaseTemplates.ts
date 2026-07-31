// ============================================================================
// backfillBaseTemplates - give every TEST organisation the base templates it
// should have arrived with.
//
// An organisation is meant to hold BOTH system templates: the PAS 79-1:2020
// default and the BS 9792 Housing FRA. Provisioning was open-coded in several
// places with different ideas of that list, so organisations across /test are
// missing one or the other - most visibly BS 9792, which means no housing
// assessment can be started in them.
//
// Nobody can repair this from the console: database.rules.json makes
// templates/$orgId server-write-only, and the New-template panel can only
// "start from" a template the org ALREADY holds. An org that never received
// BS 9792 has no route to it at all, which is why this exists as a script.
//
// SAFE TO RE-RUN, and deliberately CONSERVATIVE: a base template id that is
// already present is LEFT EXACTLY AS IT IS. An admin may have published their
// own amended version over it, and silently reverting that would destroy real
// work and re-shape every job pinned to it. This only ever FILLS A GAP.
//
// TEST ROOT ONLY. Every write is asserted to sit under /test before it is sent;
// the production path (createOrganisation, which currently publishes NO
// templates at all) is a separate, deliberate piece of work.
//
// Dry run by default; pass --apply to write:
//   npx ts-node src/seed/backfillBaseTemplates.ts
//   npx ts-node src/seed/backfillBaseTemplates.ts --apply
// ============================================================================

import * as admin from 'firebase-admin';
import { forEnv } from '../shared/paths';
import type { Keyed, Template } from '../shared/types';
import { PAS79_TEMPLATE_ID, BS9792_TEMPLATE_ID } from './ids';
import { PAS79_TEMPLATE } from './data/pas79Template';
import { BS9792_TEMPLATE } from './data/bs9792Template';

const APPLY = process.argv.includes('--apply');

/** The system templates every org should hold, by their FIXED ids - the id is
 *  the only durable marker of a base template in the data. */
const BASE_TEMPLATES: ReadonlyArray<{ id: string; template: Template }> = [
  { id: PAS79_TEMPLATE_ID, template: PAS79_TEMPLATE },
  { id: BS9792_TEMPLATE_ID, template: BS9792_TEMPLATE },
];

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

/** A write outside the test root must be impossible, not merely unlikely. */
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
      ? 'APPLY: missing base templates WILL be published into /test orgs.'
      : 'DRY RUN: nothing will be written. Re-run with --apply.',
  );

  // A source guard before a single org is read: publishing a template that had
  // silently lost its sections would replace a gap with something worse.
  for (const { id, template } of BASE_TEMPLATES) {
    if (!Array.isArray(template.sections) || template.sections.length === 0) {
      throw new Error(`Refusing to run: base template ${id} has no sections.`);
    }
  }

  const orgsSnap = await db.ref(p.db.organisationsRoot()).get();
  const orgIds = Object.keys((orgsSnap.val() ?? {}) as Record<string, unknown>);
  console.log(`Organisations in /test: ${orgIds.length}\n`);

  const update: Record<string, Template> = {};
  let filled = 0;
  let kept = 0;

  for (const orgId of orgIds) {
    const snap = await db.ref(p.db.templates(orgId)).get();
    const existing = (snap.val() ?? {}) as Keyed<Template>;
    const missing: string[] = [];

    for (const { id, template } of BASE_TEMPLATES) {
      if (existing[id]) {
        kept += 1;
        continue;
      }
      update[assertTest(p.db.template(orgId, id))] = template;
      missing.push(id);
      filled += 1;
    }

    console.log(
      missing.length > 0
        ? `  ${orgId}: publishing ${missing.join(', ')}`
        : `  ${orgId}: already complete`,
    );
  }

  console.log(`\n  already present (untouched): ${kept}`);
  console.log(`  missing (to publish):        ${filled}`);

  if (APPLY && filled > 0) {
    // Chunked: the BS 9792 body alone is large, so one update carrying a pair
    // for every org would be a payload the API refuses. Each chunk is still an
    // atomic multi-location write.
    const entries = Object.entries(update);
    const CHUNK = 10;
    for (let i = 0; i < entries.length; i += CHUNK) {
      await db.ref().update(Object.fromEntries(entries.slice(i, i + CHUNK)));
      console.log(`  written ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
    }
  }

  console.log(APPLY ? '\nDone.' : '\nDry run only.');
  process.exit(0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
