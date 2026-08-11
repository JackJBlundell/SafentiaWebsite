// ============================================================================
// acceptInvitation (callable, public/token-bearing) - brief 4.5 #3, story 1018.
//
// A recipient accepts a tokenised invite. This is the one callable that does NOT
// require an existing org session (the whole point is to JOIN an org), but it
// still enforces App Check (brief 4.6) so only a genuine app build can call it,
// and it is gated by possession of a valid, unexpired, single-use token.
//
// The token alone is authority to CREATE the invited account, not to act as one
// that already exists - see step 4. previewInvitation tells /invite which of the
// two cases applies before it asks the recipient for anything.
//
// Flow, done atomically so the database is never left half-joined (brief 18.3):
//   1. App Check + validate the token shape.
//   2. Locate the pending invite by token across both env roots (the invite is
//      env-scoped; the token is the only thing the recipient holds).
//   3. Verify it is pending and unexpired; expire it in place if stale.
//   4. Resolve the Auth user for the invited email: create it from the chosen
//      password when there is none, or - when an account already exists -
//      require the CALLER to be signed in as it.
//   5. Atomically write the membership, the reverse login index, mark the invite
//      accepted - one multi-location update so all three land together.
//   6. For a just-created account, return a custom token so the client signs in
//      straight away rather than re-entering the password it just set.
// onMembershipChange then computes the user's claims from the new membership.
//
// Customer-portal invites (invitation carries customerId) join the recipient to
// the CUSTOMER, not to the fire-safety org's staff: the atomic join writes a
// /customerMembers record (roles from the linked contact's portalRoles, viewer
// by default), the /customerUserIndex login-routing entry and - when the invite
// names a contact - the account uid back onto that CustomerContact, instead of
// the staff orgMember/userOrgs pair. One account may hold several portal spaces
// (a managing agent acting for more than one customer): the index is a
// collection keyed by portalSpaceKey, and setActiveOrganisation is how the
// person moves between the spaces they hold.
//
// We never log the token or the email (brief 18.4).
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import type { UserRecord } from 'firebase-admin/auth';
import { auth, db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck } from '../lib/guards';
import { assertRateLimit } from '../lib/rateLimit';
import { rateLimitKeyFor } from './registerInterest';
import { locateInviteByToken } from '../lib/invitations';
import { paths, portalSpaceKey } from '../lib/paths';
import { adjustStaffCount } from '../lib/usageCounters';
import {
  assertObject,
  requireString,
  optionalString,
  TEXT_LIMITS,
} from '../lib/validate';
import type {
  AcceptInvitationInput,
  AcceptInvitationResult,
  CustomerContact,
  InviteFailureReason,
  CustomerMember,
  CustomerUserIndexEntry,
  Invitation,
  OrgMember,
} from '../shared/types';

/**
 * Refuse an acceptance with a machine-readable reason. Every refusal below is a
 * failed-precondition on the wire, so /invite cannot tell "already used" from
 * "expired" by code alone; the reason rides in `details` so the page can offer
 * the right next step (sign in, versus ask for a fresh invitation).
 */
function failInvite(reason: InviteFailureReason, message: string) {
  return fail.failedPrecondition(message, { reason });
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
          throw failInvite('used', 'This invitation is no longer available.');
        }
        if (invitation.expiresAt <= Date.now()) {
          // Flip the record AND its admin-facing summary together, so the org's
          // invitation list never disagrees with the record it mirrors.
          await db.ref().update({
            [`${envPaths.db.invitation(inviteId)}/status`]: 'expired',
            [`${envPaths.db.orgInvitation(invitation.orgId, inviteId)}/status`]:
              'expired',
          });
          throw failInvite('expired', 'This invitation has expired.');
        }

        // 4. Create-or-get the Auth user for the invited email. Idempotent so a
        // returning invitee (already has an account) is reused, never duplicated.
        // Reaching this line means the caller presented a single-use token that
        // was emailed ONLY to invitation.email, so control of that address is
        // already proven - the account is recorded as verified rather than
        // sending a second, redundant confirmation the invitee has effectively
        // already completed. Nothing else about an existing account is touched.
        // Only the LOOKUP may fall through to creation. A failure of the
        // verified-flag update below must not be mistaken for "no such user"
        // and send us into createUser, which would then fail on a duplicate
        // email, so that update sits outside this try.
        let existing: UserRecord | null = null;
        try {
          existing = await auth.getUserByEmail(invitation.email);
        } catch {
          existing = null;
        }
        let uid: string;
        let createdAccount = false;
        if (existing) {
          // The token proves control of the MAILBOX, which is enough to create a
          // brand-new account for that address, but it is NOT enough to act as
          // an account that already exists: anyone who intercepted or was
          // forwarded the link could otherwise bind a stranger's established
          // account into an org, and (via the customer-portal branch) consume
          // its one portal slot. So an existing account must prove itself the
          // ordinary way - sign in first, then accept - and we check the
          // caller's own session against it here.
          if (!request.auth || request.auth.uid !== existing.uid) {
            throw failInvite(
              'sign-in-required',
              'An account already exists for this email address. Sign in with it to accept this invitation.',
            );
          }
          uid = existing.uid;
          if (!existing.emailVerified) {
            await auth.updateUser(uid, { emailVerified: true });
          }
        } else {
          // No user yet: create one, with the password the recipient just chose.
          // A password is required on this branch. The Google route never
          // reaches it: signing in with Google creates the account out-of-band
          // first, so by the time such a recipient accepts, the branch above
          // handles them. We do not over-validate the password itself - Auth
          // enforces its own strength rules and reports them.
          if (!password) {
            throw fail.invalidArgument(
              'Choose a password to create your account.',
            );
          }
          const created = await auth.createUser({
            email: invitation.email,
            emailVerified: true,
            password,
            ...(displayName ? { displayName } : {}),
          });
          uid = created.uid;
          createdAccount = true;
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
            throw failInvite(
              'contact-removed',
              'This invitation is no longer valid.',
            );
          }
          // The contact is already linked to a DIFFERENT account: silently
          // re-linking would hijack the existing member's record, so refuse.
          // (The same person re-accepting with their own account is harmless
          // and idempotent, so it passes.)
          if (contact.uid && contact.uid !== uid) {
            throw failInvite(
              'contact-linked',
              'This invitation is no longer valid.',
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
          // The transaction aborted, so the record changed under us between the
          // fast-path check and the claim. Read the value the transaction saw to
          // report the SAME reason the fast path would have: still pending means
          // it timed out mid-flight, anything else means it was revoked or
          // accepted elsewhere.
          const contended = claim.snapshot.val() as Invitation | null;
          const reason: InviteFailureReason =
            contended && contended.status === 'pending' ? 'expired' : 'used';
          throw failInvite(
            reason,
            reason === 'expired'
              ? 'This invitation has expired.'
              : 'This invitation is no longer available.',
          );
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
          // counterpart), one entry per space so an account can hold several.
          // The key is derived from the pair, so re-accepting an invitation to a
          // customer this person already belongs to overwrites its own entry
          // rather than adding a duplicate the space picker would show twice.
          update[
            envPaths.db.customerUserIndexEntry(
              uid,
              portalSpaceKey(invitation.orgId, invitation.customerId),
            )
          ] = indexEntry;
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
        // Seat accounting (Phase 3 brief 5.2): a STAFF join created an orgMember
        // above, so it occupies a plan seat - portal joins land in
        // /customerMembers and never count. Best-effort by construction: the
        // membership is real by now, so a counter failure only logs.
        if (!invitation.customerId) {
          await adjustStaffCount(envPaths, invitation.orgId, 1, logger);
        }
        logger.info('Invitation accepted', {
          uid,
          // A portal invite is issued with an EMPTY org role set (its portal
          // roles live on the contact), and RTDB drops empty objects, so roles
          // can read back undefined - hence the fallback.
          roles: Object.keys(invitation.roles ?? {}),
          customerJoin: Boolean(invitation.customerId),
        });

        // Hand the brand-new account a custom token so the page can sign it in
        // immediately, instead of sending someone who chose a password five
        // seconds ago to a sign-in form to type it again. Minted ONLY for the
        // uid this call itself created - never for an arbitrary or
        // caller-supplied one - so it can never be turned into a way to
        // impersonate an existing account. Accounts that already existed get no
        // token: they had to be signed in as themselves to reach this line, so
        // they already have a session.
        const customToken = createdAccount
          ? await auth.createCustomToken(uid)
          : undefined;

        return {
          orgId: invitation.orgId,
          uid,
          // Name the customer a PORTAL acceptance joined, so the page can make
          // that space the active one. Someone accepting while already signed
          // in to another space would otherwise land back in the previous one
          // and see no sign the acceptance did anything. Absent for a staff
          // join, which has no customer to switch to.
          ...(invitation.customerId
            ? { customerId: invitation.customerId }
            : {}),
          ...(customToken ? { customToken } : {}),
        };
      },
    ),
);
