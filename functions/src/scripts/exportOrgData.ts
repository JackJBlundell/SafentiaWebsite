// ============================================================================
// exportOrgData - operator tool: export ALL of one organisation's data.
//
// For a subject-access request, a tenant off-boarding, or an internal data
// export, this walks every org-scoped subtree under a single environment root
// (/live or /test) for one orgId and writes a single structured JSON file to
// disk. It is STRICTLY READ-ONLY: it never writes back to the database.
//
// What it exports: every collection the path builder scopes by orgId - the
// organisation profile/settings/subscription/usage, members, customers,
// contacts, sites, buildings, floor plans, templates, jobs, assessments and
// answers, actions, documents metadata, the log book, activity, the email log,
// invitation SUMMARIES and more (the full list is derived from the builders in
// shared/paths, not hand-typed, so a new collection is picked up by adding one
// builder entry below). Each collection is read as a whole subtree in one get().
//
// What it deliberately excludes: the top-level /invitations tree, whose nodes
// carry the acceptance TOKEN (a bearer secret) - the admin-readable invitation
// SUMMARIES under /orgInvitations are exported instead. Per-user reverse indexes
// (/userOrgs, /customerUserIndex, /notifications) are keyed by uid, not orgId,
// so they are not part of an org's subtree. As belt-and-braces, a redaction pass
// masks the value of any key that looks like a secret (token/secret/password/
// apiKey/bearer) anywhere in the exported tree.
//
// Run (from functions/, credentials as backfillReportMetadata - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<service-account-key.json> \
//   FIREBASE_DATABASE_URL=<rtdb-url> \
//     npx ts-node src/scripts/exportOrgData.ts <orgId> [--env live|test] [--out <file>]
//
// --env defaults to live. --out defaults to
//   ./org-export-<orgId>-<env>-<timestamp>.json
// The written file path (and its byte count) is echoed to stdout.
// ============================================================================

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../admin';
import { forEnv } from '../shared/paths';
import type {
  Environment,
  DocumentCategory,
  ReportScope,
} from '../shared/types';

/** A sentinel child id passed to multi-argument builders. It is truncated away
 *  by orgRoot() below, so its value and type are immaterial; it exists only so
 *  a builder that requires a deeper id can be called at all. */
const SENTINEL = '_sentinel_';

/**
 * Truncate a builder's output right after the orgId segment, yielding the
 * org-scoped subtree ROOT. An orgId is a unique push key, so its first
 * occurrence in the path is unambiguous (the environment root and collection
 * names that precede it are lower-case words that cannot collide with it). For
 * a builder that already takes only orgId this is a no-op.
 */
function orgRoot(path: string, orgId: string): string {
  const marker = `/${orgId}`;
  const at = path.indexOf(marker);
  return at < 0 ? path : path.slice(0, at + marker.length);
}

/** The org-scoped collections to export, each addressed through a path builder
 *  (never a hand-typed string). Adding a collection to the schema means adding
 *  one line here. Order is presentation only. */
function orgCollections(
  env: Environment,
  orgId: string,
): Array<{ label: string; ref: string }> {
  const { db: p } = forEnv(env);
  const cat = SENTINEL as DocumentCategory; // truncated away by orgRoot
  const scope = SENTINEL as ReportScope; // truncated away by orgRoot
  const entry = (label: string, path: string) => ({
    label,
    ref: orgRoot(path, orgId),
  });

  return [
    entry('organisation', p.organisation(orgId)),
    entry('orgMembers', p.orgMembers(orgId)),
    entry('buildingCustomerIndex', p.buildingCustomerIndex(orgId)),
    // Admin-readable invitation SUMMARIES only. The tokenised /invitations tree
    // is intentionally never read (see the header note).
    entry('orgInvitations', p.orgInvitations(orgId)),
    entry('customers', p.customers(orgId)),
    entry('customerContacts', p.customerContacts(orgId, SENTINEL)),
    entry('customerMembers', p.customerMembers(orgId, SENTINEL)),
    entry('sites', p.sites(orgId, SENTINEL)),
    entry('buildings', p.buildingsRoot(orgId)),
    entry('buildingAccess', p.buildingAccess(orgId, SENTINEL)),
    entry('floorPlans', p.floorPlans(orgId, SENTINEL)),
    entry('templateDrafts', p.templateDrafts(orgId)),
    entry('templateVersions', p.templateVersions(orgId, SENTINEL)),
    entry('standardParagraphs', p.standardParagraphs(orgId)),
    entry('templates', p.templates(orgId)),
    entry('jobs', p.jobs(orgId)),
    entry('assessorJobs', p.assessorJobs(orgId, SENTINEL)),
    entry('assessments', p.assessments(orgId)),
    entry('assessmentAnswers', p.assessmentAnswers(orgId, SENTINEL)),
    entry('actions', p.actionsRoot(orgId)),
    entry('documents', p.documents(orgId, SENTINEL, cat)),
    entry('logBook', p.logBook(orgId, SENTINEL)),
    entry('notificationLedger', p.notificationLedger(orgId, SENTINEL)),
    entry('activity', p.activity(orgId)),
    entry('emailLog', p.emailLog(orgId)),
    entry('reports', p.reports(orgId, scope, SENTINEL)),
  ];
}

/** Keys whose VALUE is a bearer secret and must never leave the database in an
 *  export, even though the collections above are chosen to avoid them. */
const SECRET_KEY = /token|secret|password|apikey|bearer/i;

/** Recursively mask any secret-looking value, returning a redacted deep copy.
 *  Non-object values pass through unchanged; arrays are walked element-wise. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(child);
    }
    return out;
  }
  return value;
}

function parseArgs(argv: string[]): {
  orgId: string;
  env: Environment;
  out?: string;
} {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const orgId = positionals[0];
  const envArg = readFlag(argv, '--env') ?? 'live';
  const out = readFlag(argv, '--out');
  if (!orgId) {
    fail('an <orgId> argument is required');
  }
  if (envArg !== 'live' && envArg !== 'test') {
    fail(`--env must be "live" or "test" (got "${envArg}")`);
  }
  return { orgId, env: envArg, ...(out ? { out } : {}) };
}

/** Read `--flag value` (space-separated, matching the other scripts' style). */
function readFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`exportOrgData: ${message}.`);
  console.error(
    'Usage: npx ts-node src/scripts/exportOrgData.ts <orgId> [--env live|test] [--out <file>]',
  );
  process.exit(1);
}

/** A filesystem-safe timestamp, e.g. 2026-07-16T093012Z. */
function stamp(now: number): string {
  return new Date(now).toISOString().replace(/:/g, '').replace(/\.\d+/, '');
}

async function main(): Promise<void> {
  const { orgId, env, out } = parseArgs(process.argv.slice(2));

  const collections = orgCollections(env, orgId);
  const data: Record<string, unknown> = {};
  let present = 0;
  for (const { label, ref } of collections) {
    const snap = await db.ref(ref).get();
    if (snap.exists()) {
      present += 1;
      data[label] = redact(snap.val());
    } else {
      // Record the absence explicitly so the export is a complete, self-describing
      // account of the org rather than a set of unexplained gaps.
      data[label] = null;
    }
  }

  const exportDoc = {
    meta: {
      orgId,
      environment: env,
      exportedAt: new Date().toISOString(),
      collectionsExported: collections.length,
      collectionsPresent: present,
      note:
        'Read-only export. Bearer tokens are excluded by collection choice and ' +
        'masked by a redaction pass. The /invitations token tree is not included.',
    },
    data,
  };

  const outPath = resolve(
    out ?? `./org-export-${orgId}-${env}-${stamp(Date.now())}.json`,
  );
  const json = JSON.stringify(exportDoc, null, 2);
  writeFileSync(outPath, json);

  console.log(
    `Exported org ${orgId} (${env}): ${present}/${collections.length} collections present.`,
  );
  console.log(`Written: ${outPath} (${json.length} bytes)`);
  process.exit(0);
}

void main().catch((error) => {
  console.error('exportOrgData failed:', error);
  process.exit(1);
});
