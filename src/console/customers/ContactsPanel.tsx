// ============================================================================
// ContactsPanel - the people at a customer organisation, with per-contact
// portal access. Portal state is derived, never stored twice: a linked uid
// means Active; otherwise the contact's latest invitation (from the admin-read
// /orgInvitations summaries, filtered client-side to this customer + contact)
// decides Invited / Expired / Revoked; no email means no invitation possible.
//
// The panel lives in the page's narrow aside column, so each contact is a CARD
// rather than a table row: a table of six columns in that width is either
// cramped or scrolls sideways, and neither is readable. Cards stack, wrap and
// keep long emails inside their own box.
//
// PORTAL ROLE, not just portal state. Two different facts are shown, because
// they can still disagree on older records: `contact.portalRoles` is the role an
// admin INTENDED, while the role the person actually holds lives on their
// /customerMembers record and is what mints their token (computePortalClaims).
// An account is created from the contact's roles at accept, so once someone has
// signed in their MEMBERSHIP is the truth and the card says so.
//
// Change role moves that membership. updateCustomerMember writes the account and
// the contact's portalRoles in one atomic update, so from here on the intent and
// the live grant stay in step - and a disagreement inherited from before it
// existed is put right by using it once.
//
// Mutations go through manageCustomerContact / updateCustomerMember /
// resendInvitation / revokeInvitation; the live listeners reflect the result.
// Inviting is itself a manageCustomerContact write: granting portalRoles is what
// issues the invitation server-side (autoInvitePortalContact), and it is the ONLY
// way the chosen role reaches a NEW account, since a portal invitation record
// carries no roles of its own. Once the account exists, Change role is the way.
// Destructive steps (revoke, remove, make primary) and role changes sit behind
// inline confirms. Two rules the server enforces are stated on the disabled
// control rather than left to a refusal: the primary contact cannot be removed,
// and a customer's last active portal admin cannot be demoted.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { CUSTOMER_ROLES } from '../../types';
import type {
  ClearableFields,
  CustomerContact,
  CustomerMember,
  CustomerRole,
  CustomerRoleSet,
  InvitationSummary,
  ManageCustomerContactInput,
  ManageCustomerContactResult,
  ResendInvitationInput,
  ResendInvitationResult,
  RevokeInvitationInput,
  RevokeInvitationResult,
  UpdateCustomerMemberInput,
  UpdateCustomerMemberResult,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import {
  CUSTOMER_ROLE_META,
  ContactCreateDialog,
  PortalRoleChoice,
  REPORT_SCOPE_NOTE,
  formatRoleList,
  portalRoleLabels,
} from './ContactCreateDialog';
import { isValidEmail, sortByName, toEntries, useOrgScope } from './shared';
import shared from './shared.module.css';
import styles from './ContactsPanel.module.css';

type PortalStatus =
  | 'active'
  | 'invited'
  | 'expired'
  | 'revoked'
  | 'noEmail'
  | 'notInvited'
  | 'unknown';

const PORTAL_LABELS: Record<PortalStatus, string> = {
  active: 'Account active',
  invited: 'Invitation sent',
  expired: 'Invitation expired',
  revoked: 'Invitation revoked',
  noEmail: 'No portal account',
  notInvited: 'No portal account',
  unknown: 'Status unavailable',
};

/** The chip alone cannot separate "never invited" from "no email to invite" -
 *  both are "no portal account" - so each state also states its own reason.
 *  These are the sentences an admin reads to know what to do next. */
const PORTAL_DETAIL: Record<PortalStatus, string> = {
  active: 'They can sign in to the customer portal.',
  invited: 'Waiting for them to accept it.',
  expired: 'The link has run out. Resend to send a fresh one.',
  revoked: 'Their invitation was cancelled, so they cannot sign in.',
  noEmail: 'No email address on record, so there is nowhere to send an invitation.',
  notInvited: 'They have never been invited, so they cannot sign in.',
  unknown: 'Invitation records are not visible to you, so this cannot be confirmed.',
};

/**
 * What the platform does with a RELEASED REPORT for one contact. Three states,
 * not two: "switched off" and "no address to send to" are different problems
 * with different fixes, and a card that showed both as "no" would send an admin
 * to the wrong field.
 */
type ReportState = 'receives' | 'optedOut' | 'noEmail';

const REPORT_LABELS: Record<ReportState, string> = {
  receives: 'Gets released reports',
  optedOut: 'No report copies',
  noEmail: 'Cannot be emailed',
};

/** What each state means, in full. Every line names the boundary of the setting
 *  as well as its effect: the reason a contact is taken off report copies is
 *  almost always "they only handle the door checks", and an admin has to be able
 *  to read here that doing so does NOT silence the emails that person needs. */
const REPORT_DETAIL: Record<ReportState, string> = {
  receives:
    'They are emailed a copy of every fire risk assessment released for this customer.',
  optedOut:
    'They are not sent copies of released fire risk assessments.',
  noEmail:
    'No email address on record, so nothing can be sent to them at all — not reports, reminders, visit notices or action emails.',
};

/** ABSENT MEANS YES: every contact received reports before the flag existed, so
 *  only an explicit `false` is an opt-out (see CustomerContact.receivesReports).
 *  No address beats either answer - there is nowhere to send. */
function reportState(contact: CustomerContact): ReportState {
  if (!contact.email) {
    return 'noEmail';
  }
  return contact.receivesReports === false ? 'optedOut' : 'receives';
}

interface ContactRow {
  id: string;
  contact: CustomerContact;
  portal: PortalStatus;
  /** The contact's latest invitation, when one exists. */
  invite?: { inviteId: string; summary: InvitationSummary };
  /** The portal account this contact is linked to, when they have signed up.
   *  This - not `contact.portalRoles` - carries the role they actually hold. */
  member?: CustomerMember;
}

/** Latest invitation for the contact, then the derived portal state.
 *  `invitationsKnown` is false when the invitations read is admin-gated off:
 *  with an email but no visible invitations, "not invited" cannot be derived,
 *  so the state is honestly unknown. */
function derivePortal(
  contactId: string,
  contact: CustomerContact,
  invitations: [string, InvitationSummary][],
  invitationsKnown: boolean,
  now: number,
): Pick<ContactRow, 'portal' | 'invite'> {
  if (contact.uid) {
    return { portal: 'active' };
  }
  const own = invitations
    .filter(([, summary]) => summary.contactId === contactId)
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  const latest = own[0];
  if (latest) {
    const [inviteId, summary] = latest;
    const invite = { inviteId, summary };
    if (summary.status === 'accepted') {
      // The uid write-back should accompany acceptance; trust the acceptance.
      return { portal: 'active', invite };
    }
    if (summary.status === 'revoked') {
      return { portal: 'revoked', invite };
    }
    if (summary.status === 'expired' || summary.expiresAt <= now) {
      return { portal: 'expired', invite };
    }
    return { portal: 'invited', invite };
  }
  if (!contact.email) {
    return { portal: 'noEmail' };
  }
  if (!invitationsKnown) {
    return { portal: 'unknown' };
  }
  return { portal: 'notInvited' };
}

/** The portal role a card should state, and everything that qualifies it. */
interface RoleView {
  /** The role in words - "Portal admin" - or why there is none. */
  headline: string;
  /** One line per granted role: what it lets this person do. */
  meanings: string[];
  /** Qualifications an admin needs to read: an automatic grant they did not
   *  choose, or an intent the existing account never picked up. */
  notes: string[];
  /** True when a role is actually held or pending, so the card can render the
   *  "none" case as the plainly different state it is. */
  granted: boolean;
}

/**
 * What role to show, from the right source for the contact's state.
 *
 * A live account's role comes from its /customerMembers record; the contact's
 * `portalRoles` is only an intent, and after acceptance the two can differ (the
 * account is minted once and never re-reads the contact). Saying "Portal admin"
 * off the contact record while their token says viewer is exactly the confusion
 * this panel exists to end, so a disagreement is stated rather than smoothed.
 */
function describeRole(row: ContactRow, membersKnown: boolean): RoleView {
  const intended = portalRoleLabels(row.contact.portalRoles);
  const meaningsFor = (roles: CustomerRoleSet | undefined) =>
    CUSTOMER_ROLES.filter((role) => roles?.[role] === true).map(
      (role) => CUSTOMER_ROLE_META[role].meaning,
    );
  /** The primary contact is given the admin role by manageCustomer when the
   *  customer is created, so nobody has to wonder where it came from. */
  const primaryNote = (roles: CustomerRoleSet | undefined): string[] =>
    row.contact.isPrimary && roles?.admin === true
      ? [
          'The primary contact is made a portal admin automatically when the customer is created.',
        ]
      : [];

  if (row.portal === 'active') {
    const member = row.member;
    if (!member) {
      // Two ways to land here: the contact carries no uid (the state is derived
      // from an accepted invitation, so the account exists but was never linked
      // back to this record), or the members read has not resolved. Neither may
      // be dressed up as a role - an unconfirmed grant is the one thing this
      // panel must not print.
      return {
        headline: 'Role unavailable',
        meanings: [],
        notes: [
          !row.contact.uid
            ? 'Their invitation was accepted, but no account is linked to this contact record, so their role cannot be confirmed here.'
            : membersKnown
              ? 'They are linked to a portal account this customer does not list, so their role cannot be confirmed here.'
              : 'Portal accounts could not be read just now, so their role cannot be confirmed.',
        ],
        granted: false,
      };
    }
    const held = portalRoleLabels(member.roles);
    if (held.length === 0) {
      return {
        headline: 'No role on their account',
        meanings: [],
        notes: [
          'They can sign in, but their account holds none of the three portal roles.',
        ],
        granted: false,
      };
    }
    const notes = primaryNote(member.roles);
    const heldKey = held.join('|');
    if (intended.length > 0 && intended.join('|') !== heldKey) {
      // Only records that predate Change role can land here: it writes the
      // account and the contact together, so anything it touches agrees
      // afterwards. Say which one is real, and how to settle it in one step.
      notes.push(
        `Their account holds ${formatRoleList(held)}; this contact record still asks for ${formatRoleList(intended)}. The account is what counts - use Change role to set both to the same thing.`,
      );
    }
    return {
      headline: formatRoleList(held),
      meanings: meaningsFor(member.roles),
      notes,
      granted: true,
    };
  }

  if (intended.length === 0) {
    return {
      headline: 'No portal role',
      meanings: [],
      notes: ['They are a contact record only, with no way into the portal.'],
      granted: false,
    };
  }

  return {
    headline: formatRoleList(intended),
    meanings: meaningsFor(row.contact.portalRoles),
    notes: [
      ...primaryNote(row.contact.portalRoles),
      row.portal === 'invited' || row.portal === 'expired'
        ? 'This is the role their account is created with when they accept.'
        : 'This is the role they would be given if you invite them.',
    ],
    granted: true,
  };
}

export function ContactsPanel({ customerId }: { customerId: string }) {
  const { ready, orgId, db, isAdmin } = useOrgScope();

  const contacts = useRtdbQuery<Record<string, CustomerContact> | null>({
    key: keys.customerContacts(orgId, customerId),
    path: ready ? db!.customerContacts(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });
  // Invitation summaries are admin-read; non-admins still see the contacts,
  // just without invitation-derived states.
  const invitations = useRtdbQuery<Record<string, InvitationSummary> | null>({
    key: keys.orgInvitations(orgId),
    path: ready ? db!.orgInvitations(orgId) : '',
    enabled: ready && isAdmin,
  });
  // The customer's portal accounts, keyed by uid. Readable by any active staff
  // member (the rule keys on orgMembers, not on the admin role), so a viewer
  // browsing the customer sees the same roles an admin does. This is the only
  // honest source for the role a signed-up contact actually holds.
  const members = useRtdbQuery<Record<string, CustomerMember> | null>({
    key: keys.customerMembers(orgId, customerId),
    path: ready ? db!.customerMembers(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });

  // Editing an existing contact happens inline beneath its card; creating one
  // happens in the dialog, where the invitation consequence is spelled out.
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // A minute tick so time-derived states (an invite crossing its expiry) update
  // while the page stays open, rather than freezing at first render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const customerInvitations = useMemo(
    () =>
      toEntries(invitations.data).filter(
        ([, summary]) => summary.customerId === customerId,
      ),
    [invitations.data, customerId],
  );

  const rows: ContactRow[] = useMemo(() => {
    const sorted = sortByName(toEntries(contacts.data));
    // Primary first, the rest alphabetical.
    sorted.sort((a, b) => Number(b[1].isPrimary === true) - Number(a[1].isPrimary === true));
    return sorted.map(([id, contact]) => ({
      id,
      contact,
      ...derivePortal(id, contact, customerInvitations, isAdmin, now),
      ...(contact.uid && members.data?.[contact.uid]
        ? { member: members.data[contact.uid] }
        : {}),
    }));
  }, [contacts.data, customerInvitations, isAdmin, members.data, now]);

  const membersKnown = members.isSuccess;

  // A released report that reaches nobody is a silent failure: the release
  // succeeds, the trigger logs it, and the customer is simply never told. The
  // condition is only knowable here - the contacts are all in one node - so it
  // is stated on the panel that owns them rather than left to be noticed when
  // somebody asks where their report went.
  const reportRecipients = useMemo(
    () => rows.filter((row) => reportState(row.contact) === 'receives').length,
    [rows],
  );
  const anyContactEmail = rows.some((row) => Boolean(row.contact.email));

  // Who can still administer this customer's portal. updateCustomerMember
  // refuses to leave a customer with no active portal admin; counting the same
  // thing here lets the control say so BEFORE the click rather than after the
  // refusal. Derived from the members node, never from contact intent, because
  // the account is what the server counts.
  const activeAdminUids = useMemo(
    () =>
      toEntries(members.data)
        .filter(
          ([, member]) =>
            member.status === 'active' && member.roles?.admin === true,
        )
        .map(([uid]) => uid),
    [members.data],
  );

  return (
    <Card>
      <CardHeader
        title="Contacts"
        hint="The people at this organisation. Portal access and report copies are both set per contact; each card states the role that person holds and whether released reports are sent to them."
        action={
          isAdmin ? (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add contact
            </Button>
          ) : undefined
        }
      />
      {rows.length > 0 && reportRecipients === 0 && (
        <p className={styles.noRecipients} role="status">
          <span className={styles.noRecipientsLead}>
            Nobody here receives released reports
          </span>
          <span className={styles.noRecipientsCopy}>
            {anyContactEmail
              ? 'Every contact at this organisation has been taken off report copies, so releasing an assessment will send the report to no one.'
              : 'No contact at this organisation has an email address, so releasing an assessment will send the report to no one.'}
            {isAdmin
              ? anyContactEmail
                ? ' Edit a contact and switch report copies back on for at least one person.'
                : ' Edit a contact and add an email address for at least one person.'
              : null}
          </span>
        </p>
      )}
      {rows.length === 0 ? (
        <p className={shared.cardCopy}>
          No contacts yet. Add the people you deal with at this organisation.
        </p>
      ) : (
        <ul className={styles.cards}>
          {rows.map((row) => (
            <li key={row.id} className={styles.contactCard}>
              <ContactCardBody row={row} membersKnown={membersKnown} />
              {isAdmin && (
                <ContactActions
                  customerId={customerId}
                  row={row}
                  soleActiveAdmin={
                    activeAdminUids.length === 1 &&
                    activeAdminUids[0] === row.contact.uid
                  }
                  editing={editing === row.id}
                  onEdit={() => setEditing(editing === row.id ? null : row.id)}
                />
              )}
              {isAdmin && editing === row.id && (
                <div className={styles.editorWrap}>
                  <ContactEditor
                    key={row.id}
                    customerId={customerId}
                    contactId={row.id}
                    contact={row.contact}
                    onDone={() => setEditing(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && adding && (
        <ContactCreateDialog
          customerId={customerId}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// One contact, as a card: who they are, how to reach them, and where they stand
// with the portal. Every value is labelled, so a card read aloud or read in a
// narrow column still says what each line is.
// ----------------------------------------------------------------------------

function ContactCardBody({
  row,
  membersKnown,
}: {
  row: ContactRow;
  membersKnown: boolean;
}) {
  const { contact } = row;
  const role = describeRole(row, membersKnown);
  const reports = reportState(contact);

  return (
    <div className={styles.cardBody}>
      <div className={styles.identity}>
        <span className={styles.name}>{contact.name}</span>
        {contact.isPrimary && (
          <span className={styles.primaryBadge}>Primary contact</span>
        )}
        {contact.jobTitle && (
          <span className={styles.jobTitle}>{contact.jobTitle}</span>
        )}
      </div>
      <dl className={styles.details}>
        <dt className={styles.term}>Email</dt>
        <dd className={styles.value}>
          {contact.email ? (
            <a className={styles.link} href={`mailto:${contact.email}`}>
              {contact.email}
            </a>
          ) : (
            <span className={styles.absent}>Not recorded</span>
          )}
        </dd>
        <dt className={styles.term}>Phone</dt>
        <dd className={styles.value}>
          {contact.phone ? (
            <a className={styles.link} href={`tel:${contact.phone}`}>
              {contact.phone}
            </a>
          ) : (
            <span className={styles.absent}>Not recorded</span>
          )}
        </dd>
        <dt className={styles.term}>Reports</dt>
        <dd className={styles.value}>
          <span
            className={
              reports === 'receives' ? styles.portalLive : styles.portalMuted
            }
          >
            {REPORT_LABELS[reports]}
          </span>
          <span className={styles.portalDetail}>{REPORT_DETAIL[reports]}</span>
          {/* The boundary of the setting, on the card as well as on the control:
              somebody reading "no report copies" needs to know here that the
              person is still being reminded and chased about their own work. */}
          {reports !== 'noEmail' && (
            <span className={styles.roleNote}>{REPORT_SCOPE_NOTE}</span>
          )}
        </dd>
        <dt className={styles.term}>Portal</dt>
        <dd className={styles.value}>
          <span
            className={
              row.portal === 'active' || row.portal === 'invited'
                ? styles.portalLive
                : styles.portalMuted
            }
          >
            {PORTAL_LABELS[row.portal]}
          </span>
          <span className={styles.portalDetail}>
            {PORTAL_DETAIL[row.portal]}
          </span>
        </dd>
        <dt className={styles.term}>
          {row.portal === 'active' ? 'Portal role' : 'Role when they join'}
        </dt>
        <dd className={styles.value}>
          <span className={role.granted ? styles.roleName : styles.absent}>
            {role.headline}
          </span>
          {role.meanings.map((meaning) => (
            <span key={meaning} className={styles.roleMeaning}>
              {meaning}
            </span>
          ))}
          {role.notes.map((note) => (
            <span key={note} className={styles.roleNote}>
              {note}
            </span>
          ))}
        </dd>
      </dl>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Card actions: the contextual portal action (Invite / Resend / Revoke / Change
// role), plus Edit which opens the editor beneath the card.
// ----------------------------------------------------------------------------

/** The rule updateCustomerMember enforces, in the words the panel shows BEFORE
 *  the click. A customer with no active portal admin has nobody who can invite
 *  or manage their own people, so the last one is protected. */
const LAST_ADMIN_REASON =
  'They are this customer’s only active portal administrator. Give someone else the administrator role first, then change theirs.';

function ContactActions({
  customerId,
  row,
  soleActiveAdmin,
  editing,
  onEdit,
}: {
  customerId: string;
  row: ContactRow;
  /** True when this contact's account is the ONLY active portal admin left, so
   *  the control that would demote them is disabled with the reason shown. */
  soleActiveAdmin: boolean;
  editing: boolean;
  onEdit: () => void;
}) {
  // Inviting IS a portalRoles write. createInvitation cannot carry a portal role
  // (the server rejects roles on a customer invitation, and acceptInvitation
  // reads the role off the contact record instead), so inviting without setting
  // portalRoles silently handed the joiner the server's viewer fallback - the
  // admin chose nothing and was told nothing. Granting the role here both
  // records the choice and issues the invitation, in one server-side act.
  const grant = useCallable<
    ManageCustomerContactInput,
    ManageCustomerContactResult
  >('manageCustomerContact');
  const resend = useCallable<ResendInvitationInput, ResendInvitationResult>(
    'resendInvitation',
  );
  const revoke = useCallable<RevokeInvitationInput, RevokeInvitationResult>(
    'revokeInvitation',
  );
  // Changing a LIVE account's role is a different verb to inviting: the account
  // already exists, so the write has to land on /customerMembers (which no
  // client may touch) rather than on the contact's intent. updateCustomerMember
  // writes both, so the card and the person's session agree afterwards.
  const changeRole = useCallable<
    UpdateCustomerMemberInput,
    UpdateCustomerMemberResult
  >('updateCustomerMember');
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [changing, setChanging] = useState(false);
  // Seeded from the ACCOUNT's roles when the box opens, so an admin edits what
  // the person actually holds rather than an intent that may predate it.
  const [nextRoles, setNextRoles] = useState<CustomerRoleSet>({});
  const [changedTo, setChangedTo] = useState<string | null>(null);
  // Seeded from whatever the contact already carries, so an existing intent is
  // shown and re-confirmed rather than quietly re-applied or quietly dropped.
  const [roles, setRoles] = useState<CustomerRoleSet>(
    () => ({ ...row.contact.portalRoles }),
  );
  const [roleError, setRoleError] = useState<string | null>(null);
  const [sentAs, setSentAs] = useState<string | null>(null);

  const busy =
    grant.pending || resend.pending || revoke.pending || changeRole.pending;
  const error =
    grant.error ?? resend.error ?? revoke.error ?? changeRole.error;

  const canInvite =
    Boolean(row.contact.email) &&
    (row.portal === 'notInvited' || row.portal === 'revoked');
  const canResend =
    (row.portal === 'invited' || row.portal === 'expired') && row.invite;
  const canRevoke = row.portal === 'invited' && row.invite;
  // Only a linked, readable account can have its role changed: without the
  // membership record there is nothing to change and nothing honest to seed the
  // picker from. `row.member` is set only when both are true.
  const memberUid = row.contact.uid;
  const canChangeRole = Boolean(memberUid && row.member);

  const chosenLabels = portalRoleLabels(roles);

  // What they hold now versus what the box would give them, as the same labels
  // the card reads back, so the button names the outcome rather than the verb.
  const heldLabels = portalRoleLabels(row.member?.roles);
  const nextLabels = portalRoleLabels(nextRoles);
  const roleUnchanged = nextLabels.join('|') === heldLabels.join('|');
  const wouldDemoteLastAdmin = soleActiveAdmin && nextRoles.admin !== true;

  const openInvite = () => {
    setSentAs(null);
    setRoleError(null);
    grant.clearError();
    setRoles({ ...row.contact.portalRoles });
    setInviting(true);
  };

  const sendInvite = async () => {
    if (chosenLabels.length === 0) {
      setRoleError('Choose the role this invitation grants.');
      return;
    }
    setRoleError(null);
    const result = await grant.call({
      action: 'update',
      customerId,
      contactId: row.id,
      contact: { portalRoles: roles },
    });
    if (result) {
      setSentAs(formatRoleList(chosenLabels));
      setInviting(false);
    }
  };

  const openChange = () => {
    setChangedTo(null);
    changeRole.clearError();
    setNextRoles({ ...row.member?.roles });
    setChanging(true);
  };

  const applyChange = async () => {
    const result = await changeRole.call({
      customerId,
      memberUid: memberUid as string,
      roles: nextRoles,
    });
    if (result) {
      setChangedTo(formatRoleList(nextLabels));
      setChanging(false);
    }
  };

  return (
    <div className={styles.actionsCell}>
      <div className={styles.actionButtons}>
        {canInvite && !inviting && (
          <Button variant="ghost" disabled={busy} onClick={openInvite}>
            Invite
          </Button>
        )}
        {canResend && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void resend.call({ inviteId: row.invite!.inviteId })}
          >
            {resend.pending ? 'Resending' : 'Resend'}
          </Button>
        )}
        {canRevoke && !confirmingRevoke && (
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmingRevoke(true)}>
            Revoke
          </Button>
        )}
        {canChangeRole && !changing && (
          <Button variant="ghost" disabled={busy} onClick={openChange}>
            Change role
          </Button>
        )}
        <Button
          variant="ghost"
          aria-expanded={editing}
          onClick={onEdit}
        >
          Edit
        </Button>
      </div>
      {inviting && (
        <div className={styles.inviteBox}>
          <p className={styles.confirmCopy}>
            Inviting {row.contact.name} at {row.contact.email}. Choose what they
            can do in this organisation’s portal — they hold that role from the
            moment they accept.
          </p>
          <PortalRoleChoice
            legend="Role to grant"
            intro="Pick the role deliberately: there is no default. Viewer is the usual starting point, and portal admin is the only role that lets someone invite more people."
            roles={roles}
            disabled={busy}
            onToggle={(role: CustomerRole, on: boolean) =>
              setRoles((current) => {
                // A role set is optional `true` flags, so "off" means absent.
                const next: CustomerRoleSet = { ...current };
                if (on) next[role] = true;
                else delete next[role];
                return next;
              })
            }
          />
          {roleError && <ErrorNotice message={roleError} />}
          <div className={styles.confirmButtons}>
            <Button disabled={busy} onClick={() => void sendInvite()}>
              {grant.pending
                ? 'Sending'
                : chosenLabels.length > 0
                  ? `Send invitation as ${formatRoleList(chosenLabels)}`
                  : 'Send invitation'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                grant.clearError();
                setRoleError(null);
                setInviting(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {sentAs && !inviting && !error && (
        <p className={styles.sentNote} role="status">
          {row.contact.name} was invited as {sentAs}. This card shows the
          invitation as soon as it goes out.
        </p>
      )}
      {changing && (
        <div className={styles.inviteBox}>
          <p className={styles.confirmCopy}>
            {row.contact.name}’s account holds{' '}
            {heldLabels.length > 0
              ? formatRoleList(heldLabels)
              : 'no portal role'}
            . Choose what they should hold instead. Their portal changes within
            seconds — they do not need to sign out and back in.
          </p>
          {/* A locked account keeps its roles but no session, so promising an
              immediate change would be a lie for this one state. */}
          {row.member?.status !== 'active' && (
            <p className={styles.blockedNote}>
              Their account is not active at the moment, so this sets the role
              they hold once it is.
            </p>
          )}
          <PortalRoleChoice
            legend="Role to hold"
            intro="This changes the live account, not just this contact record: both are written together, so what this card says is what their session gets."
            roles={nextRoles}
            disabled={busy}
            onToggle={(role: CustomerRole, on: boolean) =>
              setNextRoles((current) => {
                // A role set is optional `true` flags, so "off" means absent.
                const next: CustomerRoleSet = { ...current };
                if (on) next[role] = true;
                else delete next[role];
                return next;
              })
            }
          />
          {/* Every blocked state says WHY on the page, so the disabled button is
              never a dead end an admin has to guess at. */}
          {wouldDemoteLastAdmin ? (
            <p className={styles.blockedNote}>{LAST_ADMIN_REASON}</p>
          ) : nextLabels.length === 0 ? (
            <p className={styles.blockedNote}>
              Choose at least one role. An account with no role can still sign
              in and would see nothing.
            </p>
          ) : roleUnchanged ? (
            <p className={styles.blockedNote}>
              That is the role they already hold.
            </p>
          ) : null}
          <div className={styles.confirmButtons}>
            <Button
              disabled={
                busy ||
                wouldDemoteLastAdmin ||
                nextLabels.length === 0 ||
                roleUnchanged
              }
              onClick={() => void applyChange()}
              aria-label={
                nextLabels.length > 0
                  ? `Change ${row.contact.name}'s portal role to ${formatRoleList(nextLabels)}`
                  : 'Change portal role'
              }
            >
              {/* Short on purpose: the box above already states who this is and
                  which role they will hold, so repeating it here only made the
                  button wide enough to wrap. The accessible name carries the
                  detail for anyone who arrives on the control alone. */}
              {changeRole.pending ? 'Applying' : 'Change role'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                changeRole.clearError();
                setChanging(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {changedTo && !changing && !error && (
        <p className={styles.sentNote} role="status">
          {row.contact.name} now holds {changedTo}. Their portal picks the change
          up within seconds, and this contact record was updated to match.
        </p>
      )}
      {confirmingRevoke && (
        <div className={styles.confirmBox}>
          <p className={styles.confirmCopy}>
            Revoke the invitation to {row.contact.name}? Their link stops working
            immediately.
          </p>
          <div className={styles.confirmButtons}>
            <Button
              disabled={revoke.pending}
              onClick={() =>
                void revoke
                  .call({ inviteId: row.invite!.inviteId })
                  .then((result) => {
                    if (result) setConfirmingRevoke(false);
                  })
              }
            >
              {revoke.pending ? 'Revoking' : 'Revoke invitation'}
            </Button>
            <Button
              variant="ghost"
              disabled={revoke.pending}
              onClick={() => {
                revoke.clearError();
                setConfirmingRevoke(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <ErrorNotice message={error} />}
    </div>
  );
}

// ----------------------------------------------------------------------------
// The editor: edit an existing contact with the clear protocol (an emptied
// optional that WAS set sends the explicit null). Creating is the dialog's job.
// Editing also carries Make primary and Remove behind their own confirms.
// ----------------------------------------------------------------------------

function ContactEditor({
  customerId,
  contactId,
  contact,
  onDone,
}: {
  customerId: string;
  contactId: string;
  contact: CustomerContact;
  onDone: () => void;
}) {
  const manage = useCallable<ManageCustomerContactInput, ManageCustomerContactResult>(
    'manageCustomerContact',
  );

  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(contact.email ?? '');
  const [phone, setPhone] = useState(contact.phone ?? '');
  const [jobTitle, setJobTitle] = useState(contact.jobTitle ?? '');
  // Absent means yes, so the box opens ticked for every record written before
  // the setting existed - which is exactly what those records do today.
  const [receivesReports, setReceivesReports] = useState(
    contact.receivesReports !== false,
  );
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'primary' | 'remove' | null>(null);

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter the contact name.');
      return;
    }
    const trimmedEmail = email.trim();
    if (trimmedEmail && !isValidEmail(trimmedEmail)) {
      setFieldError('Enter a valid email address, or leave the field empty.');
      return;
    }
    setFieldError(null);

    const payload: ClearableFields<CustomerContact> = { name: trimmedName };
    if (trimmedEmail) payload.email = trimmedEmail;
    else if (contact.email) payload.email = null;
    const trimmedPhone = phone.trim();
    if (trimmedPhone) payload.phone = trimmedPhone;
    else if (contact.phone) payload.phone = null;
    const trimmedJob = jobTitle.trim();
    if (trimmedJob) payload.jobTitle = trimmedJob;
    else if (contact.jobTitle) payload.jobTitle = null;
    // Sent every save, not only when it changed: `true` is the server's "back to
    // the default" (it deletes the key rather than storing a redundant value),
    // so re-sending the current state is a genuine no-op and there is no diff to
    // get wrong.
    payload.receivesReports = receivesReports;

    const result = await manage.call({
      action: 'update',
      customerId,
      contactId,
      contact: payload,
    });
    if (result) {
      onDone();
    }
  };

  const makePrimary = async () => {
    const result = await manage.call({
      action: 'update',
      customerId,
      contactId,
      contact: { isPrimary: true },
    });
    if (result) {
      setConfirm(null);
      onDone();
    }
  };

  const remove = async () => {
    const result = await manage.call({ action: 'remove', customerId, contactId });
    if (result) {
      setConfirm(null);
      onDone();
    }
  };

  return (
    <div className={styles.editor}>
      <h3 className={styles.editorTitle}>Edit {contact.name}</h3>
      <div className={shared.fieldRow}>
        <div className={shared.field}>
          <label className={shared.label} htmlFor="contact-editor-name">
            Name
          </label>
          <input
            id="contact-editor-name"
            className={shared.input}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={shared.field}>
          <label className={shared.label} htmlFor="contact-editor-job">
            Job title (optional)
          </label>
          <input
            id="contact-editor-job"
            className={shared.input}
            type="text"
            autoComplete="off"
            value={jobTitle}
            onChange={(event) => setJobTitle(event.target.value)}
          />
        </div>
      </div>
      <div className={shared.fieldRow}>
        <div className={shared.field}>
          <label className={shared.label} htmlFor="contact-editor-email">
            Email (optional)
          </label>
          <input
            id="contact-editor-email"
            className={shared.input}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className={shared.field}>
          <label className={shared.label} htmlFor="contact-editor-phone">
            Phone (optional)
          </label>
          <input
            id="contact-editor-phone"
            className={shared.input}
            type="tel"
            autoComplete="off"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
      </div>
      <div className={styles.reportsField}>
        <label className={shared.checkboxRow} htmlFor="contact-editor-reports">
          <input
            id="contact-editor-reports"
            className={shared.checkbox}
            type="checkbox"
            checked={receivesReports}
            onChange={(event) => setReceivesReports(event.target.checked)}
          />
          <span className={shared.label}>Send them released reports</span>
        </label>
        <p className={shared.hint}>
          Ticked, {contact.name} gets a copy of every released fire risk
          assessment for this customer. {REPORT_SCOPE_NOTE}
        </p>
        {/* The one state where the tick means nothing yet. Left ENABLED on
            purpose: an admin is often adding the address in this same save, and
            the choice should already be recorded when it lands. */}
        {!email.trim() && (
          <p className={shared.note}>
            Without an email address nothing can be sent to {contact.name} at
            all, whether this is ticked or not.
          </p>
        )}
      </div>
      {fieldError && <ErrorNotice message={fieldError} />}
      {manage.error && <ErrorNotice message={manage.error} />}

      {confirm === 'primary' ? (
        <div className={styles.confirmBox}>
          <p className={styles.confirmCopy}>
            Make {contact.name} the primary contact? The current primary keeps
            their record and portal access.
          </p>
          <div className={styles.confirmButtons}>
            <Button disabled={manage.pending} onClick={() => void makePrimary()}>
              {manage.pending ? 'Updating' : 'Make primary'}
            </Button>
            <Button variant="ghost" disabled={manage.pending} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : confirm === 'remove' ? (
        <div className={styles.confirmBox}>
          <p className={styles.confirmCopy}>
            Remove {contact.name} from this organisation? Their record is
            deleted; any portal account is not.
          </p>
          <div className={styles.confirmButtons}>
            <Button disabled={manage.pending} onClick={() => void remove()}>
              {manage.pending ? 'Removing' : 'Remove contact'}
            </Button>
            <Button variant="ghost" disabled={manage.pending} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.editorActions}>
          <div className={shared.formActions}>
            <Button disabled={manage.pending} onClick={() => void save()}>
              {manage.pending ? 'Saving' : 'Save changes'}
            </Button>
            <Button variant="ghost" disabled={manage.pending} onClick={onDone}>
              Cancel
            </Button>
          </div>
          <div className={shared.formActions}>
            {!contact.isPrimary && (
              <Button variant="secondary" onClick={() => setConfirm('primary')}>
                Make primary
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={contact.isPrimary === true}
              title={
                contact.isPrimary
                  ? 'The primary contact cannot be removed. Make another contact primary first.'
                  : undefined
              }
              onClick={() => setConfirm('remove')}
            >
              Remove
            </Button>
            {contact.isPrimary && (
              <p className={shared.note}>
                The primary contact cannot be removed. Make another contact
                primary first.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
