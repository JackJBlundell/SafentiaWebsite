// ============================================================================
// importRecords (callable, admin-only) - bulk CSV import of an estate.
//
// manageSite and manageBuilding are one record per call, which is the right
// shape for a form and the wrong shape for a spreadsheet: several hundred
// sequential calls are slow and, worse, fail HALF WAY, leaving an admin to work
// out by hand which sites landed and which did not. This Function takes the
// whole file, validates every field of every record FIRST, and then writes the
// lot - sites, buildings, the buildingId -> customerId index and one activity
// entry per created record - in a SINGLE multi-location update. Either the
// entire import happened or none of it did.
//
// The client validates the same rules to give immediate, plain-language
// feedback; that pass is convenience, this one is the boundary. Every field is
// re-derived here from the raw payload, and the platform-derived Building
// fields (riskLevel, ragDistribution, lastAssessedAt) are rejected outright,
// exactly as manageBuilding rejects them - an import must never be a way to
// paint a high-risk building green.
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
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { ALARM_CATEGORIES } from '../shared/types';
import type {
  Building,
  BuildingDetails,
  GeoPoint,
  ImportRecordsInput,
  ImportRecordsResult,
  ResponsibleParty,
  ServiceSchedule,
  Site,
} from '../shared/types';

const MODES = ['sites', 'buildings'] as const;

/** The stored site record an import writes: Site plus the two contact fields
 *  manageSite's SITE_FIELDS also accepts, which predate the Site type's
 *  optional-field list. Declared once here rather than inlined, so the shape an
 *  import writes is stated as plainly as the shape the form writes. */
type ImportedSite = Site & { email?: string; phone?: string };

/** The ceiling the dialog states and this Function enforces. Bounds one update
 *  to a size RTDB applies comfortably in a single transaction. */
const MAX_ROWS = 500;

/** The fields a CSV row may carry, per record kind. Anything else is rejected
 *  rather than dropped, so a caller can never quietly smuggle a field past the
 *  contract - the same discipline as manageSite and manageBuilding. */
const SITE_FIELDS = [
  'name',
  'address',
  'email',
  'phone',
  'geo',
  'buildings',
] as const;
const BUILDING_FIELDS = [
  'name',
  'address',
  'responsibleParty',
  'article53Persons',
  'details',
  'serviceSchedule',
] as const;

/** Derived by the platform from released assessments; never importable. */
const DERIVED_FIELDS = ['riskLevel', 'ragDistribution', 'lastAssessedAt'] as const;

/** Mirrors manageBuilding's DETAIL_LIMITS: generous for any real building, and
 *  bounded so a mistyped cell cannot store an absurd figure. */
const DETAIL_LIMITS = {
  area: 10_000_000,
  floors: 200,
  occupiedFloors: 200,
  occupants: 100_000,
} as const;

/** The one service date an import carries (the FRA review). The rest are
 *  maintained on the building record, so accepting them here would create a
 *  second, thinner way to set statutory dates. */
const IMPORTABLE_SCHEDULE_KEYS = ['fraReview'] as const;

/** The one message the row ceiling is reported with, so every place that can
 *  trip it says the same thing. */
function tooManyRows(field: string): never {
  throw fail.invalidArgument(
    `An import may carry at most ${MAX_ROWS} rows. Split the file and import it in parts.`,
    { field, max: MAX_ROWS },
  );
}

/** Reject unknown and derived keys by name, so the failure says WHY. `where`
 *  locates the offending record for an admin reading a 400-row file. Null is
 *  rejected outright: an import only ever CREATES, so the clear-a-field intent
 *  the update callables read from null is meaningless here, and letting it
 *  through would reach the object validators as a bare "malformed body". */
function assertFields(
  payload: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const [key, value] of Object.entries(payload)) {
    if ((DERIVED_FIELDS as readonly string[]).includes(key)) {
      throw fail.invalidArgument(
        `${where}: the ${key} field is derived by the platform and cannot be imported.`,
        { field: key },
      );
    }
    if (!allowed.includes(key)) {
      throw fail.invalidArgument(`${where}: unknown field ${key}.`, {
        field: key,
      });
    }
    if (value === null) {
      throw fail.invalidArgument(
        `${where}: the ${key} field cannot be null in an import.`,
        { field: key },
      );
    }
  }
}

/** A positive finite number within a sanity ceiling. Reject, never coerce. */
function optionalPositiveNumber(
  payload: Record<string, unknown>,
  field: string,
  max: number,
  where: string,
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
      `${where}: ${field} must be a number between 0 and ${max}.`,
      { field, max },
    );
  }
  return value;
}

function optionalGeo(
  payload: Record<string, unknown>,
  where: string,
): GeoPoint | undefined {
  if (payload.geo === undefined) {
    return undefined;
  }
  const geo = assertObject(payload.geo);
  const { lat, lng } = geo;
  if (
    typeof lat !== 'number' ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lng !== 'number' ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    throw fail.invalidArgument(`${where}: geo must hold valid coordinates.`, {
      field: 'geo',
    });
  }
  return { lat, lng };
}

function optionalDetails(
  payload: Record<string, unknown>,
  where: string,
): BuildingDetails | undefined {
  if (payload.details === undefined) {
    return undefined;
  }
  const raw = assertObject(payload.details);
  const details: BuildingDetails = {};
  const area = optionalPositiveNumber(raw, 'area', DETAIL_LIMITS.area, where);
  const floors = optionalPositiveNumber(raw, 'floors', DETAIL_LIMITS.floors, where);
  const occupiedFloors = optionalPositiveNumber(
    raw,
    'occupiedFloors',
    DETAIL_LIMITS.occupiedFloors,
    where,
  );
  const occupants = optionalPositiveNumber(
    raw,
    'occupants',
    DETAIL_LIMITS.occupants,
    where,
  );
  if (area !== undefined) details.area = area;
  if (floors !== undefined) details.floors = floors;
  if (occupiedFloors !== undefined) details.occupiedFloors = occupiedFloors;
  if (occupants !== undefined) details.occupants = occupants;
  if (raw.isLandlord !== undefined) {
    if (typeof raw.isLandlord !== 'boolean') {
      throw fail.invalidArgument(`${where}: isLandlord must be true or false.`, {
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
  return Object.keys(details).length > 0 ? details : undefined;
}

function optionalParty(
  payload: Record<string, unknown>,
  where: string,
): ResponsibleParty | undefined {
  if (payload.responsibleParty === undefined) {
    return undefined;
  }
  const raw = assertObject(payload.responsibleParty);
  for (const key of Object.keys(raw)) {
    if (!['name', 'role', 'email', 'phone'].includes(key)) {
      throw fail.invalidArgument(
        `${where}: unknown responsibleParty field ${key}.`,
        { field: 'responsibleParty' },
      );
    }
  }
  const party: ResponsibleParty = {
    name: requireString(raw, 'name', TEXT_LIMITS.displayName),
  };
  const role = optionalString(raw, 'role', TEXT_LIMITS.shortText);
  const email = optionalString(raw, 'email', TEXT_LIMITS.email);
  const phone = optionalString(raw, 'phone', TEXT_LIMITS.shortText);
  if (role) party.role = role;
  if (email) party.email = email;
  if (phone) party.phone = phone;
  return party;
}

function optionalArticle53(
  payload: Record<string, unknown>,
  where: string,
): string[] | undefined {
  if (payload.article53Persons === undefined) {
    return undefined;
  }
  const raw = payload.article53Persons;
  if (!Array.isArray(raw)) {
    throw fail.invalidArgument(`${where}: article53Persons must be a list.`, {
      field: 'article53Persons',
    });
  }
  const names = raw.map((entry) => {
    if (
      typeof entry !== 'string' ||
      entry.trim().length === 0 ||
      entry.length > TEXT_LIMITS.displayName
    ) {
      throw fail.invalidArgument(`${where}: each duty-holder must be a name.`, {
        field: 'article53Persons',
      });
    }
    return entry.trim();
  });
  return names.length > 0 ? names : undefined;
}

function optionalSchedule(
  payload: Record<string, unknown>,
  where: string,
): ServiceSchedule | undefined {
  if (payload.serviceSchedule === undefined) {
    return undefined;
  }
  const raw = assertObject(payload.serviceSchedule);
  const schedule: ServiceSchedule = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(IMPORTABLE_SCHEDULE_KEYS as readonly string[]).includes(key)) {
      throw fail.invalidArgument(
        `${where}: ${key} cannot be imported. Set it on the building's service schedule.`,
        { field: 'serviceSchedule', key },
      );
    }
    const item = assertObject(value);
    const nextDue = item.nextDue;
    if (
      typeof nextDue !== 'number' ||
      !Number.isInteger(nextDue) ||
      nextDue <= 0
    ) {
      throw fail.invalidArgument(`${where}: ${key} must carry a valid date.`, {
        field: 'serviceSchedule',
        key,
      });
    }
    schedule[key as (typeof IMPORTABLE_SCHEDULE_KEYS)[number]] = { nextDue };
  }
  return Object.keys(schedule).length > 0 ? schedule : undefined;
}

/** Build the Building record for one import row. `customerId` comes from the
 *  owning customer, never from the file, so an import can never cross-wire a
 *  building to an organisation the file names. */
function readBuilding(
  value: unknown,
  customerId: string,
  where: string,
): Building {
  const payload = assertObject(value);
  assertFields(payload, BUILDING_FIELDS, where);
  const name = requireString(payload, 'name', TEXT_LIMITS.shortText);
  const address = optionalString(payload, 'address', TEXT_LIMITS.shortText);
  const responsibleParty = optionalParty(payload, where);
  const article53Persons = optionalArticle53(payload, where);
  const details = optionalDetails(payload, where);
  const serviceSchedule = optionalSchedule(payload, where);
  // riskLevel starts 'pending': no assessment has been released yet, and only
  // the platform's derivation may ever change it.
  return {
    name,
    customerId,
    riskLevel: 'pending',
    ...(address ? { address } : {}),
    ...(details ? { details } : {}),
    ...(responsibleParty ? { responsibleParty } : {}),
    ...(article53Persons ? { article53Persons } : {}),
    ...(serviceSchedule ? { serviceSchedule } : {}),
  };
}

/** The buildings list on a site row, validated but not yet keyed. `remaining`
 *  is what is left of the whole-import row ceiling: the LENGTH is checked
 *  before a single entry is validated, so an oversized payload is refused
 *  without this Function first materialising every record it names. */
function readBuildingList(
  value: unknown,
  customerId: string,
  where: string,
  remaining: number,
): Building[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw fail.invalidArgument(`${where}: buildings must be a list.`, {
      field: 'buildings',
    });
  }
  if (value.length > remaining) {
    tooManyRows('buildings');
  }
  return value.map((entry, index) =>
    readBuilding(entry, customerId, `${where}, building ${index + 1}`),
  );
}

export const importRecords = onCall<ImportRecordsInput>(
  callableOptions,
  (request) =>
    runCallable<ImportRecordsResult>(
      createLogger({ fn: 'importRecords' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'importRecords');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the shape and the owning records.
        const input = assertObject(request.data);
        const mode = requireEnum(input, 'mode', MODES);
        const customerId = requireDbKey(
          input,
          'customerId',
          TEXT_LIMITS.shortText,
        );
        const customerSnap = await db
          .ref(paths.db.customer(orgId, customerId))
          .get();
        if (!customerSnap.exists()) {
          throw fail.notFound('That customer could not be found.', {
            field: 'customerId',
          });
        }

        const update: Record<string, unknown> = {};
        let sitesCreated = 0;
        let buildingsCreated = 0;

        /** Stage one building under a site: the record, the buildingId ->
         *  customerId index the portal's per-building read scope resolves
         *  through (FR-E22), and its activity entry - all in the one update, so
         *  they can never disagree. */
        const stageBuilding = (siteId: string, building: Building): void => {
          const buildingId = db.ref(paths.db.buildings(orgId, siteId)).push()
            .key as string;
          update[paths.db.building(orgId, siteId, buildingId)] = building;
          update[paths.db.buildingCustomer(orgId, buildingId)] =
            building.customerId;
          Object.assign(
            update,
            activityUpdate(paths, orgId, {
              actorUid: uid,
              action: 'building.created (import)',
              target: buildingId,
            }),
          );
          buildingsCreated += 1;
        };

        if (mode === 'sites') {
          const rows = input.sites;
          if (!Array.isArray(rows) || rows.length === 0) {
            throw fail.invalidArgument('The import contained no sites.', {
              field: 'sites',
            });
          }
          // The cap counts ROWS as the file holds them (a site plus each of its
          // buildings), matching the number the dialog states. It is applied
          // BEFORE any validation work: a site row costs at least one row, so a
          // list longer than the ceiling can never pass, and refusing it here
          // means a hostile payload naming a million records is rejected on its
          // length rather than after this Function has built a million objects.
          if (rows.length > MAX_ROWS) {
            tooManyRows('sites');
          }
          let rowCount = 0;
          const sites = rows.map((entry, index) => {
            const where = `Site ${index + 1}`;
            const payload = assertObject(entry);
            assertFields(payload, SITE_FIELDS, where);
            const site: ImportedSite = {
              name: requireString(payload, 'name', TEXT_LIMITS.shortText),
            };
            const address = optionalString(
              payload,
              'address',
              TEXT_LIMITS.shortText,
            );
            const email = optionalString(payload, 'email', TEXT_LIMITS.email);
            const phone = optionalString(payload, 'phone', TEXT_LIMITS.shortText);
            const geo = optionalGeo(payload, where);
            if (address) site.address = address;
            if (email) site.email = email;
            if (phone) site.phone = phone;
            if (geo) site.geo = geo;
            const buildings = readBuildingList(
              payload.buildings,
              customerId,
              where,
              MAX_ROWS - rowCount,
            );
            rowCount += Math.max(buildings.length, 1);
            if (rowCount > MAX_ROWS) {
              tooManyRows('sites');
            }
            return { site, buildings };
          });

          for (const { site, buildings } of sites) {
            const siteId = db.ref(paths.db.sites(orgId, customerId)).push()
              .key as string;
            update[paths.db.site(orgId, customerId, siteId)] = site;
            Object.assign(
              update,
              activityUpdate(paths, orgId, {
                actorUid: uid,
                action: 'site.created (import)',
                target: siteId,
              }),
            );
            sitesCreated += 1;
            for (const building of buildings) {
              stageBuilding(siteId, building);
            }
          }
        } else {
          const siteId = requireDbKey(input, 'siteId', TEXT_LIMITS.shortText);
          const siteSnap = await db
            .ref(paths.db.site(orgId, customerId, siteId))
            .get();
          if (!siteSnap.exists()) {
            throw fail.notFound(
              'That site could not be found for that customer.',
              { field: 'siteId' },
            );
          }
          const rows = input.buildings;
          if (!Array.isArray(rows) || rows.length === 0) {
            throw fail.invalidArgument('The import contained no buildings.', {
              field: 'buildings',
            });
          }
          if (rows.length > MAX_ROWS) {
            tooManyRows('buildings');
          }
          const buildings = rows.map((entry, index) =>
            readBuilding(entry, customerId, `Building ${index + 1}`),
          );
          for (const building of buildings) {
            stageBuilding(siteId, building);
          }
        }

        // 3. One write: every site, every building, every index entry and every
        // activity entry land together or not at all.
        await db.ref().update(update);

        createLogger({ fn: 'importRecords', orgId }).info('Records imported', {
          mode,
          customerId,
          sitesCreated,
          buildingsCreated,
        });
        return { sitesCreated, buildingsCreated };
      },
    ),
);
