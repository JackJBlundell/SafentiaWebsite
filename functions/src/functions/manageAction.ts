// ============================================================================
// manageAction (callable, admin-only) - the action plan between assessments
// (stories 2043/2044).
//
// Assessment-born actions are written by the release pipeline; this callable is
// how an admin manages the plan BETWEEN assessments: recording a new manual
// action, keeping the details current, signing work off and reopening it. Every
// mutation lands in the SAME multi-location update as its /activity entry, so
// the audit trail cannot be skipped or forged - the reason this is a callable.
//
// Status discipline: `update` can NEVER move status. Sign-off is its own verb
// with a server-stamped provenance pair (signedOffBy from the verified token,
// signedOffAt from the server clock), and reopen is the only way back - it
// clears the stamp so a reopened action never carries stale provenance.
//
// Manual provenance: see lib/actionPlan.ts for why a manual action carries the
// 'manual' sentinel as its assessmentId/sectionCode and an empty question.
//
// WHO OWES THE WORK IS A CONTACT. An action is assigned by naming a
// CustomerContact of the building's customer (`responsibleContactId`); the
// callable reads that contact and writes its name onto `responsible` itself.
// Free text is not accepted, because a typed name is a person the platform can
// never tell - which is precisely how assignment emails came to be logged and
// dropped.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db, storage } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  requireString,
  optionalString,
  clearableString,
  requireEnum,
  requireTenantStorageRef,
  requireTimestamp,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { WEB_ORIGIN } from '../lib/webOrigin';
import { orgEmailBrand } from '../lib/emailTemplates';
import { sendKindEmail } from '../lib/templatedEmail';
import { resolveResponsibleAssignment } from '../lib/responsibleParty';
import {
  createActionRecord,
  reopenFragment,
  signOffFragment,
  startFragment,
  statusHistoryAppendFragment,
  UPDATABLE_ACTION_FIELDS,
} from '../lib/actionPlan';
import type { EnvPaths } from '../shared/paths';
import type { Logger } from '../lib/logging';
import type {
  Action,
  ActionStatusChange,
  Building,
  CustomerContact,
  Environment,
  ManageActionInput,
  ManageActionResult,
  OrgProfile,
  SafentiaDocument,
  Severity,
} from '../shared/types';

const ACTIONS = ['create', 'update', 'start', 'signOff', 'reopen'] as const;
const SEVERITIES: readonly Severity[] = ['L', 'M', 'H'] as const;

/** Human severity wording for customer-facing copy. */
const SEVERITY_LABELS: Record<Severity, string> = {
  L: 'Low',
  M: 'Medium',
  H: 'High',
};

/** A due date rendered for email, in UTC so it names the stored day. */
function formatDueDate(millis: number): string {
  return new Date(millis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The evidence fields a caller may supply. uploadedBy/uploadedAt are stamped
 *  from the verified token and the server clock, so their presence in the
 *  payload is rejected rather than trusted - proof of completion cannot carry
 *  forged attribution. */
const EVIDENCE_FIELDS = ['fileName', 'storagePath'] as const;

/**
 * The optional supporting document attached to a sign-off, validated into the
 * record shape it will be stored as.
 *
 * TENANCY IS THE POINT: `storagePath` is a pointer this product will later
 * render and serve to a customer as proof that statutory work was done, so it
 * is checked against the CALLER'S OWN tenant Storage prefix
 * (requireTenantStorageRef) rather than accepted as free text. A download URL
 * form passes that check too, but is refused here: the record must hold a
 * stable object path, because the callable stamps ownership metadata onto that
 * exact object below and every reader mints its own short-lived URL from it.
 */
function readEvidence(
  input: Record<string, unknown>,
  env: Environment,
  orgId: string,
  uid: string,
  now: number,
): SafentiaDocument | undefined {
  const supplied = input.completionEvidence;
  if (supplied === undefined || supplied === null) {
    return undefined;
  }
  const payload = assertObject(supplied);
  for (const key of Object.keys(payload)) {
    if (!(EVIDENCE_FIELDS as readonly string[]).includes(key)) {
      throw fail.invalidArgument(`Unknown evidence field: ${key}.`, {
        field: key,
      });
    }
  }
  const fileName = requireString(payload, 'fileName', TEXT_LIMITS.shortText);
  const storagePath = requireTenantStorageRef(
    requireString(payload, 'storagePath', 2048),
    'storagePath',
    env,
    orgId,
  );
  if (storagePath.includes('://')) {
    throw fail.invalidArgument(
      'Supporting evidence must be given as a stored file path, not a link.',
      { field: 'storagePath' },
    );
  }
  return { fileName, storagePath, uploadedBy: uid, uploadedAt: now };
}

/**
 * Stamp the owning customer onto the evidence object so the customer's portal
 * users can read exactly their own proof (the Storage rule scopes on this
 * metadata - the object path carries no customer segment). Mirrors how a
 * generated report is stamped, with one deliberate difference: this throws.
 *
 * The stamp is written BEFORE the sign-off lands, so a failure here leaves the
 * action untouched and the admin simply tries again - far better than recording
 * a closure whose proof the customer can never open. It doubles as the only
 * check that the claimed object actually exists: a client that names a path it
 * never uploaded fails here rather than leaving a dangling pointer in the legal
 * record.
 */
async function stampEvidenceOwner(
  storagePath: string,
  customerId: string,
  logger: Logger,
): Promise<void> {
  try {
    await storage
      .bucket()
      .file(storagePath)
      .setMetadata({ metadata: { customerId } });
  } catch (error) {
    logger.error('Evidence file could not be stamped for its owning customer', {
      storagePath,
      message: error instanceof Error ? error.message : String(error),
    });
    throw fail.failedPrecondition(
      'That supporting document could not be read back. Please attach it again.',
    );
  }
}

/** A building found in the org's estate, with the site it stands under. */
interface LocatedBuilding {
  building: Building;
  siteId: string;
}

/**
 * Find a building record (and its site) within THIS org's estate.
 *
 * The callable is told a buildingId but never a siteId, and buildings live under
 * /{env}/buildings/{orgId}/{siteId}/{buildingId}, so the record can only be
 * reached by walking the org's own buildings root - bounded by the estate size,
 * and never another tenant's data. That read is deliberately NOT done for every
 * verb: step 2's existence gate uses the targeted buildingCustomer index, and
 * this walk runs only where the RECORD (not merely its existence) is needed -
 * inheriting a responsible party on create, and routing the assignment email.
 * Both of those happen on the same request, so the caller resolves it once and
 * passes the result down rather than reading the estate twice.
 */
async function locateBuilding(
  paths: EnvPaths,
  orgId: string,
  buildingId: string,
): Promise<LocatedBuilding | undefined> {
  const estateSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
  const estate =
    (estateSnap.val() as Record<string, Record<string, Building>> | null) ?? {};
  for (const [siteId, site] of Object.entries(estate)) {
    if (site && typeof site === 'object' && buildingId in site) {
      const building = site[buildingId];
      if (building) {
        return { building, siteId };
      }
    }
  }
  return undefined;
}

/**
 * The CustomerContact an action is being assigned to, read from the building's
 * OWN customer so an id can never be aimed at another customer's directory.
 *
 * EXPLICIT versus INHERITED is the whole distinction. A contact the caller NAMED
 * must exist: recording an assignment against an id that resolves to nobody
 * would put a person on a compliance record who cannot be told about it, so it
 * is refused with copy the console can show. A contact INHERITED from the
 * building's stored default is best-effort: the admin did not choose it and the
 * action is still worth recording, so a stale default is logged and the action
 * lands with the link it inherited but no live name behind it.
 */
async function readAssignedContact(
  paths: EnvPaths,
  orgId: string,
  customerId: string,
  contactId: string,
  explicit: boolean,
  logger: Logger,
): Promise<CustomerContact | undefined> {
  const snap = await db
    .ref(paths.db.customerContact(orgId, customerId, contactId))
    .get();
  const contact = snap.val() as CustomerContact | null;
  if (contact) {
    return contact;
  }
  if (explicit) {
    throw fail.notFound(
      "That contact could not be found in this customer's contacts.",
      { field: 'responsibleContactId' },
    );
  }
  logger.warn(
    'The building’s default responsible party names a contact that is no longer in the customer’s contact list, so this action inherits a link nobody can be emailed through',
    { customerId, contactId },
  );
  return undefined;
}

/** The action facts the assignment email carries, addressed to the contact the
 *  action is assigned to. */
interface AssignedActionView {
  responsibleContactId: string;
  observation: string;
  severity: Severity;
  dueBy?: number;
  lifeProtection: boolean;
}

/**
 * Story 2047: ONE branded email to the person an action was just assigned to,
 * addressed through `Action.responsibleContactId` - the contact record itself,
 * never a name. The name-matching this replaced ("does the free-text
 * `responsible` equal the building party's name?") meant an action assigned to
 * anyone other than the building's own default was silently never sent, and it
 * could only ever have reached one person per building however many people the
 * plan actually named.
 *
 * The dead ends are a contact that has been removed from the customer's list and
 * a contact with no email address. Each is logged with its reason, because
 * "nobody was emailed" must be diagnosable - and neither is guessed around:
 * inventing an address for a statutory compliance message is worse than silence.
 *
 * Best-effort throughout - the action record has already landed and nothing here
 * may throw (the dispatchEmail contract, extended to the reads around it).
 *
 * Story 2066 note: NO emailPreferences.actionAssigned check here, deliberately.
 * The recipient is a CUSTOMER CONTACT (customerContacts record), and email
 * preferences live on OrgMember only - there is no preference record for this
 * recipient to respect. If member-assigned actions arrive later, that send
 * path must honour the assignee's actionAssigned preference.
 */
async function emailAssignedAction(
  paths: EnvPaths,
  orgId: string,
  buildingId: string,
  view: AssignedActionView,
  logger: Logger,
  located?: LocatedBuilding,
): Promise<void> {
  try {
    // The building record (the existence gate only proved presence). The create
    // path has already located it to inherit the responsible party, so it hands
    // the result in; the other callers pay for the walk here. The portal route
    // to a building is /app/sites/{siteId}/buildings/{id}, so the CTA below
    // needs the site the walk passes through as well as the record.
    const resolved = located ?? (await locateBuilding(paths, orgId, buildingId));
    if (!resolved) {
      logger.info('Assignment email skipped: building record not found', {
        buildingId,
      });
      return;
    }
    const { building, siteId } = resolved;

    const contactSnap = await db
      .ref(
        paths.db.customerContact(
          orgId,
          building.customerId,
          view.responsibleContactId,
        ),
      )
      .get();
    const contact = contactSnap.val() as CustomerContact | null;
    if (!contact) {
      logger.warn(
        'Assignment email skipped: the assigned contact is no longer in the customer’s contact list',
        { buildingId, contactId: view.responsibleContactId },
      );
      return;
    }
    if (!contact.email) {
      logger.info(
        'Assignment email skipped: the assigned contact has no email address on record',
        { buildingId, contactId: view.responsibleContactId },
      );
      return;
    }

    const excerpt =
      view.observation.length > 200
        ? `${view.observation.slice(0, 200)}…`
        : view.observation;
    // The email carries the sending organisation's own brand (name + accent),
    // falling back to the Safentia brand when the org has not set a valid one.
    const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
    const brand = orgEmailBrand(profileSnap.val() as OrgProfile | null);
    // The copy lives in the 'action-assigned' catalogue entry (or the org's own
    // saved template); this site supplies the values and the detail card it
    // computes - the conditional Due by / Life protection rows included.
    await sendKindEmail(
      {
        kind: 'action-assigned',
        env: paths.env,
        orgId,
        to: contact.email,
        variables: { 'building.name': building.name },
        brand,
        kindRows: [
          { label: 'Building', value: building.name },
          { label: 'Observation', value: excerpt },
          { label: 'Severity', value: SEVERITY_LABELS[view.severity] },
          ...(view.dueBy !== undefined
            ? [{ label: 'Due by', value: formatDueDate(view.dueBy) }]
            : []),
          ...(view.lifeProtection
            ? [
                {
                  label: 'Life protection',
                  value: 'This action affects life-safety measures.',
                },
              ]
            : []),
        ],
        // Straight to the building in the customer's own portal, where its
        // action plan lives. The staff console (/app/customers/...) would only
        // show this recipient a permission wall.
        kindLink: `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${buildingId}`,
      },
      logger,
    );
  } catch (error) {
    // The action mutation already landed; the courtesy email must not undo it.
    logger.warn('Assignment email failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export const manageAction = onCall<ManageActionInput>(
  // The assignment email needs the provider key mounted (lib/email: a v2
  // Function only sees a secret listed in its own options).
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
    runCallable<ManageActionResult>(
      createLogger({ fn: 'manageAction' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'manageAction');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        const input = assertObject(request.data);
        const action = requireEnum(input, 'action', ACTIONS);
        const buildingId = requireString(input, 'buildingId', TEXT_LIMITS.shortText);

        // 2. The building must exist in THIS org. First stop is the server-
        // maintained buildingCustomerIndex (one targeted read); buildings that
        // predate the index fall back to a scan of the org's own buildings root
        // - bounded by the estate size, and only ever this org's data, so a
        // buildingId can never be aimed at another tenant.
        const indexSnap = await db
          .ref(paths.db.buildingCustomer(orgId, buildingId))
          .get();
        // The same read answers "does this building exist" and "whose is it".
        // The second answer is what scopes sign-off evidence to the customer's
        // portal, so it is kept rather than re-read on that path.
        const indexedCustomerId = indexSnap.val() as string | null;
        if (!indexSnap.exists()) {
          const estateSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
          const estate =
            (estateSnap.val() as Record<string, Record<string, unknown>> | null) ??
            {};
          const found = Object.values(estate).some(
            (site) => site && typeof site === 'object' && buildingId in site,
          );
          if (!found) {
            throw fail.notFound('That building could not be found.', {
              field: 'buildingId',
            });
          }
        }

        const logger = createLogger({ fn: 'manageAction', orgId });

        // 3a. Create: observation + severity are the record's substance and are
        // required; dueBy defaults from DUE_WINDOW_DAYS, lifeProtection defaults
        // false, status is always 'open' (lib/actionPlan). Null is only ever a
        // CLEAR intent on update; on create there is nothing to clear.
        if (action === 'create') {
          const payload = readFields(assertObject(input.fields));
          for (const [key, value] of Object.entries(payload)) {
            if (value === null) {
              throw fail.invalidArgument(
                `The ${key} field cannot be null when creating an action.`,
                { field: key },
              );
            }
          }
          // `== null` also narrows away null for the compiler; the null case
          // was already rejected above with per-field copy.
          if (payload.observation == null || payload.severity == null) {
            throw fail.invalidArgument(
              'An action needs an observation and a severity.',
              {
                field: payload.observation === undefined ? 'observation' : 'severity',
              },
            );
          }
          // The responsible party is INHERITED when the admin did not name a
          // contact: the building's default party, exactly as the release
          // pipeline inherits it for an assessment-born action. Without this the
          // same person had to be re-picked on every manual action, and any left
          // blank vanished from the action plan's "who owes this" column.
          //
          // There is no assessment party to consider on this path: manageAction
          // only ever creates MANUAL actions, which carry the MANUAL_ASSESSMENT_ID
          // sentinel precisely because they have no originating assessment
          // (lib/actionPlan). Should a future verb create an assessment-born
          // action here, its assessment must be passed as the first source.
          //
          // The estate is walked at most ONCE: for the default party when none
          // was named, or for the owning customer when the buildingCustomer
          // index has no entry for this building. The record is then handed to
          // the assignment email below rather than re-read.
          let located: LocatedBuilding | undefined;
          if (payload.responsibleContactId == null || !indexedCustomerId) {
            located = await locateBuilding(paths, orgId, buildingId);
          }
          const customerId = indexedCustomerId ?? located?.building.customerId;
          if (!customerId) {
            // The existence gate passed, so this means the building went away
            // between that read and this one.
            throw fail.notFound('That building could not be found.', {
              field: 'buildingId',
            });
          }
          const assignment = resolveResponsibleAssignment(
            payload.responsibleContactId
              ? { responsibleContactId: payload.responsibleContactId }
              : undefined,
            undefined,
            located?.building,
          );
          // The recorded name is the CONTACT'S OWN, read from the directory:
          // `responsible` is the name as it stood when the action was raised,
          // and the contact record is what that name means at this instant.
          const contact = assignment.contactId
            ? await readAssignedContact(
                paths,
                orgId,
                customerId,
                assignment.contactId,
                payload.responsibleContactId != null,
                logger,
              )
            : undefined;
          const responsible = contact?.name ?? assignment.name;
          const record = createActionRecord(
            {
              observation: payload.observation,
              severity: payload.severity,
              ...(responsible != null ? { responsible } : {}),
              ...(assignment.contactId !== undefined
                ? { responsibleContactId: assignment.contactId }
                : {}),
              ...(payload.dueBy != null ? { dueBy: payload.dueBy } : {}),
              ...(payload.lifeProtection !== undefined
                ? { lifeProtection: payload.lifeProtection }
                : {}),
            },
            Date.now(),
          );
          const actionId = db
            .ref(paths.db.actions(orgId, buildingId))
            .push().key as string;
          await db.ref().update({
            [paths.db.action(orgId, buildingId, actionId)]: record,
            ...activityUpdate(paths, orgId, {
              actorUid: uid,
              action: 'action.created',
              target: actionId,
            }),
          });
          logger.info('Action created', {
            buildingId,
            actionId,
            // An unassigned action is a legitimate state; an action assigned to
            // nobody the platform can reach is not, so the link is logged.
            linkedContact: record.responsibleContactId !== undefined,
          });
          // Story 2047: created WITH a responsible contact - tell them, once. An
          // INHERITED contact sends too, deliberately: the notification answers
          // "an action is now yours", which is equally true whether the admin
          // picked the person or the building's default supplied them.
          // `located` is passed through so the email path does not re-read the
          // estate this branch already walked.
          if (record.responsibleContactId !== undefined) {
            await emailAssignedAction(
              paths,
              orgId,
              buildingId,
              {
                responsibleContactId: record.responsibleContactId,
                observation: record.observation,
                severity: record.severity,
                ...(record.dueBy !== undefined ? { dueBy: record.dueBy } : {}),
                lifeProtection: record.lifeProtection === true,
              },
              logger,
              located,
            );
          }
          return { actionId };
        }

        // 3b. Update / signOff / reopen all address an existing action.
        const actionId = requireString(input, 'actionId', TEXT_LIMITS.shortText);
        const actionPath = paths.db.action(orgId, buildingId, actionId);
        const existingSnap = await db.ref(actionPath).get();
        if (!existingSnap.exists()) {
          throw fail.notFound('That action could not be found.', {
            field: 'actionId',
          });
        }
        const existing = existingSnap.val() as Action;

        const update: Record<string, unknown> = {};
        let activityAction: string;
        // Set only when an update CHANGES the responsible to a new value -
        // the one edit that re-assigns the action (story 2047). Any other
        // edit (severity tweak, due-date move, re-save of the same name)
        // must never re-email.
        let assignment: AssignedActionView | undefined;
        // The status move to record in the action's history (story 2044 AC3).
        // `update` never moves status, so it leaves this undefined and appends
        // nothing. One `now` for the whole change so the sign-off stamp and the
        // history entry name the same instant.
        let historyEntry: ActionStatusChange | undefined;
        const now = Date.now();

        if (action === 'update') {
          // A signed-off action is a frozen record with provenance attached;
          // editing it would silently rewrite what was signed off. Reopen
          // first, correct, then sign off again - the trail shows all three.
          if (existing.status !== 'open') {
            throw fail.failedPrecondition(
              'Only open actions can be edited. Reopen it first.',
            );
          }
          const fields = readFields(assertObject(input.fields));
          if (fields.observation !== undefined) {
            if (fields.observation === null) {
              throw fail.invalidArgument(
                'The observation cannot be removed, only changed.',
                { field: 'observation' },
              );
            }
            update[`${actionPath}/observation`] = fields.observation;
          }
          if (fields.severity !== undefined) {
            if (fields.severity === null) {
              throw fail.invalidArgument(
                'The severity cannot be removed, only changed.',
                { field: 'severity' },
              );
            }
            // A severity change deliberately does NOT rederive dueBy: the due
            // date may have been negotiated, and silently moving it would lose
            // that. The admin edits dueBy explicitly if it should follow.
            update[`${actionPath}/severity`] = fields.severity;
          }
          if (fields.responsibleContactId !== undefined) {
            // Re-assignment names a CONTACT; the name follows from it, so the
            // pair on the record always describes one real person. Null clears
            // both - an action can be unassigned, but it can never be assigned
            // to a name with nobody behind it.
            if (fields.responsibleContactId === null) {
              update[`${actionPath}/responsible`] = null;
              update[`${actionPath}/responsibleContactId`] = null;
            } else {
              const customerId =
                indexedCustomerId ??
                (await locateBuilding(paths, orgId, buildingId))?.building
                  .customerId;
              if (!customerId) {
                throw fail.notFound('That building could not be found.', {
                  field: 'buildingId',
                });
              }
              const contact = await readAssignedContact(
                paths,
                orgId,
                customerId,
                fields.responsibleContactId,
                true,
                logger,
              );
              // An explicit id that resolves to nobody was refused above, so
              // the contact is present; the fallback only satisfies the type.
              update[`${actionPath}/responsible`] = contact?.name ?? null;
              update[`${actionPath}/responsibleContactId`] =
                fields.responsibleContactId;
            }
          }
          if (fields.dueBy !== undefined) {
            update[`${actionPath}/dueBy`] = fields.dueBy;
          }
          if (fields.lifeProtection !== undefined) {
            update[`${actionPath}/lifeProtection`] = fields.lifeProtection;
          }
          if (Object.keys(update).length === 0) {
            throw fail.invalidArgument('No action fields were provided.');
          }
          // Re-assignment detection is now an IDENTITY comparison: the action
          // moved to a different contact. Re-picking the same person - which is
          // what re-saving the form does - changes nothing and must not
          // re-email them, and a renamed contact is not a re-assignment at all
          // (the old name-comparison would have read it as one). The email
          // itself carries the action's post-update facts.
          if (
            fields.responsibleContactId != null &&
            fields.responsibleContactId !== existing.responsibleContactId
          ) {
            const effectiveDueBy =
              fields.dueBy === null ? undefined : (fields.dueBy ?? existing.dueBy);
            assignment = {
              responsibleContactId: fields.responsibleContactId,
              observation: fields.observation ?? existing.observation,
              severity: fields.severity ?? existing.severity,
              ...(effectiveDueBy !== undefined ? { dueBy: effectiveDueBy } : {}),
              lifeProtection:
                (fields.lifeProtection ?? existing.lifeProtection) === true,
            };
          }
          activityAction = 'action.updated';
        } else if (action === 'start') {
          // Only an open action can be started; an in-progress or closed one is
          // already past this point, and re-starting would rewrite its lifecycle.
          if (existing.status !== 'open') {
            throw fail.failedPrecondition('Only open actions can be started.');
          }
          Object.assign(update, startFragment(actionPath));
          historyEntry = { status: 'inProgress', byUid: uid, at: now };
          activityAction = 'action.started';
        } else if (action === 'signOff') {
          // Work can be signed off straight from open or from in progress; there
          // is no need to step back to open first.
          if (existing.status !== 'open' && existing.status !== 'inProgress') {
            throw fail.failedPrecondition('This action is not open to sign off.');
          }
          // The completion note (AC2) is optional free text, length-capped and
          // trimmed; an empty note reads as no note at all.
          const completionNote = optionalString(
            input,
            'completionNote',
            TEXT_LIMITS.freeText,
          );
          // Optional supporting evidence: a file already in this org's own
          // tenant Storage. Stamped with its owning customer before anything is
          // written, so the record can never name proof the customer's portal
          // would be refused (see stampEvidenceOwner).
          const completionEvidence = readEvidence(input, env, orgId, uid, now);
          if (completionEvidence) {
            // A building with no index entry reached here through the estate
            // scan above; without a customerId the stamp cannot scope the file,
            // so it is recorded for staff and reported for repair rather than
            // silently released to nobody.
            if (!indexedCustomerId) {
              logger.error(
                'Sign-off evidence stored with no owning customer: portal read will be denied',
                { buildingId, actionId },
              );
            } else {
              await stampEvidenceOwner(
                completionEvidence.storagePath,
                indexedCustomerId,
                logger,
              );
            }
          }
          Object.assign(
            update,
            signOffFragment(
              actionPath,
              uid,
              now,
              completionNote,
              completionEvidence,
            ),
          );
          historyEntry = {
            status: 'signedOff',
            byUid: uid,
            at: now,
            // The note and its evidence live on both the record and this history
            // entry, so the trail keeps them even after a later reopen clears
            // the record fields.
            ...(completionNote !== undefined ? { note: completionNote } : {}),
            ...(completionEvidence !== undefined
              ? { evidence: completionEvidence }
              : {}),
          };
          activityAction = 'action.signedOff';
        } else {
          // Reopen returns a signed-off OR in-progress action to open.
          if (
            existing.status !== 'signedOff' &&
            existing.status !== 'inProgress'
          ) {
            throw fail.failedPrecondition(
              'Only signed-off or in-progress actions can be reopened.',
            );
          }
          Object.assign(update, reopenFragment(actionPath));
          historyEntry = { status: 'open', byUid: uid, at: now };
          activityAction = 'action.reopened';
        }

        // Append the status move to the per-action history, by index, within
        // this SAME atomic multi-location update (see actionPlan for why the
        // index write is lost-update-safe).
        if (historyEntry) {
          Object.assign(
            update,
            statusHistoryAppendFragment(actionPath, existing, historyEntry),
          );
        }

        Object.assign(
          update,
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action: activityAction,
            target: actionId,
          }),
        );
        await db.ref().update(update);

        // Story 2047: the re-assignment email goes out only after the record
        // landed - never for signOff/reopen or a no-change edit.
        if (assignment) {
          await emailAssignedAction(paths, orgId, buildingId, assignment, logger);
        }

        logger.info(`Action ${action}`, { buildingId, actionId });
        return { actionId };
      },
    ),
);

/** Validate a fields payload against the whitelist. Unknown keys (including
 *  any attempt at `status` or the sign-off pair) are rejected, never dropped,
 *  so a client bug surfaces as an error rather than a silent no-op. */
function readFields(payload: Record<string, unknown>): {
  observation?: string | null;
  severity?: Severity | null;
  responsibleContactId?: string | null;
  dueBy?: number | null;
  lifeProtection?: boolean;
} {
  for (const key of Object.keys(payload)) {
    if (!(UPDATABLE_ACTION_FIELDS as readonly string[]).includes(key)) {
      throw fail.invalidArgument(`Unknown action field: ${key}.`, { field: key });
    }
  }
  return {
    observation: clearableString(payload, 'observation', TEXT_LIMITS.freeText),
    severity:
      payload.severity === null
        ? null
        : payload.severity !== undefined
          ? requireEnum(payload, 'severity', SEVERITIES)
          : undefined,
    responsibleContactId: clearableString(
      payload,
      'responsibleContactId',
      TEXT_LIMITS.shortText,
    ),
    dueBy:
      payload.dueBy === null
        ? null
        : payload.dueBy !== undefined
          ? requireTimestamp(payload, 'dueBy')
          : undefined,
    lifeProtection:
      payload.lifeProtection !== undefined
        ? requireBooleanField(payload, 'lifeProtection')
        : undefined,
  };
}

/** lifeProtection is a flag, never clearable: false IS the cleared state. */
function requireBooleanField(
  payload: Record<string, unknown>,
  field: string,
): boolean {
  const value = payload[field];
  if (typeof value !== 'boolean') {
    throw fail.invalidArgument(`The ${field} field must be true or false.`, {
      field,
    });
  }
  return value;
}
