// ============================================================================
// manageBuilding (callable, admin-only) - Phase 2 admin, building CRUD (2023).
//
// Create or update a building under a site (/buildings/{orgId}/{siteId}/...).
// Direct client writes are denied by rules; every change here lands in the SAME
// multi-location update as its /activity entry, so the audit trail cannot be
// skipped or forged - the whole reason this is a callable.
//
// Three Building fields are DERIVED by the platform and never accepted from an
// admin form: riskLevel and ragDistribution come from the released assessment
// via the org's RAG config, and lastAssessedAt is stamped on release. Accepting
// them here would let an admin paint a high-risk building green, so their
// presence in the payload is rejected outright. serviceSchedule IS editable
// here (story 2023 - admins maintain the statutory service dates), and a
// schedule change is called out by name in the activity entry.
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
  requireDbKey,
  optionalString,
  clearableString,
  requireEnum,
  requireTenantStorageRef,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import {
  ALARM_CATEGORIES,
  SERVICE_SCHEDULE_KEYS,
} from '../shared/types';
import type {
  Building,
  BuildingDetails,
  Environment,
  ManageBuildingInput,
  ManageBuildingResult,
  ResponsibleParty,
  ServiceSchedule,
  ServiceScheduleItem,
} from '../shared/types';

/** The building fields an admin may set. Everything on Building EXCEPT the
 *  platform-derived trio (riskLevel, ragDistribution, lastAssessedAt). */
const BUILDING_FIELDS = [
  'name',
  'customerId',
  'address',
  'details',
  'responsibleParty',
  'article53Persons',
  'photoUrl',
  'serviceSchedule',
] as const;

/** Derived fields, named so the rejection can say WHY (see file header). */
const DERIVED_FIELDS = ['riskLevel', 'ragDistribution', 'lastAssessedAt'] as const;

const ACTIONS = ['create', 'update'] as const;

/** Sanity ceilings for the physical details. Generous enough for any real
 *  building yet bounded so a typo cannot store an absurd figure. Mirrored by
 *  the BuildingForm's client-side checks. */
const DETAIL_LIMITS = {
  area: 10_000_000, // m2; the largest buildings on earth are under half this.
  floors: 200,
  occupiedFloors: 200,
  occupants: 100_000,
} as const;

/** A positive finite number (areas, counts) within a sanity ceiling. Reject,
 *  never coerce. */
function optionalPositiveNumber(
  payload: Record<string, unknown>,
  field: string,
  max: number,
): number | undefined {
  const value = payload[field];
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  ) {
    throw fail.invalidArgument(
      `The ${field} field must be a number between 0 and ${max}.`,
      { field, max },
    );
  }
  return value;
}

/** Validate the optional details block field-by-field against BuildingDetails.
 *  An explicit null is the CLEAR intent on update: the whole node goes. */
function optionalDetails(
  payload: Record<string, unknown>,
): BuildingDetails | null | undefined {
  if (payload.details === undefined) {
    return undefined;
  }
  if (payload.details === null) {
    return null;
  }
  const raw = assertObject(payload.details);
  const details: BuildingDetails = {};
  const area = optionalPositiveNumber(raw, 'area', DETAIL_LIMITS.area);
  const floors = optionalPositiveNumber(raw, 'floors', DETAIL_LIMITS.floors);
  const occupiedFloors = optionalPositiveNumber(
    raw,
    'occupiedFloors',
    DETAIL_LIMITS.occupiedFloors,
  );
  const occupants = optionalPositiveNumber(raw, 'occupants', DETAIL_LIMITS.occupants);
  if (area !== undefined) details.area = area;
  if (floors !== undefined) details.floors = floors;
  if (occupiedFloors !== undefined) details.occupiedFloors = occupiedFloors;
  if (occupants !== undefined) details.occupants = occupants;
  if (raw.isLandlord !== undefined) {
    if (typeof raw.isLandlord !== 'boolean') {
      throw fail.invalidArgument('The isLandlord field must be true or false.', {
        field: 'isLandlord',
      });
    }
    details.isLandlord = raw.isLandlord;
  }
  const alarmType = optionalString(raw, 'alarmType', TEXT_LIMITS.shortText);
  if (alarmType !== undefined) details.alarmType = alarmType;
  if (raw.alarmCategory !== undefined) {
    details.alarmCategory = requireEnum(raw, 'alarmCategory', ALARM_CATEGORIES);
  }
  return details;
}

/** Validate the optional responsible party; only `name` is required by type.
 *  An explicit null is the CLEAR intent on update: the whole node goes. */
function optionalParty(
  payload: Record<string, unknown>,
): ResponsibleParty | null | undefined {
  if (payload.responsibleParty === undefined) {
    return undefined;
  }
  if (payload.responsibleParty === null) {
    return null;
  }
  const raw = assertObject(payload.responsibleParty);
  const party: ResponsibleParty = {
    name: requireString(raw, 'name', TEXT_LIMITS.displayName),
  };
  const role = optionalString(raw, 'role', TEXT_LIMITS.shortText);
  const email = optionalString(raw, 'email', TEXT_LIMITS.email);
  const phone = optionalString(raw, 'phone', TEXT_LIMITS.shortText);
  const contactId = optionalString(raw, 'contactId', TEXT_LIMITS.shortText);
  if (role) party.role = role;
  if (email) party.email = email;
  if (phone) party.phone = phone;
  if (contactId) party.contactId = contactId;
  return party;
}

/** Validate the optional Article 5(3) duty-holder list: bounded strings only.
 *  An explicit null is the CLEAR intent on update: the whole list goes. */
function optionalArticle53(
  payload: Record<string, unknown>,
): string[] | null | undefined {
  if (payload.article53Persons === undefined) {
    return undefined;
  }
  if (payload.article53Persons === null) {
    return null;
  }
  const raw = payload.article53Persons;
  if (!Array.isArray(raw)) {
    throw fail.invalidArgument('The article53Persons field must be a list.', {
      field: 'article53Persons',
    });
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > TEXT_LIMITS.displayName) {
      throw fail.invalidArgument('Each duty-holder must be a name.', {
        field: 'article53Persons',
        index,
      });
    }
    return entry.trim();
  });
}

/** Validate the optional service schedule against the statutory key list; each
 *  entry carries an optional epoch-millis nextDue. Unknown keys are rejected.
 *  An explicit null is the CLEAR intent on update: the whole node goes. */
function optionalSchedule(
  payload: Record<string, unknown>,
): ServiceSchedule | null | undefined {
  if (payload.serviceSchedule === undefined) {
    return undefined;
  }
  if (payload.serviceSchedule === null) {
    return null;
  }
  const raw = assertObject(payload.serviceSchedule);
  const schedule: ServiceSchedule = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(SERVICE_SCHEDULE_KEYS as readonly string[]).includes(key)) {
      throw fail.invalidArgument(`Unknown service schedule key: ${key}.`, {
        field: 'serviceSchedule',
        key,
      });
    }
    const item = assertObject(value);
    const entry: ServiceScheduleItem = {};
    if (item.nextDue !== undefined) {
      if (
        typeof item.nextDue !== 'number' ||
        !Number.isInteger(item.nextDue) ||
        item.nextDue <= 0
      ) {
        throw fail.invalidArgument('Each nextDue must be a valid date.', {
          field: 'serviceSchedule',
          key,
        });
      }
      entry.nextDue = item.nextDue;
    }
    schedule[key as (typeof SERVICE_SCHEDULE_KEYS)[number]] = entry;
  }
  return schedule;
}

/** The validated, whitelisted building fields present in a payload. Null on an
 *  optional field is the CLEAR intent (ClearableFields in the contract): the
 *  update path writes it through and RTDB deletes the key or node. */
interface BuildingFields {
  name?: string;
  customerId?: string;
  address?: string | null;
  details?: BuildingDetails | null;
  responsibleParty?: ResponsibleParty | null;
  article53Persons?: string[] | null;
  photoUrl?: string | null;
  serviceSchedule?: ServiceSchedule | null;
}

/** Validate the whole payload: derived fields rejected by name, unknown fields
 *  rejected outright, each whitelisted field validated on its own terms.
 *  name and customerId are required on the record, so they can only ever be
 *  changed, never cleared. */
function readFields(
  payload: Record<string, unknown>,
  env: Environment,
  orgId: string,
): BuildingFields {
  for (const key of Object.keys(payload)) {
    if ((DERIVED_FIELDS as readonly string[]).includes(key)) {
      throw fail.invalidArgument(
        `The ${key} field is derived by the platform and cannot be set directly.`,
        { field: key },
      );
    }
    if (!(BUILDING_FIELDS as readonly string[]).includes(key)) {
      throw fail.invalidArgument(`Unknown building field: ${key}.`, { field: key });
    }
  }
  if (payload.name === null) {
    throw fail.invalidArgument('The name cannot be removed, only changed.', {
      field: 'name',
    });
  }
  if (payload.customerId === null) {
    throw fail.invalidArgument('The customerId cannot be removed, only changed.', {
      field: 'customerId',
    });
  }
  const fields: BuildingFields = {};
  const name = optionalString(payload, 'name', TEXT_LIMITS.shortText);
  const customerId = optionalString(payload, 'customerId', TEXT_LIMITS.shortText);
  const address = clearableString(payload, 'address', TEXT_LIMITS.shortText);
  if (name !== undefined) fields.name = name;
  if (customerId !== undefined) fields.customerId = customerId;
  if (address !== undefined) fields.address = address;
  const details = optionalDetails(payload);
  if (details !== undefined) fields.details = details;
  const party = optionalParty(payload);
  if (party !== undefined) fields.responsibleParty = party;
  const article53 = optionalArticle53(payload);
  if (article53 !== undefined) fields.article53Persons = article53;
  if (payload.photoUrl === null) {
    // The CLEAR intent: the photo pointer is optional, so null deletes it.
    fields.photoUrl = null;
  } else if (payload.photoUrl !== undefined) {
    // Same tenant boundary as the org logo: the photo must be an object this
    // org uploaded through the tenant-scoped Storage pipeline.
    const photoUrl = requireString(payload, 'photoUrl', 2048);
    fields.photoUrl = requireTenantStorageRef(photoUrl, 'photoUrl', env, orgId);
  }
  const schedule = optionalSchedule(payload);
  if (schedule !== undefined) fields.serviceSchedule = schedule;
  return fields;
}

export const manageBuilding = onCall<ManageBuildingInput>(
  callableOptions,
  (request) =>
    runCallable<ManageBuildingResult>(
      createLogger({ fn: 'manageBuilding' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'manageBuilding');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the action, the owning site and the fields.
        const input = assertObject(request.data);
        const action = requireEnum(input, 'action', ACTIONS);
        const siteId = requireDbKey(input, 'siteId', TEXT_LIMITS.shortText);
        const payload = assertObject(input.building);
        // Null is only meaningful as a CLEAR on update (ClearableFields in the
        // contract); on create there is nothing to clear yet, so it is a client
        // error, never accepted.
        if (action === 'create') {
          for (const [key, value] of Object.entries(payload)) {
            if (value === null) {
              throw fail.invalidArgument(
                `The ${key} field cannot be null when creating a building.`,
                { field: key },
              );
            }
          }
        }
        const fields = readFields(payload, env, orgId);

        // A linked responsible party must point at one of the building's
        // customer's contacts - an id from anywhere else would render as a
        // person who does not exist. Manual (unlinked) parties skip this.
        const assertPartyContact = async (customerId: string) => {
          const linkedContactId = fields.responsibleParty?.contactId;
          if (!linkedContactId) {
            return;
          }
          const contactSnap = await db
            .ref(paths.db.customerContact(orgId, customerId, linkedContactId))
            .get();
          if (!contactSnap.exists()) {
            throw fail.notFound(
              "That contact could not be found in this customer's contacts.",
              { field: 'responsibleParty' },
            );
          }
        };

        // 3a. Create: name + customerId required, and the site must exist under
        // that customer (a building can never be orphaned or cross-wired -
        // createJob later relies on building.customerId matching, brief 18.3).
        if (action === 'create') {
          if (!fields.name) {
            throw fail.invalidArgument('The building needs a name.', {
              field: 'name',
            });
          }
          if (!fields.customerId) {
            throw fail.invalidArgument('The building needs a customerId.', {
              field: 'customerId',
            });
          }
          const siteSnap = await db
            .ref(paths.db.site(orgId, fields.customerId, siteId))
            .get();
          if (!siteSnap.exists()) {
            throw fail.notFound('That site could not be found for that customer.', {
              field: 'siteId',
            });
          }
          await assertPartyContact(fields.customerId);
          // riskLevel starts 'pending': no assessment has been released yet, and
          // only the platform's derivation may ever change it.
          const building: Building = {
            name: fields.name,
            customerId: fields.customerId,
            riskLevel: 'pending',
            ...(fields.address ? { address: fields.address } : {}),
            ...(fields.details ? { details: fields.details } : {}),
            ...(fields.responsibleParty
              ? { responsibleParty: fields.responsibleParty }
              : {}),
            ...(fields.article53Persons
              ? { article53Persons: fields.article53Persons }
              : {}),
            ...(fields.photoUrl ? { photoUrl: fields.photoUrl } : {}),
            ...(fields.serviceSchedule
              ? { serviceSchedule: fields.serviceSchedule }
              : {}),
          };
          const buildingId = db.ref(paths.db.buildings(orgId, siteId)).push()
            .key as string;
          await db.ref().update({
            [paths.db.building(orgId, siteId, buildingId)]: building,
            // The portal's per-building rules key (actions, reports) resolves
            // buildingId -> owning customerId through this index, so it is
            // written in the SAME atomic update as the building itself - the
            // two can never disagree (FR-E22).
            [paths.db.buildingCustomer(orgId, buildingId)]: building.customerId,
            ...activityUpdate(paths, orgId, {
              actorUid: uid,
              action: 'building.created',
              target: buildingId,
            }),
          });
          createLogger({ fn: 'manageBuilding', orgId }).info('Building created', {
            siteId,
            buildingId,
          });
          return { buildingId };
        }

        // 3b. Update: the building must exist; only present fields change. A
        // customerId change must resolve to a customer that OWNS this building's
        // site - checking mere customer existence would let the record drift out
        // of step with the site tree that physically holds it, and createJob
        // trusts building.customerId downstream.
        const buildingId = requireDbKey(input, 'buildingId', TEXT_LIMITS.shortText);
        const buildingPath = paths.db.building(orgId, siteId, buildingId);
        const existingSnap = await db.ref(buildingPath).get();
        if (!existingSnap.exists()) {
          throw fail.notFound('That building could not be found.', {
            field: 'buildingId',
          });
        }
        if (fields.customerId !== undefined) {
          const siteSnap = await db
            .ref(paths.db.site(orgId, fields.customerId, siteId))
            .get();
          if (!siteSnap.exists()) {
            throw fail.failedPrecondition(
              "A building's customer must own the site the building belongs to.",
              { field: 'customerId' },
            );
          }
        }
        await assertPartyContact(
          fields.customerId ??
            (existingSnap.child('customerId').val() as string),
        );

        const update: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          update[`${buildingPath}/${key}`] = value;
        }
        if (Object.keys(update).length === 0) {
          throw fail.invalidArgument('No building fields were provided.');
        }
        if (fields.customerId !== undefined) {
          // Ownership moved: retarget the buildingId -> customerId index in the
          // SAME multi-location update, so the portal's per-building read scope
          // (actions, reports) follows the building atomically (FR-E22).
          update[paths.db.buildingCustomer(orgId, buildingId)] =
            fields.customerId;
        }

        // A service-schedule change is the compliance-relevant one (story 2023),
        // so the activity entry calls it out by name.
        const changed = Object.keys(fields).sort().join(', ');
        Object.assign(
          update,
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action:
              fields.serviceSchedule !== undefined
                ? 'building.serviceSchedule updated'
                : `building.updated (${changed})`,
            target: buildingId,
          }),
        );
        await db.ref().update(update);

        createLogger({ fn: 'manageBuilding', orgId }).info('Building updated', {
          siteId,
          buildingId,
          changed: Object.keys(fields),
        });
        return { buildingId };
      },
    ),
);
