// ============================================================================
// Settings > Billing tests: the operator-managed posture (no self-serve
// controls rendered at all), the pending-downgrade note, the two-step cancel
// confirm actually reaching the callable, and the invoice table's rendering of
// amounts and statuses. Module boundaries mocked as in billing.test.tsx;
// Stripe.js is mocked to "not configured" so no dialog or script load is ever
// attempted here - the card-update flow's client secret plumbing is exercised
// through the callable handles.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { InvoiceSummary, Plan } from '../../types';

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
  entitlements: {
    entitlements: { limits: {}, features: {}, suspended: false } as unknown,
    plan: undefined as unknown,
    subscription: undefined as unknown,
    usage: undefined as unknown,
    loading: false,
    isAdmin: true,
  },
  // One handle per callable name, so a test can assert exactly which callable
  // a control reached and with what payload.
  callables: {} as Record<
    string,
    { call: ReturnType<typeof vi.fn>; pending: boolean; error: string | null }
  >,
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

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
  useCallable: (name: string) => {
    const handle = mocks.callables[name] ?? {
      call: vi.fn(async () => null),
      pending: false,
      error: null,
    };
    return { ...handle, failure: null, clearError: vi.fn() };
  },
}));

vi.mock('./useEntitlements', () => ({
  useEntitlements: () => mocks.entitlements,
}));

// "Not configured": the page renders its calm notice and never opens a Stripe
// dialog, so these tests exercise everything except Stripe's own iframe.
vi.mock('./stripeClient', () => ({
  loadStripeForEnv: vi.fn(async () => null),
}));

import { BillingSettingsPage } from './BillingSettingsPage';

const adminClaims = { orgId: 'org-1', roles: { admin: true }, environment: 'test' };

function makePlan(name: string, pence: number, order: number): Plan {
  return {
    name,
    stripePriceId: `price_${name.toLowerCase()}_test`,
    priceMonthlyPence: pence,
    currency: 'gbp',
    features: { branding: false, emailTemplates: false, prioritySupport: false },
    limits: {
      orgStaff: 5 * order,
      customers: 10 * order,
      notificationsPerMonth: 100 * order,
      assessmentTemplates: 2 * order,
    },
    order,
  };
}

const catalogue = {
  bronze: makePlan('Bronze', 4900, 1),
  silver: makePlan('Silver', 9900, 2),
  gold: makePlan('Gold', 19900, 3),
};

// 1 September 2026 UTC - the renewal date every dated assertion reads back.
const PERIOD_END = Date.UTC(2026, 8, 1);

/** A self-serve subscription in good standing; tests override fields. */
function selfServeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    planId: 'gold',
    status: 'active',
    currentPeriodEnd: PERIOD_END,
    ...overrides,
  };
}

function handle(result: unknown = null) {
  return { call: vi.fn(async () => result), pending: false, error: null as string | null };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <BillingSettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv('test');
  mocks.rtdb = { platformPlans: catalogue };
  mocks.entitlements = {
    entitlements: { limits: {}, features: {}, suspended: false },
    plan: catalogue.gold,
    subscription: selfServeSubscription(),
    usage: { staffCount: 3, customerCount: 4, notificationsThisMonth: 2 },
    loading: false,
    isAdmin: true,
  };
  mocks.callables = {
    getBillingState: handle({}),
    changeSubscription: handle(null),
    cancelSubscription: handle(null),
    resubscribe: handle(null),
    createCardUpdateIntent: handle(null),
    listInvoices: handle({ invoices: [], hasMore: false }),
  };
});

describe('BillingSettingsPage', () => {
  it('shows only the operator-managed card when there is no Stripe subscription', async () => {
    mocks.entitlements.subscription = { planId: 'gold' };
    renderPage();
    expect(
      screen.getByText(/subscription is managed by Safentia/),
    ).toBeInTheDocument();
    // Nothing billing-mutating renders: no plan matrix, no cancel, no card
    // update, no invoices - and no billing callables are asked for anything.
    expect(screen.queryByText('Change plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel subscription')).not.toBeInTheDocument();
    expect(screen.queryByText('Update card')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
    expect(mocks.callables.listInvoices.call).not.toHaveBeenCalled();
    expect(mocks.callables.getBillingState.call).not.toHaveBeenCalled();
  });

  it('renders the pending-downgrade note with the target plan name and date', async () => {
    mocks.entitlements.subscription = selfServeSubscription({
      pendingPlanId: 'silver',
    });
    renderPage();
    expect(
      await screen.findByText('Changes to Silver on 1 September 2026.'),
    ).toBeInTheDocument();
  });

  it('cancels only through the two-step confirm, then calls the callable', async () => {
    mocks.callables.cancelSubscription = handle({
      cancelAtPeriodEnd: true,
      periodEnd: PERIOD_END,
    });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    // First press arms the confirm; nothing has been sent yet.
    expect(mocks.callables.cancelSubscription.call).not.toHaveBeenCalled();
    expect(
      screen.getByText('Cancel your subscription from 1 September 2026?'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(mocks.callables.cancelSubscription.call).toHaveBeenCalledWith({
      orgId: 'org-1',
    });
    expect(
      await screen.findByText(
        'Your subscription is scheduled to end on 1 September 2026. You can resume it at any time before then.',
      ),
    ).toBeInTheDocument();
  });

  it('renders invoices with pounds amounts, worded statuses and the hosted link', async () => {
    const invoices: InvoiceSummary[] = [
      {
        id: 'in_1',
        number: 'SAF-0001',
        created: Date.UTC(2026, 7, 1),
        amountPence: 4900,
        currency: 'gbp',
        status: 'paid',
        hostedInvoiceUrl: 'https://invoice.stripe.com/i/in_1',
      },
      {
        id: 'in_2',
        number: 'SAF-0002',
        created: Date.UTC(2026, 8, 1),
        amountPence: 9950,
        currency: 'gbp',
        status: 'open',
      },
    ];
    mocks.callables.listInvoices = handle({ invoices, hasMore: false });
    renderPage();

    expect(await screen.findByText('SAF-0001')).toBeInTheDocument();
    expect(mocks.callables.listInvoices.call).toHaveBeenCalledWith({
      orgId: 'org-1',
      limit: 12,
    });
    expect(screen.getByText('£49.00')).toBeInTheDocument();
    expect(screen.getByText('£99.50')).toBeInTheDocument();
    // Status is a word, never colour alone.
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'View' });
    expect(link).toHaveAttribute('href', 'https://invoice.stripe.com/i/in_1');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('says "No invoices yet." when the history is empty', async () => {
    renderPage();
    expect(await screen.findByText('No invoices yet.')).toBeInTheDocument();
  });

  it('swaps to the restart card for a canceled subscription (SEV-1 way back)', async () => {
    mocks.entitlements.subscription = selfServeSubscription({ status: 'canceled' });
    renderPage();

    expect(screen.getByText('Restart your subscription')).toBeInTheDocument();
    // The plan matrix is offered per tier while Stripe.js loads...
    expect(screen.getByText('Restart on Bronze')).toBeInTheDocument();
    expect(screen.getByText('Restart on Gold')).toBeInTheDocument();
    // ...then this suite's "not configured" Stripe resolves null and the card
    // degrades to its calm notice (same posture as the payment-method card).
    expect(
      await screen.findByText(/Restarting is not available just yet/),
    ).toBeInTheDocument();
    // Every management control for a live subscription is gone - the
    // dead subscription cannot be changed, cancelled or paid for.
    expect(screen.queryByText('Change plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel subscription')).not.toBeInTheDocument();
    expect(screen.queryByText('Update card')).not.toBeInTheDocument();
    // The invoice history remains - it is the org's record either way.
    expect(screen.getByText('Invoices')).toBeInTheDocument();
  });

  it('also shows the restart card for an incomplete restart still awaiting payment', () => {
    mocks.entitlements.subscription = selfServeSubscription({ status: 'incomplete' });
    renderPage();
    expect(screen.getByText('Restart your subscription')).toBeInTheDocument();
    expect(screen.queryByText('Change plan')).not.toBeInTheDocument();
  });

  it('tells a suspended (unpaid) org to pay the outstanding invoice, not that it renews', async () => {
    mocks.entitlements.subscription = selfServeSubscription({
      status: 'unpaid',
      paymentState: 'past_due',
    });
    renderPage();

    expect(
      screen.getByText(/your subscription is paused/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/pay your outstanding invoice from the payment method section/i),
    ).toBeInTheDocument();
    // The suspension line REPLACES the renewal date and the softer dunning
    // nudge - an unpaid org is not renewing and not merely in grace.
    expect(screen.queryByText(/^Renews on/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/continues unchanged/),
    ).not.toBeInTheDocument();
    // The management cards stay: the subscription is suspended, not dead.
    expect(screen.getByText('Change plan')).toBeInTheDocument();
  });
});
