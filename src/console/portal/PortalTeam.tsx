// ============================================================================
// PortalTeam - a customer admin's "my team" surface (the first portal write
// beyond accepting a report, and the first place a CUSTOMER ROLE gates a page).
//
// Two things, in the order an admin needs them:
//   1. Who is already on the team - every contact of this customer, with their
//      portal role and whether they have signed in yet. The portal can read its
//      own customerContacts node (the $customerId arm of the rule), so this is a
//      live read, not a guess.
//   2. Invite a colleague - name, email and the role to grant, with a one-line
//      description of each role so the admin knows what they are handing over,
//      and a plain statement that submitting emails an invitation.
//
// Access: the page is self-gated on the customer admin role, and the chrome only
// links it for admins. Neither is the real boundary - the portalInviteTeammate
// callable re-checks the role and derives the org + customer from the verified
// token - so a non-admin who reaches this URL sees a calm "not available" panel
// and could achieve nothing even if they called the function directly.
// ============================================================================

import { useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { CUSTOMER_ROLES } from '../../types';
import type {
  CustomerContact,
  CustomerRole,
  CustomerRoleSet,
  PortalInviteTeammateInput,
  PortalInviteTeammateResult,
} from '../../types';
import { PageHeader, EmptyState, ErrorNotice } from '../ui/Page';
import { Card, CardHeader } from '../ui/Card';
import { useCallable } from '../ui/useCallable';
import { LoadingNote, isValidEmail, sortByName, toEntries } from '../customers/shared';
import { usePortalScope, portalReadStatus, portalUrls } from './shared';
import styles from './PortalTeam.module.css';

/** Role names and what each one grants, in the words a duty-holder needs to
 *  make the decision. Kept beside the form rather than in a tooltip: an admin is
 *  handing over access to their fire safety information, so the consequence is
 *  on the page. Viewer is offered as the safe default. */
const ROLE_META: Record<CustomerRole, { label: string; description: string }> = {
  admin: {
    label: 'Admin',
    description: 'Full access, and can invite other people to the portal.',
  },
  finance: {
    label: 'Finance',
    description:
      'Full access to reports and building status, for billing contacts.',
  },
  viewer: {
    label: 'Viewer',
    description: 'Can view your reports and building status.',
  },
};

/** How a contact stands in the portal, read from the contact record alone (the
 *  portal cannot see invitation records, so this never claims more than the
 *  contact node knows). A linked account means they can sign in; portal roles
 *  without an account means an invitation is outstanding; neither means they are
 *  a contact only. */
function portalStanding(contact: CustomerContact): {
  label: string;
  tone: 'active' | 'pending' | 'none';
} {
  if (contact.uid) {
    return { label: 'Active', tone: 'active' };
  }
  if (contact.portalRoles && Object.keys(contact.portalRoles).length > 0) {
    return { label: 'Invited', tone: 'pending' };
  }
  return { label: 'No portal access', tone: 'none' };
}

/** The role labels a contact holds, in canonical order. */
function roleLabels(contact: CustomerContact): string[] {
  return CUSTOMER_ROLES.filter((role) => contact.portalRoles?.[role] === true).map(
    (role) => ROLE_META[role].label,
  );
}

export function PortalTeam() {
  const { ready, orgId, customerId, isAdmin, db } = usePortalScope();

  // The customer's own contacts. Granted to the portal by the $customerId arm of
  // the customerContacts rule, so this is the same live-listener posture as
  // every other portal read - disabled until claims resolve, never a raw .on().
  const contacts = useRtdbQuery<Record<string, CustomerContact> | null>({
    key: keys.customerContacts(orgId || 'none', customerId || 'none'),
    path: ready && db && isAdmin ? db.customerContacts(orgId, customerId) : 'none',
    enabled: ready && isAdmin,
  });

  const entries = useMemo(
    () => sortByName(toEntries(contacts.data)),
    [contacts.data],
  );
  const status = portalReadStatus(contacts);

  const invite = useCallable<
    PortalInviteTeammateInput,
    PortalInviteTeammateResult
  >('portalInviteTeammate');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  // Viewer is the safe default: the least access that still lets someone in.
  const [roles, setRoles] = useState<CustomerRoleSet>({ viewer: true });
  const [fieldError, setFieldError] = useState<string | null>(null);
  // The outcome of the last successful invite, so the confirmation names the
  // address and tells the truth about whether a fresh email actually went (a
  // teammate who already had a pending invitation is not emailed a second one).
  const [sent, setSent] = useState<{ email: string; emailed: boolean } | null>(
    null,
  );

  const busy = invite.pending;
  const roleCount = Object.keys(roles).length;

  const toggleRole = (role: CustomerRole, on: boolean) => {
    setRoles((current) => {
      // A role set is optional `true` flags, so "off" means the key is absent.
      const next: CustomerRoleSet = { ...current };
      if (on) next[role] = true;
      else delete next[role];
      return next;
    });
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter their name.');
      return;
    }
    const trimmedEmail = email.trim();
    if (!isValidEmail(trimmedEmail)) {
      setFieldError('Enter a valid email address.');
      return;
    }
    if (roleCount === 0) {
      setFieldError('Choose at least one role to grant.');
      return;
    }
    setFieldError(null);
    setSent(null);

    const result = await invite.call({
      name: trimmedName,
      email: trimmedEmail,
      roles,
    });
    if (result) {
      setSent({ email: trimmedEmail, emailed: Boolean(result.inviteId) });
      setName('');
      setEmail('');
      setRoles({ viewer: true });
    }
  };

  // Self-gate: a non-admin who reaches this URL gets a calm dead end, never the
  // form. The callable would refuse them anyway; this just spares the round trip.
  if (ready && !isAdmin) {
    return (
      <>
        <PageHeader
          title="Your team"
          back={{ label: 'your buildings', to: portalUrls.home }}
        />
        <EmptyState
          title="This page is for portal administrators"
          body="Managing who can access this portal is available to administrators only. If you need someone added, ask one of your organisation's portal administrators."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Your team"
        lede="The people who can access this portal for your organisation, and who to invite next."
        back={{ label: 'your buildings', to: portalUrls.home }}
      />

      <Card flush className={styles.listCard}>
        <div className={styles.cardPad}>
          <CardHeader
            title="Who has access"
            hint="Everyone on your account. Invite adds a person and emails them a way in; removing access is handled by your fire-risk assessor."
          />
        </div>
        {status === 'failed' && (
          <div className={styles.cardPadBottom}>
            <ErrorNotice message="Your team could not be loaded. Please try again." />
          </div>
        )}
        {status === 'loading' && (
          <div className={styles.cardPadBottom}>
            <LoadingNote>Loading your team</LoadingNote>
          </div>
        )}
        {status === 'ready' && entries.length === 0 && (
          <p className={styles.emptyRow}>
            No one is on your account yet. Invite your first teammate below.
          </p>
        )}
        {entries.length > 0 && (
          <ul className={styles.list}>
            {entries.map(([contactId, contact]) => {
              const standing = portalStanding(contact);
              const labels = roleLabels(contact);
              return (
                <li key={contactId} className={styles.row}>
                  <span className={styles.identity}>
                    <span className={styles.rowName}>{contact.name}</span>
                    {contact.email && (
                      <span className={styles.rowEmail}>{contact.email}</span>
                    )}
                  </span>
                  <span className={styles.rowMeta}>
                    <span className={styles.roles}>
                      {labels.length > 0 ? labels.join(', ') : 'No portal role'}
                    </span>
                    <span
                      className={`${styles.standing} ${styles[standing.tone]}`}
                    >
                      {standing.label}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card className={styles.formCard}>
        <CardHeader
          title="Invite a teammate"
          hint="We will email them an invitation to join the portal. They set their own password and get access as soon as they accept it."
        />
        <div className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="portal-invite-name">
              Name
            </label>
            <input
              id="portal-invite-name"
              className={styles.input}
              type="text"
              autoComplete="off"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="portal-invite-email">
              Email
            </label>
            <input
              id="portal-invite-email"
              className={styles.input}
              type="email"
              autoComplete="off"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>Role</legend>
            <p className={styles.hint}>
              Choose what this person can do. You can grant more than one.
            </p>
            {CUSTOMER_ROLES.map((role) => (
              <label key={role} className={styles.roleRow}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={roles[role] === true}
                  disabled={busy}
                  onChange={(event) => toggleRole(role, event.target.checked)}
                />
                <span className={styles.roleText}>
                  <span className={styles.roleLabel}>{ROLE_META[role].label}</span>
                  <span className={styles.roleDescription}>
                    {ROLE_META[role].description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {fieldError && <ErrorNotice message={fieldError} />}
          {invite.error && <ErrorNotice message={invite.error} />}
          {sent && !invite.error && (
            <p className={styles.success} role="status">
              {sent.emailed
                ? `Invitation sent to ${sent.email}. They will get access once they accept it.`
                : `${sent.email} already had an invitation waiting. They will get access once they accept it.`}
            </p>
          )}

          <div className={styles.actions}>
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? 'Sending' : 'Send invitation'}
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
