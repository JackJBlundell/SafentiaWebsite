// ============================================================================
// Global search tests.
//
// Two harnesses share one set of module mocks. The behaviour block mounts the
// GlobalSearch component alone (routing/rendering only, no sockets) and drives
// it with the keyboard; the placement block mounts the whole ConsoleShell to
// prove the box shows in ORG mode and never in the platform operator surface.
//
// The RTDB bridge is mocked BY KEY (the dashboards.test precedent), so each
// domain the search reads - customers, the buildings root, the bounded jobs
// window, and the per-customer sites fan-out - is served the fixture its live
// listener would deliver.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Customer, Job, OrgMember, Site } from '../../types';
import type { Building } from '../../types';
import type { SessionClaims } from '../../auth/claims';
import { forEnv } from '../../paths';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: { uid: 'u1', email: 'jane@example.com', displayName: 'Jane' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
    // ConsoleRoute gates the whole console on the context's top-level
    // emailVerified, so without this the placement cases render the
    // verification screen and find no search box to place.
    emailVerified: true,
    refreshEmailVerification: vi.fn(() => Promise.resolve(true)),
    signOut: vi.fn(),
  },
  userSpaces: {
    spaces: [{ kind: 'staff' as const, orgId: 'org-1', name: 'Acme Fire Safety', isCurrent: true }],
    loading: false,
    hasMultiple: false,
  },
  superAdmin: 'denied' as string,
  callable: vi.fn(async (_name?: string, _input?: unknown) => ({}) as unknown),
  fixtures: {
    customers: {} as Record<string, Customer> | null,
    buildingsRoot: {} as Record<string, Record<string, Building>> | null,
    jobs: {} as Record<string, Job> | null,
    sitesByCustomer: {} as Record<string, Record<string, Site>>,
    members: {} as Record<string, OrgMember> | null,
    profile: { name: 'Acme Fire Safety' } as unknown,
  },
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn() },
}));

vi.mock('firebase/functions', () => ({
  httpsCallable:
    (_fns: unknown, name: string) => (input: unknown) => mocks.callable(name, input),
}));

vi.mock('../../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mocks.auth,
}));

vi.mock('../../auth/useUserSpaces', () => ({
  useUserSpaces: () => mocks.userSpaces,
}));

vi.mock('../admin/useSuperAdminClaim', () => ({
  useSuperAdminClaim: () => mocks.superAdmin,
}));

vi.mock('../../seo/Seo', () => ({ Seo: () => null }));

vi.mock('../lib/reportClientError', () => ({
  reportClientError: vi.fn(),
  initGlobalErrorReporting: vi.fn(),
}));

vi.mock('../ui/useCallable', () => ({
  useCallable: (name: string) => ({
    call: (input: unknown) => mocks.callable(name, input),
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

// The bridge, served by query key - the dashboards.test pattern.
vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly unknown[] }) => {
    const f = mocks.fixtures;
    let data: unknown;
    switch (key[0]) {
      case 'customers':
        data = f.customers;
        break;
      case 'buildings':
        data = key[2] === 'root' ? f.buildingsRoot : null;
        break;
      case 'jobs':
        data = key[2] === 'window' ? f.jobs : null;
        break;
      case 'sites':
        data = f.sitesByCustomer[key[2] as string] ?? null;
        break;
      case 'orgMembers':
        data = f.members;
        break;
      case 'orgProfile':
        data = f.profile;
        break;
      // The validation rail badge reads a bounded stage window; empty means the
      // badge stays hidden and never distracts these assertions.
      case 'assessments':
        data = {};
        break;
      default:
        data = null;
    }
    return { data, isLoading: false, isError: false };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

import { GlobalSearch } from './GlobalSearch';
// The route Component wraps ConsoleShell in the real ThemeProvider (the shell
// itself expects one), so the placement tests drive the chrome exactly as the
// app mounts it - the console.test precedent.
import { Component as ConsoleRoute } from '../ConsoleRoute';
import { Route, Routes } from 'react-router-dom';

// --- Fixtures ----------------------------------------------------------------

const claims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

function building(overrides: Partial<Building>): Building {
  return { name: 'Unit', customerId: 'c1', riskLevel: 'low', ...overrides };
}

function job(overrides: Partial<Job>): Job {
  return {
    templateId: 't1',
    templateVersion: 1,
    customerId: 'c1',
    siteId: 's1',
    buildingId: 'b1',
    assessorUid: 'u1',
    scheduledFor: Date.UTC(2026, 6, 9, 9, 0),
    status: 'scheduled',
    ...overrides,
  };
}

/** Reads the live router location so a keyboard navigation can be asserted by
 *  the URL it actually landed on. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.claims = claims;
  mocks.auth.paths = forEnv('test');
  mocks.superAdmin = 'denied';
  mocks.fixtures.customers = {
    c1: { name: 'Riverside Housing', status: 'active', address: '1 River Street' },
    c2: { name: 'Beacon Retail', status: 'active' },
  };
  mocks.fixtures.buildingsRoot = {
    s1: {
      b1: building({ name: 'Beacon Tower', customerId: 'c1' }),
      b2: building({ name: 'Maple Court', customerId: 'c1' }),
    },
    s2: { b3: building({ name: 'Harbour Point', customerId: 'c2' }) },
  };
  mocks.fixtures.jobs = { j1: job({}) };
  mocks.fixtures.sitesByCustomer = {
    c1: { s1: { name: 'Riverside Depot' } },
    c2: { s2: { name: 'Beacon Mall' } },
  };
  mocks.fixtures.members = {
    'uid-dana': {
      name: 'Dana Field',
      email: 'dana@example.com',
      roles: { assessor: true },
      status: 'active',
    },
  };
});

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <GlobalSearch />
      <LocationProbe />
    </MemoryRouter>,
  );
}

// --- Behaviour ---------------------------------------------------------------

describe('GlobalSearch behaviour', () => {
  it('shows a hint on focus and nothing before it', async () => {
    const user = userEvent.setup();
    renderSearch();
    expect(screen.queryByText(/Start typing to find/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByText(/Start typing to find/)).toBeInTheDocument();
  });

  it('filters and groups matches across every domain', async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('combobox'), 'beacon');

    // The matching customer, its site and the building each surface under their
    // own group heading; the non-matching Maple Court does not.
    expect(await screen.findByText('Customers')).toBeInTheDocument();
    expect(screen.getByText('Sites')).toBeInTheDocument();
    expect(screen.getByText('Buildings')).toBeInTheDocument();
    // Exact name pins the customer's OWN row (its name also appears as the site
    // row's quiet customer line, which the exact match deliberately excludes).
    expect(screen.getByRole('option', { name: 'Beacon Retail' })).toHaveAttribute(
      'href',
      '/app/customers/c2',
    );
    expect(screen.getByRole('option', { name: /Beacon Mall/ })).toHaveAttribute(
      'href',
      '/app/customers/c2/sites/s2',
    );
    // The building row is distinguished from the job row (same building name) by
    // its detail line naming the site.
    expect(
      screen.getByRole('option', { name: /Beacon Tower Riverside Depot/ }),
    ).toHaveAttribute('href', '/app/customers/c1/sites/s1/buildings/b1');
    expect(screen.queryByRole('option', { name: /Maple Court/ })).not.toBeInTheDocument();
  });

  it('links a building result to its console page', async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('combobox'), 'maple');
    const option = await screen.findByRole('option', { name: /Maple Court/ });
    expect(option).toHaveAttribute(
      'href',
      '/app/customers/c1/sites/s1/buildings/b2',
    );
  });

  it('finds a job by its building and links to the job page', async () => {
    const user = userEvent.setup();
    renderSearch();
    // The job carries no name; it is found by its building (Beacon Tower).
    await user.type(screen.getByRole('combobox'), 'beacon tower');
    const jobsHeading = await screen.findByText('Jobs');
    expect(jobsHeading).toBeInTheDocument();
    const jobOption = screen
      .getAllByRole('option', { name: /Beacon Tower/ })
      .find((el) => el.getAttribute('href') === '/app/jobs/j1');
    expect(jobOption).toBeDefined();
  });

  it('moves the highlight with the arrow keys and navigates on Enter', async () => {
    const user = userEvent.setup();
    renderSearch();
    const input = screen.getByRole('combobox');
    await user.type(input, 'beacon');
    await screen.findByRole('option', { name: 'Beacon Retail' });

    // Flat order is Customers, Sites, Buildings, Jobs: index 0 is the customer,
    // one ArrowDown highlights the site, and Enter opens it.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/app/customers/c2/sites/s2',
    );
  });

  it('finds a staff member and links to their profile (admin)', async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('combobox'), 'dana');
    expect(await screen.findByText('Staff')).toBeInTheDocument();
    const option = screen.getByRole('option', { name: /Dana Field/ });
    expect(option).toHaveAttribute('href', '/app/staff/uid-dana');
  });

  it('finds a staff member and links to their profile (auditor)', async () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { auditor: true }, environment: 'test' };
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('combobox'), 'dana');
    expect(await screen.findByText('Staff')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Dana Field/ })).toHaveAttribute(
      'href',
      '/app/staff/uid-dana',
    );
  });

  it('does NOT surface staff for an assessor (staff search is admin/auditor oversight)', async () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { assessor: true }, environment: 'test' };
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('combobox'), 'dana');
    expect(screen.queryByText('Staff')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Dana Field/ })).not.toBeInTheDocument();
  });

  it('does NOT surface staff for a viewer (the directory is not theirs to read)', async () => {
    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { viewer: true },
      environment: 'test',
    };
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('combobox'), 'dana');
    // The estate still searches; the Staff group never appears for a viewer.
    expect(screen.queryByText('Staff')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Dana Field/ })).not.toBeInTheDocument();
  });

  it('states honestly when nothing matches', async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('combobox'), 'zzzznothing');
    expect(await screen.findByText(/No matches for/)).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('focuses the box on the Cmd/Ctrl+K shortcut', async () => {
    const user = userEvent.setup();
    renderSearch();
    const input = screen.getByRole('combobox');
    expect(input).not.toHaveFocus();
    await user.keyboard('{Control>}k{/Control}');
    expect(input).toHaveFocus();
  });
});

// --- Placement in the chrome -------------------------------------------------

describe('GlobalSearch placement', () => {
  function renderShellAt(url: string) {
    return render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/app/*" element={<ConsoleRoute />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('is present in the org console chrome', () => {
    mocks.superAdmin = 'denied';
    renderShellAt('/app/nowhere');
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: /Search customers/ }),
    ).toBeInTheDocument();
  });

  it('is absent from the platform operator surface', () => {
    mocks.superAdmin = 'granted';
    renderShellAt('/app/admin');
    // Platform mode is active (its rail replaced the org rail)...
    expect(screen.getByText('Platform console')).toBeInTheDocument();
    // ...and the search box does not follow the operator into it.
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
  });
});
