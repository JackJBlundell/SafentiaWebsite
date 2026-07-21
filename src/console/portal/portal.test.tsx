// ============================================================================
// Customer portal tests (FR-E22, stories 2056-2058): the gate routes a portal
// session to PortalShell (never the staff console), PortalHome renders the
// customer's buildings with RAG and next-review, and the building page's
// action plan is READ-ONLY (severity-ordered, LTP marked, no mutations).
//
// Mocked at the house boundaries (auth contract, RTDB bridge with fixtures by
// query key, theme) - the same pattern as console.test.tsx and reports.test.
// ============================================================================

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { SessionClaims } from '../../auth/claims';
import type { Action, Building, Customer, Report, Site } from '../../types';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'authenticated' as string,
      user: { uid: 'user-1', email: 'pat@example.com' } as unknown,
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
    /** RTDB fixtures keyed by the joined query key. */
    fixtures: {} as Record<string, unknown>,
  };
});

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mocks.auth,
}));

vi.mock('../../auth/useUserOrganisations', () => ({
  useUserOrganisations: () => ({
    organisations: [],
    loading: false,
    hasMultiple: false,
  }),
}));

vi.mock('../../design/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
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
  useRtdbQuery: ({ key }: { key: readonly (string | number)[] }) => {
    const fixture = mocks.fixtures[key.join('/')] ?? null;
    // An { __error } fixture simulates a failed listener (e.g. a rules
    // denial), matching the real hook's error surface.
    if (fixture !== null && typeof fixture === 'object' && '__error' in fixture) {
      return {
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error(String((fixture as { __error: unknown }).__error)),
      };
    }
    return { data: fixture, isLoading: false, isError: false, error: null };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

vi.mock('../../seo/Seo', () => ({
  Seo: () => null,
}));

import { Component as ConsoleRoute } from '../ConsoleRoute';

// --- Fixtures ----------------------------------------------------------------

const portalClaims: SessionClaims = {
  kind: 'portal',
  orgId: 'org-1',
  customerId: 'cust-1',
  customerRoles: { viewer: true },
  roles: {},
  environment: 'test',
};

const staffClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

const JULY_9_2026 = Date.UTC(2026, 6, 9);

function seedPortalFixtures() {
  const customer: Customer = { name: 'Harbour Housing', status: 'active' };
  const sites: Record<string, Site> = {
    'site-1': { name: 'Dockside Estate', address: '1 Quay Street' },
  };
  const buildings: Record<string, Building> = {
    'b-1': {
      name: 'Anchor House',
      customerId: 'cust-1',
      address: '2 Quay Street',
      riskLevel: 'medium',
      serviceSchedule: { fraReview: { nextDue: JULY_9_2026 } },
      lastAssessedAt: Date.UTC(2026, 5, 1),
    },
    'b-2': {
      name: 'Beacon Court',
      customerId: 'cust-1',
      riskLevel: 'pending',
    },
  };
  const actions: Record<string, Action> = {
    'a-low': {
      assessmentId: 'as-1',
      sectionCode: 'S1',
      question: 'Signage in stairwells',
      observation: 'Two exit signs are faded.',
      severity: 'L',
      lifeProtection: false,
      status: 'open',
    },
    'a-high': {
      assessmentId: 'as-1',
      sectionCode: 'S2',
      question: 'Fire door to plant room',
      observation: 'The fire door does not self-close.',
      severity: 'H',
      lifeProtection: true,
      status: 'open',
      dueBy: JULY_9_2026,
      responsible: 'Helen Carter',
    },
  };
  const reports: Record<string, Report> = {
    'r-1': { pdfPath: 'test/orgs/org-1/reports/r-1.pdf', generatedAt: JULY_9_2026 },
  };
  mocks.fixtures = {
    'customer/org-1/cust-1': customer,
    'sites/org-1/cust-1': sites,
    'buildings/org-1/site-1': buildings,
    'building/org-1/site-1/b-1': buildings['b-1'],
    'actions/org-1/b-1': actions,
    'reports/org-1/building/b-1': reports,
  };
}

function renderPortalAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/app/*" element={<ConsoleRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.auth.status = 'authenticated';
  mocks.auth.claims = portalClaims;
  mocks.auth.paths = forEnv('test');
  seedPortalFixtures();
  vi.clearAllMocks();
});

// --- The gate (story 2005's third landing) ------------------------------------

describe('ConsoleGate portal routing', () => {
  it('routes a portal session to PortalShell, never the staff console', async () => {
    renderPortalAt('/app');
    // The portal brand: the CUSTOMER's name, with the quiet Safentia line.
    expect(await screen.findByText('Harbour Housing')).toBeInTheDocument();
    expect(screen.getByText('Powered by Safentia')).toBeInTheDocument();
    // No staff chrome: the console nav is absent.
    expect(screen.queryByRole('navigation', { name: 'Console' })).toBeNull();
    expect(screen.queryByText('Validation')).toBeNull();
  });

  it('still routes a staff session to the staff console', async () => {
    mocks.auth.claims = staffClaims;
    renderPortalAt('/app');
    expect(
      await screen.findByRole('navigation', { name: 'Console' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Powered by Safentia')).toBeNull();
  });
});

// --- Suspended access (customer archived; rules deny every portal read) --------

describe('Portal suspended state', () => {
  it('shows the calm suspended notice on a rules denial, not the routes', async () => {
    mocks.fixtures['customer/org-1/cust-1'] = {
      __error:
        "permission_denied at /test/customers/org-1/cust-1: Client doesn't have permission to access the desired data.",
    };
    renderPortalAt('/app');
    expect(
      await screen.findByRole('heading', { name: 'Portal access suspended' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your organisation's portal access is currently suspended. Please contact your fire-risk assessor.",
      ),
    ).toBeInTheDocument();
    // The routes are not mounted: no buildings, no site listeners behind them.
    expect(screen.queryByText('Anchor House')).toBeNull();
    // Sign out stays available; the account link does not.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText('Account')).toBeNull();
  });

  it('treats a non-permission error as an ordinary failure, not suspension', async () => {
    mocks.fixtures['customer/org-1/cust-1'] = {
      __error: 'network error',
    };
    renderPortalAt('/app');
    // The shell falls back to the wordmark brand and the routes still render.
    expect(await screen.findByText('Dockside Estate')).toBeInTheDocument();
    expect(screen.queryByText('Portal access suspended')).toBeNull();
  });
});

// --- PortalHome (story 2057) ---------------------------------------------------

describe('PortalHome', () => {
  it('renders the customer buildings with RAG chip, last-assessed and next review dates', async () => {
    renderPortalAt('/app');
    expect(await screen.findByText('Anchor House')).toBeInTheDocument();
    expect(screen.getByText('Dockside Estate')).toBeInTheDocument();
    expect(screen.getByText('Medium risk')).toBeInTheDocument();
    // Story 2057 AC1: the card carries when the building was last assessed.
    expect(screen.getByText('Assessed 1 June 2026')).toBeInTheDocument();
    expect(screen.getByText('Next review 9 July 2026')).toBeInTheDocument();
    // The un-assessed building states both facts plainly: its pending RAG
    // chip and its last-assessed line both read "Not yet assessed".
    expect(screen.getByText('Beacon Court')).toBeInTheDocument();
    expect(screen.getAllByText('Not yet assessed')).toHaveLength(2);
    expect(screen.getByText('No review scheduled')).toBeInTheDocument();
  });
});

// --- PortalBuilding (story 2058) -------------------------------------------------

describe('PortalBuilding', () => {
  it('renders facts, released reports and the severity-ordered action plan', async () => {
    renderPortalAt('/app/sites/site-1/buildings/b-1');
    expect(
      await screen.findByRole('heading', { name: 'Anchor House' }),
    ).toBeInTheDocument();
    // Reports: released date plus a download control.
    expect(screen.getByText('Released 9 July 2026')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Download PDF' }),
    ).toBeInTheDocument();
    // Action plan: high severity first despite the fixture's key order, with
    // the Life Protection marker and status label.
    const items = screen.getAllByText(/Fire door to plant room|Signage in stairwells/);
    expect(items[0]).toHaveTextContent('Fire door to plant room');
    expect(screen.getByText('Life Protection')).toBeInTheDocument();
    const list = screen.getByText('Fire door to plant room').closest('ul');
    expect(list).not.toBeNull();
    expect(within(list as HTMLElement).getAllByText('Open')).toHaveLength(2);
    // The action's assignee is surfaced where recorded; the fixture's other
    // action has none, so exactly one row carries the line.
    expect(screen.getByText('Responsible: Helen Carter')).toBeInTheDocument();
  });

  it('is read-only: the only buttons on the page are report downloads and chrome', () => {
    renderPortalAt('/app/sites/site-1/buildings/b-1');
    const buttons = screen.getAllByRole('button');
    // Chrome: theme toggle + sign out. Content: one report download. Nothing
    // that mutates (no sign-off, no edit, no create).
    for (const button of buttons) {
      expect(button.textContent).not.toMatch(/sign off|edit|create|add|save/i);
    }
    expect(
      screen.getByRole('button', { name: 'Download PDF' }),
    ).toBeInTheDocument();
  });
});
