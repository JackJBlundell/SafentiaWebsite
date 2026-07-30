// ============================================================================
// backfillActionResponsibleContact - link existing actions to the CONTACT their
// responsible party actually is.
//
// THE FAULT THIS REPAIRS: an action's responsible party used to be a free-text
// name, and every email to that person was found by matching the name against
// the customer's contact list. That matching has been removed - it was silently
// wrong whenever a name was spelled differently, and it decided whether a
// duty-holder was told about statutory work. The chase now resolves strictly
// through `Action.responsibleContactId`.
//
// Which leaves the actions raised BEFORE that field existed carrying a name and
// no id, so `deadlineReminders` skips them: work that was being chased yesterday
// silently stops being chased. This script closes that gap.
//
// THE LINKING RULE, and why it is narrow. An action inherits its responsible
// party from the assessment that raised it (or the building's default). So where
// the action's stored NAME still equals the name on that resolved party, AND
// that party carries a contactId, the link is not a guess - it is recovering the
// inheritance that produced the action in the first place. That is the only case
// this script writes.
//
// It deliberately does NOT fall back to searching the customer's contacts by
// name. That is precisely the matching that was removed for being unreliable,
// and re-introducing it inside a bulk script would be worse than leaving it out:
// a wrong link here sends a statutory deadline chase to the wrong person, at
// scale, with nobody watching. Anything it cannot link with certainty is
// reported, so the gap is a list an admin can work through rather than a silence.
//
// DRY RUN BY DEFAULT: without --apply it only reports what it WOULD write. Safe
// to re-run: an action already carrying a contact id is counted and skipped,
// never rewritten.
//
// Both environments are walked by default; pass --env=live or --env=test.
//
// Run (from functions/, credentials as grantSuperAdmin - see SETUP.md):
//   GOOGLE_APPLICATION_CREDENTIALS=<key.json> \
//   FIREBASE_DATABASE_URL=<rtdb url> \
//     npx ts-node src/scripts/backfillActionResponsibleContact.ts [--env=live] [--apply]
// ============================================================================

import { db } from '../admin';
import { forEnv } from '../shared/paths';
import type {
  Action,
  Assessment,
  Building,
  Environment,
  Keyed,
} from '../shared/types';

/** A building located in the estate tree, with the site it sits under. */
interface LocatedBuilding {
  building: Building;
  siteId: string;
}

/** Index every building in an org by id. The estate is stored by site, and an
 *  action only knows its building, so one pass builds the lookup the walk needs
 *  rather than re-scanning per action. */
function indexBuildings(
  node: Record<string, Record<string, Building>> | null,
): Map<string, LocatedBuilding> {
  const byId = new Map<string, LocatedBuilding>();
  for (const [siteId, buildings] of Object.entries(node ?? {})) {
    for (const [buildingId, building] of Object.entries(buildings ?? {})) {
      if (building) {
        byId.set(buildingId, { building, siteId });
      }
    }
  }
  return byId;
}

/** Names compared for RECOVERY, not for search: trimmed and case-folded, so a
 *  stored "barbara bolgiaghi " still recognises the party it came from without
 *  ever being used to go looking for someone. */
function sameName(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const envArg = process.argv
    .find((a) => a.startsWith('--env='))
    ?.split('=')[1];
  if (envArg && envArg !== 'live' && envArg !== 'test') {
    console.error(`Unknown --env=${envArg}. Use --env=live or --env=test.`);
    process.exit(1);
  }
  const environments: Environment[] = envArg
    ? [envArg as Environment]
    : ['live', 'test'];

  console.log(
    apply
      ? 'APPLY mode: responsible contact ids WILL be written.'
      : 'DRY RUN (default): nothing will be written. Re-run with --apply to write.',
  );
  console.log(`  environments: ${environments.join(', ')}`);

  let examined = 0;
  let alreadyLinked = 0;
  let linked = 0;
  let noName = 0;
  let unresolved = 0;

  for (const env of environments) {
    const paths = forEnv(env);
    const actionsSnap = await db.ref(`${env}/actions`).get();
    if (!actionsSnap.exists()) {
      continue;
    }
    const byOrg = actionsSnap.val() as Record<
      string,
      Record<string, Keyed<Action>>
    >;

    for (const [orgId, buildings] of Object.entries(byOrg)) {
      // One read of the org's estate and its assessments: an action's party is
      // recovered from the assessment that raised it, falling back to the
      // building's default - the same chain the platform itself inherits down.
      const [estateSnap, assessmentsSnap] = await Promise.all([
        db.ref(paths.db.buildingsRoot(orgId)).get(),
        db.ref(paths.db.assessments(orgId)).get(),
      ]);
      const buildingsById = indexBuildings(
        estateSnap.val() as Record<string, Record<string, Building>> | null,
      );
      const assessments =
        (assessmentsSnap.val() as Keyed<Assessment> | null) ?? {};

      for (const [buildingId, actions] of Object.entries(buildings ?? {})) {
        for (const [actionId, action] of Object.entries(actions ?? {})) {
          if (!action) {
            continue;
          }
          examined += 1;

          if (action.responsibleContactId) {
            alreadyLinked += 1;
            continue;
          }
          if (!action.responsible) {
            // Nothing recorded to recover from. Counted separately because it is
            // a different problem from a name we could not resolve.
            noName += 1;
            continue;
          }

          // The party this action would have inherited: its assessment's, else
          // the building's default.
          const assessmentParty =
            assessments[action.assessmentId]?.responsibleParty;
          const buildingParty =
            buildingsById.get(buildingId)?.building?.responsibleParty;
          const candidate = [assessmentParty, buildingParty].find(
            (party) =>
              party?.contactId && sameName(party.name, action.responsible),
          );

          if (!candidate?.contactId) {
            unresolved += 1;
            console.log(
              `  UNRESOLVED ${env} ${orgId}/${buildingId}/${actionId}: ` +
                `"${action.responsible}" does not match a linked party on its ` +
                'assessment or building - relink it by hand from the action plan',
            );
            continue;
          }

          linked += 1;
          console.log(
            `  ${apply ? 'linked' : 'would link'} ${env} ${orgId}/${buildingId}/${actionId} ` +
              `-> ${candidate.contactId} (${action.responsible})`,
          );
          if (apply) {
            await db
              .ref(
                `${paths.db.action(orgId, buildingId, actionId)}/responsibleContactId`,
              )
              .set(candidate.contactId);
          }
        }
      }
    }
  }

  console.log('\nSummary');
  console.log(`  actions examined:       ${examined}`);
  console.log(`  already linked:         ${alreadyLinked}`);
  console.log(`  ${apply ? 'linked:                ' : 'would link:            '} ${linked}`);
  console.log(`  no responsible name:    ${noName}`);
  console.log(`  unresolved (see above): ${unresolved}`);
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.');
  }
  if (unresolved > 0) {
    console.log(
      '\nUnresolved actions are NOT guesses to be automated: each names a party ' +
        'that no longer matches a linked one, so only a person can say who was ' +
        'meant. Until relinked, their deadline chases are skipped and logged.',
    );
  }
}

void main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('backfillActionResponsibleContact failed:', error);
    process.exit(1);
  });
