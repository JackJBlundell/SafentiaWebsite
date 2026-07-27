// ============================================================================
// setActiveOrganisation (callable) - switch which SPACE the user is acting in.
//
// A person can hold several spaces: organisations they work for as staff (an
// assessor contracted to two firms) and customer portals they are a contact at
// (a managing agent covering more than one housing association). Custom claims
// carry exactly ONE active space, and the two halves are minted mutually
// exclusively - a staff token has `orgId` and never `portalOrgId`, a portal
// token has `portalOrgId` + `customerId` and never `orgId` - because that
// exclusivity IS the security boundary the rules key on. So "switching" means
// RE-MINTING the caller's claims for the chosen space; the token never names
// two spaces at once, and the index being a collection changes only what can be
// LISTED, never what a single token grants.
//
// This callable is the only way the active space changes, so it re-verifies the
// caller genuinely holds the target from the trusted records on EVERY call and
// never trusts the request, the reverse index alone, or a previously-minted
// claim. We:
//   1. Enforce App Check + auth.
//   2. Staff (no customerId): verify an ACTIVE /orgMembers record, mint staff
//      claims via computeClaims.
//      Portal (customerId present): verify BOTH the caller's own
//      /customerUserIndex entry for the space AND an ACTIVE /customerMembers
//      record behind it, then mint portal claims via computePortalClaims.
//   3. writeClaims persists them and trips the refresh marker.
// The client force-refreshes its ID token after the call, and the AuthProvider
// re-resolves the session against the new claims - re-scoping the whole app.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth } from '../lib/guards';
import { paths, portalSpaceKey, type EnvPaths } from '../lib/paths';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { computeClaims, computePortalClaims, writeClaims } from '../lib/claims';
import type {
  CustomerMember,
  CustomerUserIndexEntry,
  Environment,
  OrgMember,
  OrgRole,
  SetActiveOrganisationInput,
  SetActiveOrganisationResult,
} from '../shared/types';

/**
 * The environment the caller is currently bound to, read straight off the
 * verified token rather than through getClaims/getPortalClaims: each of those
 * demands one half's claim shape, and this callable must serve a caller crossing
 * from either half to the other. `testMode` is the one claim both shapes carry,
 * and both halves set it from the root their membership record lives under, so
 * it is the whole of the env binding (brief 4.8). A switch stays WITHIN that
 * root: the other root is a separate isolation domain and is not addressable
 * here.
 */
function envForCaller(request: CallableRequest): {
  env: Environment;
  envPaths: EnvPaths;
} {
  const env = paths.envFromTestMode(request.auth?.token?.testMode === true);
  return { env, envPaths: paths.forEnv(env) };
}

export const setActiveOrganisation = onCall<SetActiveOrganisationInput>(
  callableOptions,
  (request) =>
    runCallable<SetActiveOrganisationResult>(
      createLogger({ fn: 'setActiveOrganisation' }),
      async () => {
        // 1. Attestation + identity.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'setActiveOrganisation');
        const { env, envPaths } = envForCaller(request);

        // 2. Validate the requested space. Both ids are interpolated into
        // database paths, so requireDbKey (not requireString) is what rejects a
        // `/` that would otherwise address a node one level away from the one we
        // mean to authorise against.
        const input = assertObject(request.data);
        const orgId = requireDbKey(input, 'orgId', TEXT_LIMITS.shortText);
        const wantsPortal =
          input.customerId !== undefined && input.customerId !== null;
        const customerId = wantsPortal
          ? requireDbKey(input, 'customerId', TEXT_LIMITS.shortText)
          : undefined;

        if (customerId) {
          // 3a. PORTAL space. Two independent records must agree before we mint:
          // the caller's own reverse-index entry (what the picker listed, and
          // only ever written by the invite flow) and the /customerMembers
          // record it points at (the authority on whether the membership is real
          // and still active). The index alone is not enough - it is not deleted
          // when a membership is locked - and the request itself is evidence of
          // nothing.
          const spaceKey = portalSpaceKey(orgId, customerId);
          const indexSnap = await db
            .ref(envPaths.db.customerUserIndexEntry(uid, spaceKey))
            .get();
          const entry = indexSnap.exists()
            ? (indexSnap.val() as CustomerUserIndexEntry)
            : null;

          const memberSnap = await db
            .ref(envPaths.db.customerMember(orgId, customerId, uid))
            .get();
          const portalMember = memberSnap.exists()
            ? (memberSnap.val() as CustomerMember)
            : null;

          // The entry's own fields are re-checked against the request rather
          // than assumed from the key, so a hand-repaired index whose key and
          // value disagree cannot grant a space it does not name.
          // computePortalClaims returns null for anything that is not an active
          // member, so it doubles as the status gate.
          const portalClaims =
            entry?.orgId === orgId && entry.customerId === customerId
              ? computePortalClaims(portalMember, orgId, customerId, env)
              : null;
          if (!portalClaims) {
            // ONE message for every portal refusal - no such space, not yours,
            // membership no longer active - so a caller cannot probe which orgs
            // or customers exist by reading the difference between them.
            throw fail.permissionDenied(
              'You do not have access to that customer portal.',
            );
          }

          await writeClaims(uid, portalClaims);

          return {
            orgId,
            // A portal space grants no STAFF roles by construction; its
            // permissions ride in the customerRoles claim instead.
            roles: [],
            customerId,
          };
        }

        // 3b. STAFF space. The caller must hold an ACTIVE membership in the
        // target org. Reading their own member record is the authority; a missing
        // or non-active record means they cannot act in that org.
        const memberSnap = await db.ref(envPaths.db.orgMember(orgId, uid)).get();
        if (!memberSnap.exists()) {
          throw fail.notFound('You are not a member of that organisation.');
        }
        const member = memberSnap.val() as OrgMember;
        if (member.status !== 'active') {
          throw fail.failedPrecondition(
            'Your access to that organisation is not active.',
          );
        }

        // 4. Re-mint claims for the chosen org and persist (trips the refresh
        // marker so the next token refresh - which the client forces - applies it).
        const nextClaims = computeClaims(member, orgId);
        await writeClaims(uid, nextClaims);

        return {
          orgId,
          roles: Object.keys(nextClaims.roles) as OrgRole[],
        };
      },
    ),
);
