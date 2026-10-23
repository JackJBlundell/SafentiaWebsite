// ============================================================================
// createInvitation (callable, admin-only) - brief 4.5 #2, story 1023.
//
// An admin invites someone to their org. We:
//   1. Enforce App Check, auth and the admin role (the union model: any admin).
//   2. Validate the email shape, the role set (staff invites need at least one
//      org role; customer-portal invites must carry NONE - see below) and, for a
//      customer-portal invite, that the customer and any named contact exist.
//   3. Consult the org's plan staff limit, isolated in lib/inviteLimits (1023):
//      enforced when a plan defines one, unlimited otherwise. Staff invites
//      only - portal seats never consume the staff allowance.
//   4. Issue the invitation through lib/invitations (shared with manageCustomer's
//      primary-contact auto-invite): env-scoped tokenised record + summary, then
//      the branded email through the seam (no-ops cleanly with no provider
//      configured - FUTURE_WORK.md #1), never failing the call on email trouble.
//
// The token is a crypto-random bearer secret; acceptInvitation consumes it once.
// We never log the token or the recipient email (brief 18.4).
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
  getLiveClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  requireEmail,
  requireRoleSet,
  optionalString,
  TEXT_LIMITS,
} from '../lib/validate';
import {
  assertWithinInviteLimit,
  resolveInviteLimitContext,
} from '../lib/inviteLimits';
import { assertRateLimit } from '../lib/rateLimit';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { issueInvitation } from '../lib/invitations';
import { markOnboardingStep } from '../lib/onboardingMarks';
import type {
  CreateInvitationInput,
  CreateInvitationResult,
  OrgRoleSet,
} from '../shared/types';

export const createInvitation = onCall<CreateInvitationInput>(
  // Sends the invitation email, so the provider secret is attached (see email.ts).
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
    runCallable<CreateInvitationResult>(
      createLogger({ fn: 'createInvitation' }),
      async () => {
        // 1. Attestation, identity, authorisation - in that order.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'createInvitation');
        const claims = await getLiveClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);

        // 2. Input validation against the allow-lists; reject, never coerce.
        const input = assertObject(request.data);
        const email = requireEmail(input);
        const customerId = optionalString(input, 'customerId', TEXT_LIMITS.shortText);
        // The role set is validated ASYMMETRICALLY on purpose. A staff invite
        // must carry at least one org role (the union model - requireRoleSet).
        // A customer-portal invite (customerId present) must carry NONE: the
        // recipient's portal permissions come from the contact's portalRoles at
        // accept, so an org-staff role riding on a portal invite would be a
        // privilege smuggling vector - acceptInvitation would never grant it,
        // but the record must not carry it either. Rejected, never dropped.
        let roles: OrgRoleSet;
        if (customerId) {
          const rawRoles = input.roles;
          if (
            rawRoles !== undefined &&
            (rawRoles === null ||
              typeof rawRoles !== 'object' ||
              Array.isArray(rawRoles) ||
              Object.keys(rawRoles).length > 0)
          ) {
            throw fail.invalidArgument(
              'A customer portal invitation cannot carry organisation roles.',
              { field: 'roles' },
            );
          }
          roles = {};
        } else {
          roles = requireRoleSet(input);
        }
        // A contact link only means something inside a customer scope, and when
        // given it must point at a real contact of THAT customer - otherwise
        // acceptInvitation would write the joining uid onto thin air.
        const contactId = optionalString(input, 'contactId', TEXT_LIMITS.shortText);
        if (contactId && !customerId) {
          throw fail.invalidArgument(
            'The contactId field requires a customerId.',
            { field: 'contactId' },
          );
        }
        if (customerId) {
          // The customer itself must exist - a portal invite scoped to a
          // deleted or mistyped customer would mint an unjoinable token.
          const customerSnap = await db
            .ref(paths.db.customer(claims.orgId, customerId))
            .get();
          if (!customerSnap.exists()) {
            throw fail.notFound('That customer could not be found.', {
              field: 'customerId',
            });
          }
          if (contactId) {
            const contactSnap = await db
              .ref(paths.db.customerContact(claims.orgId, customerId, contactId))
              .get();
            if (!contactSnap.exists()) {
              throw fail.notFound('That contact could not be found.', {
                field: 'contactId',
              });
            }
          }
        }

        // 3. Plan limit check - STAFF invites only (isolated; unlimited when no
        // plan limit set). Portal seats are not staff seats, so a customer-portal
        // invite never consumes the plan's staff allowance; Phase 3 may add its
        // own portal cap.
        if (!customerId) {
          const limitCtx = await resolveInviteLimitContext(paths, claims.orgId);
          assertWithinInviteLimit(limitCtx);
        }

        // 4. Issue: record + summary + branded email, via the shared core.
        const logger = createLogger({ fn: 'createInvitation', orgId: claims.orgId });
        const { inviteId, expiresAt } = await issueInvitation({
          env,
          paths,
          orgId: claims.orgId,
          invitedBy: uid,
          email,
          roles,
          customerId,
          contactId,
          logger,
        });

        // Setup-wizard piggyback (Phase 3 §5.4): best-effort, never throws.
        await markOnboardingStep(uid, claims.orgId, 'team', logger);

        // Audit: who invited (uid), without the recipient's email in the log.
        logger.info('Invitation created', {
          invitedBy: uid,
          roles: Object.keys(roles),
          hasCustomerScope: Boolean(customerId),
        });

        return { inviteId, expiresAt };
      },
    ),
);
