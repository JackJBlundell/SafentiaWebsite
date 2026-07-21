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
const PLAN_FIELDS = ['name', 'description', 'imageUrl', 'kind'] as const;
const PLAN_KINDS = ['image', 'pdf'] as const;

const ACTIONS = ['create', 'update', 'remove'] as const;

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
          const plan: FloorPlan = {
            name: fields.name,
            imageUrl: fields.imageUrl,
            ...(fields.description ? { description: fields.description } : {}),
            ...(fields.kind ? { kind: fields.kind } : {}),
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

        // 3b. Update / remove both address an existing plan.
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
