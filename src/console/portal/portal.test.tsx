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
import type {
  Action,
  Building,
  Customer,
  OrgProfile,
  Report,
  Site,
} from '../../types';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'authenticated' as string,
      user: { uid: 'user-1', email: 'pat@example.com' } as unknown,
      claims: null as unknown,
      paths: null as unknown,
      // The gate holds an unverified account on the verification screen before
      // any portal route mounts, so these tests sign in as a verified user.
      emailVerified: true,
      refreshEmailVerification: vi.fn(() => Promise.resolve(true)),
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

vi.mock('../../auth/useUserSpaces', () => ({
  useUserSpaces: () => ({
    spaces: [],
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
    // A { __staleError } fixture models the production race that broke the
    // portal: the live listener HAS delivered a value, and the one-shot read
    // behind it then failed, so the query reports an error while still holding
    // good data. An empty node never emits again, so that error is permanent.
    if (
      fixture !== null &&
      typeof fixture === 'object' &&
      '__staleError' in fixture
    ) {
      return {
        data: (fixture as { __staleError: unknown }).__staleError,
        isLoading: false,
        isError: true,
        error: new Error('Client is offline'),
      };
    }
    // A { __pending } fixture models a read that has not come back at all.
    if (fixture !== null && typeof fixture === 'object' && '__pending' in fixture) {
      return { data: undefined, isLoading: true, isError: false, error: null };
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
  const orgProfile: OrgProfile = {
    name: 'Ember Fire Safety',
    logoUrl: 'https://example.test/ember.png',
    brand: { primary: '#1f6feb', secondary: '#0b3d91' },
  };
  mocks.fixtures = {
    'orgProfile/org-1': orgProfile,
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
    // The portal brand is the ASSESSING ORGANISATION's, with the quiet
    // Safentia attribution beneath it.
    expect(await screen.findByText('Ember Fire Safety')).toBeInTheDocument();
    expect(screen.getByText('Powered by Safentia')).toBeInTheDocument();
    // The customer's own name is the account context, not the brand.
    expect(screen.getByText('Harbour Housing')).toBeInTheDocument();
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
    // The portal-only account context never appears on the staff console.
    expect(screen.queryByText('Signed in for')).toBeNull();
  });
});

// --- Organisation branding (the portal wears the assessor's identity) ---------

describe('Portal organisation branding', () => {
  it('shows the organisation logo and names them in the page lede', async () => {
    renderPortalAt('/app');
    const brandLink = await screen.findByRole('link', {
      name: 'Ember Fire Safety home',
    });
    const logo = brandLink.querySelector('img');
    expect(logo).not.toBeNull();
    expect(logo).toHaveAttribute('src', 'https://example.test/ember.png');
    // The customer is told, in words, whose service this is.
    expect(
      screen.getByText(/Ember Fire Safety carries out the fire risk assessments/),
    ).toBeInTheDocument();
  });

  it('falls back to the Safentia mark when the org has no profile yet', async () => {
    delete mocks.fixtures['orgProfile/org-1'];
    renderPortalAt('/app');
    // Deliberate, not broken: the product mark holds the space and the lede
    // drops the organisation's name rather than printing a gap.
    expect(await screen.findByLabelText('Safentia home')).toBeInTheDocument();
    expect(screen.queryByText('Powered by Safentia')).toBeNull();
    expect(
      screen.getByText(
        'Fire safety status and reports for every building we look after for you.',
      ),
    ).toBeInTheDocument();
  });

  it('brands with the name alone when the org has set no logo', async () => {
    mocks.fixtures['orgProfile/org-1'] = {
      name: 'Ember Fire Safety',
      brand: { primary: '#1f6feb', secondary: '#0b3d91' },
    } satisfies OrgProfile;
    renderPortalAt('/app');
    const brandLink = await screen.findByRole('link', {
      name: 'Ember Fire Safety home',
    });
    expect(brandLink.querySelector('img')).toBeNull();
    expect(screen.getByText('Powered by Safentia')).toBeInTheDocument();
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
    // The site is named twice: once beside each triaged building, once as its
    // own card, so this asserts presence rather than a single occurrence.
    expect((await screen.findAllByText('Dockside Estate')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Portal access suspended')).toBeNull();
  });
});

// --- PortalHome (story 2057) ---------------------------------------------------

describe('PortalHome', () => {
  it('renders the customer buildings with RAG chip, last-assessed and next review dates', async () => {
    renderPortalAt('/app');
    expect((await screen.findAllByText('Dockside Estate')).length).toBeGreaterThan(0);
    // Each building appears twice: once in the triage list, once on its site
    // card. Both carry the same RAG language.
    expect(screen.getAllByText('Anchor House')).toHaveLength(2);
    expect(screen.getAllByText('Beacon Court')).toHaveLength(2);
    expect(screen.getAllByText('Medium risk')).toHaveLength(2);
    // Story 2057 AC1: the site card carries when the building was last assessed.
    expect(screen.getByText('Assessed 1 June 2026')).toBeInTheDocument();
    expect(screen.getByText('Next review 9 July 2026')).toBeInTheDocument();
    // The un-assessed building states the fact plainly: its pending RAG chip
    // (twice) and its last-assessed line all read "Not yet assessed".
    expect(screen.getAllByText('Not yet assessed')).toHaveLength(3);
    expect(screen.getByText('No review scheduled')).toBeInTheDocument();
  });

  it('leads with a summary of the estate, counted from what has loaded', async () => {
    renderPortalAt('/app');
    const summary = await screen.findByRole('region', {
      name: 'Fire safety summary',
    });
    // Two buildings, neither at high risk, one never assessed. The counts are
    // derived from the buildings already subscribed, never invented.
    expect(within(summary).getByText('Buildings')).toBeInTheDocument();
    expect(within(summary).getByText('2')).toBeInTheDocument();
    expect(within(summary).getByText('High risk')).toBeInTheDocument();
    expect(within(summary).getByText('Reviews overdue')).toBeInTheDocument();
    expect(within(summary).getByText('Never assessed')).toBeInTheDocument();
  });

  it('triages the buildings that need attention, saying why in words', async () => {
    renderPortalAt('/app');
    expect(
      await screen.findByRole('heading', { name: 'Needs your attention' }),
    ).toBeInTheDocument();
    // The reason is written out beside the RAG chip - colour never carries it.
    // Scoped to the triage row: "Never assessed" is also a summary tile label.
    expect(screen.getByText('Review overdue')).toBeInTheDocument();
    const triageRow = screen.getAllByRole('link', { name: /Beacon Court/ })[0];
    expect(within(triageRow).getByText('Never assessed')).toBeInTheDocument();
  });

  it('says so plainly when nothing needs attention', async () => {
    // A single, recently assessed, low-risk building with its next review far
    // enough out to be neither overdue nor imminent.
    const farFuture = Date.now() + 400 * 86_400_000;
    mocks.fixtures['buildings/org-1/site-1'] = {
      'b-1': {
        name: 'Anchor House',
        customerId: 'cust-1',
        riskLevel: 'low',
        lastAssessedAt: Date.now() - 86_400_000,
        serviceSchedule: { fraReview: { nextDue: farFuture } },
      },
    } satisfies Record<string, Building>;
    renderPortalAt('/app');
    expect(
      await screen.findByRole('heading', { name: 'Nothing needs your attention' }),
    ).toBeInTheDocument();
  });
});

// --- The empty estate: a customer whose buildings have never been assessed -----
//
// This is the shape that broke in production - one site, one building, no
// assessment, no actions, no reports - plus the neighbouring empty shapes. An
// absent RTDB node reads as `null` SUCCESSFULLY, so every one of these is a
// loaded-and-empty state, never a skeleton and never an error.

/** One site, one building, nothing assessed: no actions, no reports, no
 *  assessment. Absent nodes are simply absent from the fixture map. */
function seedNeverAssessedEstate() {
  mocks.fixtures = {
    'orgProfile/org-1': {
      name: 'Ember Fire Safety',
      brand: { primary: '#1f6feb', secondary: '#0b3d91' },
    } satisfies OrgProfile,
    'customer/org-1/cust-1': {
      name: 'McDonalds',
      status: 'active',
    } satisfies Customer,
    'sites/org-1/cust-1': {
      'site-1': { name: 'Site A' },
    } satisfies Record<string, Site>,
    'buildings/org-1/site-1': {
      'b-1': { name: 'Unit 1', customerId: 'cust-1', riskLevel: 'pending' },
    } satisfies Record<string, Building>,
    'building/org-1/site-1/b-1': {
      name: 'Unit 1',
      customerId: 'cust-1',
      riskLevel: 'pending',
    } satisfies Building,
  };
}

describe('Portal empty states', () => {
  it('resolves the summary tiles for a never-assessed estate', async () => {
    seedNeverAssessedEstate();
    renderPortalAt('/app');
    const summary = await screen.findByRole('region', {
      name: 'Fire safety summary',
    });
    // The counts are REAL numbers, not skeletons: one building, never assessed.
    expect(within(summary).queryByText('Loading Buildings')).toBeNull();
    expect(within(summary).queryByText('Loading High risk')).toBeNull();
    expect(within(summary).queryByText('Loading Never assessed')).toBeNull();
    expect(within(summary).getAllByText('1')).toHaveLength(2);
    expect(within(summary).getAllByText('0')).toHaveLength(2);
  });

  it('shows zeros and a plain explanation for a site with no buildings', async () => {
    seedNeverAssessedEstate();
    delete mocks.fixtures['buildings/org-1/site-1'];
    renderPortalAt('/app');
    const summary = await screen.findByRole('region', {
      name: 'Fire safety summary',
    });
    expect(within(summary).queryByText('Loading Buildings')).toBeNull();
    expect(within(summary).getAllByText('0')).toHaveLength(4);
    expect(
      screen.getByText('No buildings have been added to this site yet.'),
    ).toBeInTheDocument();
    // And the estate as a whole is explained, rather than left as bare zeros.
    expect(
      screen.getByRole('heading', { name: 'No buildings on record yet' }),
    ).toBeInTheDocument();
    // Nothing about this is an error.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reassures a customer with no sites at all', async () => {
    seedNeverAssessedEstate();
    delete mocks.fixtures['sites/org-1/cust-1'];
    renderPortalAt('/app');
    expect(
      await screen.findByRole('heading', { name: 'Nothing to show yet' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('still resolves when a read reports an error AFTER delivering its value', async () => {
    // The production regression: the listener delivered the (empty) node and
    // the one-shot read behind it then failed. The value we hold is good, so
    // the page must resolve rather than sit on a skeleton forever.
    seedNeverAssessedEstate();
    mocks.fixtures['buildings/org-1/site-1'] = {
      __staleError: {
        'b-1': { name: 'Unit 1', customerId: 'cust-1', riskLevel: 'pending' },
      },
    };
    renderPortalAt('/app');
    const summary = await screen.findByRole('region', {
      name: 'Fire safety summary',
    });
    expect(within(summary).queryByText('Loading Buildings')).toBeNull();
    expect(within(summary).getAllByText('1')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a genuine failure honest and retryable', async () => {
    seedNeverAssessedEstate();
    mocks.fixtures['buildings/org-1/site-1'] = { __error: 'network error' };
    renderPortalAt('/app');
    expect(
      await screen.findByText(
        "This site's buildings could not be loaded. Please try again.",
      ),
    ).toBeInTheDocument();
    // A failed site does not stall the tiles either: the counts settle on what
    // is known and the shortfall is called out in words.
    const summary = screen.getByRole('region', { name: 'Fire safety summary' });
    expect(within(summary).queryByText('Loading Buildings')).toBeNull();
    expect(
      screen.getByText(/these counts may be\s+incomplete/),
    ).toBeInTheDocument();
  });

  it('shows a skeleton, not a zero, while a read is genuinely outstanding', async () => {
    seedNeverAssessedEstate();
    mocks.fixtures['buildings/org-1/site-1'] = { __pending: true };
    renderPortalAt('/app');
    const summary = await screen.findByRole('region', {
      name: 'Fire safety summary',
    });
    expect(within(summary).getByText('Loading Buildings')).toBeInTheDocument();
    expect(within(summary).queryByText('0')).toBeNull();
  });

  it('tells a customer plainly that their building has not been assessed yet', async () => {
    seedNeverAssessedEstate();
    renderPortalAt('/app/sites/site-1/buildings/b-1');
    expect(
      await screen.findByRole('heading', { name: 'No fire risk assessment yet' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'There is no action plan yet. Your assessor has not carried out a fire risk assessment on this building, so no remedial actions have been raised.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'There is no report yet. Your assessor has not carried out a fire risk assessment on this building, so there is nothing for you to read or accept at the moment.',
      ),
    ).toBeInTheDocument();
    // The bug this replaces: an empty action plan claiming it had failed.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.queryByText('The action plan could not be loaded. Please try again.'),
    ).toBeNull();
  });

  it('distinguishes an assessed building with nothing outstanding', async () => {
    seedNeverAssessedEstate();
    const assessed: Building = {
      name: 'Unit 1',
      customerId: 'cust-1',
      riskLevel: 'low',
      lastAssessedAt: Date.UTC(2026, 5, 1),
    };
    mocks.fixtures['building/org-1/site-1/b-1'] = assessed;
    renderPortalAt('/app/sites/site-1/buildings/b-1');
    expect(
      await screen.findByRole('heading', { name: 'Unit 1' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'No fire risk assessment yet' }),
    ).toBeNull();
    expect(
      screen.getByText(
        'No remedial actions have been raised for this building. Nothing is outstanding for you to act on.',
      ),
    ).toBeInTheDocument();
  });

  it('still surfaces a real action-plan failure on the building page', async () => {
    seedNeverAssessedEstate();
    mocks.fixtures['actions/org-1/b-1'] = { __error: 'permission_denied' };
    renderPortalAt('/app/sites/site-1/buildings/b-1');
    expect(
      await screen.findByText(
        'The action plan could not be loaded. Please try again.',
      ),
    ).toBeInTheDocument();
  });
});

// --- PortalBuilding (story 2058) -------------------------------------------------

describe('PortalBuilding', () => {
  it('renders facts, released reports and the severity-ordered action plan', async () => {
    renderPortalAt('/app/sites/site-1/buildings/b-1');
    expect(
      await screen.findByRole('heading', { name: 'Anchor House' }),
    ).toBeInTheDocument();
    // Reports: released date, the outstanding-acceptance state, and the link
    // to the acceptance screen (the PDF sits behind that gate, not here).
    expect(screen.getByText('Released 9 July 2026')).toBeInTheDocument();
    expect(screen.getByText('Awaiting your acceptance')).toBeInTheDocument();
    expect(screen.getByText('1 awaiting acceptance')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Accept & sign off' }),
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

  it('is read-only: no control on the page mutates the assessment', () => {
    renderPortalAt('/app/sites/site-1/buildings/b-1');
    const buttons = screen.getAllByRole('button');
    // Chrome only: theme toggle + sign out. Nothing that edits the building,
    // the reports or the action plan. Acceptance is a LINK to its own screen.
    for (const button of buttons) {
      expect(button.textContent).not.toMatch(/sign off|edit|create|add|save/i);
    }
    expect(
      screen.getByRole('link', { name: 'Accept & sign off' }),
    ).toBeInTheDocument();
  });
});
