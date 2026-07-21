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
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
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
  clearableString,
  requireEnum,
  requireTimestamp,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { dispatchEmail, EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { WEB_ORIGIN } from '../lib/webOrigin';
import { orgEmailBrand, renderBrandedEmail } from '../lib/emailTemplates';
import {
  createActionRecord,
  reopenFragment,
  signOffFragment,
  UPDATABLE_ACTION_FIELDS,
} from '../lib/actionPlan';
import type { EnvPaths } from '../shared/paths';
import type { Logger } from '../lib/logging';
import type {
  Action,
  Building,
  CustomerContact,
  ManageActionInput,
  ManageActionResult,
  OrgProfile,
  Severity,
} from '../shared/types';

const ACTIONS = ['create', 'update', 'signOff', 'reopen'] as const;
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

/** The action facts the assignment email carries. */
interface AssignedActionView {
  responsible: string;
  observation: string;
  severity: Severity;
  dueBy?: number;
  lifeProtection: boolean;
}

/**
 * Story 2047: ONE branded email to the person an action was just assigned to.
 * `Action.responsible` is free text today (the proper Action.contactId linkage
 * is FUTURE_WORK.md section 9), so the ONLY route to an address is the
 * building's structured responsibleParty: it must carry a contactId, AND the
 * action's `responsible` must match that party's name EXACTLY after trim +
 * case-fold. Anything looser (substring, fuzzy, first-name) could route a
 * statutory compliance email to the wrong person - free text routinely names
 * contractors, teams or similarly-named colleagues, and "close enough" here
 * means telling the wrong human they hold a fire-safety duty. No linked or
 * matching contact: log the intent and skip. Best-effort throughout - the
 * action record has already landed and nothing here may throw (the
 * dispatchEmail contract, extended to the reads around it).
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
): Promise<void> {
  try {
    // Locate the building record (the existence gate only proved presence).
    // One estate read, only on the assignment path - buildings live under
    // /{env}/buildings/{orgId}/{siteId}/{buildingId} and the callable is not
    // told the siteId.
    const estateSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
    const estate =
      (estateSnap.val() as Record<string, Record<string, Building>> | null) ??
      {};
    let building: Building | undefined;
    // The portal route to a building is /app/sites/{siteId}/buildings/{id}, so
    // the CTA needs the site this walk already passes through.
    let siteId: string | undefined;
    for (const [candidateSiteId, site] of Object.entries(estate)) {
      if (site && typeof site === 'object' && buildingId in site) {
        building = site[buildingId];
        siteId = candidateSiteId;
        break;
      }
    }
    if (!building || !siteId) {
      logger.info('Assignment email skipped: building record not found');
      return;
    }

    const party = building.responsibleParty;
    if (!party?.contactId) {
      logger.info(
        'Assignment email skipped: building has no linked responsible party',
        { hasParty: Boolean(party) },
      );
      return;
    }
    const matches =
      view.responsible.trim().toLowerCase() ===
      party.name.trim().toLowerCase();
    if (!matches) {
      logger.info(
        'Assignment email skipped: responsible does not match the linked party',
      );
      return;
    }
    const contactSnap = await db
      .ref(
        paths.db.customerContact(orgId, building.customerId, party.contactId),
      )
      .get();
    const contact = contactSnap.val() as CustomerContact | null;
    if (!contact?.email) {
      logger.info('Assignment email skipped: linked contact has no email', {
        contactId: party.contactId,
      });
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
    const subject = 'An action has been assigned to you';
    const body = `A fire-safety action at ${building.name} has been assigned to you on Safentia.`;
    const html = renderBrandedEmail({
      brand,
      preheader: body,
      heading: subject,
      paragraphs: [
        body,
        'Please review the detail below and arrange the remedial work before the due date passes.',
      ],
      detailRows: [
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
      // Straight to the building in the customer's own portal, where its action
      // plan lives. The staff console (/app/customers/...) would only show this
      // recipient a permission wall.
      cta: {
        label: 'View the action plan',
        url: `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${buildingId}`,
      },
      footerNote: `You are receiving this because you are named as the responsible party for ${building.name} on Safentia.`,
    });
    await dispatchEmail({ to: contact.email, subject, body, html }, logger, {
      orgId,
      env: paths.env,
      category: 'action-assigned',
    });
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
        const { paths } = envFor(claims);
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
          const record = createActionRecord(
            {
              observation: payload.observation,
              severity: payload.severity,
              ...(payload.responsible != null
                ? { responsible: payload.responsible }
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
          logger.info('Action created', { buildingId, actionId });
          // Story 2047: created WITH a responsible - tell them, once.
          if (record.responsible !== undefined) {
            await emailAssignedAction(
              paths,
              orgId,
              buildingId,
              {
                responsible: record.responsible,
                observation: record.observation,
                severity: record.severity,
                ...(record.dueBy !== undefined ? { dueBy: record.dueBy } : {}),
                lifeProtection: record.lifeProtection === true,
              },
              logger,
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
          if (fields.responsible !== undefined) {
            update[`${actionPath}/responsible`] = fields.responsible;
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
          // Re-assignment detection: a non-null responsible that differs from
          // the stored one under the same trim + case-fold normalisation the
          // send-side match uses (so "John Smith" -> " john smith " is a
          // cosmetic re-save, not a re-assignment). The email itself carries
          // the action's post-update facts.
          if (
            fields.responsible != null &&
            fields.responsible.trim().toLowerCase() !==
              (existing.responsible ?? '').trim().toLowerCase()
          ) {
            const effectiveDueBy =
              fields.dueBy === null ? undefined : (fields.dueBy ?? existing.dueBy);
            assignment = {
              responsible: fields.responsible,
              observation: fields.observation ?? existing.observation,
              severity: fields.severity ?? existing.severity,
              ...(effectiveDueBy !== undefined ? { dueBy: effectiveDueBy } : {}),
              lifeProtection:
                (fields.lifeProtection ?? existing.lifeProtection) === true,
            };
          }
          activityAction = 'action.updated';
        } else if (action === 'signOff') {
          if (existing.status !== 'open') {
            throw fail.failedPrecondition('This action is not open to sign off.');
          }
          Object.assign(update, signOffFragment(actionPath, uid, Date.now()));
          activityAction = 'action.signedOff';
        } else {
          if (existing.status !== 'signedOff') {
            throw fail.failedPrecondition('Only signed-off actions can be reopened.');
          }
          Object.assign(update, reopenFragment(actionPath));
          activityAction = 'action.reopened';
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
  responsible?: string | null;
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
    responsible: clearableString(payload, 'responsible', TEXT_LIMITS.shortText),
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
