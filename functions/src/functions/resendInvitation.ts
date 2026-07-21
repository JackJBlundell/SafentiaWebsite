// ============================================================================
// resendInvitation (callable, admin-only) - Phase 2 admin, invitation lifecycle.
//
// An admin re-issues an invitation that was missed or has lapsed. Resending
// mints a NEW crypto-random token and a fresh expiry (the same TTL as
// createInvitation), so the OLD link dies the moment this runs - a resend is a
// rotation, never a second copy of the same secret. The record, its
// /orgInvitations summary and the /activity entry all change in ONE
// multi-location update (the atomicity is why this is a callable), then the
// branded email goes out through the same seam createInvitation uses. A lapsed
// invite is resendable whether it merely passed its expiresAt (status still
// 'pending') or was already marked 'expired'; accepted or revoked ones are not.
// We never log the token or the recipient email (brief 18.4).
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions, generateToken } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireString, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { dispatchEmail, EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { orgEmailBrand, renderBrandedEmail } from '../lib/emailTemplates';
import { INVITATION_TTL_MS } from '../lib/invitations';
import type {
  Invitation,
  OrgProfile,
  ResendInvitationInput,
  ResendInvitationResult,
} from '../shared/types';

export const resendInvitation = onCall<ResendInvitationInput>(
  // Sends the invitation email, so the provider secret is attached (see email.ts).
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
    runCallable<ResendInvitationResult>(
      createLogger({ fn: 'resendInvitation' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'resendInvitation');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the invite id.
        const input = assertObject(request.data);
        const inviteId = requireString(input, 'inviteId', TEXT_LIMITS.shortText);

        // 3. The invite must exist and belong to the CALLER'S org (same opaque
        // not-found for a foreign org as for a missing id - no cross-tenant
        // probing). Accepted and revoked invites are terminal; pending and
        // expired ones may be re-issued.
        const inviteSnap = await db.ref(paths.db.invitation(inviteId)).get();
        const invitation = inviteSnap.exists()
          ? (inviteSnap.val() as Invitation)
          : null;
        if (!invitation || invitation.orgId !== orgId) {
          throw fail.notFound('That invitation could not be found.', {
            field: 'inviteId',
          });
        }
        if (invitation.status !== 'pending' && invitation.status !== 'expired') {
          throw fail.failedPrecondition(
            'An accepted or revoked invitation cannot be resent.',
            { field: 'inviteId', status: invitation.status },
          );
        }

        // 4. Rotate: new token, fresh expiry, status back to pending. Record,
        // summary and audit entry land in one atomic update (the summary never
        // carries the token - only the new expiry and status).
        const token = generateToken();
        const expiresAt = Date.now() + INVITATION_TTL_MS;
        const invitePath = paths.db.invitation(inviteId);
        const summaryPath = paths.db.orgInvitation(orgId, inviteId);
        const update: Record<string, unknown> = {
          [`${invitePath}/token`]: token,
          [`${invitePath}/expiresAt`]: expiresAt,
          [`${invitePath}/status`]: 'pending',
          [`${summaryPath}/expiresAt`]: expiresAt,
          [`${summaryPath}/status`]: 'pending',
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'invitation.resent',
            target: inviteId,
          }),
        };
        await db.ref().update(update);

        // 5. Re-send the branded email exactly as createInvitation does. A
        // failed/skipped send never rolls back the rotation - the old link is
        // already dead and the admin can resend again.
        const acceptLink = `safentia://invite?token=${encodeURIComponent(
          token,
        )}&env=${env}`;
        const logger = createLogger({ fn: 'resendInvitation', orgId });
        // The resend carries the inviting organisation's own brand (name +
        // accent), falling back to the Safentia brand when the org has not set
        // a valid one.
        const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
        const brand = orgEmailBrand(profileSnap.val() as OrgProfile | null);
        await dispatchEmail(
          {
            to: invitation.email,
            subject: 'You have been invited to Safentia',
            body:
              'You have been invited to join an organisation on Safentia. ' +
              'Open the app and use this link to accept: ' +
              acceptLink,
            html: renderBrandedEmail({
              brand,
              preheader: 'Accept your invitation to join your organisation on Safentia.',
              heading: 'You have been invited to Safentia',
              paragraphs: [
                'Your organisation has invited you to join it on Safentia, the fire risk assessment platform.',
                'Accept the invitation on the device with the Safentia app installed. The link below opens the app and sets up your account in a couple of taps.',
                'The invitation is personal to you, works once, and expires after seven days.',
              ],
              cta: { label: 'Accept your invitation', url: acceptLink },
              footerNote:
                'You are receiving this because an administrator at your organisation invited this email address to Safentia. If you were not expecting it, you can safely ignore this email.',
            }),
          },
          logger,
          { orgId, env, category: 'invitation' },
        );

        // Audit log: the invite id only - never the token or recipient email.
        logger.info('Invitation resent', { inviteId });
        return { expiresAt };
      },
    ),
);
