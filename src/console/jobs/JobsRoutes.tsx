// ============================================================================
// JobsRoutes - the routing table for the Jobs area (FR-E17), mounted by
// ConsoleShell at /app/jobs/*. Browsing the board and a job's detail is open to
// every org role (the rules bound what each role can actually read); scheduling
// is admin-only, so the wizard sits behind AdminGate and a direct URL as any
// other role lands on the calm no-access panel.
// ============================================================================

import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { NoAccessPanel, useOrgScope } from '../customers/shared';
import { JobsBoard } from './JobsBoard';
import { JobWizard } from './JobWizard';
import { JobDetail } from './JobDetail';

/** Renders its child only for admins; everyone else sees the no-access panel.
 *  Nothing renders until claims resolve, so a slow token never flashes the
 *  wizard at someone who cannot use it. */
function AdminGate({ children }: { children: ReactNode }) {
  const { ready, isAdmin } = useOrgScope();
  if (!ready) {
    return null;
  }
  return isAdmin ? <>{children}</> : <NoAccessPanel />;
}

export function JobsRoutes() {
  return (
    <Routes>
      <Route index element={<JobsBoard />} />
      <Route
        path="new"
        element={
          <AdminGate>
            <JobWizard />
          </AdminGate>
        }
      />
      <Route path=":jobId" element={<JobDetail />} />
      {/* Any unknown suffix lands back on the board, not a dead panel. */}
      <Route path="*" element={<Navigate to="." replace />} />
    </Routes>
  );
}
