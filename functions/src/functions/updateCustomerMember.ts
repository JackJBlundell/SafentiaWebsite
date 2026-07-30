// ============================================================================
// updateCustomerMember (callable) - change the roles, and optionally the
// standing, of a customer-portal account that ALREADY EXISTS.
//
// Until this function `CustomerContact.portalRoles` was only an INTENT:
// acceptInvitation read it once to mint the /customerMembers record and nothing
// ever re-read it, so editing a contact's roles afterwards moved nothing and the
// only correction available was revoke-and-re-invite - which is not a correction
// but a second account. This closes that gap, and writes the linked contact's
// portalRoles in the SAME update as the account's roles so the intent and the
// live grant can never drift apart again.
//
// TWO legitimate callers, handled explicitly and never interchangeably. The two
// claim shapes are disjoint by construction (a staff token carries `orgId` and
// never `portalOrgId`; a portal token the reverse), so which caller this is is a
// fact about the verified token rather than a preference:
//   - ORG STAFF admin: getClaims + assertOrgRole(claims, 'admin'), acting on a
//     customer named in the payload and re-checked against a customer that
//     exists in THEIR own org.
//   - PORTAL admin: getPortalClaims, with the org and customer taken from the
//     token alone - the same trust boundary portalInviteTeammate rests on, so a
//     portal admin can only ever reach their own customer's team. Their admin
//     role is re-derived from the LIVE /customerMembers record rather than read
//     off the token, because a token is a cached copy that can be minutes stale
//     and this is the authorisation decision itself (respondToAction's posture).
//
// LAST-ADMIN PROTECTION is two separate rules, because they fail differently:
//   - A customer must keep at least one ACTIVE portal admin. Counted from a
//     fresh read of the whole member list with this change applied, so neither
//     caller can take the last one away.
//   - A portal admin may not demote or lock THEMSELVES, whatever anyone else
//     holds: the click that removes your own admin role is the click that
//     removes your ability to undo it. A staff caller has no self case - a
//     Safentia account is either staff or portal, never both.
// Both refuse with copy that names the way out rather than just the rule.
//
// onCustomerMembershipChange sees the /customerMembers write - onValueWritten
// fires for an UPDATE to a child exactly as it does for a create or a delete -
// recomputes computePortalClaims from the post-write record and trips
// metadata/{uid}/refreshAt, so the target's own session picks the new role up
// within seconds without anyone signing out.
// ============================================================================

import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getClaims,
  getPortalClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  requireCustomerRoleSet,
  requireDbKey,
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { PORTAL_ACCOUNT_STATUSES } from '../shared/types';
import type { EnvPaths } from '../lib/paths';
import type {
  Customer,
  CustomerContact,
  CustomerMember,
  CustomerRoleSet,
  PortalAccountStatus,
  UpdateCustomerMemberInput,
  UpdateCustomerMemberResult,
} from '../shared/types';

/** Which of the two callers made this request, and the scope they are allowed
 *  to act in. `kind` survives into the body because a handful of decisions
 *  (self-demotion, which copy an error carries) genuinely differ between them. */
interface Caller {
  kind: 'staff' | 'portal';
  uid: string;
  orgId: string;
  customerId: string;
  paths: EnvPaths;
}

/**
 * Authorise the caller and resolve their scope. Claim-level only: the LIVE
 * checks that need database reads (the customer's standing, a portal admin's
 * own seat) happen in the body where the reads are shared.
 *
 * The staff branch is chosen on the presence of `orgId`, which only a staff
 * token carries; everything else falls to getPortalClaims, which itself refuses
 * a token without portalOrgId + customerId. A caller who is neither is turned
 * away by that guard with the portal's own message.
 */
function resolveCaller(
  request: CallableRequest,
  uid: string,
  input: Record<string, unknown>,
): Caller {
  const token = request.auth?.token;
  if (typeof token?.orgId === 'string' && token.orgId.length > 0) {
    const claims = getClaims(request);
    assertOrgRole(claims, 'admin');
    const { paths } = envFor(claims);
    // A staff admin names the customer. It is validated as a KEY because it is
    // interpolated into database paths, and re-checked below against a customer
    // that actually exists under their own org - the org itself is never taken
    // from the payload.
    const customerId = requireDbKey(input, 'customerId', TEXT_LIMITS.shortText);
    return { kind: 'staff', uid, orgId: claims.orgId, customerId, paths };
  }

  const claims = getPortalClaims(request);
  const { paths } = envFor(claims);
  // NOTHING about scope comes from the payload here: org and customer are the
  // ones this token was minted with, so the tenancy boundary holds even if the
  // client sends someone else's customerId.
  return {
    kind: 'portal',
    uid,
    orgId: claims.orgId,
    customerId: claims.customerId,
    paths,
  };
}

/** Does this member hold the portal ADMIN role right now? Only a literal `true`
 *  on the known flag counts - the same defensive reconstruction
 *  computePortalClaims applies - so a malformed record cannot assert a role. */
function isActiveAdmin(member: CustomerMember | undefined): boolean {
  return (
    member?.status === 'active' &&
    (member.roles as Record<string, unknown> | undefined)?.admin === true
  );
}

export const updateCustomerMember = onCall<UpdateCustomerMemberInput>(
  callableOptions,
  (request) =>
    runCallable<UpdateCustomerMemberResult>(
      createLogger({ fn: 'updateCustomerMember' }),
      async () => {
        // 1. Attestation, identity, rate limit, then whichever authorisation
        // model this caller's token belongs to.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'updateCustomerMember');
        const input = assertObject(request.data);
        const caller = resolveCaller(request, uid, input);
        const { paths, orgId, customerId } = caller;

        // 2. Validate the change itself. `memberUid` is a database key (it
        // addresses a node); roles are allow-listed customer roles only, so no
        // org-staff role can ride this call; status is restricted to the two
        // standings a single account may be moved between.
        const memberUid = requireDbKey(input, 'memberUid', TEXT_LIMITS.shortText);
        const roles: CustomerRoleSet | undefined =
          input.roles !== undefined ? requireCustomerRoleSet(input) : undefined;
        const status: PortalAccountStatus | undefined =
          input.status !== undefined
            ? requireEnum(input, 'status', PORTAL_ACCOUNT_STATUSES)
            : undefined;
        if (roles === undefined && status === undefined) {
          throw fail.invalidArgument(
            'Provide a role set and/or a status to apply.',
          );
        }

        // 3. The customer must exist under this org and still be live. An
        // archived customer's accounts were locked by the archive cascade
        // (lib/customerAccess); changing a role here would quietly hand one of
        // them their access back without the archive being lifted.
        const customer = (
          await db.ref(paths.db.customer(orgId, customerId)).get()
        ).val() as Customer | null;
        if (!customer) {
          throw fail.notFound(
            caller.kind === 'portal'
              ? 'Your customer account could not be found.'
              : 'That customer could not be found in this organisation.',
            { field: 'customerId' },
          );
        }
        if (customer.status === 'archived') {
          throw fail.failedPrecondition(
            'This customer is archived, so their portal accounts are suspended. Restore the customer before changing anyone’s access.',
            { field: 'customerId' },
          );
        }

        // 4. The whole member list, read once: it answers the target's
        // existence, the portal caller's own live seat, and the last-admin
        // count, and all three must be judged against the same picture.
        const members = ((
          await db.ref(paths.db.customerMembers(orgId, customerId)).get()
        ).val() ?? {}) as Record<string, CustomerMember>;
        const target = members[memberUid];
        if (!target) {
          throw fail.notFound(
            'That person does not have a portal account for this customer.',
            { field: 'memberUid' },
          );
        }

        // 5. A PORTAL caller's authority is re-derived live, never trusted from
        // the token: a seat that was locked, cleared or removed minutes ago must
        // be refused now rather than when their ID token happens to refresh.
        if (caller.kind === 'portal') {
          if (!isActiveAdmin(members[uid])) {
            throw fail.permissionDenied(
              'Only a portal administrator can change a teammate’s access.',
            );
          }
          // Self-lockout guard. Distinct from the last-admin rule below: even
          // with other administrators in place, removing your own admin role
          // removes your own ability to put it back.
          if (memberUid === uid) {
            const losesAdmin = roles !== undefined && roles.admin !== true;
            if (status === 'locked') {
              throw fail.failedPrecondition(
                'You cannot lock your own portal account. Ask another portal administrator, or your fire-risk assessor, to do it for you.',
                { field: 'memberUid' },
              );
            }
            if (losesAdmin) {
              throw fail.failedPrecondition(
                'You cannot remove your own administrator role - you would not be able to put it back. Ask another portal administrator to change it for you.',
                { field: 'memberUid' },
              );
            }
          }
        }

        // 6. LAST-ADMIN guard: apply the change to a copy of the member list and
        // insist an ACTIVE administrator survives it.
        //
        // Unlike updateMember's org-wide twin this is a fresh read plus one
        // atomic write rather than a transaction, a deliberate trade. The org
        // case must be transactional because an organisation with no admin has
        // NO in-app route back. A customer with no portal admin does: any org
        // staff admin repairs it from the contacts panel through this same
        // callable. That makes the narrow race (two administrators demoted
        // concurrently, each counting the other) recoverable rather than
        // terminal - and buys the thing the audit trail needs, which is the
        // member change, the contact realignment and the /activity entry all
        // landing in ONE multi-location update that cannot be half-applied.
        const next: Record<string, CustomerMember> = {
          ...members,
          [memberUid]: {
            ...target,
            ...(roles !== undefined ? { roles } : {}),
            ...(status !== undefined ? { status } : {}),
          },
        };
        if (!Object.values(next).some((member) => isActiveAdmin(member))) {
          throw fail.failedPrecondition(
            'A customer must keep at least one active portal administrator. Give someone else the administrator role first, then change this account.',
            { field: 'memberUid' },
          );
        }

        // 7. The linked contact. The contact record is joined to the account by
        // `CustomerContact.uid` (acceptInvitation writes it back), so the intent
        // record is found by uid rather than by name or address. A member with
        // no linked contact - a hand-repaired record, or a contact removed after
        // its account was created - simply has no intent to realign.
        const contacts = ((
          await db.ref(paths.db.customerContacts(orgId, customerId)).get()
        ).val() ?? {}) as Record<string, CustomerContact>;
        const linkedContact = Object.entries(contacts).find(
          ([, contact]) => contact.uid === memberUid,
        );

        // 8. ONE multi-location update: the account, the contact's intent and the
        // audit entry together. Writing `roles` at its own path replaces the
        // whole object, so a role that was dropped disappears rather than
        // lingering.
        const memberPath = paths.db.customerMember(orgId, customerId, memberUid);
        const update: Record<string, unknown> = {};
        const changed: string[] = [];
        if (roles !== undefined) {
          update[`${memberPath}/roles`] = roles;
          changed.push('roles');
          if (linkedContact) {
            update[
              `${paths.db.customerContact(orgId, customerId, linkedContact[0])}/portalRoles`
            ] = roles;
          }
        }
        if (status !== undefined) {
          update[`${memberPath}/status`] = status;
          changed.push('status');
          // A deliberate standing decision supersedes the archive cascade's
          // bookkeeping: leaving the mark in place would let a later customer
          // RESTORE reactivate an account somebody has just locked on its own
          // merits (lib/customerAccess unlocks exactly the marked accounts).
          update[`${memberPath}/lockedByCustomerArchive`] = null;
        }

        // Field NAMES only in the trail, never old-vs-new PII - the same
        // discipline updateMember keeps.
        Object.assign(
          update,
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action: `customerMember.updated (${changed.join(', ')})`,
            target: memberUid,
          }),
        );

        await db.ref().update(update);

        const logger = createLogger({ fn: 'updateCustomerMember', orgId });
        logger.info('Portal account updated', {
          customerId,
          memberUid,
          changed,
          by: caller.kind,
          contactAligned: Boolean(roles !== undefined && linkedContact),
        });
        return { updated: true };
      },
    ),
);
