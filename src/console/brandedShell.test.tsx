// ============================================================================
// BrandedShell entitlement gating (Phase 3 §6.3 - assessment M2 fix).
//
// The console chrome must tell the SAME branding story the server enforces:
// applyBrandingEntitlement strips the whitelabel from reports and emails for
// an org whose plan lacks `branding`, so the shell's ThemeProvider must not
// keep painting it either. Pinned here, over mocked shells so only the
// BrandedShell seam runs:
//   - bronze (branding off)            -> default Safentia chrome
//   - silver/gold (branding on)        -> the org's whitelabel
//   - grandfathered (no subscription)  -> keeps its whitelabel
//   - entitlements still loading       -> default (no flash of a brand the
//                                         resolution may immediately retract)
//   - suspended via the member-readable profile mirror -> default, even while
//     the entitlement resolution reads as grandfathered (the non-admin /
//     portal posture, which cannot read the subscription)
//   - PLATFORM MODE (/app/admin)       -> default, whatever the org entitles:
//                                         operator surfaces are never
//                                         whitelabelled.
// Assertions read the --brand-primary custom property ThemeProvider publishes,
// with expectations computed through the same buildTheme the provider uses.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { User } from 'firebase/auth';
import { forEnv } from '../paths';
import type { SessionClaims } from '../auth/claims';
import { buildTheme } from '../design/theme';
import { resolveFontStack } from '../design/tokens/typography';
import type { Entitlements } from './billing/entitlements';

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: null as unknown,
    claims: null as unknown,
    paths: null as unknown,
    emailVerified: true,
  },
  userSpaces: { spaces: [], loading: false, hasMultiple: false },
  superAdmin: 'denied' as string,
  /** What the mocked useRtdbQuery returns - BrandedShell's org profile read is
   *  the only live query once the shells are stubbed. */
  profile: undefined as unknown,
  /** The mocked useEntitlements state the seam gates on. */
  billing: {
    entitlements: {} as Entitlements,
    plan: undefined,
    subscription: undefined,
    usage: undefined,
    loading: false,
    isAdmin: true,
  },
}));

vi.mock('../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn() },
}));
vi.mock('../seo/Seo', () => ({ Seo: () => null }));
vi.mock('../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mocks.auth,
}));
vi.mock('../auth/useUserSpaces', () => ({
  useUserSpaces: () => mocks.userSpaces,
}));
vi.mock('./admin/useSuperAdminClaim', () => ({
  useSuperAdminClaim: () => mocks.superAdmin,
}));
vi.mock('../query/useRtdbQuery', () => ({
  useRtdbQuery: () => ({ data: mocks.profile }),
  subscribeToQuery: vi.fn(() => () => undefined),
}));
vi.mock('./billing/useOnboardingNode', () => ({
  useOnboardingNode: () => ({ data: null, isLoading: false, isError: false }),
}));
vi.mock('./billing/useEntitlements', () => ({
  useEntitlements: () => mocks.billing,
}));
// The shells are stubbed to markers: this suite exercises the theming seam
// AROUND them, and each shell has its own suite.
vi.mock('./ConsoleShell', () => ({
  ConsoleShell: () => <div data-testid="console-shell" />,
}));
vi.mock('./portal/PortalShell', () => ({
  PortalShell: () => <div data-testid="portal-shell" />,
}));

import { Component as ConsoleRoute } from './ConsoleRoute';

const testUser = { uid: 'user-1', email: 'jane@example.com' } as unknown as User;
const testClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

const ORG_BRAND = { primary: '#7a1f1f', secondary: '#0f3057' };

/** The value ThemeProvider publishes for a given (possibly absent) brand, via
 *  the exact builder it uses, so the assertions never hard-code a palette. */
const primaryFor = (brand?: { primary: string; secondary: string }) =>
  buildTheme({
    scheme: 'light',
    reduceMotion: false,
    brand,
    fontFamily: resolveFontStack(undefined),
  }).brand.primary;

const DEFAULT_PRIMARY = primaryFor(undefined);
const ORG_PRIMARY = primaryFor(ORG_BRAND);

const entitled = (branding: boolean): Entitlements => ({
  limits: {
    orgStaff: -1,
    customers: -1,
    notificationsPerMonth: -1,
    assessmentTemplates: -1,
  },
  features: { branding, emailTemplates: branding, prioritySupport: branding },
  suspended: false,
});

function renderConsoleAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/app/*" element={<ConsoleRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

const brandPrimary = () =>
  document.documentElement.style.getPropertyValue('--brand-primary');

beforeEach(() => {
  Object.assign(mocks.auth, {
    status: 'authenticated',
    user: testUser,
    claims: testClaims,
    paths: forEnv('test'),
    emailVerified: true,
  });
  mocks.superAdmin = 'denied';
  mocks.profile = { name: 'Acme Fire', brand: ORG_BRAND };
  mocks.billing.entitlements = entitled(true);
  mocks.billing.loading = false;
  document.documentElement.style.removeProperty('--brand-primary');
  window.sessionStorage.clear();
});

// Sanity for every case below: the two palettes must actually differ, or the
// assertions would vacuously pass.
it('test fixture: the org brand resolves away from the default', () => {
  expect(ORG_PRIMARY).not.toBe(DEFAULT_PRIMARY);
});

describe('BrandedShell branding entitlement', () => {
  it('applies the whitelabel for an entitled (silver/gold) org', async () => {
    renderConsoleAt('/app');
    await screen.findByTestId('console-shell');
    expect(brandPrimary()).toBe(ORG_PRIMARY);
  });

  it('keeps a grandfathered org’s whitelabel (no subscription, features on)', async () => {
    mocks.billing.entitlements = entitled(true);
    mocks.billing.subscription = undefined;
    renderConsoleAt('/app');
    await screen.findByTestId('console-shell');
    expect(brandPrimary()).toBe(ORG_PRIMARY);
  });

  it('renders the default chrome for a bronze org (branding off)', async () => {
    mocks.billing.entitlements = entitled(false);
    renderConsoleAt('/app');
    await screen.findByTestId('console-shell');
    expect(brandPrimary()).toBe(DEFAULT_PRIMARY);
  });

  it('renders the default while the entitlement resolution is loading - no flash of a brand it may retract', async () => {
    mocks.billing.loading = true;
    renderConsoleAt('/app');
    await screen.findByTestId('console-shell');
    expect(brandPrimary()).toBe(DEFAULT_PRIMARY);
  });

  it('drops the whitelabel on the member-readable suspended mirror, whatever the local resolution says', async () => {
    // A non-admin or portal session resolves the grandfather posture (it
    // cannot read the subscription); profile.suspended is its honest signal.
    mocks.profile = { name: 'Acme Fire', brand: ORG_BRAND, suspended: true };
    renderConsoleAt('/app');
    await screen.findByTestId('console-shell');
    expect(brandPrimary()).toBe(DEFAULT_PRIMARY);
  });

  it('forces the default Safentia chrome in platform mode, tenant entitlement notwithstanding', async () => {
    mocks.superAdmin = 'granted';
    renderConsoleAt('/app/admin');
    await screen.findByTestId('console-shell');
    expect(brandPrimary()).toBe(DEFAULT_PRIMARY);
  });
});
