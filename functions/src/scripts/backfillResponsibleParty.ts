// ============================================================================
// backfillResponsibleParty - persist the responsible party that the app used to
// derive only at render time.
//
// THE FAULT THIS REPAIRS: the intended model is ONE responsible party per
// assessment - defaulted from the building, optionally overridden, inherited by
// every action. The defaulting chain, however, was implemented client-side when
// a screen rendered and was never written back, so the STORED records are blank:
// the report prints "Not recorded", the action plan shows no owner, and the
// assessor re-types the same person on every finding. The Functions now stamp
// the party at the source (onAssessmentCreate / startAssessment inherit it onto
// new assessments; manageAction inherits it onto new actions), but that only
// fixes records created from here on. This script fixes the ones already stored.
//
// It does two derivable things and nothing else:
//   (a) BUILDINGS - promote the legacy free-text `responsiblePerson` into the
//       structured `responsibleParty` ({ name }) where no structured party
//       exists, then DELETE the legacy key. Same person, expressed in the one
//       field everything now reads, with no copy left behind to drift from it.
//   (b) ASSESSMENTS - stamp the building's resolved default onto IN-FLIGHT
//       assessments that carry no party of their own, so their actions and
//       report inherit it exactly as a newly created assessment would.
//
// REQUIRED BEFORE DEPLOY. The legacy field has been deleted from the contract
// and from every read path (lib/responsibleParty no longer falls back to it), so
// a building that still carries only the string resolves to NO responsible party
// once the new code is live - a blank line on a statutory document. Run this
// (--apply) against an environment before deploying to it, and confirm the final
// summary reports zero legacy keys remaining.
//
// WHAT IT DELIBERATELY WILL NOT TOUCH:
//   - Released and validated (readyForRelease) assessments. Those are HISTORY:
//     a released assessment has a signed-off PDF and an accepted action plan
//     behind it, and a validated one has been through an auditor. Writing a
//     party into them now would change what a completed statutory record says
//     about who was accountable at the time. Nothing is lost by leaving them -
//     they still resolve the building's party at render time.
//   - Any record that ALREADY has a `responsibleParty`. An assessor's override
//     is the highest authority in the chain and this script must never stomp
//     one, so presence of the field alone is enough to skip. Note that such a
//     building still has its legacy key cleared: the structured party wins
//     regardless, so the string is dead weight either way.
//
// Re-runnable, including after a PARTIAL run. Every write is derived from data
// the record already implies and is skipped when the destination is occupied,
// and the promotion and the deletion are decided INDEPENDENTLY - a building
// whose party landed but whose deletion did not is picked up by the next run and
// cleared. A run with nothing left to do queues zero writes.
//
// Dry run by default. Pass --apply to write. Targets `test` unless --env says
// otherwise; --env=both walks the live and test roots in one pass.
//
//   FIREBASE_DATABASE_URL=... npx ts-node src/scripts/backfillResponsibleParty.ts
//   FIREBASE_DATABASE_URL=... npx ts-node src/scripts/backfillResponsibleParty.ts --env=live
//   FIREBASE_DATABASE_URL=... npx ts-node src/scripts/backfillResponsibleParty.ts --env=live --apply
// ============================================================================

import { db } from '../admin';
import { resolveResponsibleParty } from '../lib/responsibleParty';
import { forEnv } from '../shared/paths';
import type {
  Assessment,
  AssessmentStatus,
  Building,
  Environment,
  Keyed,
  ResponsibleParty,
} from '../shared/types';

const apply = process.argv.includes('--apply');
const envArg = process.argv.find((a) => a.startsWith('--env='))?.split('=')[1];
// Default `test`, matching the sibling scripts: an operator who forgets the flag
// must never land on production data.
const envs: Environment[] =
  envArg === 'live' ? ['live'] : envArg === 'both' ? ['test', 'live'] : ['test'];

/**
 * The statuses an assessment may be stamped in: work that is still MOVING and
 * whose report has not been issued. `readyForRelease` (auditor-validated) and
 * `released` are excluded as history - see the banner.
 */
const IN_FLIGHT: readonly AssessmentStatus[] = [
  'inProgress',
  'readyForValidation',
  'infoRequired',
];

/** RTDB caps how much one multi-location update may carry, and a whole-estate
 *  migration can exceed it; writing in batches keeps each update well inside
 *  that and makes a partial failure resumable (the run is idempotent). */
const BATCH_SIZE = 500;

/** A building as it may still sit ON DISK. `responsiblePerson` was deleted from
 *  the `Building` contract along with every path that read it, so this migration
 *  - the ONE piece of code that must still see the old field - declares it
 *  locally rather than keeping it alive in the shared types for everyone else. */
type StoredBuilding = Building & { responsiblePerson?: unknown };

interface Counts {
  buildingsPromoted: number;
  buildingsAlreadyStructured: number;
  buildingsNoParty: number;
  legacyKeysDeleted: number;
  assessmentsStamped: number;
  assessmentsAlreadySet: number;
  assessmentsNoDefault: number;
  assessmentsHistoric: number;
}

/** The legacy string as a structured party, or undefined when it names nobody.
 *  Trimmed on promotion so the derived party is clean even where the stored
 *  string was not, and blank-guarded so a cleared cell ('' from a bad import)
 *  becomes a deletion rather than an empty-named party. */
function legacyParty(building: StoredBuilding): ResponsibleParty | undefined {
  const legacy = building.responsiblePerson;
  return typeof legacy === 'string' && legacy.trim().length > 0
    ? { name: legacy.trim() }
    : undefined;
}

/** What one env's pass did, broken out by KIND rather than as one write count:
 *  the operator running this as a pre-deploy gate needs to see that the legacy
 *  keys are gone, not just that some writes happened. */
interface Totals {
  queued: number;
  promoted: number;
  deleted: number;
  stamped: number;
}

async function migrateEnv(env: Environment): Promise<Totals> {
  const paths = forEnv(env);
  // `null` is RTDB's delete: the legacy key is removed by the same multi-location
  // update that writes the promotion, so a building can never be left with the
  // string gone and the structured party unwritten.
  const update: Record<string, ResponsibleParty | null> = {};
  const counts: Counts = {
    buildingsPromoted: 0,
    buildingsAlreadyStructured: 0,
    buildingsNoParty: 0,
    legacyKeysDeleted: 0,
    assessmentsStamped: 0,
    assessmentsAlreadySet: 0,
    assessmentsNoDefault: 0,
    assessmentsHistoric: 0,
  };

  console.log(`\n=== env: ${env} ===`);

  // Every org, so the walk covers the whole tenant tree rather than one org.
  const orgsSnap = await db.ref(paths.db.organisationsRoot()).get();
  const orgIds = Object.keys((orgsSnap.val() ?? {}) as Record<string, unknown>);

  for (const orgId of orgIds) {
    // --- (a) Buildings: promote the legacy string, delete it, and build the
    // buildingId -> default-party map the assessment pass needs. The map holds
    // the POST-migration view (the promotion this run is about to write counts),
    // so one run migrates buildings and assessments coherently rather than
    // needing a second pass to pick up what it just wrote.
    const buildingsSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
    const buildingsBySite = (buildingsSnap.val() ??
      {}) as Keyed<Keyed<StoredBuilding>>;
    const defaultParty = new Map<string, ResponsibleParty>();

    for (const [siteId, buildings] of Object.entries(buildingsBySite)) {
      for (const [buildingId, building] of Object.entries(buildings ?? {})) {
        if (!building || typeof building !== 'object') {
          continue;
        }
        const buildingPath = paths.db.building(orgId, siteId, buildingId);
        const structured = resolveResponsibleParty(undefined, building);
        const legacy = legacyParty(building);
        const resolved = structured ?? legacy;
        if (resolved) {
          defaultParty.set(buildingId, resolved);
        }

        // The promotion. Decided ONLY by whether the structured field is
        // already occupied, never by whether the legacy key is still there, so
        // an assessor's chosen party is never stomped by an older string.
        if (structured) {
          counts.buildingsAlreadyStructured += 1;
        } else if (legacy) {
          counts.buildingsPromoted += 1;
          console.log(
            `  building ${orgId}/${siteId}/${buildingId}: legacy -> { name: "${legacy.name}" }`,
          );
          update[`${buildingPath}/responsibleParty`] = legacy;
        } else {
          // Neither field carries a usable name - there is nothing to derive,
          // and inventing a party is not this script's business.
          counts.buildingsNoParty += 1;
        }

        // The deletion, decided INDEPENDENTLY of the promotion above. Any
        // presence of the key at all is enough - a blank string is orphaned data
        // too - and a building that was promoted by an earlier partial run but
        // not cleared is caught here on the next pass.
        if (building.responsiblePerson !== undefined) {
          counts.legacyKeysDeleted += 1;
          update[`${buildingPath}/responsiblePerson`] = null;
        }
      }
    }

    // --- (b) Assessments: stamp the building default onto in-flight records.
    const assessmentsSnap = await db.ref(paths.db.assessments(orgId)).get();
    const assessments = (assessmentsSnap.val() ?? {}) as Keyed<Assessment>;

    for (const [assessmentId, assessment] of Object.entries(assessments)) {
      if (!assessment || typeof assessment !== 'object') {
        continue;
      }
      // Presence alone is the skip test: an assessor's override outranks every
      // default, and this script must never overwrite one.
      if (assessment.responsibleParty) {
        counts.assessmentsAlreadySet += 1;
        continue;
      }
      if (!IN_FLIGHT.includes(assessment.status)) {
        counts.assessmentsHistoric += 1;
        continue;
      }
      const party = defaultParty.get(assessment.buildingId);
      if (!party) {
        // The building names nobody either; the assessment has no default to
        // inherit. Reported rather than silently counted, because it is the one
        // case an operator may want to chase up in the estate data.
        counts.assessmentsNoDefault += 1;
        console.warn(
          `  assessment ${orgId}/${assessmentId}: building ${assessment.buildingId} has no responsible party`,
        );
        continue;
      }
      counts.assessmentsStamped += 1;
      console.log(
        `  assessment ${orgId}/${assessmentId} (${assessment.status}): -> "${party.name}"`,
      );
      update[`${paths.db.assessment(orgId, assessmentId)}/responsibleParty`] =
        party;
    }
  }

  const queued = Object.keys(update).length;
  console.log(`\n  orgs walked:                  ${orgIds.length}`);
  console.log(`  buildings already structured: ${counts.buildingsAlreadyStructured}`);
  console.log(`  buildings promoted (legacy):  ${counts.buildingsPromoted}`);
  console.log(`  buildings with no party:      ${counts.buildingsNoParty}`);
  console.log(`  legacy keys deleted:          ${counts.legacyKeysDeleted}`);
  console.log(`  assessments already set:      ${counts.assessmentsAlreadySet}`);
  console.log(`  assessments stamped:          ${counts.assessmentsStamped}`);
  console.log(`  assessments with no default:  ${counts.assessmentsNoDefault}`);
  console.log(`  assessments skipped (history):${counts.assessmentsHistoric}`);
  console.log(`  writes queued:                ${queued}`);

  const totals: Totals = {
    queued,
    promoted: counts.buildingsPromoted,
    deleted: counts.legacyKeysDeleted,
    stamped: counts.assessmentsStamped,
  };

  if (!apply || queued === 0) {
    return totals;
  }

  const entries = Object.entries(update);
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = Object.fromEntries(entries.slice(i, i + BATCH_SIZE));
    await db.ref().update(batch);
    console.log(
      `  wrote ${Math.min(i + BATCH_SIZE, entries.length)}/${entries.length}`,
    );
  }
  return totals;
}

async function main(): Promise<void> {
  console.log(
    apply
      ? 'APPLY mode: parties WILL be written and legacy keys WILL be deleted.'
      : 'DRY RUN: nothing will be written.',
  );
  console.log(`  envs: ${envs.join(', ')}`);

  const total: Totals = { queued: 0, promoted: 0, deleted: 0, stamped: 0 };
  for (const env of envs) {
    const envTotal = await migrateEnv(env);
    total.queued += envTotal.queued;
    total.promoted += envTotal.promoted;
    total.deleted += envTotal.deleted;
    total.stamped += envTotal.stamped;
  }

  // Spelled out per change kind, in the past or conditional tense to match the
  // mode: this is the pre-deploy gate's evidence, and "0 writes" means something
  // very different depending on which mode produced it.
  const verb = apply ? '' : ' would be';
  console.log(`\n--- totals across ${envs.join(', ')} ---`);
  console.log(`  buildings promoted (legacy -> responsibleParty):${verb} ${total.promoted}`);
  console.log(`  legacy responsiblePerson keys deleted:${verb} ${total.deleted}`);
  console.log(`  in-flight assessments stamped:${verb} ${total.stamped}`);

  if (!apply) {
    console.log(
      `\nDry run only. ${total.queued} write(s) would be made. Re-run with --apply to write.`,
    );
    process.exit(0);
  }
  if (total.queued === 0) {
    // The clean state this gate is looking for: no legacy data anywhere, every
    // in-flight assessment already stamped. Safe to deploy the code that has no
    // legacy fallback left.
    console.log('\nDone. Nothing left to migrate - no legacy data remains.');
    process.exit(0);
  }
  console.log(
    `\nDone. ${total.queued} write(s) applied. Re-run to confirm a clean pass before deploying.`,
  );
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
