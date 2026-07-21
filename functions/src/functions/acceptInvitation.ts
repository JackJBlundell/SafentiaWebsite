// ============================================================================
// acceptInvitation (callable, public/token-bearing) - brief 4.5 #3, story 1018.
//
// A recipient accepts a tokenised invite. This is the one callable that does NOT
// require an existing org session (the whole point is to JOIN an org), but it
// still enforces App Check (brief 4.6) so only a genuine app build can call it,
// and it is gated entirely by possession of a valid, unexpired, single-use token.
//
// Flow, done atomically so the database is never left half-joined (brief 18.3):
//   1. App Check + validate the token shape.
//   2. Locate the pending invite by token across both env roots (the invite is
//      env-scoped; the token is the only thing the recipient holds).
//   3. Verify it is pending and unexpired; expire it in place if stale.
//   4. Create-or-get the Auth user for the invited email (idempotent: a returning
//      invitee already has an account).
//   5. Atomically write the membership, the reverse login index, mark the invite
//      accepted - one multi-location update so all three land together.
// onMembershipChange then computes the user's claims from the new membership.
//
// Customer-portal invites (invitation carries customerId) join the recipient to
// the CUSTOMER, not to the fire-safety org's staff: the atomic join writes a
// /customerMembers record (roles from the linked contact's portalRoles, viewer
// by default), the /customerUserIndex login-routing entry and - when the invite
// names a contact - the account uid back onto that CustomerContact, instead of
// the staff orgMember/userOrgs pair.
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
import { paths } from '../lib/paths';
import {
  assertObject,
  requireString,
  optionalString,
  TEXT_LIMITS,
} from '../lib/validate';
import { ENVIRONMENTS } from '../shared/types';
import type {
  AcceptInvitationInput,
  AcceptInvitationResult,
  CustomerContact,
  CustomerMember,
  CustomerUserIndexEntry,
  Invitation,
  OrgMember,
} from '../shared/types';

/** An invite located in a specific env root, with its db key. */
interface LocatedInvite {
  env: (typeof ENVIRONMENTS)[number];
  inviteId: string;
  invitation: Invitation;
}

/**
 * Find the pending invite carrying this token. Invitations are env-scoped, and the
 * recipient holds only the token, so we query each env root's /invitations by the
 * indexed `token` child (the rules declare .indexOn token). The first match wins;
 * a token is unique by construction (crypto-random 32 bytes).
 */
async function locateInviteByToken(token: string): Promise<LocatedInvite | null> {
  for (const env of ENVIRONMENTS) {
    const envPaths = paths.forEnv(env);
    const snap = await db
      .ref(envPaths.db.invitations())
      .orderByChild('token')
      .equalTo(token)
      .limitToFirst(1)
      .get();
    if (snap.exists()) {
      const value = snap.val() as Record<string, Invitation>;
      const [inviteId, invitation] = Object.entries(value)[0];
      return { env, inviteId, invitation };
    }
  }
  return null;
}

export const acceptInvitation = onCall<AcceptInvitationInput>(
  callableOptions,
  (request) =>
    runCallable<AcceptInvitationResult>(
      createLogger({ fn: 'acceptInvitation' }),
      async () => {
        // 1. Attestation + token shape. No org session required here.
        assertAppCheck(request);
        // Abuse control before any database work: this is a pre-auth endpoint
        // (there is no uid yet), so the bucket is keyed by client IP exactly as
        // registerInterest's is - same header parsing, same spoof resistance.
        await assertRateLimit(
          rateLimitKeyFor(
            request.rawRequest.headers['x-forwarded-for'],
            request.rawRequest.socket?.remoteAddress ?? undefined,
          ),
          'acceptInvitation',
        );
        const input = assertObject(request.data);
        const token = requireString(input, 'token', 512);
        const password = optionalString(input, 'password', TEXT_LIMITS.password);
        const displayName = optionalString(
          input,
          'displayName',
          TEXT_LIMITS.displayName,
        );

        // 2. Locate the invite. A generic not-found (no detail) avoids confirming
        // whether any given token exists.
        const located = await locateInviteByToken(token);
        if (!located) {
          throw fail.notFound('This invitation is not valid.');
        }
        const { env, inviteId, invitation } = located;
        const envPaths = paths.forEnv(env);

        // 3. Status + expiry. A revoked or already-accepted invite is rejected; an
        // expired-but-still-pending one is marked expired so its state is truthful.
        if (invitation.status !== 'pending') {
          throw fail.failedPrecondition('This invitation is no longer available.');
        }
        if (invitation.expiresAt <= Date.now()) {
          // Flip the record AND its admin-facing summary together, so the org's
          // invitation list never disagrees with the record it mirrors.
          await db.ref().update({
            [`${envPaths.db.invitation(inviteId)}/status`]: 'expired',
            [`${envPaths.db.orgInvitation(invitation.orgId, inviteId)}/status`]:
              'expired',
          });
          throw fail.failedPrecondition('This invitation has expired.');
        }

        // 4. Create-or-get the Auth user for the invited email. Idempotent so a
        // returning invitee (already has an account) is reused, never duplicated.
        let uid: string;
        try {
          const existing = await auth.getUserByEmail(invitation.email);
          uid = existing.uid;
        } catch {
          // No user yet: create one. A password is required for email/password
          // accounts; Google sign-ins create the user out-of-band, so password is
          // optional. We do not over-validate here - Auth enforces its own rules.
          const created = await auth.createUser({
            email: invitation.email,
            ...(password ? { password } : {}),
            ...(displayName ? { displayName } : {}),
          });
          uid = created.uid;
        }

        // 5. Atomic join. One multi-location update writes the membership, the
        // reverse login index and the accepted status together, so the database is
        // never left with a half-created membership (brief 18.3).

        // Customer-portal invites carry the CustomerContact they were issued
        // for; resolve it now (read-only, before the claim) so the membership
        // inherits the contact's name, details and intended portal roles.
        let contact: CustomerContact | null = null;
        if (invitation.customerId && invitation.contactId) {
          const contactSnap = await db
            .ref(
              envPaths.db.customerContact(
                invitation.orgId,
                invitation.customerId,
                invitation.contactId,
              ),
            )
            .get();
          contact = contactSnap.exists()
            ? (contactSnap.val() as CustomerContact)
            : null;
          // The contact this invite was issued for has been removed since (the
          // removal path revokes pending invites, but a crash in its gap can
          // leave one live). Accepting would mint a membership for a person the
          // customer deleted, so refuse - the token stays unconsumed.
          if (!contact) {
            throw fail.failedPrecondition('This invitation is no longer valid.');
          }
          // The contact is already linked to a DIFFERENT account: silently
          // re-linking would hijack the existing member's record, so refuse.
          // (The same person re-accepting with their own account is harmless
          // and idempotent, so it passes.)
          if (contact.uid && contact.uid !== uid) {
            throw fail.failedPrecondition('This invitation is no longer valid.');
          }
        }
        if (invitation.customerId) {
          // /customerUserIndex holds ONE slot per uid (CustomerUserIndexEntry is
          // a single {orgId, customerId} - login routing reads it as such), so an
          // account can belong to exactly one customer portal. Joining a SECOND
          // customer would silently overwrite the first link and strand that
          // membership, so it fails loudly instead. Re-accepting into the SAME
          // customer is idempotent and passes. NOTE for the contract owner:
          // supporting multi-portal accounts needs CustomerUserIndexEntry to
          // become a multi-entry map plus a routing-reader change - a contract
          // change deliberately not smuggled in here.
          const indexSnap = await db.ref(envPaths.db.customerUserIndex(uid)).get();
          const existingIndex = indexSnap.exists()
            ? (indexSnap.val() as CustomerUserIndexEntry)
            : null;
          if (
            existingIndex &&
            (existingIndex.orgId !== invitation.orgId ||
              existingIndex.customerId !== invitation.customerId)
          ) {
            throw fail.failedPrecondition(
              'This account already belongs to a customer portal.',
            );
          }
        }

        // CLAIM the invitation first, transactionally. The earlier status check
        // is a fast-path courtesy; between it and this write an administrator
        // may have REVOKED the invite, and a plain update here would overwrite
        // that revocation and hand out membership regardless. The transaction
        // re-asserts pending + unexpired at write time, so a revoked invite can
        // never be accepted, whatever the interleaving.
        const claim = await db
          .ref(envPaths.db.invitation(inviteId))
          .transaction((current: Invitation | null) => {
            if (current === null) {
              // Uncached first run in a listener-less function instance: the
              // local cache is null even though the invitation was already read
              // above, and returning undefined here would abort before the
              // server value is read. Return the known invitation to force the
              // server round-trip; the SDK re-runs this against the real value
              // (never actually null here), so this is not persisted.
              return invitation;
            }
            if (
              current.status !== 'pending' ||
              current.expiresAt <= Date.now()
            ) {
              return undefined;
            }
            return { ...current, status: 'accepted' as const };
          });
        if (!claim.committed) {
          throw fail.failedPrecondition('This invitation is no longer available.');
        }

        const update: Record<string, unknown> = {
          // Mirror onto the admin-facing summary, so the org's invitation list
          // flips the moment the membership exists.
          [`${envPaths.db.orgInvitation(invitation.orgId, inviteId)}/status`]:
            'accepted',
        };
        if (invitation.customerId) {
          // Customer-portal join: the recipient becomes a member of the CUSTOMER
          // organisation, never of the fire-safety org's staff. Roles come from
          // the contact's intended portalRoles, defaulting to viewer (the least
          // privilege) when the invite carried no contact or the contact holds
          // none; the contact's person details ride onto the membership so a
          // responsible-party pick stays complete.
          const customerMember: CustomerMember = {
            roles:
              contact?.portalRoles && Object.keys(contact.portalRoles).length > 0
                ? contact.portalRoles
                : { viewer: true },
            name: contact?.name ?? displayName ?? invitation.email,
            email: invitation.email,
            status: 'active',
            ...(contact?.jobTitle ? { jobTitle: contact.jobTitle } : {}),
            ...(contact?.phone ? { phone: contact.phone } : {}),
          };
          const indexEntry: CustomerUserIndexEntry = {
            orgId: invitation.orgId,
            customerId: invitation.customerId,
          };
          update[
            envPaths.db.customerMember(invitation.orgId, invitation.customerId, uid)
          ] = customerMember;
          // Reverse index for portal login routing (the portal's userOrgs
          // counterpart): which customer, at which org, this uid belongs to.
          update[envPaths.db.customerUserIndex(uid)] = indexEntry;
          // Link the account back onto its CustomerContact, so the contact and
          // the portal account can never drift apart. A missing or already
          // differently-linked contact was refused above, before the claim, so
          // this write can only ever set the uid the contact expects.
          if (invitation.contactId && contact) {
            update[
              `${envPaths.db.customerContact(
                invitation.orgId,
                invitation.customerId,
                invitation.contactId,
              )}/uid`
            ] = uid;
          }
        } else {
          // Staff join: org membership plus the reverse login index.
          const member: OrgMember = {
            roles: invitation.roles,
            name: displayName ?? invitation.email,
            email: invitation.email,
            status: 'active',
            // A test-root invite produces a test member, mirroring 4.8 (the marker
            // is what onMembershipChange copies into the testMode claim).
            ...(env === 'test' ? { testMode: true as const } : {}),
          };
          update[envPaths.db.orgMember(invitation.orgId, uid)] = member;
          update[envPaths.db.userOrg(uid, invitation.orgId)] = true;
        }
        try {
          await db.ref().update(update);
        } catch (error) {
          // The claim landed but the join did not: put the invitation back so
          // the invitee can retry, rather than stranding a consumed token with
          // no membership behind it. Best-effort, loudly logged if it too fails.
          await db
            .ref(`${envPaths.db.invitation(inviteId)}/status`)
            .set('pending')
            .catch(() => undefined);
          throw error;
        }

        const logger = createLogger({
          fn: 'acceptInvitation',
          orgId: invitation.orgId,
          env,
        });
        logger.info('Invitation accepted', {
          uid,
          // A portal invite is issued with an EMPTY org role set (its portal
          // roles live on the contact), and RTDB drops empty objects, so roles
          // can read back undefined - hence the fallback.
          roles: Object.keys(invitation.roles ?? {}),
          customerJoin: Boolean(invitation.customerId),
        });

        return { orgId: invitation.orgId, uid };
      },
    ),
);
