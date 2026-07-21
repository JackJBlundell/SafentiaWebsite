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
import type { Action, ActivityEntry, Building, OrgMember } from '../types';

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
    },
  };
});

vi.mock('../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn() },
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

describe('ConsoleHome recent releases', () => {
  it('filters the activity window to release events, newest five', () => {
    mocks.fixtures.activity = [
      { id: 'e1', actorUid: 'u1', action: 'assessment.released', target: 'as-9', at: NOW - 1000 },
      { id: 'e2', actorUid: 'u1', action: 'job.cancelled', target: 'job-1', at: NOW - 2000 },
      { id: 'e3', actorUid: 'u2', action: 'assessment.released', target: 'as-8', at: NOW - 3000 },
    ];
    mocks.fixtures.members = {
      u1: { name: 'Jane Doe' } as unknown as OrgMember,
      u2: { name: 'Sam Poll' } as unknown as OrgMember,
    };
    renderHome();
    const card = screen
      .getByRole('heading', { name: 'Recent releases' })
      .closest('section') as HTMLElement;
    const rows = within(card).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // Rows read as sentences via the shared humaniser, actor first, with the
    // assessment id as the secondary line (no console view exists for it yet).
    expect(rows[0]).toHaveTextContent('Jane Doe released an assessment');
    expect(rows[0]).toHaveTextContent('as-9');
    expect(rows[1]).toHaveTextContent('Sam Poll released an assessment');
    expect(rows[1]).toHaveTextContent('as-8');
    // The non-release event stays in the recent-activity feed only.
    expect(within(card).queryByText(/job-1/)).toBeNull();
  });

  it('exposes a View-all affordance into the releases list for an auditor', () => {
    setClaims({
      orgId: 'org-1',
      roles: { auditor: true },
      environment: 'test',
    } as SessionClaims);
    renderHome();
    const card = screen
      .getByRole('heading', { name: 'Recent releases' })
      .closest('section') as HTMLElement;
    expect(within(card).getByRole('link', { name: 'View all' })).toHaveAttribute(
      'href',
      '/app/validation/released',
    );
  });

  it('withholds the View-all link from a viewer who cannot reach the list', () => {
    setClaims(viewerClaims);
    renderHome();
    const card = screen
      .getByRole('heading', { name: 'Recent releases' })
      .closest('section') as HTMLElement;
    expect(within(card).queryByRole('link', { name: 'View all' })).toBeNull();
  });
});
