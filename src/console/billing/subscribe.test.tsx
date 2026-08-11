// ============================================================================
// Subscribe-flow tests (Phase 3 §3.1, workstream D1): the pure gate-selection
// rule the ConsoleRoute ladder branches on, the plan matrix (sorted cards,
// display prices, the not-seeded empty state), and the payment page's calm
// not-configured posture when no publishable key is set. Stripe is never
// loaded: the loader module is mocked to resolve null, and the react wrapper
// is stubbed so no test can reach js.stripe.com.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { ThemeProvider } from '../../design/ThemeProvider';
import type { Plan, UserOnboarding } from '../../types';

const mocks = vi.hoisted(() => ({
  plansNode: null as Record<string, Plan> | null,
  loadStripeForEnv: vi.fn(async () => null),
  callResult: undefined as unknown,
  call: vi.fn(async () => mocks.callResult),
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn(), db: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { uid: 'founder-1' },
    refreshSession: vi.fn(async () => undefined),
  }),
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: () => ({
    data: mocks.plansNode,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../ui/useCallable', () => ({
  useCallable: () => ({
    call: mocks.call,
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

vi.mock('./stripeClient', () => ({
  loadStripeForEnv: mocks.loadStripeForEnv,
}));

// Never the real wrapper: importing it is harmless, but the mock guarantees no
// test can mount a live Elements provider by accident.
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: () => null,
  PaymentElement: () => null,
  useStripe: () => null,
  useElements: () => null,
}));

import { pickNoMembershipView } from './gating';
import { composeAddress, OrgDetailsPage, splitAddress } from './OrgDetailsPage';
import { SubscribePlanPage } from './SubscribePlanPage';
import { SubscribePaymentPage } from './SubscribePaymentPage';

beforeEach(() => {
  mocks.callResult = undefined;
  mocks.call.mockClear();
});

/** The pages render Wordmark, which reads the theme context. */
function renderPage(page: ReactElement) {
  return render(
    <MemoryRouter>
      <ThemeProvider>{page}</ThemeProvider>
    </MemoryRouter>,
  );
}

function node(step: UserOnboarding['step'], completedAt?: number): UserOnboarding {
  return { step, createdAt: 1, ...(completedAt ? { completedAt } : {}) };
}

function plan(name: string, order: number, priceMonthlyPence: number): Plan {
  return {
    name,
    stripePriceId: `price_${name.toLowerCase()}`,
    priceMonthlyPence,
    currency: 'gbp',
    features: { branding: false, emailTemplates: false, prioritySupport: false },
    limits: {
      orgStaff: 3,
      customers: 10,
      notificationsPerMonth: 200,
      assessmentTemplates: 1,
    },
    order,
  };
}

describe('pickNoMembershipView', () => {
  it('sends a claims-less session with no journey to the org-details step', () => {
    expect(pickNoMembershipView('noMembership', null)).toBe('details');
    expect(pickNoMembershipView('noMembership', undefined)).toBe('details');
  });

  it("holds a journey still at 'details' on the details step", () => {
    expect(pickNoMembershipView('noMembership', node('details'))).toBe('details');
  });

  it("resumes at the right step: 'plan' shows the matrix, 'payment' resumes payment", () => {
    expect(pickNoMembershipView('noMembership', node('plan'))).toBe('subscribe');
    expect(pickNoMembershipView('noMembership', node('payment'))).toBe('payment');
  });

  it("shows the confirming wait for a provisioned org whose claims have not landed", () => {
    expect(pickNoMembershipView('noMembership', node('setup'))).toBe('confirming');
  });

  it('ignores a finished journey: a claims-less session starts afresh at details, not stranded', () => {
    expect(pickNoMembershipView('noMembership', node('done', 123))).toBe('details');
  });

  it('gates a claimed session only while the setup wizard is unfinished', () => {
    expect(pickNoMembershipView('authenticated', node('setup'))).toBe('setup');
    expect(pickNoMembershipView('authenticated', node('setup', 123))).toBe('through');
    expect(pickNoMembershipView('authenticated', node('done', 123))).toBe('through');
    expect(pickNoMembershipView('authenticated', null)).toBe('through');
  });
});

describe('SubscribePlanPage', () => {
  it('renders the catalogue sorted by order with display prices in pounds', () => {
    // Deliberately mis-ordered keys: `order` alone decides how the matrix reads.
    mocks.plansNode = {
      gold: plan('Gold', 3, 29900),
      bronze: plan('Bronze', 1, 4900),
      silver: plan('Silver', 2, 12950),
    };
    renderPage(
      <SubscribePlanPage
        env="test"
        orgName="Acme Fire Safety Ltd"
        onChoose={vi.fn()}
        onEditDetails={vi.fn()}
        onShowHolding={vi.fn()}
      />,
    );
    // The saved organisation and the way back to editing it.
    expect(screen.getByText('Acme Fire Safety Ltd')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'edit details' }),
    ).toBeInTheDocument();
    const names = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(['Bronze', 'Silver', 'Gold']);
    expect(screen.getByText('£49')).toBeInTheDocument();
    expect(screen.getByText('£129.50')).toBeInTheDocument();
    expect(screen.getByText('£299')).toBeInTheDocument();
    expect(screen.getByText(/Prices exclude VAT/)).toBeInTheDocument();
  });

  it('shows the not-seeded empty state when the plans node is absent', () => {
    mocks.plansNode = null;
    renderPage(
      <SubscribePlanPage
        env="test"
        orgName="Acme"
        onChoose={vi.fn()}
        onEditDetails={vi.fn()}
        onShowHolding={vi.fn()}
      />,
    );
    expect(screen.getByText('Plans are not available yet')).toBeInTheDocument();
    // No plan cards render alongside the empty state.
    expect(screen.queryByText(/per month/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Prices exclude VAT/)).not.toBeInTheDocument();
  });
});

describe('SubscribePaymentPage', () => {
  it('says payments are not configured when the publishable key is absent', async () => {
    mocks.loadStripeForEnv.mockResolvedValueOnce(null);
    renderPage(
      <SubscribePaymentPage
        env="test"
        choice={{
          planId: 'bronze',
          plan: plan('Bronze', 1, 4900),
        }}
        onBack={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/Payments are not available just yet/),
    ).toBeInTheDocument();
  });
});

describe('OrgDetailsPage', () => {
  it('renders the grouped form and submits the composed details', async () => {
    const onSaved = vi.fn();
    mocks.callResult = {
      onboarding: { step: 'plan', orgName: 'Acme Fire Safety Ltd', createdAt: 1 },
    };
    renderPage(
      <OrgDetailsPage
        initialDetails={null}
        onSaved={onSaved}
        onShowHolding={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Organisation name'), {
      target: { value: 'Acme Fire Safety Ltd' },
    });
    fireEvent.change(screen.getByLabelText('Address line 1'), {
      target: { value: '1 King Street' },
    });
    fireEvent.change(screen.getByLabelText('Town or city'), {
      target: { value: 'Manchester' },
    });
    fireEvent.change(screen.getByLabelText('Postcode'), {
      target: { value: 'M2 6AW' },
    });
    fireEvent.change(screen.getByLabelText(/Phone/), {
      target: { value: '0161 496 0000' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue to plans' }),
    );

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.call).toHaveBeenCalledWith({
      details: {
        name: 'Acme Fire Safety Ltd',
        address: '1 King Street, Manchester, M2 6AW',
        phone: '0161 496 0000',
      },
    });
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'plan' }),
    );
  });

  it('refuses a too-short name inline without calling the server', () => {
    renderPage(
      <OrgDetailsPage
        initialDetails={null}
        onSaved={vi.fn()}
        onShowHolding={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Organisation name'), {
      target: { value: 'A' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue to plans' }),
    );
    expect(screen.getByText(/Enter your organisation's name/)).toBeInTheDocument();
    expect(mocks.call).not.toHaveBeenCalled();
  });
});

describe('address composition', () => {
  it('composes present parts and round-trips through splitAddress', () => {
    const composed = composeAddress({
      line1: '1 King Street',
      line2: 'Floor 2',
      city: 'Manchester',
      postcode: 'M2 6AW',
    });
    expect(composed).toBe('1 King Street, Floor 2, Manchester, M2 6AW');
    expect(splitAddress(composed)).toEqual({
      line1: '1 King Street',
      line2: 'Floor 2',
      city: 'Manchester',
      postcode: 'M2 6AW',
    });
    // Sparse addresses keep their meaning both ways.
    expect(composeAddress({ line1: '1 King Street', line2: '', city: '', postcode: '' }))
      .toBe('1 King Street');
    expect(splitAddress('1 King Street')).toEqual({
      line1: '1 King Street',
      line2: '',
      city: '',
      postcode: '',
    });
    expect(splitAddress(undefined)).toEqual({
      line1: '',
      line2: '',
      city: '',
      postcode: '',
    });
  });
});
