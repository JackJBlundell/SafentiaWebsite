// ============================================================================
// setActiveOrganisation (callable) - switch which org the user is acting in.
//
// A user can belong to several organisations (e.g. an assessor contracted to two
// firms). Custom claims carry a SINGLE active org (the source of truth for org,
// roles and environment - enforced by rules), so "switching" means re-minting the
// caller's claims for the chosen org. We:
//   1. Enforce App Check + auth.
//   2. Verify the caller holds an ACTIVE membership in the target org (in their
//      current environment - the only env whose data they can see).
//   3. Recompute their claims from that membership (computeClaims) and write them
//      (writeClaims trips the refresh marker), so roles and testMode follow.
// The client force-refreshes its ID token after the call, and the AuthProvider
// re-resolves the session against the new claims - re-scoping the whole app.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  getClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireString, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { computeClaims, writeClaims } from '../lib/claims';
import type {
  OrgMember,
  OrgRole,
  SetActiveOrganisationInput,
  SetActiveOrganisationResult,
} from '../shared/types';

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
        const claims = getClaims(request);
        // The caller switches within their current environment; a membership in
        // another env is part of a separate isolation root and is not addressable
        // here (brief 4.8).
        const { paths } = envFor(claims);

        // 2. Validate the requested org id.
        const input = assertObject(request.data);
        const orgId = requireString(input, 'orgId', TEXT_LIMITS.shortText);

        // 3. The caller must hold an ACTIVE membership in the target org. Reading
        // their own member record is the authority; a missing or non-active record
        // means they cannot act in that org.
        const memberSnap = await db.ref(paths.db.orgMember(orgId, uid)).get();
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
