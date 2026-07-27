// ============================================================================
// manageSite (callable, admin-only) - Phase 2 admin, site CRUD.
//
// Create or update a site under a customer (sites are stored per customer:
// /sites/{orgId}/{customerId}/{siteId}). Direct client writes are denied by
// rules; every change here lands in the SAME multi-location update as its
// /activity entry, so the audit trail cannot be skipped or forged - the whole
// reason this is a callable. There is no delete or archive: a site exists as
// long as its buildings' history does.
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
  requireDbKey,
  optionalString,
  clearableString,
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import type {
  GeoPoint,
  ManageSiteInput,
  ManageSiteResult,
  Site,
} from '../shared/types';

/** The site fields an admin may set; anything else is rejected, never dropped. */
const SITE_FIELDS = ['name', 'address', 'geo', 'email', 'phone', 'contactId'] as const;

const ACTIONS = ['create', 'update'] as const;

/** Validate an optional geo point: both coordinates finite and on the globe.
 *  An explicit null is the CLEAR intent on update: the whole geo node goes. */
function optionalGeo(
  payload: Record<string, unknown>,
): GeoPoint | null | undefined {
  if (payload.geo === undefined) {
    return undefined;
  }
  if (payload.geo === null) {
    return null;
  }
  const geo = assertObject(payload.geo);
  const lat = geo.lat;
  const lng = geo.lng;
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
    throw fail.invalidArgument('The geo field must hold valid coordinates.', {
      field: 'geo',
    });
  }
  return { lat, lng };
}

export const manageSite = onCall<ManageSiteInput>(callableOptions, (request) =>
  runCallable<ManageSiteResult>(
    createLogger({ fn: 'manageSite' }),
    async () => {
      // 1. Attestation, identity, authorisation.
      assertAppCheck(request);
      const { uid } = assertAuth(request);
      await assertRateLimit(uid, 'manageSite');
      const claims = getClaims(request);
      assertOrgRole(claims, 'admin');
      const { paths } = envFor(claims);
      const orgId = claims.orgId;

      // 2. Validate the action, the owning customer and the fields.
      const input = assertObject(request.data);
      const action = requireEnum(input, 'action', ACTIONS);
      const customerId = requireDbKey(input, 'customerId', TEXT_LIMITS.shortText);
      const payload = assertObject(input.site);
      for (const key of Object.keys(payload)) {
        if (!(SITE_FIELDS as readonly string[]).includes(key)) {
          throw fail.invalidArgument(`Unknown site field: ${key}.`, { field: key });
        }
      }
      // Null is only meaningful as a CLEAR on update (ClearableFields in the
      // contract: writing null deletes the key in RTDB); on create there is
      // nothing to clear yet, so it is a client error, never accepted.
      if (action === 'create') {
        for (const [key, value] of Object.entries(payload)) {
          if (value === null) {
            throw fail.invalidArgument(
              `The ${key} field cannot be null when creating a site.`,
              { field: key },
            );
          }
        }
      }
      // Name is required on the record, so it can only be changed, never cleared.
      if (payload.name === null) {
        throw fail.invalidArgument('The name cannot be removed, only changed.', {
          field: 'name',
        });
      }
      const name = optionalString(payload, 'name', TEXT_LIMITS.shortText);
      const address = clearableString(payload, 'address', TEXT_LIMITS.shortText);
      const geo = optionalGeo(payload);
      const email = clearableString(payload, 'email', TEXT_LIMITS.email);
      const phone = clearableString(payload, 'phone', TEXT_LIMITS.shortText);
      const contactId = clearableString(payload, 'contactId', TEXT_LIMITS.shortText);

      // A site's contact must be one of the owning customer's contacts - an id
      // from anywhere else would render as a person who does not exist. Null
      // (the CLEAR) and absence skip the check.
      if (contactId) {
        const contactSnap = await db
          .ref(paths.db.customerContact(orgId, customerId, contactId))
          .get();
        if (!contactSnap.exists()) {
          throw fail.notFound(
            "That contact could not be found in this customer's contacts.",
            { field: 'contactId' },
          );
        }
      }

      // 3a. Create: the owning customer must exist (a site can never be orphaned)
      // and the site needs a name. push() mints the id.
      if (action === 'create') {
        if (!name) {
          throw fail.invalidArgument('The site needs a name.', { field: 'name' });
        }
        const customerSnap = await db
          .ref(paths.db.customer(orgId, customerId))
          .get();
        if (!customerSnap.exists()) {
          throw fail.notFound('That customer could not be found.', {
            field: 'customerId',
          });
        }
        const site: Site = {
          name,
          ...(address ? { address } : {}),
          ...(geo ? { geo } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(contactId ? { contactId } : {}),
        };
        const siteId = db.ref(paths.db.sites(orgId, customerId)).push()
          .key as string;
        await db.ref().update({
          [paths.db.site(orgId, customerId, siteId)]: site,
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'site.created',
            target: siteId,
          }),
        });
        createLogger({ fn: 'manageSite', orgId }).info('Site created', {
          customerId,
          siteId,
        });
        return { siteId };
      }

      // 3b. Update: the site must exist; only present fields change.
      const siteId = requireDbKey(input, 'siteId', TEXT_LIMITS.shortText);
      const sitePath = paths.db.site(orgId, customerId, siteId);
      const existingSnap = await db.ref(sitePath).get();
      if (!existingSnap.exists()) {
        throw fail.notFound('That site could not be found.', { field: 'siteId' });
      }

      const update: Record<string, unknown> = {};
      if (name !== undefined) update[`${sitePath}/name`] = name;
      if (address !== undefined) update[`${sitePath}/address`] = address;
      if (geo !== undefined) update[`${sitePath}/geo`] = geo;
      if (email !== undefined) update[`${sitePath}/email`] = email;
      if (phone !== undefined) update[`${sitePath}/phone`] = phone;
      if (contactId !== undefined) update[`${sitePath}/contactId`] = contactId;
      if (Object.keys(update).length === 0) {
        throw fail.invalidArgument('No site fields were provided.');
      }

      Object.assign(
        update,
        activityUpdate(paths, orgId, {
          actorUid: uid,
          action: 'site.updated',
          target: siteId,
        }),
      );
      await db.ref().update(update);

      createLogger({ fn: 'manageSite', orgId }).info('Site updated', {
        customerId,
        siteId,
      });
      return { siteId };
    },
  ),
);
