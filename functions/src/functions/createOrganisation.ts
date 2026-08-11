// ============================================================================
// createOrganisation (callable, PLATFORM OPERATOR ONLY) - Phase 2 admin.
//
// Phase 3 self-serve onboarding (Stripe) provisions organisations from the
// webhook; this operator path remains for operator-founded (grandfathered,
// unlimited) tenants: the operator (superAdmin claim) creates the org, becomes
// its first admin member, then invites the client's real administrators via the
// normal staff invitations. The gate is the superAdmin CLAIM, not an org role -
// the operator is founding a tenant, so no org claims exist yet. We:
//   1. Enforce App Check + auth + the superAdmin claim, and rate limit.
//   2. Validate the org name.
//   3. Provision via lib/provisionOrganisation - the SAME atomic bootstrap the
//      self-serve webhook path runs (profile with the platform-default brand,
//      usage counters, the founder's admin membership, the /userOrgs login
//      index AND the /activity entry in ONE multi-location update), passed an
//      EMPTY subscription because operator orgs carry no Stripe fields (the
//      entitlements module grandfathers them) - which also means the helper's
//      per-subscription idempotency marker does not apply here.
//   4. The helper re-mints the caller's claims pointed at the new org (the same
//      path setActiveOrganisation uses) so they land in it immediately.
// onMembershipChange also fires on the membership write and recomputes the same
// claims - the explicit writeClaims just guarantees the ACTIVE org switches even
// if the trigger lands late, and both compute from the same trusted record.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { auth } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth, assertSuperAdmin } from '../lib/guards';
import { envFromTestMode } from '../lib/paths';
import { assertObject, requireString, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { provisionOrganisation } from '../lib/provisionOrganisation';
import type {
  CreateOrganisationInput,
  CreateOrganisationResult,
} from '../shared/types';

export const createOrganisation = onCall<CreateOrganisationInput>(
  callableOptions,
  (request) =>
    runCallable<CreateOrganisationResult>(
      createLogger({ fn: 'createOrganisation' }),
      async () => {
        // 1. Attestation, identity, operator gate, rate limit. Deliberately NOT
        // getClaims: the operator is founding a tenant, so there is no orgId
        // claim to read - the superAdmin claim is the whole gate. testMode is
        // read straight off the verified token so the new org lives in the
        // CALLER'S environment (brief 4.8).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        assertSuperAdmin(request);
        await assertRateLimit(uid, 'createOrganisation');
        const testMode = request.auth?.token?.testMode === true;
        const env = envFromTestMode(testMode);

        // 2. Validate the org name.
        const input = assertObject(request.data);
        const name = requireString(input, 'name', TEXT_LIMITS.shortText);

        // The founder's member record carries their identity for pickers and the
        // audit trail. The Auth record is the source (never client input); an
        // account with no email cannot found an org (memberships are email-keyed).
        const userRecord = await auth.getUser(uid);
        if (!userRecord.email) {
          throw fail.failedPrecondition(
            'Your account has no email address, so it cannot create an organisation.',
          );
        }

        // 3+4. The shared atomic bootstrap + claims re-mint. Empty subscription:
        // operator orgs are grandfathered/unlimited with no Stripe fields.
        const { orgId } = await provisionOrganisation(
          {
            env,
            uid,
            email: userRecord.email,
            orgName: name,
            subscription: {},
          },
          createLogger({ fn: 'createOrganisation' }),
        );

        const logger = createLogger({ fn: 'createOrganisation', orgId });
        logger.info('Organisation created', { founder: uid, env });
        return { orgId };
      },
    ),
);
