// ============================================================================
// StaffDirectory - the organisation's members, live, as a linked list.
//
// The directory is now master/detail: each row navigates to the member's own
// profile (/app/staff/:uid), where their history AND their role/status
// management live. The directory itself carries only what is ORG-level rather
// than per-member - the search/filter controls and the pending-invitations
// section - so it stays a clean, scannable index.
//
// Reads are live listeners (useRtdbQuery). The invitation mutations still run
// here (resend/revoke are properties of an invitation, not of a member) through
// their callables, applied by the listener rather than optimistically, with any
// destructive step behind an inline confirm.
// ============================================================================

import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { ORG_ROLES } from '../../types';
import type {
  InvitationSummary,
  OrgMember,
  OrgRole,
  ResendInvitationInput,
  ResendInvitationResult,
  RevokeInvitationInput,
  RevokeInvitationResult,
} from '../../types';
import { isNearLimit, isWithinLimit } from '../billing/entitlements';
import { countPendingStaffInvites } from './inviteSeats';
import { useEntitlements } from '../billing/useEntitlements';
import { LimitNudge } from '../billing/LimitNudge';
import { UpsellNotice } from '../billing/UpsellNotice';
import { Card, CardHeader } from '../ui/Card';
import { DataTable } from '../ui/DataTable';
import { PageGrid, Toolbar, ToolbarGroup } from '../ui/Grid';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import {
  ROLE_LABELS,
  RoleChips,
  StatusBadge,
  britishDate,
  staffUrls,
} from './shared';
import styles from './StaffDirectory.module.css';

type MemberRow = { uid: string; member: OrgMember };

/** 'all' or one of the five org roles; the select's options are generated from
 *  ORG_ROLES so a new role can never be missed here. */
type RoleFilter = 'all' | OrgRole;

export function StaffDirectory() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(claims && paths);

  const members = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled,
  });
  const invitations = useRtdbQuery<Record<string, InvitationSummary> | null>({
    key: keys.orgInvitations(orgId),
    path: paths ? paths.db.orgInvitations(orgId) : '',
    enabled,
  });

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [showArchived, setShowArchived] = useState(false);

  const rows = useMemo<MemberRow[]>(() => {
    const all = Object.entries(members.data ?? {}).map(([uid, member]) => ({
      uid,
      member,
    }));
    const needle = search.trim().toLowerCase();
    return all
      .filter(({ member }) => showArchived || member.status !== 'archived')
      // The role filter combines with search and the archived toggle (story
      // 2013): each narrows independently.
      .filter(
        ({ member }) => roleFilter === 'all' || member.roles?.[roleFilter] === true,
      )
      .filter(
        ({ member }) =>
          needle.length === 0 ||
          member.name.toLowerCase().includes(needle) ||
          member.email.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.member.name.localeCompare(b.member.name));
  }, [members.data, search, roleFilter, showArchived]);

  // Entitlement gate (presentation only - createInvitation enforces the same
  // limit server-side): at the plan's staff ceiling the invite button gives
  // way to the calm upsell notice (§6.3 - block new creates, hide nothing).
  // While the billing reads attach, the button shows as normal.
  const billing = useEntitlements();
  const staffLimit = billing.entitlements.limits.orgStaff;
  // Occupied seats PLUS pending invites (the server's arithmetic - a pending
  // invitation is a seat already promised, counted once via inviteSeats so the
  // gate and the nudge never recompute it two different ways), so the button
  // never looks open when createInvitation would refuse.
  const staffUsed =
    (billing.usage?.staffCount ?? 0) +
    countPendingStaffInvites(invitations.data, Date.now());
  const staffAtLimit =
    !billing.loading && !isWithinLimit(staffLimit, staffUsed);
  // The earlier, calmer nudge (assessment MEDIUM 20): >=80% of a finite ceiling
  // but not yet at it, so it never renders beside the at-limit UpsellNotice.
  const staffNearLimit =
    !billing.loading && !staffAtLimit && isNearLimit(staffLimit, staffUsed);
  const staffGateMessage = billing.entitlements.suspended
    ? 'Your subscription has ended, so staff invitations are paused. Your existing staff are unaffected.'
    : billing.plan
      ? `You're on ${billing.plan.name} (${staffLimit} staff included). Upgrade to invite more staff.`
      : `Your plan includes ${staffLimit} staff members. Upgrade to invite more.`;

  const archivedCount = useMemo(
    () =>
      Object.values(members.data ?? {}).filter((m) => m.status === 'archived')
        .length,
    [members.data],
  );

  return (
    <div>
      <PageHeader
        title="Staff"
        lede="Everyone at your organisation with access to Safentia. Open a member to see their history and manage their roles; locking or archiving takes effect on their next token refresh."
      />

      {members.isError && (
        <ErrorNotice message="Could not load the staff directory. Please try again." />
      )}

      <PageGrid>
        <Toolbar>
          <ToolbarGroup>
            <div className={styles.searchField}>
              <label className={styles.label} htmlFor="staff-search">
                Search staff
              </label>
              <input
                id="staff-search"
                type="search"
                className={styles.input}
                placeholder="Name or email"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <div className={styles.searchField}>
              <label className={styles.label} htmlFor="staff-role-filter">
                Role
              </label>
              <select
                id="staff-role-filter"
                className={styles.select}
                value={roleFilter}
                onChange={(event) =>
                  setRoleFilter(event.target.value as RoleFilter)
                }
              >
                <option value="all">All roles</option>
                {ORG_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </div>
            <label className={styles.toggle} htmlFor="show-archived">
              <input
                id="show-archived"
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              <span>
                Show archived{archivedCount > 0 ? ` (${archivedCount})` : ''}
              </span>
            </label>
          </ToolbarGroup>
          <ToolbarGroup push>
            {staffAtLimit ? (
              <UpsellNotice message={staffGateMessage} isAdmin={billing.isAdmin} />
            ) : (
              <Button to={staffUrls.invite}>Invite staff</Button>
            )}
          </ToolbarGroup>
        </Toolbar>

        {staffNearLimit && (
          <LimitNudge
            used={staffUsed}
            limit={staffLimit}
            noun="team members"
            isAdmin={billing.isAdmin}
          />
        )}

        <Card flush>
          <CardHeader title="Members" />
          {rows.length === 0 ? (
            <p className={styles.noRows}>
              {search.trim() || roleFilter !== 'all'
                ? 'No staff match the current filters.'
                : 'No staff to show yet.'}
            </p>
          ) : (
            <DataTable<MemberRow>
              label="Staff members"
              rowHref={({ uid }) => staffUrls.profile(uid)}
              columns={[
                {
                  header: 'Name',
                  cell: ({ member }) => (
                    <span className={styles.identity}>
                      <span className={styles.memberName}>{member.name}</span>
                      <span className={styles.memberEmail}>{member.email}</span>
                    </span>
                  ),
                },
                {
                  header: 'Roles',
                  cell: ({ member }) => (
                    <RoleChips
                      roles={member.roles}
                      label={`Roles for ${member.name}`}
                    />
                  ),
                },
                {
                  header: 'Status',
                  cell: ({ member }) => <StatusBadge status={member.status} />,
                },
              ]}
              rows={rows}
              rowKey={({ uid }) => uid}
            />
          )}
        </Card>

        <PendingInvitations invitations={invitations.data ?? null} />
      </PageGrid>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Pending invitations, beneath the directory. These are org-level (an invite
// belongs to no member yet), so they stay here rather than on a profile.
// ----------------------------------------------------------------------------

const INVITE_STATUS_LABELS: Record<InvitationSummary['status'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  expired: 'Expired',
  revoked: 'Revoked',
};

type InviteRow = { inviteId: string; invite: InvitationSummary };

function PendingInvitations({
  invitations,
}: {
  invitations: Record<string, InvitationSummary> | null;
}) {
  const entries: InviteRow[] = Object.entries(invitations ?? {})
    .map(([inviteId, invite]) => ({ inviteId, invite }))
    .sort((a, b) => b.invite.createdAt - a.invite.createdAt);

  return (
    <Card flush>
      <CardHeader title="Invitations" />
      {entries.length === 0 ? (
        <p className={styles.noRows}>
          No invitations yet. Invite staff and they will appear here until the
          invitation is accepted.
        </p>
      ) : (
        <DataTable<InviteRow>
          label="Invitations"
          columns={[
            {
              header: 'Email',
              cell: ({ invite }) => (
                <span className={styles.memberName}>{invite.email}</span>
              ),
            },
            {
              header: 'Roles',
              cell: ({ invite }) => (
                <RoleChips
                  roles={invite.roles}
                  label={`Invited roles for ${invite.email}`}
                />
              ),
            },
            {
              header: 'Status',
              cell: ({ invite }) => (
                <span
                  className={`${styles.statusBadge} ${
                    invite.status === 'pending'
                      ? styles.statusPending
                      : styles.statusDone
                  }`}
                >
                  {INVITE_STATUS_LABELS[invite.status]}
                </span>
              ),
            },
            {
              header: 'Expires',
              desktopOnly: true,
              cell: ({ invite }) => britishDate(invite.expiresAt),
            },
            {
              header: 'Actions',
              align: 'end',
              width: '1%',
              cell: ({ inviteId, invite }) => (
                <InviteActions key={inviteId} inviteId={inviteId} invite={invite} />
              ),
            },
          ]}
          rows={entries}
          rowKey={({ inviteId }) => inviteId}
        />
      )}
    </Card>
  );
}

function InviteActions({
  inviteId,
  invite,
}: {
  inviteId: string;
  invite: InvitationSummary;
}) {
  const resend = useCallable<ResendInvitationInput, ResendInvitationResult>(
    'resendInvitation',
  );
  const revoke = useCallable<RevokeInvitationInput, RevokeInvitationResult>(
    'revokeInvitation',
  );
  const [resent, setResent] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  // Row-level error discipline: any NEW action on the row first clears the
  // other callable's leftover error, so at most one error is ever set and the
  // notice always describes the most recent action - never a stale failure
  // from a different button sitting beside a fresh success.
  const onResend = async () => {
    setResent(false);
    revoke.clearError();
    const result = await resend.call({ inviteId });
    if (result) {
      setResent(true);
    }
  };

  const onRevoke = async () => {
    setResent(false);
    resend.clearError();
    const result = await revoke.call({ inviteId });
    if (result) {
      setConfirmingRevoke(false);
    }
  };

  const pending = invite.status === 'pending';
  const error = resend.error ?? revoke.error;

  return (
    <div className={styles.cellActions}>
      {pending && !confirmingRevoke && (
        <div className={styles.inviteActions}>
          <Button
            variant="ghost"
            disabled={resend.pending || revoke.pending}
            onClick={() => void onResend()}
          >
            {resend.pending ? 'Resending' : 'Resend'}
          </Button>
          <Button
            variant="ghost"
            disabled={resend.pending || revoke.pending}
            onClick={() => {
              // Opening the revoke confirm is a new row action: clear the
              // previous action's leftovers (same discipline as above).
              setResent(false);
              resend.clearError();
              setConfirmingRevoke(true);
            }}
          >
            Revoke
          </Button>
        </div>
      )}
      {confirmingRevoke && (
        <div className={styles.confirmBox}>
          <p className={styles.confirmCopy}>
            Revoke the invitation to {invite.email}? Their invitation link will
            stop working immediately.
          </p>
          <div className={styles.confirmButtons}>
            <Button disabled={revoke.pending} onClick={() => void onRevoke()}>
              {revoke.pending ? 'Revoking' : 'Revoke invitation'}
            </Button>
            <Button
              variant="ghost"
              disabled={revoke.pending}
              onClick={() => {
                setConfirmingRevoke(false);
                revoke.clearError();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {resent && (
        <p role="status" className={styles.success}>
          Invitation re-sent to {invite.email}. The old link no longer works.
        </p>
      )}
      {error && <ErrorNotice message={error} />}
    </div>
  );
}
