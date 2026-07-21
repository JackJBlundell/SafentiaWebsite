// ============================================================================
// Console gate and shell tests.
//
// The AuthProvider is mocked at the module boundary (its contract, not its
// implementation, is what the gate depends on), so each test drives the gate by
// setting the session state directly. The RTDB bridge and firebase module are
// mocked too: these are routing/rendering tests and must not open sockets.
// ============================================================================

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { User } from 'firebase/auth';
import { forEnv } from '../paths';
import { keys } from '../query/keys';
import { queryClient } from '../query/queryClient';
import type { SessionClaims } from '../auth/claims';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'initialising' as string,
      user: null as unknown,
      claims: null as unknown,
      paths: null as unknown,
      signInWithEmail: vi.fn(),
      signInWithGoogle: vi.fn(),
      sendReset: vi.fn(),
      changePassword: vi.fn(),
      updateDisplayName: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(),
    },
    userOrgs: {
      organisations: [] as { orgId: string; name: string; isCurrent: boolean }[],
      loading: false,
      hasMultiple: false,
    },
    // The raw-token superAdmin hook is mocked so tests drive platform mode
    // deterministically rather than round-tripping getIdTokenResult.
    superAdmin: 'denied' as string,
    rtdbData: undefined as unknown,
    callable: vi.fn(async (_name: string, _input: unknown) => ({}) as unknown),
  };
});

vi.mock('../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn() },
}));

// OrgSwitcher calls the setActiveOrganisation callable through the raw
// httpsCallable (not the useCallable hook), so route it to mocks.callable too.
vi.mock('firebase/functions', () => ({
  httpsCallable:
    (_fns: unknown, name: string) => (input: unknown) => mocks.callable(name, input),
}));

vi.mock('../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mocks.auth,
}));

vi.mock('../auth/useUserOrganisations', () => ({
  useUserOrganisations: () => mocks.userOrgs,
}));

vi.mock('./admin/useSuperAdminClaim', () => ({
  useSuperAdminClaim: () => mocks.superAdmin,
}));

vi.mock('../query/useRtdbQuery', () => ({
  useRtdbQuery: () => ({ data: mocks.rtdbData }),
  subscribeToQuery: vi.fn(() => () => undefined),
}));

vi.mock('../seo/Seo', () => ({
  Seo: () => null,
}));

// The error boundary forwards a caught crash to the telemetry util; mock it so
// the boundary tests can assert the call without opening a callable.
vi.mock('./lib/reportClientError', () => ({
  reportClientError: vi.fn(),
  initGlobalErrorReporting: vi.fn(),
}));

vi.mock('./ui/useCallable', () => ({
  useCallable: (name: string) => ({
    call: (input: unknown) => mocks.callable(name, input),
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import { Component as ConsoleRoute } from './ConsoleRoute';
import { AccountPage } from './AccountPage';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { reportClientError } from './lib/reportClientError';

// --- Fixtures ----------------------------------------------------------------

const testUser = {
  uid: 'user-1',
  email: 'jane@example.com',
  displayName: 'Jane Doe',
} as unknown as User;

const testClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true, assessor: true },
  environment: 'test',
};

function setAuth(overrides: Partial<typeof mocks.auth>) {
  Object.assign(mocks.auth, overrides);
}

/** Renders whatever URL the redirect landed on, so the returnTo assertion reads
 *  the real router state rather than inspecting a Navigate element. */
function LoginProbe() {
  const location = useLocation();
  return <div data-testid="login-probe">{location.pathname + location.search}</div>;
}

function renderConsoleAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/app/*" element={<ConsoleRoute />} />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setAuth({
    status: 'initialising',
    user: null,
    claims: null,
    paths: null,
  });
  mocks.userOrgs.organisations = [];
  mocks.userOrgs.loading = false;
  mocks.userOrgs.hasMultiple = false;
  mocks.superAdmin = 'denied';
  mocks.rtdbData = undefined;
  vi.clearAllMocks();
});

// --- The gate ----------------------------------------------------------------

describe('ConsoleGate', () => {
  it('shows the splash while the session is initialising', () => {
    setAuth({ status: 'initialising' });
    renderConsoleAt('/app');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading your organisation',
    );
  });

  it('redirects a signed-out visitor to /login carrying the requested URL', () => {
    setAuth({ status: 'signedOut' });
    renderConsoleAt('/app/jobs?filter=open');
    const probe = screen.getByTestId('login-probe');
    expect(probe).toHaveTextContent(
      `/login?returnTo=${encodeURIComponent('/app/jobs?filter=open')}`,
    );
  });

  it('shows the holding screen for a user with no organisation membership', () => {
    setAuth({ status: 'noMembership', user: testUser });
    renderConsoleAt('/app');
    expect(
      screen.getByRole('heading', {
        name: 'You are signed in, but not a member of an organisation yet',
      }),
    ).toBeInTheDocument();
    // The signed-in email is shown so a "wrong account" mistake is obvious.
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    // Invitation-only: organisations are founded by the platform operator
    // until Phase 3 self-serve, so there is no create entry here.
    expect(
      screen.getByText(/An administrator at your organisation needs to invite you/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create an organisation' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('shows the console shell once authenticated', () => {
    setAuth({
      status: 'authenticated',
      user: testUser,
      claims: testClaims,
      paths: forEnv('test'),
    });
    mocks.userOrgs.organisations = [
      { orgId: 'org-1', name: 'Acme Fire Safety', isCurrent: true },
    ];
    renderConsoleAt('/app');
    expect(
      screen.getByRole('heading', { name: 'Hello, Jane' }),
    ).toBeInTheDocument();
    // The account menu carries the user's identity.
    expect(
      screen.getByRole('button', { name: /Jane Doe/ }),
    ).toBeInTheDocument();
    // The overview renders its cards even while every RTDB read is still
    // undefined (this mock never resolves data) - no tile invents a number.
    expect(
      screen.getByRole('heading', { name: 'Recent activity' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Upcoming reviews' }),
    ).toBeInTheDocument();
    // The overview cards each carry a "View all" affordance (Recent activity,
    // and Recent releases for auditors/admins), so there is at least one.
    expect(
      screen.getAllByRole('link', { name: 'View all' }).length,
    ).toBeGreaterThan(0);
  });
});

// --- The org switcher ----------------------------------------------------------

describe('OrgSwitcher', () => {
  beforeEach(() => {
    setAuth({
      status: 'authenticated',
      user: testUser,
      claims: testClaims,
      paths: forEnv('test'),
    });
  });

  it('renders a single organisation as static text, not a control', () => {
    mocks.userOrgs.organisations = [
      { orgId: 'org-1', name: 'Acme Fire Safety', isCurrent: true },
    ];
    mocks.userOrgs.hasMultiple = false;
    renderConsoleAt('/app');
    expect(screen.getByText('Acme Fire Safety')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Acme Fire Safety/ }),
    ).not.toBeInTheDocument();
    // No "Add" entry: org creation is operator-only until Phase 3 self-serve.
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('renders a disclosure listing every organisation when the user has several', async () => {
    const user = userEvent.setup();
    mocks.userOrgs.organisations = [
      { orgId: 'org-1', name: 'Acme Fire Safety', isCurrent: true },
      { orgId: 'org-2', name: 'Borough Compliance', isCurrent: false },
    ];
    mocks.userOrgs.hasMultiple = true;
    renderConsoleAt('/app');

    const trigger = screen.getByRole('button', { name: /Acme Fire Safety/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const list = screen.getByRole('list', { name: 'Your organisations' });
    expect(list).toBeInTheDocument();
    // The active organisation is marked as current.
    const currentOption = screen.getByRole('button', {
      name: /Acme Fire Safety Current/,
    });
    expect(currentOption).toHaveAttribute('aria-current', 'true');
    expect(
      screen.getByRole('button', { name: 'Borough Compliance' }),
    ).toBeInTheDocument();
    // The disclosure only switches: no create entry (operator-only until
    // Phase 3 self-serve).
    expect(
      screen.queryByRole('button', { name: 'Add organisation' }),
    ).not.toBeInTheDocument();
  });
});

// --- Platform (super admin) mode -----------------------------------------------

describe('Platform mode', () => {
  beforeEach(() => {
    setAuth({
      status: 'authenticated',
      user: testUser,
      claims: testClaims,
      paths: forEnv('test'),
    });
    // The console renders the operator surface at /app/admin, which the shell's
    // ErrorBoundary would log if a page beneath it threw; silence it so the
    // rail assertions stay legible.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers a super admin the Super Admin Dashboard switcher entry that enters platform mode', async () => {
    const user = userEvent.setup();
    mocks.superAdmin = 'granted';
    mocks.userOrgs.organisations = [
      { orgId: 'org-1', name: 'Acme Fire Safety', isCurrent: true },
    ];
    mocks.userOrgs.hasMultiple = false;
    renderConsoleAt('/app');

    // A super admin gets the disclosure even with a single org.
    const trigger = screen.getByRole('button', { name: /Acme Fire Safety/ });
    await user.click(trigger);
    const entry = screen.getByRole('button', { name: 'Super Admin Dashboard' });

    // Selecting it navigates to /app/admin: the platform rail replaces the org
    // rail, which proves the client-side navigation landed.
    await user.click(entry);
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Home' })).not.toBeInTheDocument();
    // Entering platform mode never touches the claims.
    expect(mocks.callable).not.toHaveBeenCalledWith(
      'setActiveOrganisation',
      expect.anything(),
    );
  });

  it('renders the platform rail and neutral brand at /app/admin, not the org rail', () => {
    mocks.superAdmin = 'granted';
    mocks.userOrgs.organisations = [
      { orgId: 'org-1', name: 'Acme Fire Safety', isCurrent: true },
    ];
    renderConsoleAt('/app/admin');

    for (const label of [
      'Dashboard',
      'Organisations',
      'Customers',
      'Buildings',
      'Members',
      'Activity',
    ]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    // The org rail is gone.
    expect(screen.queryByRole('link', { name: 'Home' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();
    // The trigger reads as the platform mode, and the brand is neutral.
    expect(screen.getByRole('button', { name: 'Super Admin' })).toBeInTheDocument();
    expect(screen.getByText('Platform console')).toBeInTheDocument();
  });

  it('never shows the platform entry or rail to a non-super-admin', () => {
    mocks.superAdmin = 'denied';
    mocks.userOrgs.organisations = [
      { orgId: 'org-1', name: 'Acme Fire Safety', isCurrent: true },
    ];
    // Even at a hand-typed /app/admin the org rail stays; platform is presentation
    // over the rules' real superAdmin boundary.
    renderConsoleAt('/app/admin');
    expect(
      screen.queryByRole('button', { name: 'Super Admin Dashboard' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Organisations' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Acme Fire Safety')).toBeInTheDocument();
  });

  it('returns to an organisation from platform mode', async () => {
    const user = userEvent.setup();
    mocks.superAdmin = 'granted';
    mocks.userOrgs.organisations = [
      { orgId: 'org-1', name: 'Acme Fire Safety', isCurrent: true },
      { orgId: 'org-2', name: 'Borough Compliance', isCurrent: false },
    ];
    mocks.userOrgs.hasMultiple = true;
    renderConsoleAt('/app/admin');

    // In platform mode the trigger reads as the platform, not an org.
    const trigger = screen.getByRole('button', { name: 'Super Admin' });
    await user.click(trigger);
    // Selecting the current org returns to /app without re-switching claims.
    await user.click(screen.getByRole('button', { name: /Acme Fire Safety/ }));
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(mocks.callable).not.toHaveBeenCalledWith(
      'setActiveOrganisation',
      expect.anything(),
    );
  });
});

// --- AccountPage email preferences (story 2066) --------------------------------

describe('AccountPage email preferences', () => {
  function renderAccount() {
    return render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );
  }

  it('seeds the toggles from the member record (absent means on)', () => {
    setAuth({ status: 'authenticated', user: testUser, claims: testClaims, paths: forEnv('test') });
    // The bridge mock serves this for the caller's own orgMember read.
    mocks.rtdbData = {
      roles: { admin: true },
      name: 'Jane Doe',
      email: 'jane@example.com',
      status: 'active',
      emailPreferences: { released: false },
    };
    renderAccount();

    expect(screen.getByLabelText('Reviews due')).toBeChecked();
    expect(screen.getByLabelText('Actions assigned')).toBeChecked();
    expect(
      screen.getByLabelText('Assessments awaiting validation'),
    ).toBeChecked();
    // Only an explicit stored false unticks.
    expect(screen.getByLabelText('Released reports')).not.toBeChecked();
    // The honest boundary is stated on screen.
    expect(
      screen.getByText('Security and account email always sends.'),
    ).toBeInTheDocument();
  });

  it('saves all four categories through updateMyPreferences', async () => {
    const user = userEvent.setup();
    setAuth({ status: 'authenticated', user: testUser, claims: testClaims, paths: forEnv('test') });
    mocks.rtdbData = {
      roles: { admin: true },
      name: 'Jane Doe',
      email: 'jane@example.com',
      status: 'active',
    };
    mocks.callable.mockResolvedValueOnce({ updated: true });
    renderAccount();

    await user.click(screen.getByLabelText('Reviews due'));
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(mocks.callable).toHaveBeenCalledWith('updateMyPreferences', {
      emailPreferences: {
        reviewDue: false,
        actionAssigned: true,
        awaitingValidation: true,
        released: true,
      },
    });
    expect(
      await screen.findByText('Email preferences saved.'),
    ).toBeInTheDocument();
  });

  it('hides the card for portal sessions, whose records carry no preferences', () => {
    setAuth({
      status: 'authenticated',
      user: testUser,
      claims: {
        kind: 'portal',
        orgId: 'org-1',
        customerId: 'cust-1',
        customerRoles: { viewer: true },
        roles: {},
        environment: 'test',
      } as SessionClaims,
      paths: forEnv('test'),
    });
    renderAccount();
    expect(screen.queryByText('Email preferences')).not.toBeInTheDocument();
  });
});

// --- The page-level error boundary ---------------------------------------------

describe('ErrorBoundary', () => {
  /** Throws while armed; renders once the module-level flag is lowered. */
  let armed = true;
  function Bomb() {
    if (armed) {
      throw new Error('boom');
    }
    return <p>Recovered content</p>;
  }

  beforeEach(() => {
    armed = true;
    vi.mocked(reportClientError).mockClear();
  });

  it('catches a render crash, logs with the stable prefix, and recovers on Try again', async () => {
    const user = userEvent.setup();
    // React logs the caught error too; silence the console for the assertion.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('heading', { name: 'Something went wrong on this page' }),
    ).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith(
      '[Safentia console] Page render failed:',
      expect.any(Error),
      expect.anything(),
    );
    // The crash is forwarded to telemetry (best-effort), carrying the message
    // and the React component stack.
    expect(reportClientError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'boom',
        componentStack: expect.anything(),
      }),
    );
    // The way out is a real link home, not a dead end.
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute(
      'href',
      '/app',
    );
    // Disarm and retry: the boundary resets and the page renders.
    armed = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    errorSpy.mockRestore();
  });

  it('resets itself when resetKey changes, so navigation is recovery', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(
      <MemoryRouter>
        <ErrorBoundary resetKey="/app/jobs">
          <Bomb />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('heading', { name: 'Something went wrong on this page' }),
    ).toBeInTheDocument();
    armed = false;
    rerender(
      <MemoryRouter>
        <ErrorBoundary resetKey="/app">
          <Bomb />
        </ErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});

// --- The Validation rail badge ---------------------------------------------------

describe('Validation nav badge', () => {
  beforeEach(() => {
    setAuth({
      status: 'authenticated',
      user: testUser,
      claims: testClaims,
      paths: forEnv('test'),
    });
  });

  it('shows the waiting count on the rail item with the number in words', () => {
    // The bridge mock serves this map for the badge's bounded stage read.
    mocks.rtdbData = { a1: {}, a2: {}, a3: {} };
    renderConsoleAt('/app/nowhere');
    const link = screen.getByRole('link', { name: 'Validation, 3 waiting' });
    expect(within(link).getByText('3')).toBeInTheDocument();
  });

  it('caps the pill at 99+ while the accessible name keeps the true count', () => {
    mocks.rtdbData = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`a${i}`, {}]),
    );
    renderConsoleAt('/app/nowhere');
    const link = screen.getByRole('link', { name: 'Validation, 120 waiting' });
    expect(within(link).getByText('99+')).toBeInTheDocument();
  });

  it('hides the badge entirely when nothing is waiting', () => {
    mocks.rtdbData = {};
    renderConsoleAt('/app/nowhere');
    expect(screen.getByRole('link', { name: 'Validation' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /waiting/ })).not.toBeInTheDocument();
  });

  it('shows neither the item nor a badge to roles the queue read is not attached for', () => {
    setAuth({
      claims: { orgId: 'org-1', roles: { assessor: true }, environment: 'test' },
    });
    mocks.rtdbData = { a1: {}, a2: {}, a3: {} };
    renderConsoleAt('/app/nowhere');
    expect(screen.queryByRole('link', { name: /Validation/ })).not.toBeInTheDocument();
  });
});

// --- The connection banner -------------------------------------------------------

describe('Connection banner', () => {
  beforeEach(() => {
    queryClient.clear();
    setAuth({
      status: 'authenticated',
      user: testUser,
      claims: testClaims,
      paths: forEnv('test'),
    });
  });

  it('shows only after a sustained drop and clears promptly on reconnect', () => {
    // Fake only the grace timer's clock: TanStack Query delivers cache updates
    // on microtasks, which must keep running for the banner to react at all.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      queryClient.setQueryData(keys.infoConnected(), false);
      renderConsoleAt('/app/nowhere');
      // Inside the grace period nothing shows - blips and route changes stay
      // silent.
      expect(
        screen.queryByText('Connection lost. Reconnecting...'),
      ).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      const banner = screen.getByText('Connection lost. Reconnecting...');
      expect(banner).toHaveAttribute('role', 'status');
      // Reconnection clears it at once, no grace period on the way back. The
      // zero-advance only flushes TanStack Query's setTimeout(0) notification
      // batch, which the fake clock would otherwise hold forever.
      act(() => {
        queryClient.setQueryData(keys.infoConnected(), true);
        vi.advanceTimersByTime(0);
      });
      expect(
        screen.queryByText('Connection lost. Reconnecting...'),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      queryClient.clear();
    }
  });

  it('renders nothing while the connection state is still unknown', () => {
    renderConsoleAt('/app/nowhere');
    expect(
      screen.queryByText('Connection lost. Reconnecting...'),
    ).not.toBeInTheDocument();
  });
});
