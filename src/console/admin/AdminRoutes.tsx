// ============================================================================
// AdminRoutes - the super-admin oversight console (FR-E24, stories 2067-2070).
//
// READ-ONLY OVERSIGHT OF TENANTS, BY DESIGN: no screen under /app/admin
// mutates a tenant's data. The console exists so the platform operator can see
// the estate - organisations, their size, their recent activity - never act on
// a tenant's behalf; tenant changes belong to the tenant's own admins and
// their audited callables. Every screen restates this. The ONE action here is
// platform-level, not tenant-level: creating a new organisation, which is
// operator-only until Phase 3 self-serve onboarding (the createOrganisation
// callable enforces the same superAdmin claim server-side).
//
// Access is the `superAdmin: true` custom claim (useSuperAdminClaim). The gate
// here is presentation; database.rules.json's superAdmin read cascade is the
// boundary that actually holds.
// ============================================================================

import { Route, Routes } from 'react-router-dom';
import { EmptyState } from '../ui/Page';
import { useSuperAdminClaim } from './useSuperAdminClaim';
import { PlatformDashboard } from './PlatformDashboard';
import { OrgsOverview } from './OrgsOverview';
import { OrgDetail } from './OrgDetail';
import { OrgCustomerDetail } from './OrgCustomerDetail';
import { OrgBuildingDetail } from './OrgBuildingDetail';
import { PlatformActivity } from './PlatformActivity';
import { PlatformMembers } from './PlatformMembers';
import { PlatformBuildings } from './PlatformBuildings';
import { PlatformCustomers } from './PlatformCustomers';
import styles from './admin.module.css';

export function AdminRoutes() {
  const claim = useSuperAdminClaim();

  if (claim === 'loading') {
    return <p className={styles.loadingNote}>Checking access</p>;
  }
  if (claim === 'denied') {
    // Fail closed, calmly: no hint at what lives here beyond its name.
    return (
      <EmptyState
        title="Not available"
        body="This area is restricted to platform operators."
      />
    );
  }

  // Each screen owns its own PageHeader (title, breadcrumbs and any action), so
  // this router is just the map. The environment is no longer a URL segment: it
  // is the one platform-wide choice from the rail toggle (see platformEnv), so
  // every route here is env-less. The landing is the platform dashboard; the
  // organisations table lives one level down at /organisations, and the
  // oversight drill-down runs org -> customer -> building.
  return (
    <Routes>
      <Route index element={<PlatformDashboard />} />
      <Route path="organisations" element={<OrgsOverview />} />
      {/* Static list segments come BEFORE the dynamic ":orgId" route.
          React-router v6 ranks static over dynamic, but keeping them above is
          the readable guarantee that /members, /buildings, /customers and
          /activity are never swallowed by the org drill-down. Org ids are push
          ids, never the literal words, so no real collision exists. */}
      <Route path="members" element={<PlatformMembers />} />
      <Route path="buildings" element={<PlatformBuildings />} />
      <Route path="customers" element={<PlatformCustomers />} />
      <Route path="activity" element={<PlatformActivity />} />
      <Route path=":orgId" element={<OrgDetail />} />
      <Route
        path=":orgId/customers/:customerId"
        element={<OrgCustomerDetail />}
      />
      <Route
        path=":orgId/customers/:customerId/buildings/:siteId/:buildingId"
        element={<OrgBuildingDetail />}
      />
    </Routes>
  );
}
