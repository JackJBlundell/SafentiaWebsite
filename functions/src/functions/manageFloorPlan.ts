// ============================================================================
// manageFloorPlan (callable, admin-only) - Phase 2 admin, floor-plan CRUD.
//
// Create, update or remove a floor plan record for a building. The image itself
// is already in tenant-scoped Storage (uploaded under the Storage rules); this
// manages the RTDB record that points at it. Every change lands in the SAME
// multi-location update as its /activity entry, so the audit trail cannot be
// skipped or forged - the whole reason this is a callable. imageUrl gets the
// same tenant-boundary validation as the org logo: it must reference an object
// inside this org's own Storage root, never another tenant's or an external
// host.
//
// A "floor plan" is not always renderable. A practice's drawing may be a CAD
// export or an office document, so `kind` spans image / pdf / file, and the
// descriptive fileName + contentType + sizeBytes travel with the record so a
// plan that cannot be previewed is still named and described wherever it is
// listed. Only image and pdf can carry location pins (isAnnotatableFloorPlan).
//
// Remove deletes the PLAN RECORD ONLY. Past assessments' flag composites (the
// plan flattened with R/A/G pins) are separate stored images under
// /flags/{flagId}, so historic reports keep their annotated plans after the
// source plan is removed - a QA acceptance criterion.
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
  requireTenantStorageRef,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import type {
  FloorPlan,
  ManageFloorPlanInput,
  ManageFloorPlanResult,
} from '../shared/types';

/** The plan fields an admin may set; anything else is rejected, never dropped. */
const PLAN_FIELDS = [
  'name',
  'description',
  'imageUrl',
  'kind',
  'fileName',
  'contentType',
  'sizeBytes',
] as const;
/** 'file' is a drawing that is stored and downloadable but NOT renderable or
 *  annotatable (a CAD export, a TIFF, an office document); the console offers
 *  those types now, so the callable has to accept the kind that describes them.
 *  See FloorPlanKind / isAnnotatableFloorPlan in the contract. */
const PLAN_KINDS = ['image', 'pdf', 'file'] as const;

const ACTIONS = ['create', 'update', 'remove', 'reorder'] as const;

/**
 * Validate the uploaded file's byte size: absent leaves it, null CLEARS it (the
 * clearableString intents), and a present value must be a non-negative finite
 * integer. It is DISPLAY ONLY - nothing is enforced against it here, because
 * the size that matters is the one Storage actually accepted, and the upload
 * rules are what police that. Rejecting nonsense still matters: a stored NaN or
 * negative would be rendered to an admin as a fact about their drawing.
 */
function clearableSizeBytes(
  payload: Record<string, unknown>,
  field: string,
): number | null | undefined {
  const value = payload[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw fail.invalidArgument(`The ${field} field must be a size in bytes.`, {
      field,
    });
  }
  return value;
}

export const manageFloorPlan = onCall<ManageFloorPlanInput>(
  callableOptions,
  (request) =>
    runCallable<ManageFloorPlanResult>(
      createLogger({ fn: 'manageFloorPlan' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'manageFloorPlan');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the action, the owning building and (for the writing
        // actions) the whitelisted plan fields.
        const input = assertObject(request.data);
        const action = requireEnum(input, 'action', ACTIONS);
        const buildingId = requireString(input, 'buildingId', TEXT_LIMITS.shortText);

        // On update an explicit null on an OPTIONAL field (description, kind)
        // is the CLEAR intent (ClearableFields in the contract: writing null
        // deletes the key in RTDB); name and imageUrl are required on the
        // record, so they can only ever be changed, never cleared.
        const readFields = (payload: Record<string, unknown>) => {
          for (const key of Object.keys(payload)) {
            if (!(PLAN_FIELDS as readonly string[]).includes(key)) {
              throw fail.invalidArgument(`Unknown floor plan field: ${key}.`, {
                field: key,
              });
            }
          }
          if (payload.name === null) {
            throw fail.invalidArgument('The name cannot be removed, only changed.', {
              field: 'name',
            });
          }
          if (payload.imageUrl === null) {
            throw fail.invalidArgument(
              'The image cannot be removed, only replaced.',
              { field: 'imageUrl' },
            );
          }
          return {
            name: clearableString(payload, 'name', TEXT_LIMITS.shortText),
            description: clearableString(payload, 'description', TEXT_LIMITS.freeText),
            // Tenant boundary: the image must be an object this org uploaded.
            imageUrl:
              payload.imageUrl !== undefined
                ? requireTenantStorageRef(
                    requireString(payload, 'imageUrl', 2048),
                    'imageUrl',
                    env,
                    orgId,
                  )
                : undefined,
            kind:
              payload.kind === null
                ? null
                : payload.kind !== undefined
                  ? requireEnum(payload, 'kind', PLAN_KINDS)
                  : undefined,
            // Descriptive only: the originating file's own name, content type
            // and size, so a plan that cannot be rendered is still nameable and
            // describable in a list. None is trusted for anything but display -
            // the tenancy boundary is imageUrl, checked above.
            fileName: clearableString(payload, 'fileName', TEXT_LIMITS.shortText),
            contentType: clearableString(payload, 'contentType', TEXT_LIMITS.shortText),
            sizeBytes: clearableSizeBytes(payload, 'sizeBytes'),
          };
        };

        // 3a. Create: a plan is a name plus the image it points at. Null is
        // only meaningful as a CLEAR on update; on create there is nothing to
        // clear yet, so it is a client error, never accepted.
        if (action === 'create') {
          const payload = assertObject(input.plan);
          for (const [key, value] of Object.entries(payload)) {
            if (value === null) {
              throw fail.invalidArgument(
                `The ${key} field cannot be null when creating a floor plan.`,
                { field: key },
              );
            }
          }
          const fields = readFields(payload);
          if (!fields.name || !fields.imageUrl) {
            throw fail.invalidArgument('A floor plan needs a name and an image.', {
              field: !fields.name ? 'name' : 'imageUrl',
            });
          }
          // Give the new plan a defined position at the END of the building's
          // list (story 2021), derived from the existing plans rather than
          // trusted from the client, so ordering is total the moment the record
          // exists and a fresh upload never jumps an admin's arrangement. A
          // batch upload creates plans one awaited call at a time, so each read
          // here already sees the previous one and appends after it.
          const existing = (
            await db.ref(paths.db.floorPlans(orgId, buildingId)).get()
          ).val() as Record<string, FloorPlan> | null;
          const orders = existing
            ? Object.values(existing)
                .map((entry) => entry.order)
                .filter((value): value is number => typeof value === 'number')
            : [];
          const nextOrder = orders.length > 0 ? Math.max(...orders) + 1 : 0;
          const plan: FloorPlan = {
            name: fields.name,
            imageUrl: fields.imageUrl,
            order: nextOrder,
            ...(fields.description ? { description: fields.description } : {}),
            ...(fields.kind ? { kind: fields.kind } : {}),
            ...(fields.fileName ? { fileName: fields.fileName } : {}),
            ...(fields.contentType ? { contentType: fields.contentType } : {}),
            // Written on its own value, not on truthiness: a 0-byte upload is a
            // real (if useless) file, and dropping the key would report it as
            // "size unknown" rather than as the empty drawing it is.
            ...(typeof fields.sizeBytes === 'number'
              ? { sizeBytes: fields.sizeBytes }
              : {}),
          };
          const planId = db.ref(paths.db.floorPlans(orgId, buildingId)).push()
            .key as string;
          await db.ref().update({
            [paths.db.floorPlan(orgId, buildingId, planId)]: plan,
            ...activityUpdate(paths, orgId, {
              actorUid: uid,
              action: 'floorPlan.created',
              target: planId,
            }),
          });
          createLogger({ fn: 'manageFloorPlan', orgId }).info('Floor plan created', {
            buildingId,
            planId,
          });
          return { planId };
        }

        // 3b. Reorder: rewrite every plan's position in one atomic update. The
        // client sends the FULL id list in the intended order; we accept it
        // only if it is EXACTLY the building's current plan set. A reorder built
        // against a stale list (a plan added or removed on another device
        // meanwhile) must FAIL, never silently drop, duplicate or invent a
        // record, so the check below proves the two sets are identical before
        // any write.
        if (action === 'reorder') {
          const requested = input.order;
          if (!Array.isArray(requested)) {
            throw fail.invalidArgument(
              'A reorder needs the full list of plan ids.',
              { field: 'order' },
            );
          }
          const orderedIds = requested.map((value, index) => {
            if (typeof value !== 'string' || value.trim().length === 0) {
              throw fail.invalidArgument(
                'Each plan id in the order must be a non-empty string.',
                { field: `order[${index}]` },
              );
            }
            return value;
          });

          const existing = (
            await db.ref(paths.db.floorPlans(orgId, buildingId)).get()
          ).val() as Record<string, FloorPlan> | null;
          const currentIds = existing ? Object.keys(existing) : [];
          const currentSet = new Set(currentIds);

          // Same length + every id belongs to the current set + no duplicates,
          // together, prove the requested list is a permutation of exactly the
          // current set: nothing dropped, nothing invented, nothing doubled.
          if (orderedIds.length !== currentIds.length) {
            throw fail.failedPrecondition(
              'The floor plans changed since this order was made. Reload and try again.',
              { field: 'order' },
            );
          }
          const seen = new Set<string>();
          for (const id of orderedIds) {
            if (!currentSet.has(id)) {
              throw fail.failedPrecondition(
                'The floor plans changed since this order was made. Reload and try again.',
                { field: 'order' },
              );
            }
            if (seen.has(id)) {
              throw fail.invalidArgument(
                'A plan id appears more than once in the order.',
                { field: 'order' },
              );
            }
            seen.add(id);
          }

          const reorderUpdate: Record<string, unknown> = {};
          orderedIds.forEach((id, index) => {
            reorderUpdate[`${paths.db.floorPlan(orgId, buildingId, id)}/order`] =
              index;
          });
          Object.assign(
            reorderUpdate,
            activityUpdate(paths, orgId, {
              actorUid: uid,
              action: 'floorPlan.reordered',
              target: buildingId,
            }),
          );
          await db.ref().update(reorderUpdate);

          createLogger({ fn: 'manageFloorPlan', orgId }).info(
            'Floor plans reordered',
            { buildingId, count: orderedIds.length },
          );
          // The result carries a single planId by contract; a reorder has no one
          // subject, so return the first in the new order (the building always
          // has at least one plan to reorder).
          return { planId: orderedIds[0] ?? buildingId };
        }

        // 3c. Update / remove both address an existing plan.
        const planId = requireString(input, 'planId', TEXT_LIMITS.shortText);
        const planPath = paths.db.floorPlan(orgId, buildingId, planId);
        const existingSnap = await db.ref(planPath).get();
        if (!existingSnap.exists()) {
          throw fail.notFound('That floor plan could not be found.', {
            field: 'planId',
          });
        }

        const update: Record<string, unknown> = {};
        if (action === 'update') {
          const fields = readFields(assertObject(input.plan));
          if (fields.name !== undefined) update[`${planPath}/name`] = fields.name;
          if (fields.description !== undefined) {
            update[`${planPath}/description`] = fields.description;
          }
          if (fields.imageUrl !== undefined) {
            update[`${planPath}/imageUrl`] = fields.imageUrl;
          }
          if (fields.kind !== undefined) update[`${planPath}/kind`] = fields.kind;
          if (fields.fileName !== undefined) {
            update[`${planPath}/fileName`] = fields.fileName;
          }
          if (fields.contentType !== undefined) {
            update[`${planPath}/contentType`] = fields.contentType;
          }
          if (fields.sizeBytes !== undefined) {
            update[`${planPath}/sizeBytes`] = fields.sizeBytes;
          }
          if (Object.keys(update).length === 0) {
            throw fail.invalidArgument('No floor plan fields were provided.');
          }
        } else {
          // Remove: delete the plan RECORD only. Flag composites from past
          // assessments are separate stored images and survive (file header).
          update[planPath] = null;
        }

        Object.assign(
          update,
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action: action === 'update' ? 'floorPlan.updated' : 'floorPlan.removed',
            target: planId,
          }),
        );
        await db.ref().update(update);

        createLogger({ fn: 'manageFloorPlan', orgId }).info(`Floor plan ${action}d`, {
          buildingId,
          planId,
        });
        return { planId };
      },
    ),
);
