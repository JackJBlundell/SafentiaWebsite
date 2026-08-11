// ============================================================================
// updateOrgProfile (callable, admin-only) - Phase 2 admin, whitelabel theming.
//
// An admin edits their org's public profile (name, brand, contact, typography,
// logo, report cover image). Partial by design: only the fields present in the
// input change. Being a callable means the profile write and its /activity entry
// land in ONE multi-location update - the audit trail cannot be skipped or
// forged. Two validations matter especially:
//   - Brand colours must be #RRGGBB exactly; a malformed colour would crash the
//     themed report renderer, so it is rejected here, never stored.
//   - logoUrl and coverImageUrl must reference an object inside the org's OWN
//     tenant Storage root (env + orgId); accepting an arbitrary URL would let an
//     admin point their org's mark - or every report cover they issue - at
//     another tenant's object or an external host.
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
  optionalString,
  requireTenantStorageRef,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { assertFeature, resolvePlanContext } from '../lib/planContext';
import { markOnboardingStep } from '../lib/onboardingMarks';
import type {
  OrgBrand,
  OrgContact,
  UpdateOrgProfileInput,
  UpdateOrgProfileResult,
} from '../shared/types';

/** Exactly #RRGGBB. The report renderer and the portal theme both consume these
 *  raw, so anything looser (names, rgb(), 3-digit hex) is rejected. */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** The profile fields an admin may set. Anything else in the payload is rejected
 *  rather than dropped, so a client cannot silently believe it wrote a field.
 *  `suspended` (the member-readable suspension mirror) is deliberately NOT
 *  here: it is written exclusively by the Stripe webhook, and this whitelist
 *  is what makes it unforgeable through the one client write path profile has.
 *  The per-child writes below also mean an admin edit can never blow it away. */
const PROFILE_FIELDS = [
  'name',
  'brand',
  'contact',
  'fontFamily',
  'logoUrl',
  'coverImageUrl',
] as const;
const CONTACT_FIELDS = ['name', 'email', 'phone', 'address', 'website'] as const;

/**
 * Does this partial profile write SET branded presentation - brand colours or
 * a logo (Phase 3 §6)? Pure and exported so both outcomes unit-test without a
 * database. An explicit null on logoUrl is a CLEAR, which moves the profile
 * TOWARDS the platform default and is therefore always allowed - the gate
 * blocks applying branding, never removing it (§6.3: never delete, never
 * hide). Name, contact, cover image and typography stay ungated: only the
 * fields the branding feature is sold on are refused.
 */
export function requestsBrandedFields(profile: Record<string, unknown>): boolean {
  return (
    profile.brand !== undefined ||
    (profile.logoUrl !== undefined && profile.logoUrl !== null)
  );
}

export const updateOrgProfile = onCall<UpdateOrgProfileInput>(
  callableOptions,
  (request) =>
    runCallable<UpdateOrgProfileResult>(
      createLogger({ fn: 'updateOrgProfile' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'updateOrgProfile');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the partial profile against the whitelist.
        const input = assertObject(request.data);
        const profile = assertObject(input.profile);
        for (const key of Object.keys(profile)) {
          if (!(PROFILE_FIELDS as readonly string[]).includes(key)) {
            throw fail.invalidArgument(`Unknown profile field: ${key}.`, {
              field: key,
            });
          }
        }

        // Branding is a plan feature (Phase 3 §6): setting colours or a logo
        // requires it. The plan context is read only when a branded field is
        // actually being set, so the everyday name/contact edit costs nothing.
        // Anything already stored stays stored (§6.3) - it is simply not
        // APPLIED while the feature is off (see lib/planContext's
        // applyBrandingEntitlement) - and an explicit null CLEAR is always
        // allowed, because it moves the profile towards the platform default.
        if (requestsBrandedFields(profile)) {
          const { entitlements } = await resolvePlanContext(paths, orgId);
          assertFeature(
            entitlements,
            'branding',
            'Custom branding (your logo and colours) is included from the Silver plan. Upgrade to apply your own branding; anything you have already uploaded is kept safe.',
          );
        }

        // Each present field validates on its own terms and becomes one child
        // write under /profile, so absent fields are genuinely untouched.
        const profilePath = paths.db.orgProfile(orgId);
        const update: Record<string, unknown> = {};

        if (profile.name !== undefined) {
          update[`${profilePath}/name`] = requireString(
            profile,
            'name',
            TEXT_LIMITS.shortText,
          );
        }

        if (profile.brand !== undefined) {
          // Brand is replaced whole (both colours are required by OrgBrand).
          const brandInput = assertObject(profile.brand);
          const primary = requireString(brandInput, 'primary', 16);
          const secondary = requireString(brandInput, 'secondary', 16);
          if (!HEX_COLOUR.test(primary) || !HEX_COLOUR.test(secondary)) {
            throw fail.invalidArgument(
              'Brand colours must be six-digit hex values like #D9C554.',
              { field: 'brand' },
            );
          }
          const brand: OrgBrand = { primary, secondary };
          update[`${profilePath}/brand`] = brand;
        }

        if (profile.contact === null) {
          // The CLEAR intent: contact is optional, so an explicit null removes
          // the whole node (RTDB deletes a key written as null).
          update[`${profilePath}/contact`] = null;
        } else if (profile.contact !== undefined) {
          // Contact is replaced whole; every field is optional free-ish text.
          const contactInput = assertObject(profile.contact);
          for (const key of Object.keys(contactInput)) {
            if (!(CONTACT_FIELDS as readonly string[]).includes(key)) {
              throw fail.invalidArgument(`Unknown contact field: ${key}.`, {
                field: key,
              });
            }
          }
          const contact: OrgContact = {};
          const name = optionalString(contactInput, 'name', TEXT_LIMITS.displayName);
          const email = optionalString(contactInput, 'email', TEXT_LIMITS.email);
          const phone = optionalString(contactInput, 'phone', TEXT_LIMITS.shortText);
          const address = optionalString(contactInput, 'address', TEXT_LIMITS.shortText);
          // Stored exactly as typed, scheme or not: an admin writes
          // "wmcompliance.co.uk" and the report cover prints that, so demanding
          // https:// here would reject the form most people actually write. It
          // is display text on a PDF, never a fetched or linkified URL, so the
          // length bound is the whole of the safety it needs.
          const website = optionalString(contactInput, 'website', TEXT_LIMITS.shortText);
          if (name) contact.name = name;
          if (email) contact.email = email;
          if (phone) contact.phone = phone;
          if (address) contact.address = address;
          if (website) contact.website = website;
          update[`${profilePath}/contact`] = contact;
        }

        if (profile.fontFamily !== undefined) {
          // Null OR an empty string removes the override so the platform
          // default applies - this is what makes the form's "Leave blank for
          // the Safentia default" hint true. optionalString returns undefined
          // for both null and blank, so ?? null turns either into the delete.
          update[`${profilePath}/fontFamily`] =
            optionalString(profile, 'fontFamily', TEXT_LIMITS.shortText) ?? null;
        }

        if (profile.logoUrl === null) {
          // The CLEAR intent: the logo is optional, so an explicit null
          // removes it and the platform default applies.
          update[`${profilePath}/logoUrl`] = null;
        } else if (profile.logoUrl !== undefined) {
          // Tenant boundary: the logo must be an object the org itself uploaded
          // through the tenant-scoped Storage pipeline. See requireTenantStorageRef.
          const logoUrl = requireString(profile, 'logoUrl', 2048);
          update[`${profilePath}/logoUrl`] = requireTenantStorageRef(
            logoUrl,
            'logoUrl',
            env,
            orgId,
          );
        }

        if (profile.coverImageUrl === null) {
          // The CLEAR intent. Absent is a designed state, not a broken one: the
          // report cover paints its top-left panel from the brand colours
          // instead, so removing this never leaves a hole on a client's PDF.
          update[`${profilePath}/coverImageUrl`] = null;
        } else if (profile.coverImageUrl !== undefined) {
          // Same tenant boundary as the logo, and it matters more here: this
          // image is stamped on every report the org issues, so an unvalidated
          // URL would be a durable pointer at another tenant's object or at
          // external, mutable content in someone else's control.
          const coverImageUrl = requireString(profile, 'coverImageUrl', 2048);
          update[`${profilePath}/coverImageUrl`] = requireTenantStorageRef(
            coverImageUrl,
            'coverImageUrl',
            env,
            orgId,
          );
        }

        if (Object.keys(update).length === 0) {
          throw fail.invalidArgument('No profile fields were provided.');
        }

        // 3. Atomic write: the profile changes and the audit entry together.
        const changed = Object.keys(profile).sort().join(', ');
        Object.assign(
          update,
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action: `orgProfile.updated (${changed})`,
            target: orgId,
          }),
        );
        await db.ref().update(update);

        const logger = createLogger({ fn: 'updateOrgProfile', orgId });
        // Setup-wizard piggyback (Phase 3 §5.4): best-effort, never throws.
        await markOnboardingStep(uid, orgId, 'profile', logger);
        logger.info('Organisation profile updated', { fields: Object.keys(profile) });
        return { updated: true };
      },
    ),
);
