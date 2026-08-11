// ============================================================================
// Billing UI gating tests: useEntitlements' resolution branches (grandfather,
// plan limits, suspended, the non-admin degradation) and one rendered gate
// (branding locked on the organisation settings page). Module boundaries
// mocked as in settings.test.tsx; the pure resolution arithmetic itself is
// covered by the entitlements module's own unit tests.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { OrgProfile, Plan } from '../../types';

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: { uid: 'admin-1', email: 'admin@example.com' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
    refreshSession: vi.fn(async () => undefined),
    signOut: vi.fn(),
  },
  rtdb: {} as Record<string, unknown>,
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

// Keyed by the key's root segment, honouring `enabled` exactly as the real
// bridge does: a gated-off read (the non-admin subscription path) yields no
// data, which is the degradation the hook under test must absorb.
vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({
    key,
    enabled = true,
  }: {
    key: readonly (string | number)[];
    enabled?: boolean;
  }) => ({
    data: enabled ? mocks.rtdb[String(key[0])] : undefined,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../ui/useCallable', () => ({
  useCallable: () => ({
    call: vi.fn(),
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import { useEntitlements } from './useEntitlements';
import { isNearLimit } from './entitlements';
import { BillingBanner } from './BillingBanner';
import { OrganisationSettingsPage } from '../settings/OrganisationSettingsPage';

const adminClaims = { orgId: 'org-1', roles: { admin: true }, environment: 'test' };

const bronze: Plan = {
  name: 'Bronze',
  stripePriceId: 'price_bronze_test',
  priceMonthlyPence: 4900,
  currency: 'gbp',
  features: { branding: false, emailTemplates: false, prioritySupport: false },
  limits: {
    orgStaff: 5,
    customers: 10,
    notificationsPerMonth: 100,
    assessmentTemplates: 2,
  },
  order: 1,
};

const profile: OrgProfile = {
  name: 'Acme Fire Safety',
  brand: { primary: '#1a5fb4', secondary: '#26a269' },
  contact: { email: 'office@acme.example' },
};

beforeEach(() => {
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv('test');
  mocks.rtdb = {};
});

describe('useEntitlements resolution', () => {
  it('grandfathers an organisation with no subscription: unlimited, features on', () => {
    mocks.rtdb = { orgSubscription: null, orgUsage: null };
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.entitlements.limits.orgStaff).toBe(-1);
    expect(result.current.entitlements.features.branding).toBe(true);
    expect(result.current.entitlements.suspended).toBe(false);
    expect(result.current.subscription).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it('resolves an active subscription to its plan limits and features', () => {
    mocks.rtdb = {
      orgSubscription: { planId: 'bronze', status: 'active' },
      platformPlans: bronze,
      orgUsage: { staffCount: 5, customerCount: 3, notificationsThisMonth: 2 },
    };
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.entitlements.limits.orgStaff).toBe(5);
    expect(result.current.entitlements.limits.assessmentTemplates).toBe(2);
    expect(result.current.entitlements.features.branding).toBe(false);
    expect(result.current.entitlements.suspended).toBe(false);
    expect(result.current.plan?.name).toBe('Bronze');
    expect(result.current.usage?.staffCount).toBe(5);
  });

  it('drops a terminally dead subscription to the suspended zero-create floor', () => {
    mocks.rtdb = {
      orgSubscription: { planId: 'bronze', status: 'unpaid' },
      platformPlans: bronze,
      orgUsage: { staffCount: 1, customerCount: 0, notificationsThisMonth: 0 },
    };
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.entitlements.suspended).toBe(true);
    expect(result.current.entitlements.limits.customers).toBe(0);
    expect(result.current.entitlements.features.emailTemplates).toBe(false);
  });

  it('degrades to the grandfather posture for a non-admin who cannot read the subscription', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { assessor: true }, environment: 'test' };
    // The node EXISTS - the mock honours `enabled`, so the gated-off read never
    // sees it, exactly like the rules denial the gating avoids.
    mocks.rtdb = {
      orgSubscription: { planId: 'bronze', status: 'unpaid' },
      platformPlans: bronze,
    };
    const { result } = renderHook(() => useEntitlements());
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.subscription).toBeUndefined();
    expect(result.current.entitlements.limits.orgStaff).toBe(-1);
    expect(result.current.entitlements.features.branding).toBe(true);
    expect(result.current.loading).toBe(false);
  });
});

describe('isNearLimit (approaching-limit nudge threshold)', () => {
  it('fires at >=80% of a finite ceiling but below it', () => {
    // Limit 10: 80% is 8, so 8 and 9 nudge; 7 does not; 10 is the wall.
    expect(isNearLimit(10, 7)).toBe(false);
    expect(isNearLimit(10, 8)).toBe(true);
    expect(isNearLimit(10, 9)).toBe(true);
    expect(isNearLimit(10, 10)).toBe(false);
    expect(isNearLimit(10, 11)).toBe(false);
  });

  it('handles a small ceiling where 80% is exact', () => {
    // Limit 5: 80% is exactly 4.
    expect(isNearLimit(5, 3)).toBe(false);
    expect(isNearLimit(5, 4)).toBe(true);
    expect(isNearLimit(5, 5)).toBe(false);
  });

  it('never fires for unlimited (-1) or the suspended zero-create floor (0)', () => {
    expect(isNearLimit(-1, 1000)).toBe(false);
    expect(isNearLimit(0, 0)).toBe(false);
    expect(isNearLimit(0, 1)).toBe(false);
  });
});

describe('BillingBanner', () => {
  function renderBanner() {
    return render(
      <MemoryRouter>
        <BillingBanner />
      </MemoryRouter>,
    );
  }

  it('shows the admin reactivation banner for a suspended subscription', () => {
    mocks.rtdb = {
      orgSubscription: { stripeSubscriptionId: 'sub_1', planId: 'bronze', status: 'unpaid' },
      platformPlans: bronze,
      orgUsage: { staffCount: 1, customerCount: 0, notificationsThisMonth: 0 },
    };
    renderBanner();
    expect(
      screen.getByText(/creating new work is paused/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Reactivate your subscription' }),
    ).toBeInTheDocument();
  });

  it('shows the read-only member variant from the profile.suspended mirror (SEV-1 fix 3)', () => {
    // A non-admin cannot read the subscription node (rules, by design) - the
    // member-readable profile mirror is their only, and sufficient, signal.
    mocks.auth.claims = { orgId: 'org-1', roles: { assessor: true }, environment: 'test' };
    mocks.rtdb = {
      orgProfile: { ...profile, suspended: true },
      orgSubscription: { planId: 'bronze', status: 'unpaid' },
    };
    renderBanner();
    expect(
      screen.getByText(/ask your administrator/i),
    ).toBeInTheDocument();
    // Read-only: no reactivation link - billing is not theirs to act on.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing for a member of a healthy organisation', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { assessor: true }, environment: 'test' };
    mocks.rtdb = { orgProfile: profile };
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('branding gate', () => {
  it('locks the brand controls behind the upsell when the plan lacks branding', () => {
    mocks.rtdb = {
      orgProfile: profile,
      orgSubscription: { planId: 'bronze', status: 'active' },
      platformPlans: bronze,
      orgUsage: { staffCount: 1, customerCount: 0, notificationsThisMonth: 0 },
    };
    render(
      <MemoryRouter>
        <OrganisationSettingsPage />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/Custom branding isn't included in your current plan/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute(
      'href',
      '/app/settings/billing',
    );
    // The disabled fieldset locks the brand inputs (§6.3 visible-but-locked)...
    expect(screen.getByLabelText('Primary colour')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose logo' })).toBeDisabled();
    // ...while the rest of the profile form stays fully editable.
    expect(screen.getByLabelText('Organisation name')).toBeEnabled();
  });

  it('leaves the brand controls editable when the feature is included', () => {
    mocks.rtdb = {
      orgProfile: profile,
      orgSubscription: {
        planId: 'gold',
        status: 'active',
      },
      platformPlans: { ...bronze, name: 'Gold', features: { ...bronze.features, branding: true } },
      orgUsage: { staffCount: 1, customerCount: 0, notificationsThisMonth: 0 },
    };
    render(
      <MemoryRouter>
        <OrganisationSettingsPage />
      </MemoryRouter>,
    );
    expect(
      screen.queryByText(/Custom branding isn't included/),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Primary colour')).toBeEnabled();
  });
});
