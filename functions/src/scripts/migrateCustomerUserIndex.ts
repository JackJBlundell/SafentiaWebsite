// ============================================================================
// migrateCustomerUserIndex - one-off operator script, run BEFORE the space
// picker ships.
//
// /customerUserIndex used to hold ONE slot per account:
//   /{env}/customerUserIndex/{uid} = { orgId, customerId }
// It is now a COLLECTION, one entry per portal space the account holds, keyed by
// portalSpaceKey(orgId, customerId):
//   /{env}/customerUserIndex/{uid}/{orgId}__{customerId} = { orgId, customerId }
// so a person who is a contact at more than one customer (a managing agent) can
// hold, and switch between, several portal spaces. This script converts the
// legacy shape in place, in BOTH env roots.
//
// IDEMPOTENT: a node is only migrated when it carries the legacy scalar fields
// (`orgId` and `customerId` as STRINGS directly on the uid node). An already
// migrated node's children are entry OBJECTS, and no space key can collide with
// those field names because every key contains the `__` separator, so a second
// run recognises its own output and skips it rather than nesting an entry inside
// an entry. Anything matching neither shape is left untouched and reported, so
// the script never guesses at data it does not understand.
//
// The conversion is one atomic update per account: it writes the new entry and
// clears both legacy fields together, so an interrupted run can never leave a
// node that is readable as neither shape. (A crash between accounts is fine -
// re-running finishes the job.)
//
// DRY RUN BY DEFAULT: without the --apply flag it only reports what it WOULD
// change. Run it once dry, eyeball the summary, then re-run with --apply.
//
// Run (from functions/, credentials as grantSuperAdmin - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   FIREBASE_DATABASE_URL=<rtdb url> \
//     npx ts-node src/scripts/migrateCustomerUserIndex.ts [--apply]
// ============================================================================

import type { Reference } from 'firebase-admin/database';
import { db } from '../admin';
import { forEnv, portalSpaceKey } from '../shared/paths';
import type {
  CustomerUserIndexEntry,
  Environment,
  Keyed,
} from '../shared/types';

const ENVIRONMENTS: Environment[] = ['live', 'test'];

/** Counters reported once at the end, summed across both env roots. */
interface Counts {
  total: number;
  migrated: number;
  alreadyMigrated: number;
  malformed: number;
}

/**
 * The collection root for one env. The mirrored contract addresses the index
 * per-uid (that is the only shape feature code needs) and hand-typing a path is
 * forbidden, so the root is derived as the PARENT of a per-uid ref: the path
 * still has exactly one source of truth.
 */
function indexRootRef(env: Environment): Reference {
  const uidRef = db.ref(forEnv(env).db.customerUserIndex('placeholder-uid'));
  const parent = uidRef.parent;
  if (!parent) {
    throw new Error(`Could not derive the customerUserIndex root for ${env}.`);
  }
  return parent;
}

/** True when a value is a well-formed entry: an object carrying both ids. */
function isEntry(value: unknown): value is CustomerUserIndexEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.orgId === 'string' &&
    record.orgId.length > 0 &&
    typeof record.customerId === 'string' &&
    record.customerId.length > 0
  );
}

/**
 * True when a node is already in the new shape: an object with at least one
 * child, every child being an entry. Requiring EVERY child to be an entry means
 * a half-understood node is reported as malformed rather than silently accepted.
 */
function isMigrated(node: Record<string, unknown>): boolean {
  const children = Object.values(node);
  return children.length > 0 && children.every(isEntry);
}

async function migrateEnv(env: Environment, apply: boolean): Promise<Counts> {
  const counts: Counts = {
    total: 0,
    migrated: 0,
    alreadyMigrated: 0,
    malformed: 0,
  };

  const rootRef = indexRootRef(env);
  const snap = await rootRef.get();
  if (!snap.exists()) {
    console.log(`  ${env}: no customerUserIndex data.`);
    return counts;
  }
  const byUid = (snap.val() as Keyed<unknown> | null) ?? {};

  for (const [uid, node] of Object.entries(byUid)) {
    counts.total += 1;

    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      counts.malformed += 1;
      console.log(`  ${env} ${uid}: not an object, skipped.`);
      continue;
    }
    const record = node as Record<string, unknown>;

    // The legacy marker, checked first: the ids sit directly on the uid node as
    // strings. A migrated node cannot look like this - its children are objects,
    // and no space key is named `orgId` or `customerId` (every one contains the
    // `__` separator).
    if (record.orgId !== undefined || record.customerId !== undefined) {
      if (!isEntry(record)) {
        counts.malformed += 1;
        console.log(`  ${env} ${uid}: partial legacy record, skipped.`);
        continue;
      }
      const entry: CustomerUserIndexEntry = {
        orgId: record.orgId as string,
        customerId: record.customerId as string,
      };
      counts.migrated += 1;
      if (apply) {
        // One update: the new entry lands and the legacy fields are deleted
        // (null removes a key) in a single atomic write.
        await db.ref(forEnv(env).db.customerUserIndex(uid)).update({
          [portalSpaceKey(entry.orgId, entry.customerId)]: entry,
          orgId: null,
          customerId: null,
        });
        console.log(`  ${env} ${uid}: migrated.`);
      } else {
        console.log(`  ${env} ${uid}: would migrate.`);
      }
      continue;
    }

    if (isMigrated(record)) {
      counts.alreadyMigrated += 1;
      continue;
    }

    counts.malformed += 1;
    console.log(`  ${env} ${uid}: unrecognised shape, skipped.`);
  }

  return counts;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(
    apply
      ? 'APPLY mode: the index WILL be rewritten.'
      : 'DRY RUN (default): nothing will be written. Re-run with --apply to write.',
  );

  const totals: Counts = {
    total: 0,
    migrated: 0,
    alreadyMigrated: 0,
    malformed: 0,
  };
  for (const env of ENVIRONMENTS) {
    const counts = await migrateEnv(env, apply);
    totals.total += counts.total;
    totals.migrated += counts.migrated;
    totals.alreadyMigrated += counts.alreadyMigrated;
    totals.malformed += counts.malformed;
  }

  console.log('\nSummary (both env roots)');
  console.log(`  accounts in the index:   ${totals.total}`);
  console.log(
    `  ${apply ? 'migrated' : 'would migrate'}:           ${totals.migrated}`,
  );
  console.log(`  already migrated:        ${totals.alreadyMigrated}`);
  console.log(`  malformed, skipped:      ${totals.malformed}`);
  if (!apply && totals.migrated > 0) {
    console.log('\nDry run only. Re-run with --apply to write.');
  }
  process.exit(0);
}

void main().catch((error) => {
  console.error('migrateCustomerUserIndex failed:', error);
  process.exit(1);
});
