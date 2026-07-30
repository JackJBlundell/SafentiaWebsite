// ============================================================================
// PortalTeam - a customer admin's "my team" surface (the first portal write
// beyond accepting a report, and the first place a CUSTOMER ROLE gates a page).
//
// Three things, in the order an admin needs them:
//   1. Who is already on the team - every contact of this customer, with their
//      portal role and whether they have signed in yet. The portal can read its
//      own customerContacts node (the $customerId arm of the rule), so this is a
//      live read, not a guess.
//   2. Change a teammate's role - for anyone whose account already exists, via
//      the updateCustomerMember callable. A role is chosen deliberately in a
//      confirm box, never by a dropdown that saves as it changes.
//   3. Invite a colleague - name, email and the role to grant, with a one-line
//      description of each role so the admin knows what they are handing over,
//      and a plain statement that submitting emails an invitation.
//
// WHY THE ROLE SHOWN COMES FROM THE CONTACT RECORD. The live grant lives on
// /customerMembers, which the rules expose to org STAFF only - a portal token
// cannot read it at all. The contact's portalRoles is what this page can see,
// and updateCustomerMember writes both in one atomic update, so every change
// made from here keeps them in step. Only an account whose role was changed
// before that callable existed can read back stale, and one use of Change role
// settles it.
//
// Access: the page is self-gated on the customer admin role, and the chrome only
// links it for admins. Neither is the real boundary - portalInviteTeammate and
// updateCustomerMember both re-check the role (the latter from the LIVE
// membership record, not the token) and derive the org + customer from the
// verified token - so a non-admin who reaches this URL sees a calm "not
// available" panel and could achieve nothing even if they called the functions
// directly.
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
  UpdateCustomerMemberInput,
  UpdateCustomerMemberResult,
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
    label: 'Portal admin',
    description:
      'Sees your reports, buildings and actions, and can invite other people from your organisation to this portal.',
  },
  finance: {
    label: 'Finance',
    description:
      'Sees the same reports, buildings and actions as a viewer. A label for billing contacts; it grants nothing extra.',
  },
  viewer: {
    label: 'Viewer',
    description:
      'Sees your reports, buildings and actions. Cannot invite anyone.',
  },
};

/** Says what "admin" is NOT. A portal admin runs this portal for their own
 *  organisation; they are not staff of the fire-safety company and cannot see
 *  anyone else's information. Stated where the role is granted and where it is
 *  read back, because "admin" is the word people over-read. */
const ROLE_SCOPE_NOTE =
  'These roles apply to this portal only. A portal admin is not an administrator of your fire-risk assessor’s systems, and can never see another organisation’s information.';

/** How a contact stands in the portal, read from the contact record alone (the
 *  portal cannot see invitation records, so this never claims more than the
 *  contact node knows). A linked account means they can sign in; portal roles
 *  without an account means an invitation is outstanding; neither means they are
 *  a contact only. */
function portalStanding(contact: CustomerContact): {
  label: string;
  detail: string;
  tone: 'active' | 'pending' | 'none';
} {
  if (contact.uid) {
    return {
      label: 'Active',
      detail: 'Has an account and can sign in to this portal.',
      tone: 'active',
    };
  }
  if (contact.portalRoles && Object.keys(contact.portalRoles).length > 0) {
    return {
      label: 'Invitation pending',
      detail: 'Invited, but has not accepted yet, so they cannot sign in.',
      tone: 'pending',
    };
  }
  return {
    label: 'No portal account',
    detail: 'On your contact list only - they have no way into this portal.',
    tone: 'none',
  };
}

/** The role a contact holds, in words, with what it lets them do. Named rather
 *  than implied: a role shown only by position in a list, or only by the tint of
 *  a chip, is not a role anybody can check. */
function roleView(contact: CustomerContact): {
  text: string;
  meanings: string[];
} {
  const held = CUSTOMER_ROLES.filter(
    (role) => contact.portalRoles?.[role] === true,
  );
  if (held.length === 0) {
    return {
      // A signed-up account with no recorded role predates roles being chosen
      // deliberately; saying "no role" of someone who can sign in would be a lie.
      text: contact.uid ? 'Role not recorded' : 'No portal role',
      meanings: [],
    };
  }
  return {
    text: held.map((role) => ROLE_META[role].label).join(', '),
    meanings: held.map((role) => ROLE_META[role].description),
  };
}

/** The two rules updateCustomerMember enforces on a portal admin, in the words
 *  this page shows BEFORE the click. Both leave the same customer without a way
 *  back in, so neither is discovered by being refused. */
const SELF_DEMOTE_REASON =
  'You cannot remove your own administrator role — you would not be able to put it back. Ask another portal administrator to change it for you.';
const LAST_ADMIN_REASON =
  'They are your organisation’s only portal administrator. Give someone else the administrator role first, then change theirs.';

/**
 * Change one teammate's role. Deliberately a confirm box rather than a
 * dropdown that saves as it moves: this hands over (or takes away) access to
 * the organisation's fire-safety information, so the box states what they hold,
 * what they would hold, and when it takes effect before the button is pressed.
 *
 * Every blocked state disables the button with its reason ON THE PAGE. The
 * callable enforces the same two rules regardless - and from the LIVE
 * membership records, which this page cannot read - so a contact record that
 * has not caught up simply means the server has the last word and its message
 * is shown.
 */
function ChangeRoleControl({
  contact,
  isSelf,
  soleAdmin,
}: {
  contact: CustomerContact;
  /** True when this row is the person reading the page. */
  isSelf: boolean;
  /** True when this row is the only portal administrator the team can see. */
  soleAdmin: boolean;
}) {
  const change = useCallable<
    UpdateCustomerMemberInput,
    UpdateCustomerMemberResult
  >('updateCustomerMember');
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<CustomerRoleSet>({});
  const [changedTo, setChangedTo] = useState<string | null>(null);

  const labelsFor = (set: CustomerRoleSet | undefined) =>
    CUSTOMER_ROLES.filter((role) => set?.[role] === true).map(
      (role) => ROLE_META[role].label,
    );
  const heldLabels = labelsFor(contact.portalRoles);
  const nextLabels = labelsFor(roles);
  const unchanged = nextLabels.join('|') === heldLabels.join('|');
  // Losing admin is the only change that can lock someone out, so it is the
  // only one either rule cares about.
  const losesAdmin = roles.admin !== true;
  const blockedReason = !losesAdmin
    ? null
    : isSelf
      ? SELF_DEMOTE_REASON
      : soleAdmin
        ? LAST_ADMIN_REASON
        : null;

  const openBox = () => {
    setChangedTo(null);
    change.clearError();
    setRoles({ ...contact.portalRoles });
    setOpen(true);
  };

  const apply = async () => {
    const result = await change.call({
      memberUid: contact.uid as string,
      roles,
    });
    if (result) {
      setChangedTo(nextLabels.join(', '));
      setOpen(false);
    }
  };

  return (
    <div className={styles.rowActions}>
      {!open && (
        <Button variant="ghost" disabled={change.pending} onClick={openBox}>
          Change role
        </Button>
      )}
      {open && (
        <div className={styles.changeBox}>
          <p className={styles.rowDetail}>
            {contact.name} holds{' '}
            {heldLabels.length > 0 ? heldLabels.join(', ') : 'no portal role'}.
            Choose what they should hold instead. Their portal changes within
            seconds — they do not need to sign out and back in.
          </p>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>Role to hold</legend>
            {CUSTOMER_ROLES.map((role) => (
              <label key={role} className={styles.roleRow}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={roles[role] === true}
                  disabled={change.pending}
                  onChange={(event) =>
                    setRoles((current) => {
                      // A role set is optional `true` flags, so "off" is absent.
                      const next: CustomerRoleSet = { ...current };
                      if (event.target.checked) next[role] = true;
                      else delete next[role];
                      return next;
                    })
                  }
                />
                <span className={styles.roleText}>
                  <span className={styles.roleLabel}>
                    {ROLE_META[role].label}
                  </span>
                  <span className={styles.roleDescription}>
                    {ROLE_META[role].description}
                  </span>
                </span>
              </label>
            ))}
            <p className={styles.roleScope}>{ROLE_SCOPE_NOTE}</p>
          </fieldset>
          {blockedReason ? (
            <p className={styles.blockedNote}>{blockedReason}</p>
          ) : nextLabels.length === 0 ? (
            <p className={styles.blockedNote}>
              Choose at least one role. An account with no role can still sign
              in and would see nothing.
            </p>
          ) : unchanged ? (
            <p className={styles.blockedNote}>
              That is the role they already hold.
            </p>
          ) : null}
          {change.error && <ErrorNotice message={change.error} />}
          <div className={styles.actions}>
            <Button
              disabled={
                change.pending ||
                Boolean(blockedReason) ||
                nextLabels.length === 0 ||
                unchanged
              }
              onClick={() => void apply()}
              aria-label={
                nextLabels.length > 0
                  ? `Change role to ${nextLabels.join(', ')}`
                  : 'Change role'
              }
            >
              {/* Short on purpose - see the note on the console's equivalent:
                  the confirm box states the person and the new role directly
                  above, so a button repeating them just wrapped. */}
              {change.pending ? 'Applying' : 'Change role'}
            </Button>
            <Button
              variant="ghost"
              disabled={change.pending}
              onClick={() => {
                change.clearError();
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {changedTo && !open && !change.error && (
        <p className={styles.success} role="status">
          {contact.name} now holds {changedTo}. Their portal picks the change up
          within seconds.
        </p>
      )}
    </div>
  );
}

export function PortalTeam() {
  const { ready, orgId, customerId, isAdmin, uid, db } = usePortalScope();

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

  // Who could still administer this portal. Counted from what the portal can
  // see - a contact with an account (uid) whose record carries the admin role -
  // so the last-admin control can state its reason before the click. The
  // callable re-counts from the live membership records either way, so this
  // being one row out only means the server's message is the one that lands.
  const adminUids = useMemo(
    () =>
      entries
        .filter(
          ([, contact]) =>
            Boolean(contact.uid) && contact.portalRoles?.admin === true,
        )
        .map(([, contact]) => contact.uid as string),
    [entries],
  );

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
  const [sent, setSent] = useState<{
    email: string;
    emailed: boolean;
    roles: string;
  } | null>(null);

  const busy = invite.pending;
  // The roles as they read on screen, so the button, the confirmation and the
  // list all name the same thing the tick boxes say.
  const chosenLabels = CUSTOMER_ROLES.filter((role) => roles[role] === true).map(
    (role) => ROLE_META[role].label,
  );
  const roleCount = chosenLabels.length;

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
      setSent({
        email: trimmedEmail,
        emailed: Boolean(result.inviteId),
        roles: chosenLabels.join(', '),
      });
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
        lede="The people who can access this portal for your organisation, the role each of them holds, and who to invite next."
        back={{ label: 'your buildings', to: portalUrls.home }}
      />

      <Card flush className={styles.listCard}>
        <div className={styles.cardPad}>
          <CardHeader
            title="Who has access"
            hint="Everyone on your account, with the role each of them holds. Change role moves a teammate’s access and takes effect on their portal within seconds; invite adds a person and emails them a way in. Removing access altogether is handled by your fire-risk assessor."
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
              const role = roleView(contact);
              return (
                <li key={contactId} className={styles.row}>
                  <div className={styles.rowTop}>
                    <span className={styles.identity}>
                      <span className={styles.rowName}>{contact.name}</span>
                      {contact.email && (
                        <span className={styles.rowEmail}>{contact.email}</span>
                      )}
                    </span>
                    <span className={styles.rowMeta}>
                      <span className={styles.roles}>
                        <span className={styles.rolesTerm}>Role: </span>
                        {role.text}
                      </span>
                      <span
                        className={`${styles.standing} ${styles[standing.tone]}`}
                      >
                        {standing.label}
                      </span>
                    </span>
                  </div>
                  <p className={styles.rowDetail}>
                    {[standing.detail, ...role.meanings].join(' ')}
                  </p>
                  {/* Only a live account has a role to change; a pending or
                      contact-only row has nothing on the other side yet. */}
                  {contact.uid && (
                    <ChangeRoleControl
                      contact={contact}
                      isSelf={contact.uid === uid}
                      soleAdmin={
                        adminUids.length === 1 && adminUids[0] === contact.uid
                      }
                    />
                  )}
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
            <legend className={styles.legend}>Role to grant</legend>
            <p className={styles.hint}>
              Choose what this person can do. Viewer is ticked to start with, as
              the least access that still lets someone in - change it before you
              send. You can grant more than one role.
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
            <p className={styles.roleScope}>{ROLE_SCOPE_NOTE}</p>
          </fieldset>

          {fieldError && <ErrorNotice message={fieldError} />}
          {invite.error && <ErrorNotice message={invite.error} />}
          {sent && !invite.error && (
            <p className={styles.success} role="status">
              {sent.emailed
                ? `Invitation sent to ${sent.email} as ${sent.roles}. They hold that role once they accept it.`
                : `${sent.email} already had an invitation waiting. They join as ${sent.roles} once they accept it.`}
            </p>
          )}

          <div className={styles.actions}>
            <Button disabled={busy} onClick={() => void submit()}>
              {busy
                ? 'Sending'
                : roleCount > 0
                  ? `Send invitation as ${chosenLabels.join(', ')}`
                  : 'Send invitation'}
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
