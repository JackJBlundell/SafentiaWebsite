// ============================================================================
// InviteStaffPage - one email, a role set, one callable.
//
// The createInvitation callable mints the token, stores the admin-readable
// summary and sends the email; this form only gathers a valid address and at
// least one role. Success swaps the form for a confirmation with the two
// onward paths (invite another, back to the directory). Presented as one
// centred Card so the single task sits in the middle of a wide screen.
// ============================================================================

import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { ORG_ROLES } from '../../types';
import type {
  CreateInvitationInput,
  CreateInvitationResult,
  OrgRole,
  OrgRoleSet,
} from '../../types';
import { isWithinLimit } from '../billing/entitlements';
import { useEntitlements } from '../billing/useEntitlements';
import { UpsellNotice } from '../billing/UpsellNotice';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { InvitationSummary } from '../../types';
import { countPendingStaffInvites } from './inviteSeats';
import { Card } from '../ui/Card';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { ROLE_LABELS } from './shared';
import styles from './InviteStaffPage.module.css';

/** Deliberately simple: something@something.something. Deeper validity is the
 *  mail system's problem; this catches the typo class a form can catch. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteStaffPage() {
  const create = useCallable<CreateInvitationInput, CreateInvitationResult>(
    'createInvitation',
  );
  // Read before any conditional return below (rules of hooks); the gate that
  // consumes it sits after the sent-confirmation branch.
  const billing = useEntitlements();
  // The org's invitation summaries (same admin-read node - and cache entry -
  // the staff directory lists), so the gate can count pending invites as the
  // reserved seats the server treats them as.
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const invitations = useRtdbQuery<Record<string, InvitationSummary> | null>({
    key: keys.orgInvitations(orgId),
    path: paths ? paths.db.orgInvitations(orgId) : '',
    enabled: Boolean(claims && paths),
  });
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<OrgRoleSet>({});
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const toggleRole = (role: OrgRole, checked: boolean) => {
    setRoles((current) => {
      const next: OrgRoleSet = { ...current };
      if (checked) {
        next[role] = true;
      } else {
        delete next[role];
      }
      return next;
    });
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setFieldError('Enter a valid email address.');
      return;
    }
    if (!ORG_ROLES.some((role) => roles[role])) {
      setFieldError('Choose at least one role.');
      return;
    }
    setFieldError(null);
    const result = await create.call({ email: trimmed, roles });
    if (result) {
      setSentTo(trimmed);
    }
  };

  const reset = () => {
    setEmail('');
    setRoles({});
    setFieldError(null);
    setSentTo(null);
    create.clearError();
  };

  if (sentTo) {
    return (
      <div className={styles.root}>
        <PageHeader
          title="Invitation sent"
          crumbs={[{ label: 'Staff', to: '/app/staff' }, { label: 'Invite' }]}
        />
        <Card>
          <div className={styles.body}>
            <p role="status" className={styles.successCopy}>
              Invitation sent to <strong>{sentTo}</strong>.
            </p>
            <p className={styles.note}>
              The invitation expires in 7 days. If it lapses, you can resend it
              from the staff directory.
            </p>
            <div className={styles.actions}>
              <Button onClick={reset}>Invite another</Button>
              <Button variant="secondary" to="/app/staff">
                Back to staff
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // Entitlement gate for the direct-URL route (the directory already swaps its
  // button): at the plan's staff ceiling the form gives way to the upsell
  // notice, so nobody fills in a form the server would reject. Presentation
  // only - createInvitation enforces the same limit. The sent confirmation
  // above stays reachable even if THAT invitation was the one that hit the
  // ceiling.
  const staffAtLimit =
    !billing.loading &&
    !isWithinLimit(
      billing.entitlements.limits.orgStaff,
      // Occupied seats PLUS pending invites - the server's arithmetic, so the
      // form never invites into a seat an outstanding invitation has reserved.
      (billing.usage?.staffCount ?? 0) +
        countPendingStaffInvites(invitations.data, Date.now()),
    );
  if (staffAtLimit) {
    const limit = billing.entitlements.limits.orgStaff;
    return (
      <div className={styles.root}>
        <PageHeader
          title="Invite staff"
          crumbs={[{ label: 'Staff', to: '/app/staff' }, { label: 'Invite' }]}
        />
        <UpsellNotice
          message={
            billing.entitlements.suspended
              ? 'Your subscription has ended, so staff invitations are paused. Your existing staff are unaffected.'
              : billing.plan
                ? `You're on ${billing.plan.name} (${limit} staff included). Upgrade to invite more staff.`
                : `Your plan includes ${limit} staff members. Upgrade to invite more.`
          }
          isAdmin={billing.isAdmin}
        />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <PageHeader
        title="Invite staff"
        lede="They will receive an email with a link to join your organisation."
        crumbs={[{ label: 'Staff', to: '/app/staff' }, { label: 'Invite' }]}
      />
      <Card>
        <form
          className={styles.body}
          onSubmit={(event) => void onSubmit(event)}
          noValidate
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor="invite-email">
              Email address
            </label>
            <input
              id="invite-email"
              className={styles.input}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <fieldset className={styles.roleFieldset}>
            <legend className={styles.legend}>Roles</legend>
            <div className={styles.roleGrid}>
              {ORG_ROLES.map((role) => (
                <label
                  key={role}
                  className={styles.roleOption}
                  htmlFor={`invite-role-${role}`}
                >
                  <input
                    id={`invite-role-${role}`}
                    type="checkbox"
                    checked={roles[role] === true}
                    onChange={(event) => toggleRole(role, event.target.checked)}
                  />
                  <span>{ROLE_LABELS[role]}</span>
                </label>
              ))}
            </div>
            <p className={styles.note}>
              Choose at least one. Roles can be changed later from the directory.
            </p>
          </fieldset>

          {fieldError && <ErrorNotice message={fieldError} />}
          {create.error && <ErrorNotice message={create.error} />}

          <p className={styles.note}>
            The invitation expires in 7 days and can be resent from the staff
            directory.
          </p>

          <Button type="submit" disabled={create.pending}>
            {create.pending ? 'Sending invitation' : 'Send invitation'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
