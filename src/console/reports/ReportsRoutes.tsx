// ============================================================================
// ReportsRoutes - the reporting area's router (story 2040, FR-E19).
//
// The whole area is finance-or-admin: the shell already hides the nav item
// from other roles, and this gate covers the direct-URL case.
// ============================================================================

import { Navigate, Route, Routes } from 'react-router-dom';
import { RoleGate } from './RoleGate';
import { ReportsPage } from './ReportsPage';
import type { OrgRole } from '../../types';

/** The roles this area admits; the shell's nav entry lists the same pair. */
export const REPORTS_ROLES: readonly OrgRole[] = ['finance', 'admin'];

export function ReportsRoutes() {
  return (
    <RoleGate roles={REPORTS_ROLES}>
      <Routes>
        <Route index element={<ReportsPage />} />
        <Route path="*" element={<Navigate to="." replace />} />
      </Routes>
    </RoleGate>
  );
}
