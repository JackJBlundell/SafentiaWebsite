// ============================================================================
// revokeInvitation (callable, admin-only) - Phase 2 admin, invitation lifecycle.
//
// An admin withdraws a pending invitation, killing its accept link immediately
// (acceptInvitation rejects anything not status 'pending'). The invitation
// record, its admin-facing /orgInvitations summary and the /activity entry all
// flip in ONE multi-location update - the summary can never drift from the
// record and the audit entry can never be skipped, which is why this is a
// callable and not a client write. The org check matters: /invitations is a
// flat env-scoped root, so we verify the invite BELONGS to the caller's org
// before touching it.
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
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import type {
  Invitation,
  RevokeInvitationInput,
  RevokeInvitationResult,
} from '../shared/types';

export const revokeInvitation = onCall<RevokeInvitationInput>(
  callableOptions,
  (request) =>
    runCallable<RevokeInvitationResult>(
      createLogger({ fn: 'revokeInvitation' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'revokeInvitation');
        const claims = await getLiveClaims(request);
        assertOrgRole(claims, 'admin');
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the invite id.
        const input = assertObject(request.data);
        const inviteId = requireDbKey(input, 'inviteId', TEXT_LIMITS.shortText);

        // 3. The invite must exist, belong to the CALLER'S org, and still be
        // pending. A foreign-org invite returns the same not-found as a missing
        // one, so ids cannot be probed across tenants.
        const inviteSnap = await db.ref(paths.db.invitation(inviteId)).get();
        const invitation = inviteSnap.exists()
          ? (inviteSnap.val() as Invitation)
          : null;
        if (!invitation || invitation.orgId !== orgId) {
          throw fail.notFound('That invitation could not be found.', {
            field: 'inviteId',
          });
        }
        if (invitation.status !== 'pending') {
          throw fail.failedPrecondition(
            'Only a pending invitation can be revoked.',
            { field: 'inviteId', status: invitation.status },
          );
        }

        // 4. Atomic flip: record status, summary status and audit entry together.
        const update: Record<string, unknown> = {
          [`${paths.db.invitation(inviteId)}/status`]: 'revoked',
          [`${paths.db.orgInvitation(orgId, inviteId)}/status`]: 'revoked',
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'invitation.revoked',
            target: inviteId,
          }),
        };
        await db.ref().update(update);

        // Audit log: the invite id only - never the recipient's email.
        const logger = createLogger({ fn: 'revokeInvitation', orgId });
        logger.info('Invitation revoked', { inviteId });
        return { revoked: true };
      },
    ),
);
