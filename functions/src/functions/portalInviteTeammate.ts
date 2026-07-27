// ============================================================================
// portalInviteTeammate (callable, customer portal) - a customer ADMIN invites a
// colleague from their own organisation into the customer portal with a role.
//
// This is the FIRST portal-side write beyond acceptReport, and the FIRST place
// the product ENFORCES a customer role rather than merely carrying it: the call
// is gated on the caller holding customerRoles.admin.
//
// Trust boundary: the org and customer are taken from the VERIFIED portal token
// (portalOrgId + customerId via getPortalClaims), NEVER from the payload. A
// customer admin can therefore only ever invite into their OWN customer - the
// whole tenancy boundary rests on this. Only the teammate's name, email and the
// roles to grant come from the client, each allow-listed before it is stored.
//
// Roles are CUSTOMER roles only (validated against CUSTOMER_ROLES); the
// invitation itself is issued with EMPTY org roles, the mirror image of
// createInvitation's portal path, so no organisation-staff access can ever ride
// a portal invite - portal permission comes solely from the contact's
// portalRoles. A NON-primary CustomerContact is created (or an account-less
// existing contact for the same address is reused), which is why the write
// transacts on the customer's whole contacts node exactly as
// manageCustomerContact does: it must add or merge without disturbing the
// customer's single primary contact, and two concurrent invites of one address
// must not create two rows. Email failure is non-fatal - the contact is real by
// then, so a dropped invitation must not roll it back (staff can resend).
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  getPortalClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  requireEmail,
  requireString,
  requireCustomerRoleSet,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { issueInvitation } from '../lib/invitations';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import type {
  Customer,
  CustomerContact,
  InvitationSummary,
  PortalInviteTeammateInput,
  PortalInviteTeammateResult,
} from '../shared/types';

/** Does the verified portal token grant this caller the customer ADMIN role?
 *  Reconstructed defensively from the token (the same posture getClaims uses for
 *  org roles): only a literal `true` admin flag counts, so a tampered or stale
 *  token cannot assert a role it was never minted with. This is the first place
 *  the product reads a customer role to decide access. */
function isPortalAdmin(rawRoles: unknown): boolean {
  return (
    typeof rawRoles === 'object' &&
    rawRoles !== null &&
    (rawRoles as Record<string, unknown>).admin === true
  );
}

/** Find an existing contact of this customer by email. Emails are stored
 *  lower-cased (requireEmail normalises), so the comparison is a plain match
 *  against the already-normalised input. */
function findByEmail(
  contacts: Record<string, CustomerContact>,
  email: string,
): [string, CustomerContact] | undefined {
  return Object.entries(contacts).find(
    ([, contact]) => (contact.email ?? '').toLowerCase() === email,
  );
}

export const portalInviteTeammate = onCall<PortalInviteTeammateInput>(
  // Issues the invitation email, so the provider secret is attached (see email.ts).
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
    runCallable<PortalInviteTeammateResult>(
      createLogger({ fn: 'portalInviteTeammate' }),
      async () => {
        // 1. Attestation, identity, rate limit, then the PORTAL identity (a staff
        // token resolves to nothing here - portal and staff claims are disjoint).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'portalInviteTeammate');
        const claims = getPortalClaims(request);
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;
        const customerId = claims.customerId;

        // 2. Authorise: only a customer ADMIN may manage their team. Read from
        // the verified token, never the payload - this is the customer-role gate.
        if (!isPortalAdmin(request.auth?.token?.customerRoles)) {
          throw fail.permissionDenied(
            'Only a portal administrator can invite teammates.',
          );
        }

        // 3. Validate the input against the allow-lists; reject, never coerce.
        // Only the name, email and roles come from the client.
        const input = assertObject(request.data);
        const name = requireString(input, 'name', TEXT_LIMITS.displayName);
        const email = requireEmail(input);
        // Customer roles only, non-empty. An org-staff role or an unknown key is
        // rejected here, so nothing but a portal role can be granted.
        const roles = requireCustomerRoleSet(input);

        // 4. Re-derive the customer's standing server-side. Portal grants already
        // forbid an archived customer, but a claim can outlive an archival, so
        // the boundary is re-checked here rather than trusted from the token.
        const customerSnap = await db
          .ref(paths.db.customer(orgId, customerId))
          .get();
        const customer = customerSnap.val() as Customer | null;
        if (!customer) {
          throw fail.notFound('Your customer account could not be found.');
        }
        if (customer.status === 'archived') {
          throw fail.permissionDenied(
            'Your portal access is suspended, so teammates cannot be invited.',
          );
        }

        const logger = createLogger({ fn: 'portalInviteTeammate', orgId });
        const contactsRef = db.ref(paths.db.customerContacts(orgId, customerId));

        // 5. Fast-path read for honest copy and to pick reuse vs create. An
        // existing contact for this address that ALREADY has a portal account is
        // rejected outright ("already on the team"); an account-less one is
        // reused (the roles are granted onto it) rather than duplicated.
        const existingSnap = await contactsRef.get();
        const existing = (existingSnap.val() ?? {}) as Record<
          string,
          CustomerContact
        >;
        const fastDup = findByEmail(existing, email);
        if (fastDup && fastDup[1].uid) {
          throw fail.failedPrecondition(
            'Someone with that email address is already on your team.',
            { field: 'email' },
          );
        }
        const newId = contactsRef.push().key as string;
        const newContact: CustomerContact = {
          name,
          email,
          portalRoles: roles,
          createdAt: Date.now(),
        };

        // 6. Add or merge under a TRANSACTION on the whole contacts node, the
        // same posture as manageCustomerContact: the write must land on the
        // state it commits against so a racing invite (or a racing staff edit)
        // cannot create a second row for one address, and the customer's single
        // primary is never touched (this contact is NON-primary by construction).
        //
        // The updater must be correct for a NULL current value, because on a cold
        // instance the SDK's local cache is null even when the node has rows. It
        // never returns `undefined` (abort) on that first null run - it takes the
        // create branch - so the transaction always proceeds to fetch the true
        // server value and RE-RUN this updater against it. By commit time `all`
        // therefore reflects the real node, so the dedup below sees any existing
        // contact and the abort only ever fires against real server state.
        const result = await contactsRef.transaction(
          (
            all: Record<string, CustomerContact> | null,
          ): Record<string, CustomerContact> | undefined => {
            const next: Record<string, CustomerContact> = { ...(all ?? {}) };
            const dup = findByEmail(next, email);
            if (dup) {
              if (dup[1].uid) {
                // Gained an account since the fast-path read: reject via abort.
                return undefined;
              }
              // Reuse: grant the roles without disturbing the rest of the record
              // (name, phone, primary flag all stay as the staff set them).
              next[dup[0]] = {
                ...dup[1],
                portalRoles: { ...(dup[1].portalRoles ?? {}), ...roles },
              };
              return next;
            }
            next[newId] = newContact;
            return next;
          },
        );
        if (!result.committed) {
          // The only abort path is a contact that gained a portal account between
          // the fast-path read and the commit.
          throw fail.failedPrecondition(
            'Someone with that email address is already on your team.',
            { field: 'email' },
          );
        }

        // The authoritative id is read back from the committed state (a race
        // could have decided reuse differently than the fast-path guessed).
        const committed = (result.snapshot.val() ?? {}) as Record<
          string,
          CustomerContact
        >;
        const committedEntry = findByEmail(committed, email);
        const contactId = committedEntry ? committedEntry[0] : newId;

        // 7. Audit AFTER the commit (a transaction cannot join a multi-location
        // update), attributed to the inviting portal uid so the org sees which
        // customer admin added someone.
        await db.ref().update(
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'customerContact.invited',
            target: contactId,
          }),
        );

        // 8. Issue the invitation: env-scoped tokenised record + admin summary +
        // branded accept email, via the shared core. Org roles are EMPTY - portal
        // permission comes from the contact's portalRoles, so no staff access can
        // ride the invite. Non-fatal: the contact exists by now, so a failed or
        // duplicate invitation must never roll it back (staff can resend from the
        // console). A live invitation for this contact is not stacked.
        let inviteId: string | undefined;
        try {
          const summariesSnap = await db.ref(paths.db.orgInvitations(orgId)).get();
          const summaries = (summariesSnap.val() ?? {}) as Record<
            string,
            InvitationSummary
          >;
          const live = Object.values(summaries).some(
            (summary) =>
              summary.customerId === customerId &&
              summary.contactId === contactId &&
              (summary.status === 'pending' || summary.status === 'accepted'),
          );
          if (!live) {
            const issued = await issueInvitation({
              env,
              paths,
              orgId,
              invitedBy: uid,
              email,
              roles: {},
              customerId,
              contactId,
              logger,
            });
            inviteId = issued.inviteId;
          }
        } catch (error) {
          logger.error(
            'Portal teammate invitation failed after contact write; the contact exists and staff can resend from the contacts panel',
            { customerId, contactId, error: String(error) },
          );
        }

        logger.info('Portal teammate invited', {
          customerId,
          contactId,
          roles: Object.keys(roles),
          invited: Boolean(inviteId),
        });
        return { contactId, ...(inviteId ? { inviteId } : {}) };
      },
    ),
);
