// ============================================================================
// previewInvitation (callable, public/token-bearing) - the read-only companion
// to acceptInvitation.
//
// /invite cannot read /invitations (it holds bearer tokens and is closed to
// clients), so before this existed the page had to render one guess-the-branch
// form: it could not name the invited address, could not tell a first-time
// recipient from someone who already has an account, and could only discover a
// dead invitation AFTER the visitor had filled the form in. This resolves all
// three up front.
//
// Same pre-auth posture as acceptInvitation: App Check (brief 4.6) so only a
// genuine build can call it, an IP-keyed rate limit in place of a uid, and
// possession of the token as the whole of the credential. No assertAuth - the
// point is that the recipient may not have an account yet.
//
// STRICTLY READ-ONLY. In particular an expired-but-still-pending invitation is
// REPORTED as expired here but not flipped to `expired` in the database: that
// write belongs to the accept path, so a page load can never mutate an invite.
//
// We never log the token or the email (brief 18.4).
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { auth, db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck } from '../lib/guards';
import { assertRateLimit } from '../lib/rateLimit';
import { rateLimitKeyFor } from './registerInterest';
import { locateInviteByToken } from '../lib/invitations';
import { paths } from '../lib/paths';
import { assertObject, requireString } from '../lib/validate';
import type {
  Customer,
  InviteFailureReason,
  OrgProfile,
  PreviewInvitationInput,
  PreviewInvitationResult,
} from '../shared/types';

/** Refuse with the same machine-readable reason discriminator acceptInvitation
 *  uses, so /invite renders one set of dead-end screens whichever call found
 *  the invitation was already over. */
function failInvite(reason: InviteFailureReason, message: string) {
  return fail.failedPrecondition(message, { reason });
}

export const previewInvitation = onCall<PreviewInvitationInput>(
  callableOptions,
  (request) =>
    runCallable<PreviewInvitationResult>(
      createLogger({ fn: 'previewInvitation' }),
      async () => {
        assertAppCheck(request);
        // Pre-auth endpoint, so the abuse bucket is keyed by client IP exactly
        // as acceptInvitation's and registerInterest's are - same header
        // parsing, same spoof resistance.
        await assertRateLimit(
          rateLimitKeyFor(
            request.rawRequest.headers['x-forwarded-for'],
            request.rawRequest.socket?.remoteAddress ?? undefined,
          ),
          'previewInvitation',
        );
        const input = assertObject(request.data);
        const token = requireString(input, 'token', 512);

        // An unknown token gets the IDENTICAL generic not-found acceptInvitation
        // returns - no detail, no reason - so this endpoint cannot be used to
        // sort real tokens from invented ones any faster than accepting could.
        const located = await locateInviteByToken(token);
        if (!located) {
          throw fail.notFound('This invitation is not valid.');
        }
        const { env, invitation } = located;
        const envPaths = paths.forEnv(env);

        // Report a dead invitation with the reason acceptInvitation would give,
        // so the page shows the "already used" or "expired" screen on load
        // rather than after a form submission that could never have succeeded.
        if (invitation.status !== 'pending') {
          throw failInvite('used', 'This invitation is no longer available.');
        }
        if (invitation.expiresAt <= Date.now()) {
          throw failInvite('expired', 'This invitation has expired.');
        }

        // Everything below is disclosed to a caller who already holds the
        // single-use token that was EMAILED to invitation.email. Returning the
        // address, the inviting organisation's name and whether an account
        // exists for it therefore tells that caller nothing they did not
        // already have; it is not an enumeration oracle, because reaching this
        // point at all requires the unguessable token.
        const [profileSnap, existingUser] = await Promise.all([
          db.ref(envPaths.db.orgProfile(invitation.orgId)).get(),
          auth
            .getUserByEmail(invitation.email)
            .then(() => true)
            .catch(() => false),
        ]);
        const profile = profileSnap.exists()
          ? (profileSnap.val() as OrgProfile)
          : null;

        // Portal invites join a CUSTOMER rather than the fire-safety org's
        // staff, and the recipient knows the customer they work for far better
        // than the assessing org, so name it when there is one.
        let customerName: string | undefined;
        if (invitation.customerId) {
          const customerSnap = await db
            .ref(envPaths.db.customer(invitation.orgId, invitation.customerId))
            .get();
          const customer = customerSnap.exists()
            ? (customerSnap.val() as Customer)
            : null;
          customerName = customer?.name;
        }

        return {
          email: invitation.email,
          // A profile is written with every organisation, so the fallback only
          // covers a partially-provisioned org; the page must still render.
          orgName: profile?.name ?? 'your organisation',
          ...(customerName ? { customerName } : {}),
          accountExists: existingUser,
        };
      },
    ),
);
