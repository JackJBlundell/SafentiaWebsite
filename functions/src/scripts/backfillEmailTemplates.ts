// ============================================================================
// backfillEmailTemplates - one-off operator script, run at the templating
// deploy. Seeds every existing organisation with a BASE library of email
// templates so the console's template editor opens onto today's copy rather
// than an empty list:
//   - one template per configurable email kind (everything except 'manual';
//     'invitation' IS included - its toggle is locked but its template is
//     customisable), each a copy of the kind's built-in default from the
//     catalogue, named with the kind's label;
//   - one general-purpose 'Announcement' template for the Compose flow, which
//     requires an org template to start from.
// NOTHING is written to emailSettings: the seeded templates stay unassigned,
// so live sending behaviour is unchanged until an admin assigns one.
//
// Idempotent by NAME: an org already holding a template whose `name` equals
// the would-be seed's name (case-sensitive exact match) keeps its version and
// the seed is skipped - re-running the script, or running it after an admin
// has edited a seeded template, never duplicates or overwrites.
//
// DRY RUN BY DEFAULT: without the --apply flag it only reports what it WOULD
// write. Run it once dry, eyeball the per-org lines, then re-run with --apply.
//
// Run (from functions/, credentials as grantSuperAdmin - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   FIREBASE_DATABASE_URL=<rtdb url> \
//     npx ts-node src/scripts/backfillEmailTemplates.ts \
//       [--env test|live] [--apply] [--org <orgId>]
// ============================================================================

import { db } from '../admin';
import { forEnv } from '../lib/paths';
import { EMAIL_KINDS, CONFIGURABLE_EMAIL_KIND_IDS } from '../lib/emailKindCatalogue';
import type { EmailTemplateShape } from '../lib/emailVariableEngine';
import type { EmailTemplate, Environment, Keyed } from '../shared/types';

// ----------------------------------------------------------------------------
// The Announcement seed - the one template with no kind behind it. It exists
// for the Compose flow (a manual send starts from an org template), so its
// copy is a calm, neutral starting point the admin overwrites.
// ----------------------------------------------------------------------------

export const ANNOUNCEMENT_NAME = 'Announcement';

const ANNOUNCEMENT_TEMPLATE: EmailTemplateShape = {
  subject: 'A message from {{org.name}}',
  heading: '{{org.name}}',
  blocks: [
    {
      id: 'p1',
      type: 'paragraph',
      text: 'Hello {{recipient.name}}. Replace this paragraph with the message you would like to send.',
    },
  ],
};

// ----------------------------------------------------------------------------
// Pure planning - separated from I/O so the seed set is unit-testable.
// ----------------------------------------------------------------------------

/** One seed the plan considers: the template name (the idempotency key) and
 *  the shape it would be created from. */
interface TemplateSeed {
  name: string;
  shape: EmailTemplateShape;
}

/** Every seed the script knows, in catalogue order plus Announcement last. */
function allSeeds(): TemplateSeed[] {
  const seeds: TemplateSeed[] = CONFIGURABLE_EMAIL_KIND_IDS.map((id) => ({
    name: EMAIL_KINDS[id].label,
    shape: EMAIL_KINDS[id].defaultTemplate,
  }));
  seeds.push({ name: ANNOUNCEMENT_NAME, shape: ANNOUNCEMENT_TEMPLATE });
  return seeds;
}

/** Build the EmailTemplate doc a seed produces. The spread lands the shape's
 *  subject/preheader/heading/blocks/footerNote; the optional keys are then
 *  stripped when absent, because RTDB rejects `undefined` values and the doc
 *  must match EmailTemplate exactly. */
function seedToDoc(seed: TemplateSeed, now: number): EmailTemplate {
  const doc: EmailTemplate = {
    name: seed.name,
    ...seed.shape,
    updatedAt: now,
    updatedBy: 'system',
  };
  if (doc.preheader === undefined) delete doc.preheader;
  if (doc.footerNote === undefined) delete doc.footerNote;
  return doc;
}

export interface OrgTemplatePlan {
  /** Docs to create, in seed order. */
  create: EmailTemplate[];
  /** Seed names already present on the org (skipped). */
  present: string[];
}

/** Given an org's existing templates, decide which seeds are missing. The
 *  idempotency key is the template NAME, case-sensitive exact match. */
export function planOrgTemplates(
  existing: Keyed<EmailTemplate> | null,
  now: number,
): OrgTemplatePlan {
  const existingNames = new Set(
    Object.values(existing ?? {})
      .map((template) => template?.name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const create: EmailTemplate[] = [];
  const present: string[] = [];
  for (const seed of allSeeds()) {
    if (existingNames.has(seed.name)) {
      present.push(seed.name);
    } else {
      create.push(seedToDoc(seed, now));
    }
  }
  return { create, present };
}

// ----------------------------------------------------------------------------
// I/O
// ----------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const env = (argValue('--env') ?? 'test') as Environment;
  if (env !== 'test' && env !== 'live') {
    console.error(`--env must be 'test' or 'live', got '${env as string}'.`);
    process.exit(1);
  }
  const onlyOrg = argValue('--org');

  console.log(
    apply
      ? `APPLY mode [${env}]: template docs WILL be written.`
      : `DRY RUN (default) [${env}]: nothing will be written. Re-run with --apply to write.`,
  );

  const envPaths = forEnv(env);
  const orgsSnap = await db.ref(envPaths.db.organisationsRoot()).get();
  const orgs = (orgsSnap.val() as Keyed<Record<string, unknown>> | null) ?? {};
  const orgIds = onlyOrg ? [onlyOrg] : Object.keys(orgs);
  if (onlyOrg && !orgs[onlyOrg]) {
    console.error(`[${env}] organisation '${onlyOrg}' not found.`);
    process.exit(1);
  }

  let orgsSeen = 0;
  let orgsSkipped = 0;
  let totalCreated = 0;
  const now = Date.now();

  for (const orgId of orgIds) {
    // Guard: a half-deleted org (no profile node) is not seeded.
    const org = orgs[orgId];
    if (!org || typeof org !== 'object' || !('profile' in org)) {
      orgsSkipped += 1;
      console.log(`  [${env}] ${orgId}: SKIPPED - no profile node (half-deleted?)`);
      continue;
    }
    orgsSeen += 1;

    const templatesSnap = await db.ref(envPaths.db.emailTemplates(orgId)).get();
    const existing = templatesSnap.val() as Keyed<EmailTemplate> | null;
    const plan = planOrgTemplates(existing, now);

    if (plan.create.length === 0) {
      console.log(`  [${env}] ${orgId}: all ${plan.present.length} templates already present`);
      continue;
    }

    if (apply) {
      // One multi-location update per org: push keys minted locally, then a
      // single atomic write under the org's emailTemplates node.
      const updates: Record<string, EmailTemplate> = {};
      for (const doc of plan.create) {
        const templateId = db.ref().push().key as string;
        updates[templateId] = doc;
      }
      await db.ref(envPaths.db.emailTemplates(orgId)).update(updates);
      totalCreated += plan.create.length;
      console.log(
        `  [${env}] ${orgId}: created ${plan.create.length} ` +
          `(${plan.present.length} already present)`,
      );
    } else {
      console.log(
        `  [${env}] ${orgId}: would create ${plan.create.length}, ` +
          `${plan.present.length} already present`,
      );
      for (const doc of plan.create) console.log(`      + ${doc.name}`);
      if (plan.present.length > 0) {
        console.log(`      = present: ${plan.present.join(', ')}`);
      }
    }
  }

  console.log('\nSummary');
  console.log(`  organisations ${apply ? 'seeded' : 'inspected'}: ${orgsSeen}`);
  if (orgsSkipped > 0) console.log(`  organisations skipped (no profile): ${orgsSkipped}`);
  if (apply) console.log(`  templates created: ${totalCreated}`);
  if (!apply && orgsSeen > 0) {
    console.log('\nDry run only. Re-run with --apply to write the template docs.');
  }
  process.exit(0);
}

// Only run as a script - the pure planning half is imported by the tests.
if (require.main === module) {
  void main().catch((error) => {
    console.error('backfillEmailTemplates failed:', error);
    process.exit(1);
  });
}
