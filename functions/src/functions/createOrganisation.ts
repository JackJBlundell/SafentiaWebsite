// ============================================================================
// createOrganisation (callable, PLATFORM OPERATOR ONLY) - Phase 2 admin.
//
// Until Phase 3 self-serve onboarding (Stripe) arrives, organisations are
// founded by the platform operator: the operator (superAdmin claim) creates the
// org, becomes its first admin member, then invites the client's real
// administrators via the normal staff invitations. Phase 3 replaces this gate
// with self-serve onboarding; the provisioning below is already shaped for it.
// The gate is the superAdmin CLAIM, not an org role - the operator is founding
// a tenant, so no org claims exist yet. We:
//   1. Enforce App Check + auth + the superAdmin claim, and rate limit.
//   2. Validate the org name.
//   3. Atomically write the profile (platform-default brand), the founder's
//      admin membership, the /userOrgs login index AND the /activity entry in
//      ONE multi-location update - the audit entry can never be skipped, which
//      is why creation is a callable and not a rules-governed client write.
//   4. Re-mint the caller's claims pointed at the new org (the same helper
//      setActiveOrganisation uses) so they land in it immediately.
// onMembershipChange also fires on the membership write and recomputes the same
// claims - the explicit writeClaims just guarantees the ACTIVE org switches even
// if the trigger lands late, and both compute from the same trusted record.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { auth, db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth, assertSuperAdmin } from '../lib/guards';
import { forEnv, envFromTestMode } from '../lib/paths';
import { assertObject, requireString, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { computeClaims, writeClaims } from '../lib/claims';
import { activityUpdate } from '../lib/events';
import type {
  CreateOrganisationInput,
  CreateOrganisationResult,
  OrgMember,
  OrgProfile,
} from '../shared/types';

/** Platform-default brand for a fresh org (the design system's accent pair).
 *  The admin re-brands via updateOrgProfile; a default means the themed report
 *  and portal are never left without valid colours. */
const DEFAULT_BRAND = { primary: '#2563EB', secondary: '#1E3A8A' } as const;

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
        const paths = forEnv(env);

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

        // 3. Atomic bootstrap. push() mints the org id; the profile, the admin
        // membership, the login index and the audit entry land together so the
        // database is never left with a half-created organisation (brief 18.3).
        const orgId = db.ref().push().key as string;
        const profile: OrgProfile = { name, brand: { ...DEFAULT_BRAND } };
        const member: OrgMember = {
          roles: { admin: true },
          name: userRecord.displayName ?? userRecord.email,
          email: userRecord.email,
          status: 'active',
          // A test-env founder produces a test member, mirroring 4.8 (the marker
          // is what onMembershipChange copies into the testMode claim).
          ...(testMode ? { testMode: true as const } : {}),
        };
        const update: Record<string, unknown> = {
          [paths.db.orgProfile(orgId)]: profile,
          [paths.db.orgMember(orgId, uid)]: member,
          [paths.db.userOrg(uid, orgId)]: true,
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'organisation.created',
            target: orgId,
          }),
        };
        await db.ref().update(update);

        // 4. Point the caller's ACTIVE org at the new tenant (same path as
        // setActiveOrganisation); the client force-refreshes its token after.
        const nextClaims = computeClaims(member, orgId);
        await writeClaims(uid, nextClaims);

        const logger = createLogger({ fn: 'createOrganisation', orgId });
        logger.info('Organisation created', { founder: uid, env });
        return { orgId };
      },
    ),
);
