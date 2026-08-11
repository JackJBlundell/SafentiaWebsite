// ============================================================================
// SetupWizard tests - the post-subscribe first-run wizard (Phase 3 §3.1.7).
//
// Module boundaries mocked as in billing.test.tsx: the callable layer is a
// per-name registry so a test can assert exactly which contract a control
// invoked (navigation MUST go through advanceOnboarding, business writes
// through the real callables); the RTDB bridge serves the live onboarding
// node whose server-side setupDone marks drive the auto-ticks. The list
// builders send through callWithFailure so per-row outcomes are asserted on
// that handle.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../design/ThemeProvider';
import type { UserOnboarding } from '../../types';

interface MockHandle {
  call: ReturnType<typeof vi.fn>;
  callWithFailure: ReturnType<typeof vi.fn>;
  pending: boolean;
  error: string | null;
  failure: null;
  clearError: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
  const handles: Record<string, MockHandle> = {};
  return {
    auth: {
      status: 'authenticated',
      user: { uid: 'admin-1', email: 'admin@example.com' },
      claims: { orgId: 'org-1', roles: { admin: true } },
      paths: null,
    },
    rtdb: {} as Record<string, unknown>,
    handles,
    handle(name: string): MockHandle {
      if (!handles[name]) {
        handles[name] = {
          call: vi.fn(async () => ({})),
          callWithFailure: vi.fn(async () => ({ data: {}, failure: null })),
          pending: false,
          error: null,
          failure: null,
          clearError: vi.fn(),
        };
      }
      return handles[name];
    },
    entitlements: {
      entitlements: {
        limits: {
          orgStaff: -1,
          customers: -1,
          notificationsPerMonth: -1,
          assessmentTemplates: -1,
        },
        features: { branding: false, emailTemplates: false, prioritySupport: false },
        suspended: false,
      },
      plan: undefined as { name: string } | undefined,
      usage: undefined as { staffCount: number } | undefined,
      subscription: undefined,
      isAdmin: true,
      loading: false,
    },
  };
});

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), db: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly (string | number)[] }) => ({
    data: mocks.rtdb[String(key[0])] ?? null,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../ui/useCallable', () => ({
  useCallable: (name: string) => mocks.handle(name),
}));

vi.mock('./useEntitlements', () => ({
  useEntitlements: () => mocks.entitlements,
}));

import SetupWizard from './SetupWizard';
import SetupCompleteScreen from './SetupCompleteScreen';

const baseNode: UserOnboarding = {
  step: 'setup',
  orgId: 'org-1',
  orgName: 'Acme Fire Safety',
  planId: 'silver',
  setupStep: 'profile',
  createdAt: 1,
};

const onCelebrate = vi.fn();

function renderWizard(onboarding: Partial<UserOnboarding> = {}) {
  const node = { ...baseNode, ...onboarding };
  mocks.rtdb.userOnboarding = node;
  // The wizard renders Wordmark, which reads the theme context.
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <SetupWizard onboarding={node} onCelebrate={onCelebrate} />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** The team pane's email inputs, in row order. */
const emailInputs = () => screen.getAllByLabelText('Email address');

beforeEach(() => {
  for (const key of Object.keys(mocks.handles)) delete mocks.handles[key];
  for (const key of Object.keys(mocks.rtdb)) delete mocks.rtdb[key];
  mocks.entitlements.entitlements.features.branding = false;
  mocks.entitlements.entitlements.limits.orgStaff = -1;
  mocks.entitlements.plan = undefined;
  mocks.entitlements.usage = undefined;
  onCelebrate.mockClear();
});

describe('SetupWizard', () => {
  it('renders the pane the node records as the current step', () => {
    renderWizard({ setupStep: 'team' });
    expect(screen.getByText('Invite your team')).toBeTruthy();
    // The stepper marks Team current and Branding done.
    const current = screen.getByText('Team').closest('[aria-current="step"]');
    expect(current).toBeTruthy();
  });

  it('shows exactly three steps - finishing is not a stepper entry', () => {
    renderWizard();
    const stepper = screen.getByRole('list', { name: 'Progress' });
    const steps = within(stepper).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(within(stepper).queryByText('Finish')).toBeNull();
  });

  it('collects no name or address: the details step owns them now', () => {
    renderWizard();
    // The first pane is branding only; the org's details were collected
    // before payment and provisioned onto the profile.
    expect(screen.getByText('Your branding')).toBeTruthy();
    expect(screen.queryByLabelText('Organisation name')).toBeNull();
    expect(screen.queryByLabelText(/Address/)).toBeNull();
  });

  it('skip calls advanceOnboarding with the next setup step', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(mocks.handle('advanceOnboarding').call).toHaveBeenCalledWith({
      skipTo: 'team',
    });
    // The pane advanced once the server accepted the movement.
    expect(screen.getByText('Invite your team')).toBeTruthy();
  });

  it('renders the auto-tick when the live node carries a setupDone mark', () => {
    renderWizard({ setupDone: { profile: true } });
    expect(screen.getByText('Done')).toBeTruthy();
    // A ticked step's forward control invites moving on rather than skipping.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
  });

  it('hides the brand colour fields without the branding feature', () => {
    renderWizard();
    expect(screen.queryByLabelText('Primary colour')).toBeNull();
    // The locked posture: the upsell stands where the controls would.
    expect(screen.getByText(/Brand colours are part of the Silver plan/)).toBeTruthy();
  });

  it('shows the brand colour fields when the plan includes branding', () => {
    mocks.entitlements.entitlements.features.branding = true;
    renderWizard();
    expect(screen.getByLabelText('Primary colour')).toBeTruthy();
    expect(screen.getByLabelText('Secondary colour')).toBeTruthy();
    expect(
      screen.queryByText(/Brand colours are part of the Silver plan/),
    ).toBeNull();
  });

  // --- Team pane: the invite list builder ---------------------------------

  it('drives the team header from the plan limit', () => {
    mocks.entitlements.entitlements.limits.orgStaff = 5;
    mocks.entitlements.plan = { name: 'Silver' };
    mocks.entitlements.usage = { staffCount: 1 };
    renderWizard({ setupStep: 'team' });
    expect(
      screen.getByText(/Your Silver plan includes up to 5 team members/),
    ).toBeTruthy();
  });

  it('shows no cap copy on an unlimited plan', () => {
    renderWizard({ setupStep: 'team' });
    expect(screen.queryByText(/plan includes up to/)).toBeNull();
  });

  it('adds and removes invite rows', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'team' });
    expect(emailInputs()).toHaveLength(1);
    await user.type(emailInputs()[0]!, 'a@example.com');
    await user.click(screen.getByRole('button', { name: 'Add another' }));
    expect(emailInputs()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove this row' }));
    expect(emailInputs()).toHaveLength(1);
    expect((emailInputs()[0] as HTMLInputElement).value).toBe('a@example.com');
  });

  it('rejects a duplicate email on add', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'team' });
    await user.type(emailInputs()[0]!, 'a@example.com');
    await user.click(screen.getByRole('button', { name: 'Add another' }));
    await user.type(emailInputs()[1]!, 'A@example.com');
    await user.click(screen.getByRole('button', { name: 'Add another' }));
    expect(screen.getByText(/is already in the list/)).toBeTruthy();
    expect(emailInputs()).toHaveLength(2);
  });

  it('rejects a malformed email on add', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'team' });
    await user.type(emailInputs()[0]!, 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Add another' }));
    expect(screen.getByText(/does not look like an email address/)).toBeTruthy();
    expect(emailInputs()).toHaveLength(1);
  });

  it('disables adding rows when the plan allowance runs out', () => {
    // 3 seats, 2 already used, 1 row in the list => remaining 0.
    mocks.entitlements.entitlements.limits.orgStaff = 3;
    mocks.entitlements.plan = { name: 'Bronze' };
    mocks.entitlements.usage = { staffCount: 2 };
    renderWizard({ setupStep: 'team' });
    const add = screen.getByRole('button', { name: 'Add another' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/everyone your plan includes/)).toBeTruthy();
  });

  it('sends one createInvitation per row, sequentially, and locks sent rows', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'team' });
    await user.type(emailInputs()[0]!, 'a@example.com');
    await user.click(screen.getByRole('button', { name: 'Add another' }));
    await user.type(emailInputs()[1]!, 'b@example.com');
    await user.click(screen.getByRole('button', { name: 'Send 2 invites' }));
    const sends = mocks.handle('createInvitation').callWithFailure;
    expect(sends).toHaveBeenCalledTimes(2);
    expect(sends).toHaveBeenNthCalledWith(1, {
      email: 'a@example.com',
      roles: { assessor: true },
    });
    expect(sends).toHaveBeenNthCalledWith(2, {
      email: 'b@example.com',
      roles: { assessor: true },
    });
    // Both rows locked into their confirmation lines; no editable rows remain.
    expect(screen.getAllByText(/Invitation sent to/)).toHaveLength(2);
    expect(screen.queryAllByLabelText('Email address')).toHaveLength(0);
  });

  it('keeps a failed send editable with the server message, and retries only it', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'team' });
    const sends = mocks.handle('createInvitation').callWithFailure;
    sends.mockImplementation(async ({ email }: { email: string }) =>
      email === 'bad@example.com'
        ? {
            data: null,
            failure: {
              code: 'resource-exhausted',
              message: 'You have reached your plan limit.',
              details: null,
            },
          }
        : { data: {}, failure: null },
    );
    await user.type(emailInputs()[0]!, 'good@example.com');
    await user.click(screen.getByRole('button', { name: 'Add another' }));
    await user.type(emailInputs()[1]!, 'bad@example.com');
    await user.click(screen.getByRole('button', { name: 'Send 2 invites' }));
    // The failed row shows the server's calm message and stays editable.
    expect(screen.getByText('You have reached your plan limit.')).toBeTruthy();
    expect(emailInputs()).toHaveLength(1);
    expect((emailInputs()[0] as HTMLInputElement).value).toBe('bad@example.com');
    // Retry resends only the failed row.
    sends.mockClear();
    sends.mockImplementation(async () => ({ data: {}, failure: null }));
    await user.click(screen.getByRole('button', { name: 'Send 1 invite' }));
    expect(sends).toHaveBeenCalledTimes(1);
    expect(sends).toHaveBeenCalledWith({
      email: 'bad@example.com',
      roles: { assessor: true },
    });
  });

  // --- Back navigation ------------------------------------------------------

  it('back reviews the previous pane and forward returns without re-calling the server', async () => {
    const user = userEvent.setup();
    // Furthest recorded step is 'team', so Branding is already-advanced ground.
    renderWizard({ setupStep: 'team' });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Your branding')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    // Local movement only: the server already records furthest progress.
    expect(mocks.handle('advanceOnboarding').call).not.toHaveBeenCalled();
    expect(screen.getByText('Invite your team')).toBeTruthy();
  });

  it('back preserves what was typed into a list', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'team' });
    await user.type(emailInputs()[0]!, 'kept@example.com');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect((emailInputs()[0] as HTMLInputElement).value).toBe('kept@example.com');
  });

  // --- Customer pane: the same list-builder pattern ------------------------

  it('creates one customer per row through manageCustomer', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'customer' });
    await user.type(screen.getByLabelText('Customer name'), 'Acme Ltd');
    await user.type(screen.getByLabelText('Primary contact name'), 'Jo Smith');
    await user.type(screen.getByLabelText(/Contact email/), 'jo@acme.example');
    await user.click(screen.getByRole('button', { name: 'Add 1 customer' }));
    expect(mocks.handle('manageCustomer').callWithFailure).toHaveBeenCalledWith({
      action: 'create',
      customer: { name: 'Acme Ltd' },
      primaryContact: { name: 'Jo Smith', email: 'jo@acme.example' },
    });
    expect(screen.getByText(/Customer added:/)).toBeTruthy();
  });

  it('caps the customer list at five rows', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'customer' });
    for (let i = 0; i < 4; i += 1) {
      const names = screen.getAllByLabelText('Customer name');
      const contacts = screen.getAllByLabelText('Primary contact name');
      await user.type(names[names.length - 1]!, `Customer ${i}`);
      await user.type(contacts[contacts.length - 1]!, `Contact ${i}`);
      await user.click(screen.getByRole('button', { name: 'Add another' }));
    }
    expect(screen.getAllByLabelText('Customer name')).toHaveLength(5);
    const add = screen.getByRole('button', { name: 'Add another' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/add the rest from the Customers page/)).toBeTruthy();
  });

  // --- Finishing ------------------------------------------------------------

  it('resumes at the last pane when the node records the legacy building step', () => {
    renderWizard({ setupStep: 'building', setupDone: { profile: true, team: true } });
    expect(screen.getByText('Add your first customers')).toBeTruthy();
  });

  it('finish setup celebrates immediately and fires advanceOnboarding in the background', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'customer', setupDone: { profile: true, team: true } });
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(mocks.handle('advanceOnboarding').call).toHaveBeenCalledWith({
      finish: true,
    });
    expect(onCelebrate).toHaveBeenCalledWith({
      brandingSaved: false,
      invitesSent: 0,
      customersAdded: 0,
    });
  });

  it('reports what the session actually did in the celebration summary', async () => {
    const user = userEvent.setup();
    renderWizard({ setupStep: 'customer' });
    await user.type(screen.getByLabelText('Customer name'), 'Acme Ltd');
    await user.type(screen.getByLabelText('Primary contact name'), 'Jo Smith');
    await user.click(screen.getByRole('button', { name: 'Add 1 customer' }));
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(onCelebrate).toHaveBeenCalledWith({
      brandingSaved: false,
      invitesSent: 0,
      customersAdded: 1,
    });
  });
});

describe('SetupCompleteScreen', () => {
  it('renders the celebration with a summary and one CTA', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SetupCompleteScreen
            summary={{ brandingSaved: true, invitesSent: 2, customersAdded: 1 }}
            onContinue={onContinue}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(/all set/)).toBeTruthy();
    expect(
      screen.getByText('Branding saved, 2 invitations sent and 1 customer added - your organisation is ready.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Go to your dashboard' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('stays calm when everything was skipped', () => {
    render(
      <MemoryRouter>
        <ThemeProvider>
          <SetupCompleteScreen
            summary={{ brandingSaved: false, invitesSent: 0, customersAdded: 0 }}
            onContinue={() => {}}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/anything you skipped is waiting in the console/),
    ).toBeTruthy();
  });
});
