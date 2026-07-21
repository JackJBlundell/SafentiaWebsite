// ============================================================================
// manageCustomer (callable, admin-only) - Phase 2 admin, customer CRUD.
//
// Create, update, archive or restore a customer. Direct client writes to
// /customers are denied by rules; funnelling the writes through here means
// every change lands in the SAME multi-location update as its /activity entry,
// so the audit trail cannot be skipped or forged - the whole reason this is a
// callable. There is no delete: archiving flips status so history (sites,
// buildings, assessments) stays attributed, and restore flips it back. `score` is derived by the platform (rolls up from
// buildings) and is never accepted from the admin form.
//
// Create also provisions the customer's PRIMARY CONTACT when one is supplied:
// the contact record (isPrimary, portal admin roles) lands in the SAME atomic
// update as the customer, and when the contact has an email their portal
// invitation is issued afterwards through lib/invitations. A failed invite
// never fails the creation - the customer and contact are real by then, so we
// log loudly and let the admin resend from the invitations list instead.
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
  requireEmail,
  optionalString,
  clearableString,
  clearableEmail,
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { issueInvitation } from '../lib/invitations';
import type {
  Customer,
  CustomerContact,
  ManageCustomerInput,
  ManageCustomerResult,
} from '../shared/types';

/** The customer fields an admin may set. Unknown or derived keys (score,
 *  status - status moves only via the archive action) are rejected, never
 *  dropped, so a client cannot silently believe it wrote a field. */
const CUSTOMER_FIELDS = ['name', 'address', 'email', 'phone'] as const;

const ACTIONS = ['create', 'update', 'archive', 'restore'] as const;

/** The primary-contact fields accepted at customer creation. */
const PRIMARY_CONTACT_FIELDS = ['name', 'email', 'phone', 'jobTitle'] as const;

export const manageCustomer = onCall<ManageCustomerInput>(
  // Create can send the primary contact's portal invitation, so the email
  // provider secret is attached (see email.ts).
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
    runCallable<ManageCustomerResult>(
      createLogger({ fn: 'manageCustomer' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'manageCustomer');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the action and, for the writing actions, the fields.
        const input = assertObject(request.data);
        const action = requireEnum(input, 'action', ACTIONS);

        // Whitelist validation shared by create and update: only known fields,
        // each a bounded string when present. On update an explicit null on an
        // OPTIONAL field is the CLEAR intent (ClearableFields in the contract:
        // writing null deletes the key in RTDB); name is required on the record
        // so it can only ever be changed, never cleared.
        const readFields = (payload: Record<string, unknown>) => {
          for (const key of Object.keys(payload)) {
            if (!(CUSTOMER_FIELDS as readonly string[]).includes(key)) {
              throw fail.invalidArgument(`Unknown customer field: ${key}.`, {
                field: key,
              });
            }
          }
          if (payload.name === null) {
            throw fail.invalidArgument('The name cannot be removed, only changed.', {
              field: 'name',
            });
          }
          return {
            name: optionalString(payload, 'name', TEXT_LIMITS.shortText),
            address: clearableString(payload, 'address', TEXT_LIMITS.shortText),
            // The org-level switchboard email; shape-checked like every other
            // address on the platform, never accepted as a free-text string.
            email: clearableEmail(payload),
            phone: clearableString(payload, 'phone', TEXT_LIMITS.shortText),
          };
        };

        // The primary contact travels only on create: the customer organisation
        // and its first person are provisioned together (the whole reason the
        // field exists), so it is meaningless - and rejected - elsewhere.
        if (input.primaryContact !== undefined && action !== 'create') {
          throw fail.invalidArgument(
            'A primary contact can only be supplied when creating a customer.',
            { field: 'primaryContact' },
          );
        }

        // 3a. Create: name is required; status starts active; push() mints the id.
        if (action === 'create') {
          const payload = assertObject(input.customer);
          // Null is only meaningful as a CLEAR on update; on create there is
          // nothing to clear yet, so it is a client error, never accepted.
          for (const [key, value] of Object.entries(payload)) {
            if (value === null) {
              throw fail.invalidArgument(
                `The ${key} field cannot be null when creating a customer.`,
                { field: key },
              );
            }
          }
          const fields = readFields(payload);
          if (!fields.name) {
            throw fail.invalidArgument('The customer needs a name.', {
              field: 'name',
            });
          }
          // The primary contact, validated up-front so a bad contact rejects the
          // whole call BEFORE any write - the customer and its first person are
          // provisioned together or not at all. Name is required; nulls are a
          // client error on create, same as the customer fields above.
          let primaryContact:
            | { name: string; email?: string; phone?: string; jobTitle?: string }
            | undefined;
          if (input.primaryContact !== undefined) {
            const pc = assertObject(input.primaryContact);
            for (const key of Object.keys(pc)) {
              if (!(PRIMARY_CONTACT_FIELDS as readonly string[]).includes(key)) {
                throw fail.invalidArgument(
                  `Unknown primary contact field: ${key}.`,
                  { field: key },
                );
              }
            }
            for (const [key, value] of Object.entries(pc)) {
              if (value === null) {
                throw fail.invalidArgument(
                  `The primary contact ${key} field cannot be null.`,
                  { field: key },
                );
              }
            }
            primaryContact = {
              name: requireString(pc, 'name', TEXT_LIMITS.displayName),
              email: pc.email === undefined ? undefined : requireEmail(pc),
              phone: optionalString(pc, 'phone', TEXT_LIMITS.shortText),
              jobTitle: optionalString(pc, 'jobTitle', TEXT_LIMITS.shortText),
            };
          }

          const customer: Customer = {
            name: fields.name,
            status: 'active',
            ...(fields.address ? { address: fields.address } : {}),
            ...(fields.email ? { email: fields.email } : {}),
            ...(fields.phone ? { phone: fields.phone } : {}),
          };
          const customerId = db.ref(paths.db.customers(orgId)).push()
            .key as string;

          const update: Record<string, unknown> = {
            [paths.db.customer(orgId, customerId)]: customer,
            ...activityUpdate(paths, orgId, {
              actorUid: uid,
              action: 'customer.created',
              target: customerId,
            }),
          };

          // The primary contact lands in the SAME multi-location update as the
          // customer, so a customer with a supplied contact can never exist
          // without it. It is born the primary with portal admin roles (the
          // exactly-one-primary invariant starts here; manageCustomerContact
          // maintains it thereafter), and its own audit entry rides along.
          let primaryContactId: string | undefined;
          if (primaryContact) {
            primaryContactId = db
              .ref(paths.db.customerContacts(orgId, customerId))
              .push().key as string;
            const contact: CustomerContact = {
              name: primaryContact.name,
              ...(primaryContact.email ? { email: primaryContact.email } : {}),
              ...(primaryContact.phone ? { phone: primaryContact.phone } : {}),
              ...(primaryContact.jobTitle
                ? { jobTitle: primaryContact.jobTitle }
                : {}),
              portalRoles: { admin: true },
              isPrimary: true,
              createdAt: Date.now(),
            };
            update[
              paths.db.customerContact(orgId, customerId, primaryContactId)
            ] = contact;
            Object.assign(
              update,
              activityUpdate(paths, orgId, {
                actorUid: uid,
                action: 'customerContact.created',
                target: primaryContactId,
              }),
            );
          }
          await db.ref().update(update);

          // Auto-invite the primary contact to the portal AFTER the creation has
          // committed. The customer and contact are real by now, so a failed
          // invitation must NOT fail the call: we log loudly and omit inviteId -
          // the UI offers a resend from the invitations list.
          const logger = createLogger({ fn: 'manageCustomer', orgId });
          let inviteId: string | undefined;
          if (primaryContact?.email && primaryContactId) {
            try {
              const issued = await issueInvitation({
                env,
                paths,
                orgId,
                invitedBy: uid,
                email: primaryContact.email,
                roles: {},
                customerId,
                contactId: primaryContactId,
                logger,
              });
              inviteId = issued.inviteId;
            } catch (error) {
              logger.error(
                'Primary contact auto-invite failed after customer creation; the customer and contact exist, the admin must resend the invitation',
                {
                  customerId,
                  primaryContactId,
                  message: error instanceof Error ? error.message : String(error),
                },
              );
            }
          }

          logger.info('Customer created', {
            customerId,
            hasPrimaryContact: Boolean(primaryContactId),
            invited: Boolean(inviteId),
          });
          return {
            customerId,
            ...(primaryContactId ? { primaryContactId } : {}),
            ...(inviteId ? { inviteId } : {}),
          };
        }

        // 3b. Update / archive both address an existing customer.
        const customerId = requireString(input, 'customerId', TEXT_LIMITS.shortText);
        const customerPath = paths.db.customer(orgId, customerId);
        const existingSnap = await db.ref(customerPath).get();
        if (!existingSnap.exists()) {
          throw fail.notFound('That customer could not be found.', {
            field: 'customerId',
          });
        }

        const update: Record<string, unknown> = {};
        if (action === 'update') {
          // Only the present whitelisted fields change; absent ones are untouched.
          const payload = assertObject(input.customer);
          const fields = readFields(payload);
          if (fields.name !== undefined) update[`${customerPath}/name`] = fields.name;
          if (fields.address !== undefined) {
            update[`${customerPath}/address`] = fields.address;
          }
          if (fields.email !== undefined) update[`${customerPath}/email`] = fields.email;
          if (fields.phone !== undefined) update[`${customerPath}/phone`] = fields.phone;
          if (Object.keys(update).length === 0) {
            throw fail.invalidArgument('No customer fields were provided.');
          }
        } else if (action === 'archive') {
          // Archive: a status flip, never a delete - history stays attributed.
          update[`${customerPath}/status`] = 'archived';
        } else {
          // Restore: the inverse flip. Only an archived customer can return to
          // active - restoring anything else is a client error, not a no-op,
          // so a stale UI learns its state is wrong.
          const existing = existingSnap.val() as Customer;
          if (existing.status !== 'archived') {
            throw fail.invalidArgument(
              'Only an archived customer can be restored.',
              { field: 'customerId' },
            );
          }
          update[`${customerPath}/status`] = 'active';
        }

        const activityAction =
          action === 'update'
            ? 'customer.updated'
            : action === 'archive'
              ? 'customer.archived'
              : 'customer.restored';
        Object.assign(
          update,
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action: activityAction,
            target: customerId,
          }),
        );
        await db.ref().update(update);

        createLogger({ fn: 'manageCustomer', orgId }).info(`Customer ${action}d`, {
          customerId,
        });
        return { customerId };
      },
    ),
);
