// ============================================================================
// Reports area tests (story 2040, FR-E19): the role gate, the stat roll-ups,
// the monthly summary derivation and the CSV builders.
//
// Mocked at the house boundaries (auth contract, RTDB bridge with fixtures by
// query key, theme). The pure derivations and CSV escaping are also exercised
// directly from orgMetrics.ts, DOM-free.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { SessionClaims } from '../../auth/claims';
import type { Action, Building, Job } from '../../types';
import {
  buildMonthlySummaryCsv,
  countOverdueActions,
  countPerMonth,
  escapeCsvField,
  isActionOverdue,
  lastMonths,
  monthKey,
  upcomingReviews,
} from './orgMetrics';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'member' as string,
      user: { uid: 'user-1' } as unknown,
      claims: null as unknown,
      paths: null as unknown,
    },
    fixtures: {
      buildingsRoot: {} as Record<string, Record<string, Building>>,
      actionsRoot: {} as Record<string, Record<string, Action>>,
      jobs: {} as Record<string, Job>,
      releaseTimes: [] as Array<{ at: number }>,
    },
  };
});

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

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
  useRtdbQuery: ({ key }: { key: readonly unknown[] }) => {
    const fixtures = mocks.fixtures;
    let data: unknown;
    switch (key[0]) {
      case 'buildings':
        data = key[2] === 'root' ? fixtures.buildingsRoot : null;
        break;
      case 'actions':
        data = key[2] === 'root' ? fixtures.actionsRoot : null;
        break;
      case 'jobs':
        data = fixtures.jobs;
        break;
      case 'activity':
        // The reports page reads the time-bounded 'since' window, already
        // shaped by its selector to release timestamps.
        data = key[2] === 'since' ? fixtures.releaseTimes : [];
        break;
      default:
        data = null;
    }
    return { data, isLoading: false, isError: false };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

import { ReportsRoutes } from './ReportsRoutes';

// --- Fixtures ----------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function claimsWith(roles: SessionClaims['roles']): SessionClaims {
  return { orgId: 'org-1', roles, environment: 'test' };
}

function setClaims(claims: SessionClaims) {
  mocks.auth.claims = claims;
  mocks.auth.paths = forEnv(claims.environment);
}

function renderReports() {
  return render(
    <MemoryRouter initialEntries={['/app/reports']}>
      <Routes>
        <Route path="/app/reports/*" element={<ReportsRoutes />} />
      </Routes>
    </MemoryRouter>,
  );
}

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

function job(overrides: Partial<Job>): Job {
  return {
    templateId: 't1',
    templateVersion: 1,
    customerId: 'c1',
    siteId: 's1',
    buildingId: 'b1',
    assessorUid: 'u1',
    scheduledFor: NOW,
    status: 'scheduled',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setClaims(claimsWith({ finance: true }));
  mocks.fixtures.buildingsRoot = {
    site1: { b1: building({ riskLevel: 'high' }), b2: building({ riskLevel: 'low' }) },
  };
  mocks.fixtures.actionsRoot = {};
  mocks.fixtures.jobs = {};
  mocks.fixtures.releaseTimes = [];
});

// --- The role gate ------------------------------------------------------------

describe('Reports role gate', () => {
  it('denies a viewer with a calm panel', () => {
    setClaims(claimsWith({ viewer: true }));
    renderReports();
    expect(
      screen.getByRole('heading', {
        name: 'Finance or administrator access required',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Reports' })).toBeNull();
  });

  it('admits a finance member', () => {
    setClaims(claimsWith({ finance: true }));
    renderReports();
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect(
      screen.getByText(/month by month, from live platform data/),
    ).toBeInTheDocument();
  });

  it('admits an administrator', () => {
    setClaims(claimsWith({ admin: true }));
    renderReports();
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument();
  });
});

// --- Stat roll-ups --------------------------------------------------------------

describe('Reports stat bands', () => {
  it('counts buildings by risk and the action-plan position from the reads', () => {
    mocks.fixtures.actionsRoot = {
      b1: {
        x1: action({ dueBy: NOW - DAY }), // open + overdue
        x2: action({ dueBy: NOW + DAY }), // open, not due
        x3: action({ status: 'signedOff', signedOffAt: NOW - DAY }),
      },
    };
    renderReports();
    const riskBand = screen.getByRole('region', {
      name: 'Buildings by current risk',
    });
    expect(
      within(riskBand).getByText('High risk').closest('div'),
    ).toHaveTextContent('1');
    const actionBand = screen.getByRole('region', {
      name: 'Action plan position',
    });
    const openTile = within(actionBand)
      .getByText('Open actions')
      .closest('div') as HTMLElement;
    expect(within(openTile).getByText('2')).toBeInTheDocument();
    const overdueTile = within(actionBand)
      .getByText('Overdue actions')
      .closest('div') as HTMLElement;
    expect(within(overdueTile).getByText('1')).toBeInTheDocument();
  });
});

// --- Monthly summary --------------------------------------------------------------

describe('Reports monthly summary', () => {
  it('derives the current month row from releases, jobs and sign-offs', () => {
    mocks.fixtures.releaseTimes = [{ at: NOW - 1000 }, { at: NOW - 2000 }];
    mocks.fixtures.jobs = {
      j1: job({ status: 'released' }),
      j2: job({ status: 'scheduled' }),
    };
    mocks.fixtures.actionsRoot = {
      b1: { x1: action({ status: 'signedOff', signedOffAt: NOW - 1000 }) },
    };
    renderReports();
    const currentLabel = new Intl.DateTimeFormat('en-GB', {
      month: 'short',
      year: 'numeric',
    }).format(NOW);
    const row = screen.getByRole('row', { name: new RegExp(currentLabel) });
    const cells = within(row).getAllByRole('cell');
    // Month | released | scheduled | completed | closed
    expect(cells[1]).toHaveTextContent('2');
    expect(cells[2]).toHaveTextContent('2');
    expect(cells[3]).toHaveTextContent('1');
    expect(cells[4]).toHaveTextContent('1');
    // Twelve month rows plus the header row.
    expect(screen.getAllByRole('row')).toHaveLength(13);
  });
});

// --- Releases-per-month chart -------------------------------------------------------

describe('Releases per month chart', () => {
  it('summarises the twelve-month release run in the accessible name', () => {
    mocks.fixtures.releaseTimes = [
      { at: NOW - 1000 },
      { at: NOW - 2000 },
      { at: NOW - 40 * DAY },
    ];
    renderReports();
    // The SVG's aria-label narrates the series; the summary table beneath is
    // the full accessible table view of the same figures.
    expect(
      screen.getByRole('img', {
        name: /Assessments released per month over the last 12 months: 3 in total, peaking at 2\./,
      }),
    ).toBeInTheDocument();
  });

  it('states a quiet year plainly rather than drawing twelve empty bars', () => {
    mocks.fixtures.releaseTimes = [];
    renderReports();
    // Loaded-and-genuinely-empty is its own state (see ReportsPage): a wall of
    // zero-height columns reads as a rendering fault, and it buries the real,
    // reassuring message. Nothing is lost - the monthly summary beneath still
    // carries every month, zeros included.
    expect(screen.getByText('No reports released yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        /No assessments have been released in the last 12 months/,
      ),
    ).toBeInTheDocument();
    // And no chart is drawn, so nothing narrates a series that does not exist.
    expect(
      screen.queryByRole('img', { name: /Assessments released per month/ }),
    ).not.toBeInTheDocument();
  });
});

// --- Pure derivations and CSV ------------------------------------------------------

describe('orgMetrics derivations', () => {
  it('builds twelve calendar months oldest-first, ending now', () => {
    const months = lastMonths(12, NOW);
    expect(months).toHaveLength(12);
    expect(months[11].key).toBe(monthKey(NOW));
    expect(new Set(months.map((month) => month.key)).size).toBe(12);
  });

  it('counts events into their local calendar month', () => {
    const janFirst = new Date(2026, 0, 1, 0, 30).getTime();
    const counts = countPerMonth([{ at: janFirst }, { at: janFirst + DAY }]);
    expect(counts.get('2026-01')).toBe(2);
  });

  it('marks an action overdue only once the whole due day has passed (story 2045)', () => {
    // dueBy is midnight UTC on the due day: the due day itself is on time.
    expect(isActionOverdue(action({ dueBy: NOW }), NOW)).toBe(false);
    expect(isActionOverdue(action({ dueBy: NOW - DAY + 1 }), NOW)).toBe(false);
    // The boundary: exactly one full day after dueBy, the action turns overdue.
    expect(isActionOverdue(action({ dueBy: NOW - DAY }), NOW)).toBe(true);
    expect(isActionOverdue(action({ dueBy: NOW - 3 * DAY }), NOW)).toBe(true);
    // No deadline is never a breach of one; closed actions are never overdue.
    expect(isActionOverdue(action({}), NOW)).toBe(false);
    expect(
      isActionOverdue(action({ dueBy: NOW - 3 * DAY, status: 'signedOff' }), NOW),
    ).toBe(false);
  });

  it('rolls the same derivation up into the overdue and LTP counts', () => {
    const counts = countOverdueActions(
      [
        action({ dueBy: NOW - DAY }), // overdue, boundary
        action({ dueBy: NOW - 2 * DAY, lifeProtection: true }), // overdue + LTP
        action({ dueBy: NOW - DAY + 1 }), // due day not fully past
        action({ dueBy: NOW + DAY }), // not due
        action({ dueBy: NOW - 5 * DAY, status: 'signedOff' }), // closed
      ],
      NOW,
    );
    expect(counts).toEqual({ overdue: 2, lifeProtectionOverdue: 1 });
  });

  it('orders reviews lapsed-first, then soonest', () => {
    const rows = upcomingReviews(
      [
        {
          siteId: 's1',
          buildingId: 'b1',
          building: building({
            serviceSchedule: { fraReview: { nextDue: NOW + 5 * DAY } },
          }),
        },
        {
          siteId: 's1',
          buildingId: 'b2',
          building: building({
            serviceSchedule: { fraReview: { nextDue: NOW - 30 * DAY } },
          }),
        },
        {
          siteId: 's1',
          buildingId: 'b3',
          building: building({
            serviceSchedule: { fraReview: { nextDue: NOW - 2 * DAY } },
          }),
        },
      ],
      NOW,
    );
    expect(rows.map((row) => row.buildingId)).toEqual(['b2', 'b3', 'b1']);
    expect(rows[0].lapsed).toBe(true);
    expect(rows[2].lapsed).toBe(false);
  });

  it('escapes CSV fields: quotes, separators and formula injection', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('=SUM(A1)')).toBe("'=SUM(A1)");
  });

  it('serialises the monthly summary with CRLF rows', () => {
    const csv = buildMonthlySummaryCsv([
      {
        key: '2026-06',
        label: 'Jun 2026',
        assessmentsReleased: 3,
        jobsScheduled: 4,
        jobsCompleted: 2,
        actionsClosed: 5,
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'Month,Assessments released,Jobs scheduled,Jobs completed,Action items closed',
    );
    expect(lines[1]).toBe('Jun 2026,3,4,2,5');
  });
});
