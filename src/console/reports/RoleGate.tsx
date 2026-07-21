// ============================================================================
// RoleGate - the staff area's AdminGate pattern, generalised to a role list.
//
// Lives in reports/ (its only consumer today) rather than the shared kit: a
// primitive earns a kit place by its second consumer, not its first. Like the
// admin gate it is presentation only - the real boundary is the database rules
// and each callable's own role check - so the refusal is calm, not alarmed.
// ============================================================================

import React from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState } from '../ui/Page';
import type { OrgRole } from '../../types';

export function RoleGate({
  roles,
  children,
}: {
  /** Any ONE of these roles admits the member. */
  roles: readonly OrgRole[];
  children: React.ReactNode;
}) {
  const { claims } = useAuth();
  const allowed = roles.some((role) => claims?.roles[role] === true);
  if (!allowed) {
    return (
      <EmptyState
        title="Finance or administrator access required"
        body="You need finance or administrator access for this area. If you believe you should have it, ask an administrator at your organisation."
      />
    );
  }
  return <>{children}</>;
}
