// ============================================================================
// Staff area shared primitives: the role/status vocabulary, the tiny role-set
// helpers, and the two presentational badges (RoleChips, StatusBadge) that the
// directory and a member's profile both render. One definition each, so a
// member reads identically whether you meet them in the list or on their page.
//
// The route URLs live here too (staffUrls), the same single-source idiom as
// jobUrls: the directory rows, the profile breadcrumbs and global search all
// address a member's page through this one builder, so a link can never point
// somewhere the router does not.
// ============================================================================

import { ORG_ROLES } from '../../types';
import type { MemberStatus, OrgRole, OrgRoleSet } from '../../types';
import styles from './shared.module.css';

/** The staff area's router URLs. */
export const staffUrls = {
  staff: '/app/staff',
  invite: '/app/staff/invite',
  profile: (memberUid: string) => `/app/staff/${memberUid}`,
} as const;

/** Human labels for the role keys - the API vocabulary never reaches the eye. */
export const ROLE_LABELS: Record<OrgRole, string> = {
  admin: 'Administrator',
  assessor: 'Assessor',
  auditor: 'Auditor',
  finance: 'Finance',
  viewer: 'Viewer',
};

export const STATUS_LABELS: Record<MemberStatus, string> = {
  active: 'Active',
  locked: 'Locked',
  archived: 'Archived',
};

const STATUS_CLASS: Record<MemberStatus, string> = {
  active: styles.statusActive,
  locked: styles.statusLocked,
  archived: styles.statusArchived,
};

/** British short date, e.g. "14 Jun 2026". */
export function britishDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// Tolerates a record with no `roles` object at all. The type says roles is
// required, but a malformed or part-provisioned record can omit it, and the
// directory (and a profile) must render such a member as no roles rather than
// crash the page.
export function roleList(roles: OrgRoleSet | undefined): OrgRole[] {
  if (!roles) {
    return [];
  }
  return ORG_ROLES.filter((role) => roles[role] === true);
}

export function RoleChips({
  roles,
  label,
}: {
  roles: OrgRoleSet | undefined;
  label: string;
}) {
  return (
    <ul className={styles.chipList} aria-label={label}>
      {roleList(roles).map((role) => (
        <li key={role} className={styles.roleChip}>
          {ROLE_LABELS[role]}
        </li>
      ))}
    </ul>
  );
}

export function StatusBadge({ status }: { status: MemberStatus }) {
  return (
    <span className={`${styles.statusBadge} ${STATUS_CLASS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
