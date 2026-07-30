// ============================================================================
// Organisation dashboard tests (story 2035, FR-E19).
//
// Mocked at the same module boundaries as console.test.tsx: the auth contract,
// the RTDB bridge (fixture data by query key, no sockets) and the theme. The
// fixtures are shaped exactly as the org-root reads deliver them
// (/buildings/{orgId} nested by site, /actions/{orgId} nested by building),
// so the flatten/count derivations are exercised for real.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { forEnv } from '../paths';
import type { SessionClaims } from '../auth/claims';
import type {
  Action,
  ActivityEntry,
  Assessment,
  Building,
  Customer,
  Job,
  OrgMember,
  Report,
  Template,
} from '../types';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'member' as string,
      user: { uid: 'user-1', displayName: 'Jane Doe' } as unknown,
      claims: null as unknown,
      paths: null as unknown,
    },
    fixtures: {
      buildingsRoot: {} as Record<string, Record<string, Building>>,
      actionsRoot: {} as Record<string, Record<string, Action>>,
      activity: [] as Array<ActivityEntry & { id: string }>,
      members: {} as Record<string, OrgMember>,
      profile: { name: 'Acme Fire Safety' } as unknown,
      /** Already ordered, as the ConsoleHome selector would deliver them. */
      releases: [] as Array<Assessment & { id: string }>,
      jobs: {} as Record<string, Job>,
      buildings: {} as Record<string, Building>,
      customers: {} as Record<string, Customer>,
      /** Keyed by buildingId, matching the building-scoped reports node. */
      reports: {} as Record<string, Record<string, Report>>,
    },
    getDownloadURL: vi.fn(async () => 'https://example.com/report.pdf'),
  };
});

vi.mock('../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

// The report affordance resolves a Storage path to a tokened URL; mocked at the
// SDK boundary so the card renders without touching Storage.
vi.mock('firebase/storage', () => ({
  ref: vi.fn(),
  getDownloadURL: () => mocks.getDownloadURL(),
}));

vi.mock('../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../design/ThemeProvider', () => ({
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

// Fixture data served by query key, mirroring what the live listeners would
// deliver for each path. The 'root' discriminator selects the org-root nodes.
vi.mock('../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly unknown[] }) => {
    const fixtures = mocks.fixtures;
    let data: unknown;
    switch (key[0]) {
      case 'orgProfile':
        data = fixtures.profile;
        break;
      case 'buildings':
        data = key[2] === 'root' ? fixtures.buildingsRoot : null;
        break;
      case 'actions':
        data = key[2] === 'root' ? fixtures.actionsRoot : null;
        break;
      case 'activity':
        data = fixtures.activity;
        break;
      case 'orgMembers':
        data = fixtures.members;
        break;
      // The releases card's own bounded window, plus the cached single-node
      // reads each row resolves through.
      case 'assessments':
        data = fixtures.releases;
        break;
      case 'jobs':
        data = fixtures.jobs[String(key[2])] ?? null;
        break;
      case 'building':
        data = fixtures.buildings[String(key[3])] ?? null;
        break;
      case 'customer':
        data = fixtures.customers[String(key[2])] ?? null;
        break;
      case 'reports':
        data = fixtures.reports[String(key[3])] ?? null;
        break;
      default:
        data = null;
    }
    return { data, isLoading: false, isError: false };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

import { ConsoleHome } from './ConsoleHome';

// --- Fixtures ----------------------------------------------------------------

const adminClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

const viewerClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { viewer: true },
  environment: 'test',
};

function setClaims(claims: SessionClaims) {
  mocks.auth.claims = claims;
  mocks.auth.paths = forEnv(claims.environment);
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <ConsoleHome />
    </MemoryRouter>,
  );
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function building(overrides: Partial<Building>): Building {
  return { name: 'Unit', customerId: 'c1', riskLevel: 'low', ...overrides };
}

function action(overrides: Partial<Action>): Action {
  return {
    assessmentId: 'a1',
    sectionCode: 's1',
    question: 'Q',
    observation: 'O',
    severity: 'M',
    lifeProtection: false,
    status: 'open',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setClaims(adminClaims);
  mocks.fixtures.buildingsRoot = {
    site1: {
      b1: building({ name: 'North Tower', riskLevel: 'high' }),
      b2: building({ name: 'South Annex', riskLevel: 'medium' }),
    },
    site2: {
      b3: building({ name: 'Depot', riskLevel: 'medium' }),
      b4: building({ name: 'Gatehouse', riskLevel: 'pending' }),
    },
  };
  mocks.fixtures.actionsRoot = {};
  mocks.fixtures.activity = [];
  mocks.fixtures.members = {};
  mocks.fixtures.releases = [];
  mocks.fixtures.jobs = {};
  mocks.fixtures.buildings = {};
  mocks.fixtures.customers = {};
  mocks.fixtures.reports = {};
});

// --- Buildings-by-risk stat tiles ---------------------------------------------

describe('ConsoleHome risk tiles', () => {
  it('renders the estate band through the shared ComplianceGlance component', () => {
    renderHome();
    // The band is one labelled region; its risk and escalation tiles live
    // inside it (the same component every detail page now mounts).
    const band = screen.getByRole('region', { name: 'Compliance at a glance' });
    expect(
      within(band).getByRole('link', { name: /High risk/ }),
    ).toBeInTheDocument();
    expect(
      within(band).getByRole('img', { name: /Estate risk distribution/ }),
    ).toBeInTheDocument();
  });

  it('counts buildings by stored risk level and drills through to the filtered directory', () => {
    renderHome();
    const high = screen.getByRole('link', { name: /High risk/ });
    expect(high).toHaveTextContent('1');
    expect(high).toHaveAttribute('href', '/app/customers?risk=high');
    const medium = screen.getByRole('link', { name: /Medium risk/ });
    expect(medium).toHaveTextContent('2');
    expect(medium).toHaveAttribute('href', '/app/customers?risk=medium');
    expect(screen.getByRole('link', { name: /Low risk/ })).toHaveAttribute(
      'href',
      '/app/customers?risk=low',
    );
    expect(
      screen.getByRole('link', { name: /Not yet assessed/ }),
    ).toHaveAttribute('href', '/app/customers?risk=pending');
  });

  it('renders for a viewer too: every roll-up node is org-readable', () => {
    setClaims(viewerClaims);
    renderHome();
    expect(screen.getByRole('link', { name: /High risk/ })).toHaveTextContent('1');
    // A viewer gets read-only shortcuts, never the admin's create actions.
    expect(
      screen.getByRole('heading', { name: 'Quick actions' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'High-risk customers' }),
    ).toHaveAttribute('href', '/app/customers?risk=high');
    expect(
      screen.getByRole('link', { name: 'Customers with overdue actions' }),
    ).toHaveAttribute('href', '/app/customers?overdue=1');
    expect(screen.queryByRole('link', { name: 'New customer' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Schedule a job' })).toBeNull();
  });
});

// --- Estate risk distribution bar ------------------------------------------------

describe('ConsoleHome risk distribution bar', () => {
  it('narrates the estate mix with counts, never colour alone', () => {
    renderHome();
    // 1 high, 2 medium, 0 low, 1 pending from the beforeEach fixtures.
    expect(
      screen.getByRole('img', {
        name: 'Estate risk distribution across 4 buildings: 1 high risk, 2 medium risk, 0 low risk, 1 not yet assessed.',
      }),
    ).toBeInTheDocument();
  });

  it('shows an honest empty state for a zero-building organisation', () => {
    mocks.fixtures.buildingsRoot = {};
    renderHome();
    expect(screen.getByText(/No buildings yet/)).toBeInTheDocument();
    expect(
      screen.queryByRole('img', { name: /Estate risk distribution/ }),
    ).toBeNull();
  });
});

// --- Overdue action derivation -------------------------------------------------

describe('ConsoleHome overdue tiles', () => {
  it('counts open past-due actions, escalating the Life Protection subset', () => {
    mocks.fixtures.actionsRoot = {
      b1: {
        x1: action({ dueBy: NOW - 2 * DAY }), // overdue
        x2: action({ dueBy: NOW - DAY, lifeProtection: true }), // overdue + LTP
        x3: action({ dueBy: NOW + 5 * DAY }), // not due yet
      },
      b2: {
        x4: action({ dueBy: NOW - 9 * DAY, status: 'signedOff' }), // closed
        x5: action({}), // no due date: never overdue
      },
    };
    renderHome();
    const overdueTile = screen
      .getByText('Overdue actions')
      .closest('div') as HTMLElement;
    expect(within(overdueTile).getByText('2')).toBeInTheDocument();
    const ltpTile = screen
      .getByText('Life Protection overdue')
      .closest('div') as HTMLElement;
    expect(within(ltpTile).getByText('1')).toBeInTheDocument();
    // Both escalation tiles drill through to the overdue-filtered directory.
    expect(
      screen.getByRole('link', { name: /Overdue actions/ }),
    ).toHaveAttribute('href', '/app/customers?overdue=1');
    expect(
      screen.getByRole('link', { name: /Life Protection overdue/ }),
    ).toHaveAttribute('href', '/app/customers?overdue=1');
  });
});

// --- Upcoming reviews ------------------------------------------------------------

describe('ConsoleHome upcoming reviews', () => {
  it('lists reviews within 60 days with lapsed pinned first, and links each building', () => {
    mocks.fixtures.buildingsRoot = {
      site1: {
        b1: building({
          name: 'North Tower',
          riskLevel: 'high',
          serviceSchedule: { fraReview: { nextDue: NOW + 10 * DAY } },
        }),
        b2: building({
          name: 'South Annex',
          riskLevel: 'medium',
          serviceSchedule: { fraReview: { nextDue: NOW - 5 * DAY } },
        }),
      },
      site2: {
        b3: building({
          name: 'Depot',
          serviceSchedule: { fraReview: { nextDue: NOW + 90 * DAY } },
        }),
        b4: building({ name: 'Gatehouse' }),
      },
    };
    renderHome();
    const card = screen
      .getByRole('heading', { name: 'Upcoming reviews' })
      .closest('section') as HTMLElement;
    const rows = within(card).getAllByRole('listitem');
    // Beyond the horizon (Depot) and unscheduled (Gatehouse) are absent.
    expect(rows).toHaveLength(2);
    // Lapsed first, stated in words, then the upcoming one.
    expect(rows[0]).toHaveTextContent('South Annex');
    expect(rows[0]).toHaveTextContent(/Lapsed/);
    expect(rows[1]).toHaveTextContent('North Tower');
    expect(rows[1]).toHaveTextContent(/Due/);
    // Colour is never alone: the RAG chip carries its label.
    expect(rows[0]).toHaveTextContent('Medium risk');
    // Drill-through to the building URL built from customerId + nesting keys.
    expect(within(rows[0]).getByRole('link')).toHaveAttribute(
      'href',
      '/app/customers/c1/sites/site1/buildings/b2',
    );
  });

  it('states the empty case rather than hiding the card', () => {
    renderHome();
    expect(
      screen.getByText(/No FRA reviews are lapsed or due/),
    ).toBeInTheDocument();
  });
});

// --- Recent releases --------------------------------------------------------------

const templateSnapshot: Template = {
  name: 'PAS 79 Fire Risk Assessment',
  version: 3,
  status: 'published',
  standard: 'pas79',
  sections: [],
};

function release(overrides: Partial<Assessment> & { id: string }): Assessment & {
  id: string;
} {
  return {
    jobId: 'job-1',
    buildingId: 'b1',
    customerId: 'c-1',
    templateSnapshot,
    conductedBy: 'u1',
    conductedAt: NOW - 5 * DAY,
    status: 'released',
    workflow: { releasedAt: NOW - 1000, releasedBy: 'u1' },
    ...overrides,
  };
}

/** The joins one released row resolves: job -> siteId -> building, and the
 *  customer record. */
function seedRowContext() {
  mocks.fixtures.jobs = {
    'job-1': { siteId: 'site1' } as unknown as Job,
  };
  mocks.fixtures.buildings = {
    b1: building({ name: 'North Tower', riskLevel: 'high' }),
  };
  mocks.fixtures.customers = {
    'c-1': { name: 'Meridian Estates' } as unknown as Customer,
  };
  mocks.fixtures.members = { u1: { name: 'Jane Doe' } as unknown as OrgMember };
}

function releasesCard(): HTMLElement {
  return screen
    .getByRole('heading', { name: 'Recent releases' })
    .closest('section') as HTMLElement;
}

describe('ConsoleHome recent releases', () => {
  it('tells each release in full: building, customer, template and attribution', () => {
    seedRowContext();
    mocks.fixtures.releases = [release({ id: 'as-9' })];
    renderHome();

    const card = releasesCard();
    // The building is the headline, linking into its own record.
    expect(
      within(card).getByRole('link', { name: 'North Tower' }),
    ).toHaveAttribute('href', '/app/customers/c-1/sites/site1/buildings/b1');
    // Customer and the pinned template (with its standard) on the meta line.
    expect(card).toHaveTextContent(
      'Meridian Estates · PAS 79 Fire Risk Assessment v3 · PAS 79',
    );
    // Attribution names the releaser, not a raw uid.
    expect(card).toHaveTextContent(/Released .* by Jane Doe/);
  });

  it('offers the report as a labelled download once it has been generated', async () => {
    seedRowContext();
    mocks.fixtures.releases = [release({ id: 'as-9' })];
    mocks.fixtures.reports = {
      b1: {
        'rep-1': {
          pdfPath: 'orgs/org-1/reports/rep-1.pdf',
          generatedAt: NOW - 500,
          assessmentId: 'as-9',
        },
      },
    };
    renderHome();

    // The control names WHAT it downloads, not a bare "Download".
    const link = await screen.findByRole('link', {
      name: 'Download PDF for North Tower',
    });
    expect(link).toHaveAttribute('href', 'https://example.com/report.pdf');
  });

  it('states that the report is not ready rather than offering a dead button', () => {
    seedRowContext();
    mocks.fixtures.releases = [release({ id: 'as-9' })];
    // The building has reports, but none for THIS assessment: generation is
    // asynchronous and trails the release.
    mocks.fixtures.reports = {
      b1: {
        'rep-old': {
          pdfPath: 'orgs/org-1/reports/rep-old.pdf',
          generatedAt: NOW - 90 * DAY,
          assessmentId: 'as-1',
        },
      },
    };
    renderHome();

    const card = releasesCard();
    expect(within(card).getByText(/Report not ready/)).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Download PDF/ })).toBeNull();
  });

  it('offers an unattributed legacy report, captioned as not linked to this assessment', async () => {
    seedRowContext();
    mocks.fixtures.releases = [release({ id: 'as-9' })];
    // A report predating Report.assessmentId. The building's own page lists and
    // downloads it, so claiming "not ready" here would contradict that screen -
    // but it cannot be passed off as this assessment's either.
    mocks.fixtures.reports = {
      b1: {
        'rep-legacy': {
          pdfPath: 'orgs/org-1/reports/rep-legacy.pdf',
          generatedAt: NOW - 30 * DAY,
        },
      },
    };
    renderHome();

    const link = await screen.findByRole('link', {
      name: /Download PDF for North Tower/,
    });
    expect(link).toHaveAttribute('href', 'https://example.com/report.pdf');
    expect(
      within(releasesCard()).getByText(/Not linked to this assessment/),
    ).toBeInTheDocument();
  });

  it('degrades a dangling building and customer to their ids', () => {
    mocks.fixtures.members = { u1: { name: 'Jane Doe' } as unknown as OrgMember };
    mocks.fixtures.releases = [release({ id: 'as-9' })];
    renderHome();

    const card = releasesCard();
    // No job node, so no honest building URL: the id stands in as plain text.
    expect(within(card).getByText('b1')).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: 'b1' })).toBeNull();
    expect(card).toHaveTextContent('c-1 · PAS 79 Fire Risk Assessment v3 · PAS 79');
  });

  it('states the empty case rather than hiding the card', () => {
    renderHome();
    expect(
      within(releasesCard()).getByText(
        'No assessments have been released recently.',
      ),
    ).toBeInTheDocument();
  });

  it('exposes a View-all affordance into the releases list for an auditor', () => {
    setClaims({
      orgId: 'org-1',
      roles: { auditor: true },
      environment: 'test',
    } as SessionClaims);
    renderHome();
    expect(
      within(releasesCard()).getByRole('link', { name: 'View all' }),
    ).toHaveAttribute('href', '/app/validation/released');
  });

  it('withholds the View-all link from a viewer who cannot reach the list', () => {
    setClaims(viewerClaims);
    renderHome();
    expect(
      within(releasesCard()).queryByRole('link', { name: 'View all' }),
    ).toBeNull();
  });
});
