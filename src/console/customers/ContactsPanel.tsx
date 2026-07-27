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
// Mutations go through manageCustomerContact / createInvitation /
// resendInvitation / revokeInvitation; the live listeners reflect the result.
// Destructive steps (revoke, remove, make primary) sit behind inline confirms.
// The primary contact cannot be removed - the server enforces it; the button
// is disabled with the same reason so nobody discovers the rule by failing.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { CUSTOMER_ROLES } from '../../types';
import type {
  ClearableFields,
  CreateInvitationInput,
  CreateInvitationResult,
  CustomerContact,
  InvitationSummary,
  ManageCustomerContactInput,
  ManageCustomerContactResult,
  ResendInvitationInput,
  ResendInvitationResult,
  RevokeInvitationInput,
  RevokeInvitationResult,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { CUSTOMER_ROLE_LABELS, ContactCreateDialog } from './ContactCreateDialog';
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
  active: 'Active',
  invited: 'Invited',
  expired: 'Expired',
  revoked: 'Revoked',
  noEmail: 'No email',
  notInvited: 'Not invited',
  unknown: 'Status unavailable',
};

interface ContactRow {
  id: string;
  contact: CustomerContact;
  portal: PortalStatus;
  /** The contact's latest invitation, when one exists. */
  invite?: { inviteId: string; summary: InvitationSummary };
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
    }));
  }, [contacts.data, customerInvitations, isAdmin, now]);

  return (
    <Card>
      <CardHeader
        title="Contacts"
        hint="The people at this organisation. Portal access is granted per contact."
        action={
          isAdmin ? (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add contact
            </Button>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <p className={shared.cardCopy}>
          No contacts yet. Add the people you deal with at this organisation.
        </p>
      ) : (
        <ul className={styles.cards}>
          {rows.map((row) => (
            <li key={row.id} className={styles.contactCard}>
              <ContactCardBody row={row} />
              {isAdmin && (
                <ContactActions
                  customerId={customerId}
                  row={row}
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

function ContactCardBody({ row }: { row: ContactRow }) {
  const { contact } = row;
  const roleLabels = CUSTOMER_ROLES.filter(
    (role) => contact.portalRoles?.[role] === true,
  ).map((role) => CUSTOMER_ROLE_LABELS[role]);

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
        </dd>
        <dt className={styles.term}>Portal roles</dt>
        <dd className={styles.value}>
          {roleLabels.length > 0 ? (
            roleLabels.join(', ')
          ) : (
            <span className={styles.absent}>None</span>
          )}
        </dd>
      </dl>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Card actions: the contextual portal action (Invite / Resend / Revoke), plus
// Edit which opens the editor beneath the card.
// ----------------------------------------------------------------------------

function ContactActions({
  customerId,
  row,
  editing,
  onEdit,
}: {
  customerId: string;
  row: ContactRow;
  editing: boolean;
  onEdit: () => void;
}) {
  const invite = useCallable<CreateInvitationInput, CreateInvitationResult>(
    'createInvitation',
  );
  const resend = useCallable<ResendInvitationInput, ResendInvitationResult>(
    'resendInvitation',
  );
  const revoke = useCallable<RevokeInvitationInput, RevokeInvitationResult>(
    'revokeInvitation',
  );
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const busy = invite.pending || resend.pending || revoke.pending;
  const error = invite.error ?? resend.error ?? revoke.error;

  const canInvite =
    Boolean(row.contact.email) &&
    (row.portal === 'notInvited' || row.portal === 'revoked');
  const canResend =
    (row.portal === 'invited' || row.portal === 'expired') && row.invite;
  const canRevoke = row.portal === 'invited' && row.invite;

  return (
    <div className={styles.actionsCell}>
      <div className={styles.actionButtons}>
        {canInvite && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void invite.call({
                email: row.contact.email!,
                roles: {},
                customerId,
                contactId: row.id,
              })
            }
          >
            {invite.pending ? 'Inviting' : 'Invite'}
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
        <Button
          variant="ghost"
          aria-expanded={editing}
          onClick={onEdit}
        >
          Edit
        </Button>
      </div>
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
