// ============================================================================
// StaffRoutes - the staff area's router plus its role gates.
//
// The area is split by audience. The directory and the invite flow are org
// administration, so they stay ADMIN-ONLY (the shell hides the nav item from
// non-admins; this gate covers the direct-URL case). A member's PROFILE is a
// colleague's full job/assessment/action history plus - for admins -
// management: a management and OVERSIGHT function, so it opens to
// administrators and auditors ONLY. That is deliberately tighter than the
// /orgMembers read rule (which also admits assessors); an assessor, finance or
// viewer who reaches it by direct URL gets a calm notice rather than a crash.
// The real boundary throughout remains the database rules and each callable's
// own role check; these gates are presentation.
// ============================================================================

import { Route, Routes } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { EmptyState } from '../ui/Page';
import { StaffDirectory } from './StaffDirectory';
import { StaffProfile } from './StaffProfile';
import { InviteStaffPage } from './InviteStaffPage';

const adminGate = (
  <EmptyState
    title="Administrator access required"
    body="You need administrator access for this area. If you believe you should have it, ask an administrator at your organisation."
  />
);

const profileGate = (
  <EmptyState
    title="You do not have access"
    body="Staff profiles are available to administrators and auditors. If you believe you should have access, ask an administrator at your organisation."
  />
);

export function StaffRoutes() {
  const { claims } = useAuth();
  const isAdmin = claims?.roles.admin === true;
  // Oversight function: administrators and auditors ONLY (see the header note).
  const canViewProfile = isAdmin || claims?.roles.auditor === true;

  return (
    <Routes>
      <Route index element={isAdmin ? <StaffDirectory /> : adminGate} />
      <Route path="invite" element={isAdmin ? <InviteStaffPage /> : adminGate} />
      <Route
        path=":memberUid"
        element={canViewProfile ? <StaffProfile /> : profileGate}
      />
    </Routes>
  );
}
