// ============================================================================
// Super-admin console tests (FR-E24): the gate fails closed without the
// superAdmin claim, the organisations overview renders names and live counts
// from the environment roots, and the operator-only create-organisation entry
// (story 2010, gated to the platform operator until Phase 3) opens the shared
// dialog, whose callable-then-session-refresh flow is tested here too.
//
// getIdTokenResult is mocked at the firebase/auth boundary (the hook reads the
// RAW token - see useSuperAdminClaim); the RTDB bridge mock routes by path so
// one test can serve the orgs root and each org's count nodes together.
// ============================================================================

import type { ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// --- Module mocks -------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: { uid: 'operator-1' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
    refreshSession: vi.fn(async () => undefined),
  },
  tokenClaims: {} as Record<string, unknown>,
  // Path-routed RTDB data: the mock query returns whatever the test registered
  // for the requested path.
  rtdbByPath: {} as Record<string, unknown>,
  callable: vi.fn(async (_name: string, _input: unknown) => ({}) as unknown),
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

vi.mock('firebase/auth', () => ({
  getIdTokenResult: vi.fn(async () => ({ claims: mocks.tokenClaims })),
}));

vi.mock('firebase/database', () => ({
  query: vi.fn(),
  orderByChild: vi.fn(),
  limitToLast: vi.fn(),
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

// The drill-down pages render RAG chips (RagChip -> useTheme); the console tests
// have no ThemeProvider, so supply the minimal palette riskPresentation reads.
vi.mock('../../design/ThemeProvider', () => ({
  useTheme: () => ({
    theme: {
      colors: { textMuted: '#666', surfaceSunken: '#eee' },
      rag: {
        red: '#b00',
        amber: '#a60',
        green: '#060',
        redSurface: '#fdd',
        amberSurface: '#fed',
        greenSurface: '#dfd',
      },
    },
  }),
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: (options: {
    path: string;
    select?: (value: unknown) => unknown;
  }) => {
    const raw = mocks.rtdbByPath[options.path];
    return {
      data: options.select ? options.select(raw ?? null) : raw,
      isLoading: false,
      isError: false,
    };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

vi.mock('../ui/useCallable', () => ({
  useCallable: (name: string) => ({
    call: (input: unknown) => mocks.callable(name, input),
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import { AdminRoutes } from './AdminRoutes';
import { PlatformDashboard } from './PlatformDashboard';
import { OrgCustomerDetail } from './OrgCustomerDetail';
import { OrgBuildingDetail } from './OrgBuildingDetail';
import { PlatformEnvProvider, usePlatformEnv } from './platformEnv';
import { CreateOrganisationDialog } from '../CreateOrganisationDialog';

beforeEach(() => {
  mocks.tokenClaims = {};
  mocks.rtdbByPath = {};
  mocks.auth.refreshSession.mockClear();
  mocks.callable.mockClear();
  mocks.callable.mockResolvedValue({});
  // The platform environment now persists in localStorage (see platformEnv), so
  // clear it between tests: a toggle in one test must never leak into the next.
  window.localStorage.clear();
});

function renderAdmin(url = '/') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AdminRoutes />
    </MemoryRouter>,
  );
}

/** A minimal stand-in for the platform rail toggle: it writes the shared
 *  provider through usePlatformEnv, so a test can flip the ONE env source and
 *  watch a page re-read. */
function EnvSwitch() {
  const { setEnv } = usePlatformEnv();
  return (
    <button type="button" onClick={() => setEnv('test')}>
      Use test
    </button>
  );
}

describe('AdminRoutes gate', () => {
  it('denies without the superAdmin claim', async () => {
    mocks.tokenClaims = {};
    renderAdmin();
    expect(
      await screen.findByText('This area is restricted to platform operators.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Platform')).not.toBeInTheDocument();
  });

  it('denies while signed out', async () => {
    mocks.auth.user = null;
    renderAdmin();
    expect(
      await screen.findByText('This area is restricted to platform operators.'),
    ).toBeInTheDocument();
    mocks.auth.user = { uid: 'operator-1' };
  });

  it('routes the index to the platform dashboard', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = { 'live/organisations': {} };
    renderAdmin('/');
    expect(
      await screen.findByRole('link', { name: /View all organisations/i }),
    ).toBeInTheDocument();
  });
});

describe('OrgsOverview', () => {
  it('renders organisations with live counts from the environment roots', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': {
        'org-a': { profile: { name: 'Alpha Fire Ltd' } },
        'org-b': { profile: { name: 'Bravo Safety' } },
      },
      'live/orgMembers/org-a': { u1: {}, u2: {}, u3: {} },
      'live/orgMembers/org-b': { u1: {} },
      'live/customers/org-a': { c1: {}, c2: {} },
      'live/buildings/org-a': {
        's1': { b1: {}, b2: {} },
        's2': { b3: {} },
      },
    };
    renderAdmin('/organisations');

    expect(await screen.findByText('Alpha Fire Ltd')).toBeInTheDocument();
    expect(screen.getByText('Bravo Safety')).toBeInTheDocument();
    // Counts: 3 members, 2 customers, 3 buildings (flattened across sites).
    const table = screen.getByRole('table', { name: 'Organisations' });
    expect(table).toHaveTextContent('3');
    expect(table).toHaveTextContent('2');
    // Every admin screen states its read-only posture.
    expect(
      screen.getByText('Read-only oversight; counts are live.'),
    ).toBeInTheDocument();
  });

  it('sorts by a count column when its header button is chosen', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': {
        'org-a': { profile: { name: 'Alpha Fire Ltd' } },
        'org-b': { profile: { name: 'Bravo Safety' } },
      },
      // Bravo has MORE members than Alpha, so a members sort (largest first)
      // must invert the default name order.
      'live/orgMembers/org-a': { u1: {} },
      'live/orgMembers/org-b': { u1: {}, u2: {}, u3: {} },
    };
    renderAdmin('/organisations');

    const table = await screen.findByRole('table', { name: 'Organisations' });
    const namesInOrder = () =>
      within(table)
        .getAllByRole('row')
        .slice(1) // drop the header row
        .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

    // Default: A to Z by name.
    expect(namesInOrder()).toEqual(['Alpha Fire Ltd', 'Bravo Safety']);

    await userEvent.click(screen.getByRole('button', { name: 'Members' }));
    expect(namesInOrder()).toEqual(['Bravo Safety', 'Alpha Fire Ltd']);

    // Choosing the active column again flips the direction.
    await userEvent.click(screen.getByRole('button', { name: /Members/ }));
    expect(namesInOrder()).toEqual(['Alpha Fire Ltd', 'Bravo Safety']);
  });

  it('offers the operator-only create entry on the overview, and opens the dialog', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = { 'live/organisations': {} };
    renderAdmin('/organisations');

    const createButton = await screen.findByRole('button', {
      name: 'Create organisation',
    });
    await userEvent.click(createButton);
    expect(
      screen.getByRole('dialog', { name: 'Create an organisation' }),
    ).toBeInTheDocument();
  });

  it('does not offer the create entry on the activity sub-page', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': {
        'org-a': { profile: { name: 'Alpha Fire Ltd' } },
      },
      'live/activity/org-a': {
        e1: {
          at: 1_700_000_000_000,
          action: 'assessment.stage.released',
          target: 'as-1',
          actorUid: 'u1',
        },
      },
    };
    renderAdmin('/activity');

    // Generous timeout: under full-suite load the activity page can settle
    // slowly; the positive anchor must be present before asserting absence.
    await screen.findByLabelText('Event type', {}, { timeout: 10_000 });
    expect(
      screen.queryByRole('button', { name: 'Create organisation' }),
    ).not.toBeInTheDocument();
  });
});

// --- The create-organisation dialog (moved here with its operator-only home) ---

describe('CreateOrganisationDialog', () => {
  it('calls createOrganisation, then refreshes the session', async () => {
    const user = userEvent.setup();
    mocks.callable.mockResolvedValue({ orgId: 'org-new' });
    render(
      <MemoryRouter>
        <CreateOrganisationDialog onClose={vi.fn()} />
      </MemoryRouter>,
    );
    const nameField = screen.getByLabelText('Organisation name');
    // Focus lands in the name field on open.
    expect(nameField).toHaveFocus();
    await user.type(nameField, 'Blundell Fire Ltd');
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));
    expect(mocks.callable).toHaveBeenCalledWith('createOrganisation', {
      name: 'Blundell Fire Ltd',
    });
    await waitFor(() => expect(mocks.auth.refreshSession).toHaveBeenCalled());
  });

  it('requires a name and does not call the callable without one', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateOrganisationDialog onClose={vi.fn()} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Create organisation' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a name for your organisation.',
    );
    expect(mocks.callable).not.toHaveBeenCalled();
  });
});

describe('PlatformDashboard', () => {
  // A recent invitation timestamp, so the growth chart plots a real point
  // (createdAt in the current month) rather than the honest empty state.
  const RECENT = Date.now();

  function renderDashboard() {
    return render(
      <MemoryRouter>
        <PlatformDashboard />
      </MemoryRouter>,
    );
  }

  /** The stat tile carrying `label`: its label and value are siblings inside the
   *  same tile element, so we scope value assertions to that tile. */
  function tile(label: string) {
    return within(screen.getByText(label).closest('div') as HTMLElement);
  }

  it('aggregates the stat tiles across every organisation', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': {
        'org-a': { profile: { name: 'Alpha Fire Ltd' } },
        'org-b': { profile: { name: 'Bravo Safety' } },
      },
      // Members sum to 4 across the two orgs; customers 5; buildings 3.
      'live/orgMembers/org-a': { u1: {}, u2: {}, u3: {} },
      'live/orgMembers/org-b': { u1: {} },
      'live/customers/org-a': { c1: {}, c2: {}, c3: {} },
      'live/customers/org-b': { c1: {}, c2: {} },
      'live/buildings/org-a': { s1: { b1: {}, b2: {} }, s2: { b3: {} } },
    };
    renderDashboard();

    // Organisations counts the org list; the rest are running sums of the
    // per-org reporter values.
    await waitFor(() =>
      expect(tile('Organisations').getByText('2')).toBeInTheDocument(),
    );
    expect(tile('Members').getByText('4')).toBeInTheDocument();
    expect(tile('Customers').getByText('5')).toBeInTheDocument();
    expect(tile('Buildings').getByText('3')).toBeInTheDocument();
  });

  it('plots members invited per month, never "users over time"', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': {
        'org-a': { profile: { name: 'Alpha Fire Ltd' } },
      },
      'live/orgInvitations/org-a': {
        i1: { email: 'a@x.co', createdAt: RECENT },
        i2: { email: 'b@x.co', createdAt: RECENT },
      },
    };
    renderDashboard();

    // The card title, the chart's accessible name and the table all say
    // "invited"; nothing claims "users over time", which the schema cannot prove.
    expect(
      await screen.findByRole('heading', { name: 'Members invited per month' }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('img', { name: /Members invited per month/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Members invited')).toBeInTheDocument();
    expect(screen.queryByText(/users over time/i)).not.toBeInTheDocument();
  });

  it('shows the revenue preview as an honest, tagged preview', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = { 'live/organisations': {} };
    renderDashboard();

    expect(await screen.findByText('Preview')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Billing is not yet active. These figures are illustrative and populate once subscriptions go live in a later phase.',
      ),
    ).toBeInTheDocument();
  });

  it('switches the reads when the shared platform environment changes', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': { 'org-a': { profile: { name: 'Alpha Fire Ltd' } } },
      'live/orgMembers/org-a': { u1: {}, u2: {}, u3: {}, u4: {} },
      'test/organisations': { 'org-t': { profile: { name: 'Test Org' } } },
      'test/orgMembers/org-t': { u1: {}, u2: {}, u3: {}, u4: {}, u5: {}, u6: {}, u7: {} },
    };
    // The toggle no longer lives on the page; it writes the shared provider,
    // which the dashboard reads. A tiny harness stands in for the rail toggle so
    // this proves the page re-reads when the ONE env source changes.
    render(
      <MemoryRouter>
        <PlatformEnvProvider>
          <EnvSwitch />
          <PlatformDashboard />
        </PlatformEnvProvider>
      </MemoryRouter>,
    );

    // Live: 4 members. Switching to Test re-reads the test root: 7 members.
    await waitFor(() =>
      expect(tile('Members').getByText('4')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Use test' }));
    await waitFor(() =>
      expect(tile('Members').getByText('7')).toBeInTheDocument(),
    );
  });

  it('makes each stat tile a link to its platform-wide list', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': { 'org-a': { profile: { name: 'Alpha Fire Ltd' } } },
    };
    renderDashboard();

    // The tiles keep their numbers.
    await waitFor(() =>
      expect(tile('Organisations').getByText('1')).toBeInTheDocument(),
    );

    // Each tile is a whole-tile link to its list route.
    const byHref = (href: string) =>
      screen.getAllByRole('link').find((link) => link.getAttribute('href') === href);
    expect(byHref('/app/admin/organisations')).toBeTruthy();
    expect(byHref('/app/admin/members')).toBeTruthy();
    expect(byHref('/app/admin/buildings')).toBeTruthy();
    expect(byHref('/app/admin/customers')).toBeTruthy();
  });
});

describe('PlatformActivity', () => {
  it('filters the loaded entries by event type', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': {
        'org-a': { profile: { name: 'Alpha Fire Ltd' } },
      },
      'live/activity/org-a': {
        e1: {
          at: 1_700_000_000_000,
          action: 'assessment.stage.released',
          target: 'as-1',
          actorUid: 'u1',
        },
        e2: {
          at: 1_700_000_100_000,
          action: 'member.updated (roles)',
          target: 'u2',
          actorUid: 'u1',
        },
      },
    };
    renderAdmin('/activity');

    // Both entries show unfiltered as humanised phrases (the raw code stays on
    // the cell's title), and the select offers their grouped categories.
    expect(
      await screen.findByText('Released an assessment'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Updated a staff member (roles)'),
    ).toBeInTheDocument();

    await userEvent.selectOptions(
      await screen.findByLabelText('Event type'),
      'Members',
    );
    expect(
      screen.queryByText('Released an assessment'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('Updated a staff member (roles)'),
    ).toBeInTheDocument();
  });
});

// --- The super-admin drill-down (OrgDetail customers -> customer -> building) ---

describe('OrgDetail customers section', () => {
  it('lists the organisation customers and links each to its customer page', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations/org-a': { profile: { name: 'Alpha Fire Ltd' } },
      'live/orgMembers/org-a': { u1: {} },
      'live/customers/org-a': {
        c1: { name: 'Acme Retail', status: 'active', email: 'ops@acme.co' },
        c2: { name: 'Borough Council', status: 'active' },
      },
      'live/activity/org-a': {},
    };
    renderAdmin('/org-a');

    // Breadcrumbs: Platform / <org>.
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Platform')).toBeInTheDocument();
    expect(within(crumbs).getByText('Alpha Fire Ltd')).toBeInTheDocument();

    // The customer links point at the customer drill-down route.
    const link = screen.getByRole('link', { name: 'Acme Retail' });
    expect(link).toHaveAttribute(
      'href',
      '/app/admin/org-a/customers/c1',
    );
    expect(screen.getByText('Borough Council')).toBeInTheDocument();

    // Read-only: no create/edit/archive affordances anywhere on the page.
    expect(
      screen.queryByRole('button', { name: 'Create organisation' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Archive/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the empty state when the organisation has no customers', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations/org-a': { profile: { name: 'Alpha Fire Ltd' } },
      'live/orgMembers/org-a': { u1: {} },
      'live/activity/org-a': {},
    };
    renderAdmin('/org-a');
    expect(
      await screen.findByText('This organisation has no customers.'),
    ).toBeInTheDocument();
  });
});

function renderAt(element: ReactNode, url: string, path: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={path} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrgCustomerDetail', () => {
  const CUSTOMER_PATH = '/:orgId/customers/:customerId';

  it('lists sites and their buildings, each linking to the building page', async () => {
    mocks.rtdbByPath = {
      'live/organisations/org-a/profile': { name: 'Alpha Fire Ltd' },
      'live/customers/org-a/c1': { name: 'Acme Retail', status: 'active' },
      'live/sites/org-a/c1': {
        s1: { name: 'Head Office', address: '1 High St' },
      },
      'live/buildings/org-a': {
        s1: { b1: { name: 'Tower A', riskLevel: 'high' } },
      },
    };
    renderAt(<OrgCustomerDetail />, '/org-a/customers/c1', CUSTOMER_PATH);

    // Breadcrumbs: Platform / <org> / <customer>.
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Platform')).toBeInTheDocument();
    expect(within(crumbs).getByText('Alpha Fire Ltd')).toBeInTheDocument();
    expect(within(crumbs).getByText('Acme Retail')).toBeInTheDocument();

    expect(screen.getByText('Head Office')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Tower A' });
    expect(link).toHaveAttribute(
      'href',
      '/app/admin/org-a/customers/c1/buildings/s1/b1',
    );

    // Read-only: none of the tenant SiteDetail mutation controls exist.
    expect(
      screen.queryByRole('link', { name: /Add site/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Add building/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });

  it('shows the per-site empty state when a site has no buildings', async () => {
    mocks.rtdbByPath = {
      'live/organisations/org-a/profile': { name: 'Alpha Fire Ltd' },
      'live/customers/org-a/c1': { name: 'Acme Retail', status: 'active' },
      'live/sites/org-a/c1': { s1: { name: 'Head Office' } },
      'live/buildings/org-a': {},
    };
    renderAt(<OrgCustomerDetail />, '/org-a/customers/c1', CUSTOMER_PATH);
    expect(
      await screen.findByText('No buildings recorded for this site.'),
    ).toBeInTheDocument();
  });
});

describe('OrgBuildingDetail', () => {
  const BUILDING_PATH =
    '/:orgId/customers/:customerId/buildings/:siteId/:buildingId';
  const BUILDING_URL = '/org-a/customers/c1/buildings/s1/b1';

  it('shows the assessment history, reports note and breadcrumbs, read-only', async () => {
    mocks.rtdbByPath = {
      'live/organisations/org-a/profile': { name: 'Alpha Fire Ltd' },
      'live/customers/org-a/c1': { name: 'Acme Retail', status: 'active' },
      'live/sites/org-a/c1/s1': { name: 'Head Office' },
      'live/buildings/org-a/s1/b1': {
        name: 'Tower A',
        customerId: 'c1',
        riskLevel: 'high',
      },
      'live/assessments/org-a': {
        a1: {
          buildingId: 'b1',
          status: 'released',
          conductedAt: 1_700_000_000_000,
          conductedBy: 'u1',
          workflow: { releasedBy: 'u1' },
        },
      },
      'live/reports/org-a/building/b1': {
        r1: { pdfPath: 'x/y.pdf', generatedAt: 1_700_000_000_000, assessmentId: 'a1' },
      },
      'live/orgMembers/org-a': { u1: { name: 'Jo Assessor' } },
    };
    renderAt(<OrgBuildingDetail />, BUILDING_URL, BUILDING_PATH);

    // Breadcrumbs: Platform / <org> / <customer> / <building>.
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Platform')).toBeInTheDocument();
    expect(within(crumbs).getByText('Alpha Fire Ltd')).toBeInTheDocument();
    expect(within(crumbs).getByText('Acme Retail')).toBeInTheDocument();
    expect(within(crumbs).getByText('Tower A')).toBeInTheDocument();

    // Assessment history: stage label, conductor name, release attribution.
    const history = screen.getByRole('table', { name: 'Assessment history' });
    expect(within(history).getByText('Released')).toBeInTheDocument();
    expect(within(history).getAllByText('Jo Assessor').length).toBeGreaterThan(0);

    // Reports: metadata plus the honest owning-org note (no download link).
    expect(screen.getByText(/Generated/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /The report PDF is opened from within the owning organisation/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Download' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Regenerate/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Edit/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the empty state when the building has no assessments', async () => {
    mocks.rtdbByPath = {
      'live/organisations/org-a/profile': { name: 'Alpha Fire Ltd' },
      'live/customers/org-a/c1': { name: 'Acme Retail', status: 'active' },
      'live/sites/org-a/c1/s1': { name: 'Head Office' },
      'live/buildings/org-a/s1/b1': {
        name: 'Tower A',
        customerId: 'c1',
        riskLevel: 'pending',
      },
      'live/orgMembers/org-a': {},
    };
    renderAt(<OrgBuildingDetail />, BUILDING_URL, BUILDING_PATH);
    expect(
      await screen.findByText('No assessments recorded for this building.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No reports have been released for this building.'),
    ).toBeInTheDocument();
  });
});

// --- The platform-wide list pages (members / buildings / customers) -----------
// Each aggregates across every org via the /members, /buildings, /customers
// routes, so rendering AdminRoutes at those paths also proves the routes
// resolve (they must win over the ":orgId" dynamic route).

describe('PlatformMembers', () => {
  it('aggregates members across organisations, links to the org, and survives a member with no roles', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': {
        'org-a': { profile: { name: 'Alpha Fire Ltd' } },
        'org-b': { profile: { name: 'Bravo Safety' } },
      },
      'live/orgMembers/org-a': {
        u1: {
          name: 'Ada Byron',
          email: 'ada@x.co',
          roles: { admin: true, assessor: true },
          status: 'active',
        },
      },
      // No `roles` field at all: the page must render this row without chips
      // and never crash (the bug that just bit the tenant staff page).
      'live/orgMembers/org-b': {
        u2: { name: 'Noel NoRoles', email: 'noel@x.co', status: 'active' },
      },
    };
    renderAdmin('/members');

    // Aggregated across both organisations.
    expect(await screen.findByText('Ada Byron')).toBeInTheDocument();
    expect(screen.getByText('Noel NoRoles')).toBeInTheDocument();

    // Roles render as text chips (colour is never the sole carrier). Scoped to
    // the table: the role filter's select offers the same labels as options.
    const membersTable = screen.getByRole('table', { name: 'Members' });
    expect(within(membersTable).getByText('Administrator')).toBeInTheDocument();
    expect(within(membersTable).getByText('Assessor')).toBeInTheDocument();
    // The role-less member reads honestly rather than throwing.
    expect(within(membersTable).getByText('No roles')).toBeInTheDocument();

    // The row links to its organisation's detail page.
    expect(
      screen.getByRole('link', { name: 'Alpha Fire Ltd' }),
    ).toHaveAttribute('href', '/app/admin/org-a');
  });

  it('shows the honest empty state when no organisation holds members', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': { 'org-a': { profile: { name: 'Alpha Fire Ltd' } } },
    };
    renderAdmin('/members');
    expect(
      await screen.findByText('No members found in this environment.'),
    ).toBeInTheDocument();
  });
});

describe('PlatformBuildings', () => {
  it('aggregates buildings, shows the stored RAG level, and links to the drill-down', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': { 'org-a': { profile: { name: 'Alpha Fire Ltd' } } },
      'live/buildings/org-a': {
        s1: {
          b1: { name: 'Tower A', customerId: 'c1', riskLevel: 'high' },
          // No customerId: the row falls back to the org detail, never a broken
          // link.
          b2: { name: 'Tower B', riskLevel: 'low' },
        },
      },
    };
    renderAdmin('/buildings');

    expect(await screen.findByText('Tower A')).toBeInTheDocument();
    expect(screen.getByText('Tower B')).toBeInTheDocument();
    // The stored risk level, presented (never re-derived). Scoped to the table
    // because the risk filter reuses the same "High risk" label as its chip.
    expect(
      within(screen.getByRole('table', { name: 'Buildings' })).getByText('High risk'),
    ).toBeInTheDocument();

    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toContain(
      '/app/admin/org-a/customers/c1/buildings/s1/b1',
    );
    // The customerId-less building falls back to the organisation detail.
    expect(hrefs).toContain('/app/admin/org-a');
  });

  it('shows the honest empty state when no organisation holds buildings', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': { 'org-a': { profile: { name: 'Alpha Fire Ltd' } } },
    };
    renderAdmin('/buildings');
    expect(
      await screen.findByText('No buildings found in this environment.'),
    ).toBeInTheDocument();
  });
});

describe('PlatformCustomers', () => {
  it('aggregates customers across organisations and links each to its customer page', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': {
        'org-a': { profile: { name: 'Alpha Fire Ltd' } },
        'org-b': { profile: { name: 'Bravo Safety' } },
      },
      'live/customers/org-a': { c1: { name: 'Acme Retail', status: 'active' } },
      'live/customers/org-b': {
        c2: { name: 'Borough Council', status: 'active' },
      },
    };
    renderAdmin('/customers');

    expect(await screen.findByText('Acme Retail')).toBeInTheDocument();
    expect(screen.getByText('Borough Council')).toBeInTheDocument();

    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toContain('/app/admin/org-a/customers/c1');
    expect(hrefs).toContain('/app/admin/org-b/customers/c2');
  });

  it('shows the honest empty state when no organisation holds customers', async () => {
    mocks.tokenClaims = { superAdmin: true };
    mocks.rtdbByPath = {
      'live/organisations': { 'org-a': { profile: { name: 'Alpha Fire Ltd' } } },
    };
    renderAdmin('/customers');
    expect(
      await screen.findByText('No customers found in this environment.'),
    ).toBeInTheDocument();
  });
});
