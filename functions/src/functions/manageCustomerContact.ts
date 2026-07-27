// ============================================================================
// manageCustomerContact (callable, admin-only) - Phase 2 admin, contact CRUD.
//
// Create, update or remove a person at a customer organisation (a customer is
// the ORGANISATION; its people are CustomerContact records). Direct client
// writes to /customerContacts are denied by rules; funnelling the writes
// through here means every change carries its /activity entry and the
// primary-contact invariant below can be enforced server-side.
//
// The primary-contact invariant: a customer has AT MOST ONE primary contact
// (exactly one once the first has been appointed - manageCustomer appoints it
// at creation). Promoting a contact to primary therefore DEMOTES the current
// primary, and the primary itself can never be removed or stripped of the
// flag - it is only ever reassigned by promoting another contact. Every write
// runs as a TRANSACTION on the customer's whole contacts node (the same
// posture as updateMember's last-admin guard): a read-then-write here is a
// TOCTOU hole where two concurrent promotions land two primaries, or a
// promotion racing a removal leaves none. The transaction asserts the
// invariant against the in-transaction state, so racing writes serialise.
//
// Removing a contact also revokes any pending portal invitation issued for
// them, so an accept link can never outlive the person it was for.
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
  getClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  requireString,
  optionalString,
  clearableString,
  clearableEmail,
  clearableCustomerRoleSet,
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { issueInvitation } from '../lib/invitations';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import type { EnvPaths } from '../shared/paths';
import type {
  CustomerContact,
  Environment,
  InvitationSummary,
  ManageCustomerContactInput,
  ManageCustomerContactResult,
} from '../shared/types';

/** The contact fields an admin may set. Server-managed keys (uid - linked by
 *  acceptInvitation; createdAt - stamped here) are rejected, never dropped, so
 *  a client cannot silently believe it wrote a field. */
const CONTACT_FIELDS = [
  'name',
  'email',
  'phone',
  'jobTitle',
  'portalRoles',
  'isPrimary',
] as const;

const ACTIONS = ['create', 'update', 'remove'] as const;

/** Does this contact hold at least one portal role? A role set is an object of
 *  optional `true` flags, so "has portal access" is simply a non-empty set. */
function hasPortalAccess(contact: CustomerContact): boolean {
  const roles = contact.portalRoles;
  return Boolean(roles) && Object.keys(roles as object).length > 0;
}

/**
 * Invite a contact to the portal if they should have access and do not already.
 *
 * Granting `portalRoles` is the act of saying "this person should be able to
 * sign in", so it is what issues the invitation - previously roles could be
 * granted with no invitation ever sent, leaving a contact who was supposed to
 * have access sitting there with no way in and no signal that anything was
 * outstanding. Mirrors the primary-contact auto-invite in manageCustomer.
 *
 * Runs AFTER the contact write has committed and NEVER throws: the contact is
 * real by this point, so a failed invitation must not fail the call or roll the
 * contact back. The admin can always resend from the contacts panel.
 */
async function autoInvitePortalContact({
  env,
  paths,
  orgId,
  customerId,
  contactId,
  contact,
  invitedBy,
  logger,
}: {
  env: Environment;
  paths: EnvPaths;
  orgId: string;
  customerId: string;
  contactId: string;
  contact: CustomerContact;
  invitedBy: string;
  logger: ReturnType<typeof createLogger>;
}): Promise<void> {
  if (!contact.email || !hasPortalAccess(contact)) return;
  // Already linked to an account: they can sign in, so there is nothing to send.
  if (contact.uid) return;

  try {
    // Do not stack invitations. The token-bearing /invitations root is not
    // readable here by design, so this reads the admin-safe per-org summaries,
    // exactly as the remove branch does when it revokes.
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
    if (live) return;

    // roles is deliberately empty: a portal invitation carries NO organisation
    // roles, the recipient's permissions come from the contact's portalRoles.
    await issueInvitation({
      env,
      paths,
      orgId,
      invitedBy,
      email: contact.email,
      roles: {},
      customerId,
      contactId,
      logger,
    });
    logger.info('Portal invitation auto-issued for customer contact', {
      customerId,
      contactId,
    });
  } catch (error) {
    logger.error(
      'Auto-invite failed after contact write; the contact exists and an admin can resend from the contacts panel',
      { customerId, contactId, error: String(error) },
    );
  }
}

export const manageCustomerContact = onCall<ManageCustomerContactInput>(
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
    runCallable<ManageCustomerContactResult>(
      createLogger({ fn: 'manageCustomerContact' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'manageCustomerContact');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the action and the owning customer.
        const input = assertObject(request.data);
        const action = requireEnum(input, 'action', ACTIONS);
        const customerId = requireString(input, 'customerId', TEXT_LIMITS.shortText);

        // Whitelist validation shared by create and update: only known fields,
        // each validated when present. On update an explicit null on an OPTIONAL
        // field is the CLEAR intent (ClearableFields in the contract); name is
        // required on the record and the primary flag only moves by promotion,
        // so null is rejected on both.
        const readFields = (payload: Record<string, unknown>) => {
          for (const key of Object.keys(payload)) {
            if (!(CONTACT_FIELDS as readonly string[]).includes(key)) {
              throw fail.invalidArgument(`Unknown contact field: ${key}.`, {
                field: key,
              });
            }
          }
          if (payload.name === null) {
            throw fail.invalidArgument('The name cannot be removed, only changed.', {
              field: 'name',
            });
          }
          if (payload.isPrimary === null) {
            // The primary is reassigned by promoting another contact, never
            // cleared - clearing would leave the customer with no primary.
            throw fail.invalidArgument(
              'The primary contact is reassigned by promoting another contact.',
              { field: 'isPrimary' },
            );
          }
          if (payload.isPrimary !== undefined && payload.isPrimary !== true) {
            // A flag, not a boolean: only literal `true` (promote) is meaningful.
            throw fail.invalidArgument(
              'The isPrimary field can only be set to true.',
              { field: 'isPrimary' },
            );
          }
          return {
            name: optionalString(payload, 'name', TEXT_LIMITS.displayName),
            email: clearableEmail(payload),
            phone: clearableString(payload, 'phone', TEXT_LIMITS.shortText),
            jobTitle: clearableString(payload, 'jobTitle', TEXT_LIMITS.shortText),
            portalRoles: clearableCustomerRoleSet(payload),
            isPrimary: payload.isPrimary as true | undefined,
          };
        };

        // Every write action transacts on the customer's WHOLE contacts node so
        // the exactly-one-primary invariant is asserted against the state the
        // write actually lands on, never a stale earlier read.
        const contactsRef = db.ref(paths.db.customerContacts(orgId, customerId));

        const logger = createLogger({ fn: 'manageCustomerContact', orgId });

        /** Demote whichever contact holds the primary flag in `next` (mutates). */
        const demoteCurrentPrimary = (
          next: Record<string, CustomerContact>,
          exceptId: string,
        ) => {
          for (const [id, other] of Object.entries(next)) {
            if (id !== exceptId && other.isPrimary) {
              const demoted: CustomerContact = { ...other };
              delete demoted.isPrimary;
              next[id] = demoted;
            }
          }
        };

        /** Audit entry AFTER a committed transaction (a transaction cannot join
         *  a multi-location update). The deliberate trade-off, same as
         *  updateMember: invariant correctness wins over single-write audit
         *  atomicity; a crash in the gap loses one audit line, never the
         *  invariant. `extra` lets remove ride its invitation revocations in
         *  the same update as the entry. */
        const writeAudit = (
          auditAction:
            | 'customerContact.created'
            | 'customerContact.updated'
            | 'customerContact.removed',
          target: string,
          extra: Record<string, unknown> = {},
        ) =>
          db.ref().update({
            ...extra,
            ...activityUpdate(paths, orgId, {
              actorUid: uid,
              action: auditAction,
              target,
            }),
          });

        // 3a. Create: the owning customer must exist (a contact can never be
        // orphaned) and the contact needs a name. push() mints the id.
        if (action === 'create') {
          const payload = assertObject(input.contact);
          // Null is only meaningful as a CLEAR on update; on create there is
          // nothing to clear yet, so it is a client error, never accepted.
          for (const [key, value] of Object.entries(payload)) {
            if (value === null) {
              throw fail.invalidArgument(
                `The ${key} field cannot be null when creating a contact.`,
                { field: key },
              );
            }
          }
          const fields = readFields(payload);
          if (!fields.name) {
            throw fail.invalidArgument('The contact needs a name.', {
              field: 'name',
            });
          }
          const customerSnap = await db
            .ref(paths.db.customer(orgId, customerId))
            .get();
          if (!customerSnap.exists()) {
            throw fail.notFound('That customer could not be found.', {
              field: 'customerId',
            });
          }

          const contact: CustomerContact = {
            name: fields.name,
            ...(fields.email ? { email: fields.email } : {}),
            ...(fields.phone ? { phone: fields.phone } : {}),
            ...(fields.jobTitle ? { jobTitle: fields.jobTitle } : {}),
            ...(fields.portalRoles ? { portalRoles: fields.portalRoles } : {}),
            ...(fields.isPrimary ? { isPrimary: true as const } : {}),
            createdAt: Date.now(),
          };
          const contactId = contactsRef.push().key as string;

          // Exactly-one-primary invariant: creating the new primary DEMOTES
          // whichever contact holds the flag IN THE TRANSACTION STATE, so two
          // racing creations (or a creation racing a promotion) serialise and
          // no reader can ever observe two primaries. The updater never aborts,
          // so a non-committed result can only mean RTDB gave up (thrown).
          await contactsRef.transaction(
            (all: Record<string, CustomerContact> | null) => {
              const next: Record<string, CustomerContact> = { ...(all ?? {}) };
              if (fields.isPrimary) {
                demoteCurrentPrimary(next, contactId);
              }
              next[contactId] = contact;
              return next;
            },
          );

          await writeAudit('customerContact.created', contactId);
          logger.info('Customer contact created', { customerId, contactId });

          // Created with portal roles = created with portal access, so send the
          // invitation now rather than leaving it as a separate manual step an
          // admin has to remember.
          await autoInvitePortalContact({
            env,
            paths,
            orgId,
            customerId,
            contactId,
            contact,
            invitedBy: uid,
            logger,
          });
          return { contactId };
        }

        // 3b. Update / remove both address an existing contact. The read here is
        // a fast-path courtesy for honest copy; the transaction below re-asserts
        // existence (and the primary guard) against the state it commits on.
        const contactId = requireString(input, 'contactId', TEXT_LIMITS.shortText);
        const contactPath = paths.db.customerContact(orgId, customerId, contactId);
        const existingSnap = await db.ref(contactPath).get();
        if (!existingSnap.exists()) {
          throw fail.notFound('That contact could not be found.', {
            field: 'contactId',
          });
        }
        const existing = existingSnap.val() as CustomerContact;

        if (action === 'update') {
          // Only the present whitelisted fields change; absent ones are
          // untouched; null CLEARS an optional field (RTDB deletes the key).
          const payload = assertObject(input.contact);
          const fields = readFields(payload);
          if (
            fields.name === undefined &&
            fields.email === undefined &&
            fields.phone === undefined &&
            fields.jobTitle === undefined &&
            fields.portalRoles === undefined &&
            !fields.isPrimary
          ) {
            throw fail.invalidArgument('No contact fields were provided.');
          }

          const result = await contactsRef.transaction(
            (all: Record<string, CustomerContact> | null) => {
              if (all === null) {
                // Uncached first run in a listener-less function instance: the
                // local cache is null even though the node exists, and returning
                // undefined would abort before the server value is read. Return a
                // sentinel to force the server round-trip; the SDK re-runs this
                // against the real contacts node (the fast-path read confirmed it
                // exists), so the sentinel is never persisted.
                return {} as Record<string, CustomerContact>;
              }
              if (!all[contactId]) {
                // The contact vanished between the fast-path read and now.
                return undefined;
              }
              const nextContact: CustomerContact = { ...all[contactId] };
              if (fields.name !== undefined) nextContact.name = fields.name;
              if (fields.email !== undefined) {
                if (fields.email === null) delete nextContact.email;
                else nextContact.email = fields.email;
              }
              if (fields.phone !== undefined) {
                if (fields.phone === null) delete nextContact.phone;
                else nextContact.phone = fields.phone;
              }
              if (fields.jobTitle !== undefined) {
                if (fields.jobTitle === null) delete nextContact.jobTitle;
                else nextContact.jobTitle = fields.jobTitle;
              }
              if (fields.portalRoles !== undefined) {
                if (fields.portalRoles === null) delete nextContact.portalRoles;
                else nextContact.portalRoles = fields.portalRoles;
              }
              const next: Record<string, CustomerContact> = {
                ...all,
                [contactId]: nextContact,
              };
              if (fields.isPrimary) {
                // Exactly-one-primary invariant, promotion path: the old primary
                // is demoted in the SAME transaction result the new one is
                // flagged in, asserted against the in-transaction state so two
                // racing promotions serialise to one primary.
                nextContact.isPrimary = true;
                demoteCurrentPrimary(next, contactId);
              }
              return next;
            },
          );
          if (!result.committed) {
            throw fail.notFound('That contact could not be found.', {
              field: 'contactId',
            });
          }

          await writeAudit('customerContact.updated', contactId);
          logger.info('Customer contact updated', { customerId, contactId });

          // Granting portal roles to an existing contact is the same act as
          // creating one with them, so it invites too. Gated on roles actually
          // being granted in THIS update: without the gate every unrelated edit
          // (a phone number, a job title) would pay a read of the invitation
          // summaries only to find there is nothing to do.
          if (fields.portalRoles) {
            const committed = (result.snapshot.val() ?? {}) as Record<
              string,
              CustomerContact
            >;
            const updated = committed[contactId];
            if (updated) {
              await autoInvitePortalContact({
                env,
                paths,
                orgId,
                customerId,
                contactId,
                contact: updated,
                invitedBy: uid,
                logger,
              });
            }
          }
          return { contactId };
        }

        // Remove. The primary can never be removed - the customer must always
        // keep its primary, so it is reassigned first. The fast-path check gives
        // honest copy; the transaction re-asserts it so a removal racing a
        // promotion can never leave the customer with zero primaries.
        if (existing.isPrimary) {
          throw fail.failedPrecondition('Assign a new primary contact first.', {
            field: 'contactId',
          });
        }
        // Deleting the record deliberately does NOT touch any linked portal
        // account: a contact with a `uid` keeps portal access, because
        // revoking access is member management (/customerMembers), not
        // contact removal.
        const result = await contactsRef.transaction(
          (all: Record<string, CustomerContact> | null) => {
            if (all === null) {
              // Uncached first run in a listener-less function instance: force
              // the server round-trip so the SDK re-runs against the real
              // contacts node (the fast-path read confirmed it exists); the
              // sentinel is never persisted.
              return {} as Record<string, CustomerContact>;
            }
            if (!all[contactId]) {
              return undefined;
            }
            if (all[contactId].isPrimary) {
              // Guard tripped: a racing promotion made this contact primary.
              return undefined;
            }
            const next: Record<string, CustomerContact> = { ...all };
            delete next[contactId];
            return next;
          },
        );
        if (!result.committed) {
          // The transaction cannot carry a reason out of an abort; a fresh read
          // distinguishes "contact gone" from "guard tripped" for honest copy.
          const stillThere = (await db.ref(contactPath).get()).exists();
          if (!stillThere) {
            throw fail.notFound('That contact could not be found.', {
              field: 'contactId',
            });
          }
          throw fail.failedPrecondition('Assign a new primary contact first.', {
            field: 'contactId',
          });
        }

        // Removing the person also kills any PENDING portal invitation issued
        // for them - the accept link must not outlive the contact. /invitations
        // is not indexed by contact, so we read the org's admin-facing summary
        // node and match customerId + contactId + pending, then flip each
        // record AND its summary together, riding in the SAME update as the
        // audit entry (the flips cannot join the contacts transaction above).
        // If the process dies in the gap the invite stays pending, but
        // acceptInvitation refuses a portal invite whose contact no longer
        // exists, so a stale invite is inert either way.
        const summariesSnap = await db.ref(paths.db.orgInvitations(orgId)).get();
        const summaries = (summariesSnap.val() ?? {}) as Record<
          string,
          InvitationSummary
        >;
        const revocations: Record<string, unknown> = {};
        for (const [inviteId, summary] of Object.entries(summaries)) {
          if (
            summary.status === 'pending' &&
            summary.customerId === customerId &&
            summary.contactId === contactId
          ) {
            revocations[`${paths.db.invitation(inviteId)}/status`] = 'revoked';
            revocations[`${paths.db.orgInvitation(orgId, inviteId)}/status`] =
              'revoked';
          }
        }
        await writeAudit('customerContact.removed', contactId, revocations);

        logger.info('Customer contact removed', {
          customerId,
          contactId,
          revokedInvites: Object.keys(revocations).length / 2,
        });
        return { contactId };
      },
    ),
);
