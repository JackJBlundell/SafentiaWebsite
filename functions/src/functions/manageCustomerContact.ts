// ============================================================================
// manageCustomerContact (callable, admin - plus a narrow assessor CREATE path)
// - Phase 2 admin, contact CRUD.
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
//
// THE ASSESSOR CREATE PATH. A responsible party must be a real CustomerContact,
// because that record is what every automated email resolves through. An
// assessor standing in a building, facing a duty-holder who is not in the
// directory, previously had nowhere to put them - which is exactly why free-text
// responsible parties existed and why nobody could be emailed about them. An
// ACTIVE assessor may therefore CREATE (never update, never remove) a contact,
// under three limits:
//
//   - the customer must be one they are actually working for, proved from a LIVE
//     job assigned to them server-side (assertAssessorWorksForCustomer). The
//     payload's customerId is checked against that, never trusted as authority.
//   - `portalRoles` and `isPrimary` are refused. Granting portal access issues an
//     invitation and mints an account, and the primary contact is the customer's
//     own governance; both are the organisation's decisions, not a visiting
//     assessor's.
//   - everything else is unchanged - the same transaction, the same invariant,
//     the same /activity entry, now attributed to the assessor. That includes
//     `receivesReports`: it grants nothing, its default is to receive, and the
//     assessor is the one who was told "just the door checks, please" - so it is
//     theirs to record, and the admin email below names the choice.
//
// The precedent is manageFloorPlan-style assessor-authored, customer-adjacent
// work: the assessor may add what the visit needs, never re-shape the customer.
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
  requireDbKey,
  optionalString,
  clearableString,
  clearableEmail,
  clearableCustomerRoleSet,
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { sendNotification } from '../lib/notifications';
import { issueInvitation } from '../lib/invitations';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { orgEmailBrand } from '../lib/emailTemplates';
import { loadKindConfig } from '../lib/templatedEmail';
import { deliverKindEmail } from '../lib/emailDigest';
import { WEB_ORIGIN } from '../lib/webOrigin';
import type { Logger } from '../lib/logging';
import type { EnvPaths } from '../shared/paths';
import type {
  CustomerContact,
  Environment,
  InvitationSummary,
  Job,
  JobStatus,
  ManageCustomerContactInput,
  ManageCustomerContactResult,
  OrgMember,
  OrgProfile,
} from '../shared/types';

/** The contact fields an admin may set. Server-managed keys (uid - linked by
 *  acceptInvitation; createdAt - stamped here) are rejected, never dropped, so
 *  a client cannot silently believe it wrote a field. An assessor creating a
 *  contact gets a narrower set again: see the create branch. */
const CONTACT_FIELDS = [
  'name',
  'email',
  'phone',
  'jobTitle',
  'receivesReports',
  'portalRoles',
  'isPrimary',
] as const;

const ACTIONS = ['create', 'update', 'remove'] as const;

/** A job that is still work in hand. A cancelled job was called off and a
 *  released one is finished: neither is a reason to be adding people to a
 *  customer's directory today, so neither opens the assessor create path. */
const LIVE_JOB_STATUSES: readonly JobStatus[] = [
  'scheduled',
  'inProgress',
  'readyForValidation',
  'infoRequired',
  'readyForRelease',
];

/**
 * Prove, from the server's own records, that this assessor is working for this
 * customer right now.
 *
 * The authority is the JOB, never the payload: the caller names a customerId,
 * and it is only accepted if one of the assessor's own live jobs actually names
 * it. The /assessorJobs index gives the caller's job ids in one read; each
 * candidate's job record is then read and re-checked (assessorUid, status,
 * customerId) because the index is a mirror and a mirror can lag - a job
 * reassigned to somebody else must stop opening this door immediately.
 *
 * Cost is bounded by the assessor's own LIVE jobs (a handful in practice) and
 * short-circuits on the first match, so the common case is one or two reads.
 */
async function assertAssessorWorksForCustomer(
  paths: EnvPaths,
  orgId: string,
  assessorUid: string,
  customerId: string,
): Promise<void> {
  const indexSnap = await db.ref(paths.db.assessorJobs(orgId, assessorUid)).get();
  const index = (indexSnap.val() as Record<string, JobStatus> | null) ?? {};
  for (const [jobId, indexedStatus] of Object.entries(index)) {
    if (!LIVE_JOB_STATUSES.includes(indexedStatus)) {
      continue;
    }
    const job = (await db.ref(paths.db.job(orgId, jobId)).get()).val() as
      | Job
      | null;
    if (
      job &&
      job.assessorUid === assessorUid &&
      job.customerId === customerId &&
      LIVE_JOB_STATUSES.includes(job.status)
    ) {
      return;
    }
  }
  throw fail.permissionDenied(
    'You can only add a contact for a customer you have a live job with.',
    { field: 'customerId' },
  );
}

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

/**
 * Tell the organisation's active admins that an assessor added a contact from
 * the field, and prompt them to decide whether that person should have portal
 * access.
 *
 * EMAIL is the channel that matters here: admins work from their inbox and the
 * console, not from the assessor's app, so an in-app record alone would sit
 * unread. The in-app notification is sent as well - it costs nothing and the
 * console surfaces it - but the email is the one that does the job.
 *
 * The call to action is the invitation, not the contact: an assessor can add a
 * PERSON but is deliberately barred from granting portal access (portalRoles and
 * isPrimary are refused above), so the decision the organisation actually has to
 * take is whether to invite them. The email links straight to the customer,
 * where that is done.
 *
 * The email goes through lib/emailDigest, so a day of field work does not fill
 * every admin's inbox one contact at a time: the first addition reaches them
 * straight away, and the rest of the day's arrive next morning as one list. The
 * in-app notification above is unbundled and always sent, so the console still
 * shows every addition individually.
 *
 * Best-effort throughout - the contact already exists by the time this runs, so
 * a failure here is logged and swallowed rather than surfaced to an assessor who
 * did nothing wrong.
 */
async function notifyAdminsOfFieldContact({
  paths,
  env,
  orgId,
  customerId,
  customerName,
  contact,
  actorUid,
  logger,
}: {
  paths: EnvPaths;
  env: Environment;
  orgId: string;
  customerId: string;
  customerName: string;
  contact: CustomerContact;
  actorUid: string;
  logger: Logger;
}): Promise<void> {
  try {
    const [membersSnap, profileSnap] = await Promise.all([
      db.ref(paths.db.orgMembers(orgId)).get(),
      db.ref(paths.db.orgProfile(orgId)).get(),
    ]);
    const members =
      (membersSnap.val() as Record<string, OrgMember> | null) ?? {};
    const profile = profileSnap.val() as OrgProfile | null;
    const assessorName = members[actorUid]?.name ?? 'An assessor';
    const orgName = profile?.name ?? 'Your organisation';

    // The in-app notification's body; the EMAIL copy itself now lives in the
    // 'field-contact-added' catalogue entry (or the org's own saved template).
    const body = `${assessorName} added ${contact.name} as a contact for ${customerName} while on site. They can now be named as a responsible party and emailed about reports and actions.`;
    const brand = orgEmailBrand(profile);
    // The detail card, built once and shared by every admin's send.
    const kindRows = [
      { label: 'Contact', value: contact.name },
      ...(contact.jobTitle
        ? [{ label: 'Role', value: contact.jobTitle }]
        : []),
      {
        label: 'Email',
        // Named honestly: without an address the platform cannot tell this
        // person anything, which is the admin's to put right.
        value: contact.email ?? 'None given - they cannot be emailed',
      },
      ...(contact.phone ? [{ label: 'Phone', value: contact.phone }] : []),
      // Only worth a row when it is the EXCEPTION. Every contact receives
      // released reports unless somebody says otherwise, so stating the
      // default on every one of these emails would bury the one case an admin
      // has to look at: an assessor took this person off the distribution.
      ...(contact.receivesReports === false
        ? [
            {
              label: 'Report copies',
              value:
                'No - they were added as not needing a copy of released fire risk assessment reports',
            },
          ]
        : []),
      { label: 'Customer', value: customerName },
      { label: 'Added by', value: assessorName },
    ];
    // One config read serves the whole admin loop, exactly as one rendered
    // html used to.
    const config = await loadKindConfig(env, orgId, 'field-contact-added', logger);

    for (const [uid, member] of Object.entries(members)) {
      if (member?.status !== 'active' || member.roles?.admin !== true) {
        continue;
      }
      // An admin who is also the assessor who did it does not need telling.
      if (uid === actorUid) {
        continue;
      }
      await sendNotification(
        paths,
        orgId,
        uid,
        {
          type: 'account',
          title: 'New customer contact added on site',
          body,
        },
        logger,
      );
      if (member.email) {
        await deliverKindEmail(
          {
            kind: 'field-contact-added',
            env,
            orgId,
            to: member.email,
            variables: {
              'org.name': orgName,
              'assessor.name': assessorName,
              'contact.name': contact.name,
              'customer.name': customerName,
            },
            brand,
            kindRows,
            kindLink: `${WEB_ORIGIN}/app/customers/${customerId}`,
            config,
            // A day on site can add half a dozen contacts, so the digest gives
            // each one a line: who was added, and whose directory they landed
            // in - which is what an admin checks before they trust the entry.
            digestRow: { label: contact.name, value: customerName },
          },
          logger,
        );
      }
    }
  } catch (caught) {
    logger.warn('Could not notify admins of a field-created contact', {
      orgId,
      reason: caught instanceof Error ? caught.message : String(caught),
    });
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
        const claims = await getLiveClaims(request);
        // The union model: an admin may do anything here, an assessor only the
        // guarded create below. An admin+assessor passes as an admin.
        assertOrgRole(claims, ['admin', 'assessor']);
        const isAdmin = claims.roles.admin === true;
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the action and the owning customer.
        const input = assertObject(request.data);
        const action = requireEnum(input, 'action', ACTIONS);
        const customerId = requireDbKey(input, 'customerId', TEXT_LIMITS.shortText);

        // 2b. The assessor gate. Editing and removing a customer's people is
        // administration, so an assessor is turned away here rather than part
        // way through - and the reason names what they CAN do.
        if (!isAdmin) {
          if (action !== 'create') {
            throw fail.permissionDenied(
              'You can add a contact for a customer you are working with, but only an administrator can change or remove one.',
            );
          }
          // Their role claim says what they may do; their membership says
          // whether they still work here. A suspended assessor keeps a valid
          // token until it refreshes, and must not be writing to a customer's
          // directory in the meantime (the dailyJobReminders posture).
          const memberSnap = await db
            .ref(paths.db.orgMember(orgId, uid))
            .get();
          const member = memberSnap.val() as OrgMember | null;
          if (member?.status !== 'active') {
            throw fail.permissionDenied(
              'Your membership of this organisation is not active.',
            );
          }
          await assertAssessorWorksForCustomer(paths, orgId, uid, customerId);
        }

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
          if (
            payload.receivesReports !== undefined &&
            payload.receivesReports !== null &&
            typeof payload.receivesReports !== 'boolean'
          ) {
            throw fail.invalidArgument(
              'The receivesReports field must be true or false.',
              { field: 'receivesReports' },
            );
          }
          return {
            name: optionalString(payload, 'name', TEXT_LIMITS.displayName),
            email: clearableEmail(payload),
            phone: clearableString(payload, 'phone', TEXT_LIMITS.shortText),
            jobTitle: clearableString(payload, 'jobTitle', TEXT_LIMITS.shortText),
            // Kept as sent - null (the clear protocol) and true both mean "back
            // to the default", and the writers below turn either into an ABSENT
            // key rather than a stored `true`. Absence is the single expression
            // of "receives reports" for every record, old and new alike, so
            // there is never a second spelling of the same fact to keep in step.
            receivesReports: payload.receivesReports as
              | boolean
              | null
              | undefined,
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
          // An assessor records WHO the person is, never what they may do.
          // Portal roles issue an invitation and mint an account, and the
          // primary contact is the customer's own governance; both belong to
          // the organisation. Refused, never dropped, so a client bug surfaces
          // rather than silently creating a lesser contact than it believes.
          //
          // `receivesReports` is deliberately NOT on this list. It grants
          // nothing and reveals nothing - it only decides whether one person is
          // posted a copy of the report - and the assessor standing in the
          // building is usually the only one who has been told "I just do the
          // door checks, don't send me the whole assessment". It is also the
          // safe direction to be wrong in: the default is to receive, so an
          // assessor who says nothing changes nothing, the choice is announced
          // to the admins in the field-contact email below, and an admin can
          // reverse it from the contacts panel in one edit.
          if (!isAdmin) {
            for (const key of ['portalRoles', 'isPrimary'] as const) {
              if (payload[key] !== undefined) {
                throw fail.permissionDenied(
                  'Only an administrator can grant portal access or set the primary contact.',
                  { field: key },
                );
              }
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
            // Only the OPT-OUT is stored: absent already means "sends them the
            // report", for this record and for every record written before the
            // field existed, so writing `true` would be a second spelling of a
            // fact the schema already carries.
            ...(fields.receivesReports === false
              ? { receivesReports: false }
              : {}),
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

          // Tell the organisation's admins when an ASSESSOR adds someone to a
          // customer's directory. An admin adding a contact is administration
          // doing its own job and needs no announcement; an assessor doing it
          // from a building is the organisation's people-record changing from
          // the field, and the person added becomes emailable by the platform
          // (release notices, action assignments, deadline chases). That is
          // worth an admin knowing without having to read the activity log.
          //
          // Best-effort, and deliberately AFTER the write: the contact is real
          // by now, so a notification failure must not fail the creation the
          // assessor is standing there waiting for.
          if (!isAdmin) {
            await notifyAdminsOfFieldContact({
              paths,
              env,
              orgId,
              customerId,
              customerName:
                (customerSnap.val() as { name?: string } | null)?.name ??
                'a customer',
              contact,
              actorUid: uid,
              logger,
            });
          }

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
        const contactId = requireDbKey(input, 'contactId', TEXT_LIMITS.shortText);
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
            fields.receivesReports === undefined &&
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
              if (fields.receivesReports !== undefined) {
                // Turning report copies back ON removes the key rather than
                // storing `true`: absent IS "receives reports", so a restored
                // contact becomes indistinguishable from one that was never
                // opted out - which is the truth, and leaves nothing for a
                // later reader to interpret differently.
                if (fields.receivesReports === false) {
                  nextContact.receivesReports = false;
                } else {
                  delete nextContact.receivesReports;
                }
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
