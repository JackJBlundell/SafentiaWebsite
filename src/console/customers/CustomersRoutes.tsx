// ============================================================================
// CustomersRoutes - the routing table for the customer -> site -> building
// hierarchy, mounted by ConsoleShell at /app/customers/*.
//
// Creation flows are WIZARDS (CustomerWizard here; SiteWizard/BuildingWizard
// are code-split siblings); the plain forms remain for edits. Reading is open
// to every org role; every mutating route is wrapped in AdminGate so a direct
// URL as a viewer or auditor lands on the calm no-access panel rather than a
// form that would fail on submit. BuildingDetail and the site/building wizards
// are code-split: nothing else pays for their weight up front.
// ============================================================================

import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CustomersList } from './CustomersList';
import { CustomerForm } from './CustomerForm';
import { CustomerDetail } from './CustomerDetail';
import { CustomerWizard } from './CustomerWizard';
import { SiteForm } from './SiteForm';
import { SiteDetail } from './SiteDetail';
import { BuildingForm } from './BuildingForm';
import { LoadingNote, NoAccessPanel, useOrgScope } from './shared';

const BuildingDetail = lazy(() =>
  import('./BuildingDetail').then((module) => ({
    default: module.BuildingDetail,
  })),
);
const SiteWizard = lazy(() =>
  import('./SiteWizard').then((module) => ({ default: module.SiteWizard })),
);
const BuildingWizard = lazy(() =>
  import('./BuildingWizard').then((module) => ({
    default: module.BuildingWizard,
  })),
);

/** Renders its child only for admins; everyone else sees the no-access panel.
 *  Nothing renders until claims resolve, so a slow token never flashes a form
 *  at someone who is not allowed to use it. */
function AdminGate({ children }: { children: ReactNode }) {
  const { ready, isAdmin } = useOrgScope();
  if (!ready) {
    return null;
  }
  return isAdmin ? <>{children}</> : <NoAccessPanel />;
}

export function CustomersRoutes() {
  return (
    <Routes>
      <Route index element={<CustomersList />} />
      <Route
        path="new"
        element={
          <AdminGate>
            <CustomerWizard />
          </AdminGate>
        }
      />
      <Route path=":customerId" element={<CustomerDetail />} />
      <Route
        path=":customerId/edit"
        element={
          <AdminGate>
            <CustomerForm />
          </AdminGate>
        }
      />
      <Route
        path=":customerId/sites/new"
        element={
          <AdminGate>
            <Suspense fallback={<LoadingNote>Loading</LoadingNote>}>
              <SiteWizard />
            </Suspense>
          </AdminGate>
        }
      />
      <Route path=":customerId/sites/:siteId" element={<SiteDetail />} />
      <Route
        path=":customerId/sites/:siteId/edit"
        element={
          <AdminGate>
            <SiteForm mode="edit" />
          </AdminGate>
        }
      />
      <Route
        path=":customerId/sites/:siteId/buildings/new"
        element={
          <AdminGate>
            <Suspense fallback={<LoadingNote>Loading</LoadingNote>}>
              <BuildingWizard />
            </Suspense>
          </AdminGate>
        }
      />
      <Route
        path=":customerId/sites/:siteId/buildings/:buildingId"
        element={
          <Suspense fallback={<LoadingNote>Loading building</LoadingNote>}>
            <BuildingDetail />
          </Suspense>
        }
      />
      <Route
        path=":customerId/sites/:siteId/buildings/:buildingId/edit"
        element={
          <AdminGate>
            <BuildingForm mode="edit" />
          </AdminGate>
        }
      />
      {/* Any unknown suffix lands back on the list, not a dead panel. */}
      <Route path="*" element={<Navigate to="." replace />} />
    </Routes>
  );
}
