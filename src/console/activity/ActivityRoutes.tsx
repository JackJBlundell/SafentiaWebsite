// ============================================================================
// ActivityRoutes - the mount point for the organisation activity area (story
// 2062). The shell mounts this once at /app/activity/*; routing detail below
// that stays private to this directory.
//
// The area is the audit trail alone. The email send log lived here as an
// admin-only sub-tab until the Emails area (section 6b) gave it a home of its
// own at /app/emails; the old /app/activity/emails URL redirects there so
// bookmarks and stale links land correctly (EmailsRoutes carries the admin
// gate the tab had here).
// ============================================================================

import { Navigate, Route, Routes } from 'react-router-dom';
import { ActivityPage } from './ActivityPage';

export function ActivityRoutes() {
  return (
    <Routes>
      <Route index element={<ActivityPage />} />
      <Route path="emails" element={<Navigate to="/app/emails" replace />} />
    </Routes>
  );
}
