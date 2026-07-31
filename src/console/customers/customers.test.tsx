// ============================================================================
// Customers area tests - the organisation model.
//
// Mocked at the same module boundaries as console.test.tsx: the auth contract,
// the RTDB bridge (fixture data by query key, no sockets), the theme, and the
// callable hook (so a submit can be asserted without Firebase). The routes are
// exercised through CustomersRoutes exactly as ConsoleShell mounts them.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { SessionClaims } from '../../auth/claims';
import type {
  Action,
  Building,
  Customer,
  CustomerContact,
  InvitationSummary,
  OrgMember,
  Site,
  Template,
} from '../../types';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'member' as string,
      user: { uid: 'user-1', email: 'admin@example.com' } as unknown,
      claims: null as unknown,
      paths: null as unknown,
    },
    fixtures: {
      customers: {} as Record<string, Customer>,
      contacts: {} as Record<string, CustomerContact>,
      invitations: {} as Record<string, InvitationSummary>,
      sites: {} as Record<string, Site>,
      buildings: {} as Record<string, Building>,
      // The org-root roll-up nodes: /buildings/{orgId} nested by siteId,
      // /actions/{orgId} nested by buildingId (the dashboard's exact shapes).
      buildingsRoot: {} as Record<string, Record<string, Building>>,
      actionsRoot: {} as Record<string, Record<string, Action>>,
      // Per-building action plans, served for the building-scoped `actions`
      // key (BuildingDetail's band and its ActionsPanel share this read).
      buildingActions: {} as Record<string, Record<string, Action>>,
      templates: {} as Record<string, Template>,
      members: {} as Record<string, OrgMember>,
    },
    callableCall: vi.fn(async () => null as unknown),
  };
});

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

// BuildingDetail mounts the storage-backed asset panels; their Storage calls
// are inert here (no test drives an upload or a download).
vi.mock('firebase/storage', () => ({
  ref: vi.fn(),
  getDownloadURL: vi.fn(async () => 'https://example.com/object'),
  uploadBytesResumable: vi.fn(),
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

// Fixture data served by query-key domain, mirroring what the live listeners
// would deliver for each path.
vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly unknown[] }) => {
    const fixtures = mocks.fixtures;
    let data: unknown;
    switch (key[0]) {
      case 'customers':
        data = fixtures.customers;
        break;
      case 'customer':
        data = fixtures.customers[key[2] as string] ?? null;
        break;
      case 'customerContacts':
        data = fixtures.contacts;
        break;
      case 'orgInvitations':
        data = fixtures.invitations;
        break;
      case 'sites':
        data = fixtures.sites;
        break;
      case 'buildings':
        // The 'root' discriminator selects the org-root node (nested by site);
        // any other third segment is a per-site key.
        data = key[2] === 'root' ? fixtures.buildingsRoot : fixtures.buildings;
        break;
      case 'actions':
        data =
          key[2] === 'root'
            ? fixtures.actionsRoot
            : fixtures.buildingActions[key[2] as string] ?? null;
        break;
      case 'building':
        data = fixtures.buildings[key[3] as string] ?? null;
        break;
      case 'templates':
        data = fixtures.templates;
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

vi.mock('../ui/useCallable', () => ({
  useCallable: () => ({
    call: mocks.callableCall,
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import { CustomersRoutes } from './CustomersRoutes';

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

function renderCustomersAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/app/customers/*" element={<CustomersRoutes />} />
      </Routes>
    </MemoryRouter>,
  );
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  setClaims(adminClaims);
  mocks.fixtures.customers = {
    c1: {
      name: 'Acme Facilities',
      address: '4 Foundry Lane, Leeds',
      status: 'active',
    },
    c2: { name: 'Borough Housing', email: 'ops@borough.example', status: 'active' },
    c3: { name: 'Closed Company', status: 'archived' },
  };
  mocks.fixtures.contacts = {
    p1: {
      name: 'Amy Archer',
      email: 'amy@acme.example',
      jobTitle: 'Facilities Director',
      isPrimary: true,
      uid: 'uid-amy',
      createdAt: 1,
    },
    p2: { name: 'Ben Brook', email: 'ben@acme.example', createdAt: 2 },
    p3: { name: 'Cara Cole', createdAt: 3 },
  };
  mocks.fixtures.invitations = {
    i1: {
      email: 'ben@acme.example',
      roles: {},
      customerId: 'c1',
      contactId: 'p2',
      status: 'pending',
      expiresAt: Date.now() + 7 * DAY,
      createdAt: 2,
      invitedBy: 'user-1',
    },
  };
  mocks.fixtures.sites = {
    s1: { name: 'Head Office', address: '1 High Street, Leeds' },
  };
  mocks.fixtures.buildings = {
    b1: {
      name: 'Main Block',
      customerId: 'c1',
      riskLevel: 'pending',
    } as Building,
  };
  // The org-root roll-ups: Acme (c1) holds 1 high + 1 pending building with
  // 2 overdue actions (1 Life Protection) on b1; Borough (c2) holds 2 high +
  // 1 medium with nothing overdue.
  mocks.fixtures.buildingsRoot = {
    s1: {
      b1: { name: 'Main Block', customerId: 'c1', riskLevel: 'high' } as Building,
      b2: { name: 'Store', customerId: 'c1', riskLevel: 'pending' } as Building,
    },
    s2: {
      b3: { name: 'Court A', customerId: 'c2', riskLevel: 'high' } as Building,
      b4: { name: 'Court B', customerId: 'c2', riskLevel: 'high' } as Building,
      b5: { name: 'Court C', customerId: 'c2', riskLevel: 'medium' } as Building,
    },
  };
  mocks.fixtures.actionsRoot = {
    b1: {
      a1: action({ dueBy: Date.now() - DAY }),
      a2: action({ dueBy: Date.now() - 2 * DAY, lifeProtection: true }),
      a3: action({ dueBy: Date.now() + DAY }),
    },
  };
  mocks.fixtures.buildingActions = {};
  mocks.fixtures.templates = {};
  mocks.fixtures.members = {};
});

/** A minimal open action; overrides set the due date and LTP flag. */
function action(overrides: Partial<Action>): Action {
  return {
    assessmentId: 'as1',
    sectionCode: 'sec1',
    question: 'Q',
    observation: 'O',
    severity: 'M',
    lifeProtection: false,
    status: 'open',
    ...overrides,
  } as Action;
}

// --- The list ------------------------------------------------------------------

describe('CustomersList', () => {
  it('renders active customers and hides archived ones by default', () => {
    renderCustomersAt('/app/customers');
    expect(screen.getByText('Acme Facilities')).toBeInTheDocument();
    expect(screen.getByText('Borough Housing')).toBeInTheDocument();
    expect(screen.queryByText('Closed Company')).not.toBeInTheDocument();
  });

  it('filters rows by the search box', async () => {
    const user = userEvent.setup();
    renderCustomersAt('/app/customers');
    await user.type(screen.getByLabelText('Search customers'), 'acme');
    expect(screen.getByText('Acme Facilities')).toBeInTheDocument();
    expect(screen.queryByText('Borough Housing')).not.toBeInTheDocument();
  });

  it('shows archived customers when the toggle is on', async () => {
    const user = userEvent.setup();
    renderCustomersAt('/app/customers');
    await user.click(screen.getByLabelText('Show archived'));
    expect(screen.getByText('Closed Company')).toBeInTheDocument();
  });
});

// --- At-a-glance risk on the list -------------------------------------------

describe('CustomersList risk visibility', () => {
  const table = () => screen.getByRole('table', { name: 'Customers' });
  const rowFor = (name: string) =>
    within(table()).getByText(name).closest('tr') as HTMLElement;

  it('rolls the org-root reads up into a per-customer strip and overdue count', () => {
    renderCustomersAt('/app/customers');
    // Acme: 1 high + 1 pending, spoken as one sentence; 2 overdue, 1 LTP.
    const acme = rowFor('Acme Facilities');
    expect(
      within(acme).getByRole('img', {
        name: 'Buildings: 1 high risk, 1 not yet assessed',
      }),
    ).toBeInTheDocument();
    expect(
      within(acme).getByRole('img', {
        name: '2 overdue actions, 1 Life Protection',
      }),
    ).toBeInTheDocument();
    // Borough: 2 high + 1 medium, and an honest overdue zero.
    const borough = rowFor('Borough Housing');
    expect(
      within(borough).getByRole('img', {
        name: 'Buildings: 2 high risk, 1 medium risk',
      }),
    ).toBeInTheDocument();
    expect(within(borough).getByText('0')).toBeInTheDocument();
  });

  it('?risk=high filters to holders and sorts by that count, worst first', () => {
    renderCustomersAt('/app/customers?risk=high');
    expect(
      screen.getByText('Showing customers with high-risk buildings'),
    ).toBeInTheDocument();
    const rows = within(table()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Borough Housing'); // 2 high
    expect(rows[1]).toHaveTextContent('Acme Facilities'); // 1 high
  });

  it('?risk=medium hides customers without that level, and the chip dismisses', async () => {
    const user = userEvent.setup();
    renderCustomersAt('/app/customers?risk=medium');
    expect(
      screen.getByText('Showing customers with medium-risk buildings'),
    ).toBeInTheDocument();
    expect(screen.getByText('Borough Housing')).toBeInTheDocument();
    expect(screen.queryByText('Acme Facilities')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getByText('Acme Facilities')).toBeInTheDocument();
    expect(
      screen.queryByText('Showing customers with medium-risk buildings'),
    ).toBeNull();
  });

  it('?overdue=1 filters to customers with overdue actions', () => {
    renderCustomersAt('/app/customers?overdue=1');
    expect(
      screen.getByText('Showing customers with overdue actions'),
    ).toBeInTheDocument();
    expect(screen.getByText('Acme Facilities')).toBeInTheDocument();
    expect(screen.queryByText('Borough Housing')).toBeNull();
  });

  it('ignores an out-of-vocabulary risk value', () => {
    renderCustomersAt('/app/customers?risk=terrible');
    expect(screen.getByText('Acme Facilities')).toBeInTheDocument();
    expect(screen.getByText('Borough Housing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
  });
});

// --- Per-site grouping on the customer profile --------------------------------

describe('CustomerDetail sites table risk strip', () => {
  it('groups that customer’s buildings by site into a RagSummary cell', () => {
    renderCustomersAt('/app/customers/c1');
    const sitesTable = screen.getByRole('table', { name: 'Sites' });
    // The per-site probe serves s1's buildings (fixtures.buildings: one
    // pending building), grouped into the row's strip.
    expect(
      within(sitesTable).getByRole('img', {
        name: 'Buildings: 1 not yet assessed',
      }),
    ).toBeInTheDocument();
  });
});

// --- The estate's building rows and their next FRA review (story 2036 AC2) -----

describe('CustomerDetail building rows', () => {
  it('shows each building with its next review date, fallback and lapsed tone', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    mocks.fixtures.buildings = {
      b1: {
        name: 'Main Block',
        customerId: 'c1',
        riskLevel: 'pending',
        serviceSchedule: {
          fraReview: { nextDue: Date.UTC(2026, 8, 1) }, // 1 September 2026
        },
      } as Building,
      b2: {
        name: 'Store',
        customerId: 'c1',
        riskLevel: 'high',
        serviceSchedule: {
          fraReview: { nextDue: Date.now() - 10 * DAY_MS }, // lapsed
        },
      } as Building,
      b3: { name: 'Annex', customerId: 'c1', riskLevel: 'low' } as Building,
    };
    renderCustomersAt('/app/customers/c1');

    const buildingsTable = screen.getByRole('table', { name: 'Buildings' });
    const rows = within(buildingsTable).getAllByRole('row').slice(1);
    // Sorted by name: Annex, Main Block, Store.
    expect(rows[0]).toHaveTextContent('Annex');
    expect(rows[0]).toHaveTextContent('No review scheduled');
    expect(rows[1]).toHaveTextContent('Main Block');
    expect(rows[1]).toHaveTextContent('1 September 2026');
    // The lapsed review says so in words, never colour alone.
    expect(rows[2]).toHaveTextContent('Store');
    expect(rows[2]).toHaveTextContent('(lapsed)');
  });

  it('omits the buildings card while the estate has no buildings', () => {
    mocks.fixtures.buildings = {};
    renderCustomersAt('/app/customers/c1');
    expect(screen.queryByRole('table', { name: 'Buildings' })).not.toBeInTheDocument();
  });
});

// --- Open actions on the site's building rows ----------------------------------

describe('SiteDetail open actions', () => {
  it('shows open and overdue counts for each building from the org-root read', () => {
    renderCustomersAt('/app/customers/c1/sites/s1');
    const row = screen.getByText('Main Block').closest('a') as HTMLElement;
    // b1 carries three open actions, two of them overdue (one LTP).
    expect(row).toHaveTextContent('Open actions: 3');
    expect(
      within(row).getByRole('img', {
        name: '2 overdue actions, 1 Life Protection',
      }),
    ).toBeInTheDocument();
  });
});

// --- The compliance-at-a-glance band, scoped per entity -----------------------

describe('compliance-at-a-glance band', () => {
  it('scopes the customer band to that customer and drills through to its own filtered list', () => {
    renderCustomersAt('/app/customers/c1');
    const band = screen.getByRole('region', { name: 'Compliance at a glance' });
    // c1 holds 1 high + 1 pending (Borough's three high/medium are excluded).
    expect(
      within(band).getByRole('img', {
        name: 'Risk distribution across 2 buildings: 1 high risk, 0 medium risk, 0 low risk, 1 not yet assessed.',
      }),
    ).toBeInTheDocument();
    // Every tile is a whole-tile link to THIS customer's filtered view.
    const high = within(band).getByRole('link', { name: /High risk/ });
    expect(high).toHaveTextContent('1');
    expect(high).toHaveAttribute('href', '/app/customers/c1?risk=high');
    const overdue = within(band).getByRole('link', { name: /Overdue actions/ });
    expect(overdue).toHaveTextContent('2');
    expect(overdue).toHaveAttribute('href', '/app/customers/c1?overdue=1');
    const ltp = within(band).getByRole('link', {
      name: /Life Protection overdue/,
    });
    expect(ltp).toHaveTextContent('1');
    expect(ltp).toHaveAttribute('href', '/app/customers/c1?overdue=1');
  });

  it('scopes the site band to that site and links to its filtered list', () => {
    renderCustomersAt('/app/customers/c1/sites/s1');
    const band = screen.getByRole('region', { name: 'Compliance at a glance' });
    // s1 (the per-site read) carries one pending building.
    expect(
      within(band).getByRole('img', {
        name: 'Risk distribution across 1 buildings: 0 high risk, 0 medium risk, 0 low risk, 1 not yet assessed.',
      }),
    ).toBeInTheDocument();
    const overdue = within(band).getByRole('link', { name: /Overdue actions/ });
    expect(overdue).toHaveTextContent('2');
    expect(overdue).toHaveAttribute(
      'href',
      '/app/customers/c1/sites/s1?overdue=1',
    );
    expect(
      within(band).getByRole('link', { name: /High risk/ }),
    ).toHaveAttribute('href', '/app/customers/c1/sites/s1?risk=high');
  });

  it('degrades to the single-building form on a building page, tiles linking to the actions section', async () => {
    mocks.fixtures.buildings = {
      b1: { name: 'Main Block', customerId: 'c1', riskLevel: 'high' } as Building,
    };
    mocks.fixtures.buildingActions = {
      b1: {
        a1: action({ dueBy: Date.now() - DAY }),
        a2: action({ dueBy: Date.now() - 2 * DAY, lifeProtection: true }),
        a3: action({ dueBy: Date.now() + DAY }),
      },
    };
    renderCustomersAt('/app/customers/c1/sites/s1/buildings/b1');
    const band = await screen.findByRole('region', {
      name: 'Compliance at a glance',
    });
    // No proportional bar for a single building: its own RAG stands in.
    expect(
      within(band).queryByRole('img', { name: /risk distribution/i }),
    ).toBeNull();
    // The band keeps the WORDS, not the H/M/L dot: this is a standalone status
    // chip with room for them, and the dot exists only for a table column.
    expect(within(band).getByText('High risk')).toBeInTheDocument();
    // Tiles read this building's own plan: 3 open, 2 overdue, 1 Life Protection.
    const open = within(band).getByRole('link', { name: /Open actions/ });
    expect(open).toHaveTextContent('3');
    expect(open).toHaveAttribute(
      'href',
      '/app/customers/c1/sites/s1/buildings/b1#actions-panel-heading',
    );
    const overdue = within(band).getByRole('link', { name: /Overdue actions/ });
    expect(overdue).toHaveTextContent('2');
    const ltp = within(band).getByRole('link', {
      name: /Life Protection overdue/,
    });
    expect(ltp).toHaveTextContent('1');
  });
});

// --- Name-adjacent count badges and the band's list filter --------------------

describe('CustomerDetail count badges', () => {
  it('shows live site and building counts as badges beside the name', () => {
    renderCustomersAt('/app/customers/c1');
    // One site (s1), one building (the per-site probe's fixture).
    expect(screen.getByText('1 site')).toBeInTheDocument();
    expect(screen.getByText('1 building')).toBeInTheDocument();
  });
});

describe('CustomerDetail band filter', () => {
  it('filters the buildings list to the risk the tile carried, and clears', async () => {
    const user = userEvent.setup();
    mocks.fixtures.buildings = {
      b1: { name: 'Tower', customerId: 'c1', riskLevel: 'high' } as Building,
      b2: { name: 'Annex', customerId: 'c1', riskLevel: 'pending' } as Building,
    };
    renderCustomersAt('/app/customers/c1?risk=high');
    // The filtered list has a stable scroll target the page brings into view.
    expect(document.getElementById('customer-buildings')).not.toBeNull();
    // The active filter is obvious at the list, with the way back.
    expect(screen.getByText('Showing high-risk buildings')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Buildings' });
    expect(within(table).getByText('Tower')).toBeInTheDocument();
    expect(within(table).queryByText('Annex')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(
      screen.queryByText('Showing high-risk buildings'),
    ).toBeNull();
    expect(
      within(screen.getByRole('table', { name: 'Buildings' })).getByText('Annex'),
    ).toBeInTheDocument();
  });

  it('shows an honest empty state when nothing matches, keeping the way back', () => {
    // c1's buildings are all pending; a high-risk filter matches none.
    mocks.fixtures.buildings = {
      b1: { name: 'Annex', customerId: 'c1', riskLevel: 'pending' } as Building,
    };
    renderCustomersAt('/app/customers/c1?risk=high');
    expect(
      screen.getByText('No high-risk buildings for this customer.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Clear filter' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Buildings' })).toBeNull();
  });
});

describe('SiteDetail band filter', () => {
  it('filters the site list to the risk the tile carried, into a scroll target', () => {
    mocks.fixtures.buildings = {
      b1: { name: 'Tower', customerId: 'c1', riskLevel: 'high' } as Building,
      b2: { name: 'Annex', customerId: 'c1', riskLevel: 'pending' } as Building,
    };
    renderCustomersAt('/app/customers/c1/sites/s1?risk=high');
    expect(document.getElementById('site-buildings')).not.toBeNull();
    expect(screen.getByText('Showing high-risk buildings')).toBeInTheDocument();
    expect(screen.getByText('Tower')).toBeInTheDocument();
    expect(screen.queryByText('Annex')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Clear filter' }),
    ).toBeInTheDocument();
  });
});

// --- Admin gating ---------------------------------------------------------------

describe('admin gating', () => {
  it('hides the add actions from non-admins', () => {
    setClaims(viewerClaims);
    renderCustomersAt('/app/customers');
    expect(screen.queryByText('Add customer')).not.toBeInTheDocument();
    expect(screen.getByText('Acme Facilities')).toBeInTheDocument();
  });

  it('shows the no-access panel on the wizard URL as a non-admin', () => {
    setClaims(viewerClaims);
    renderCustomersAt('/app/customers/new');
    expect(
      screen.getByText('You do not have access to this page'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Organisation name')).not.toBeInTheDocument();
  });

  it('lets an admin open the wizard', () => {
    renderCustomersAt('/app/customers/new');
    expect(screen.getByLabelText('Organisation name')).toBeInTheDocument();
  });
});

// --- The wizard --------------------------------------------------------------------

describe('CustomerWizard', () => {
  it('creates the customer with the primary contact in one payload at step 2', async () => {
    const user = userEvent.setup();
    mocks.callableCall.mockResolvedValue({
      customerId: 'c9',
      primaryContactId: 'p9',
      inviteId: 'i9',
    } as unknown);
    renderCustomersAt('/app/customers/new');

    await user.type(screen.getByLabelText('Organisation name'), 'New Org');
    await user.click(screen.getByRole('button', { name: 'Next: contacts' }));

    await user.type(screen.getByLabelText('Name'), 'Pat Piper');
    await user.type(screen.getByLabelText('Email'), 'pat@neworg.example');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'create',
      customer: { name: 'New Org' },
      primaryContact: { name: 'Pat Piper', email: 'pat@neworg.example' },
    });
    // The wizard moved on to the sites step.
    expect(await screen.findByLabelText('Site name')).toBeInTheDocument();
  });

  it('blocks step 1 without an organisation name', async () => {
    const user = userEvent.setup();
    renderCustomersAt('/app/customers/new');
    await user.click(screen.getByRole('button', { name: 'Next: contacts' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter the organisation name.',
    );
    expect(mocks.callableCall).not.toHaveBeenCalled();
  });
});

// --- The profile's contacts panel -------------------------------------------------

describe('CustomerDetail contacts', () => {
  it('derives portal status per contact from uid, invitations and email', () => {
    renderCustomersAt('/app/customers/c1');
    // The panel sits in the page's narrow aside column, so each contact is a
    // CARD rather than a table row (see ContactsPanel). Scope by the card the
    // person's name sits in, exactly as the row used to be scoped.
    const cardFor = (name: string) =>
      screen.getByText(name).closest('li') as HTMLElement;

    // A linked uid is an account, whatever the invitation records say.
    expect(
      within(cardFor('Amy Archer')).getByText('Account active'),
    ).toBeInTheDocument();
    expect(
      within(cardFor('Amy Archer')).getByText('Primary contact'),
    ).toBeInTheDocument();
    // No uid, but an invitation that is still live.
    expect(
      within(cardFor('Ben Brook')).getByText('Invitation sent'),
    ).toBeInTheDocument();
    // No email at all. The headline cannot carry this state on its own - both
    // "never invited" and "nowhere to send an invitation" read as "No portal
    // account" - so the REASON sentence is what actually pins the derivation.
    const cara = within(cardFor('Cara Cole'));
    expect(cara.getByText('No portal account')).toBeInTheDocument();
    expect(
      cara.getByText(
        'No email address on record, so there is nowhere to send an invitation.',
      ),
    ).toBeInTheDocument();
  });

});

// --- Archive / restore --------------------------------------------------------

describe('customer restore', () => {
  it('offers Restore (not Archive) on an archived profile and sends the restore payload after the confirm step', async () => {
    const user = userEvent.setup();
    renderCustomersAt('/app/customers/c3');

    expect(screen.queryByRole('button', { name: 'Archive customer' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Restore customer' }));
    // The confirm step names the customer before anything is sent.
    expect(
      screen.getByText('Restore Closed Company? They return to active lists.'),
    ).toBeInTheDocument();
    expect(mocks.callableCall).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm restore' }));
    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'restore',
      customerId: 'c3',
    });
  });

  it('gives archived list rows a two-step restore action with the same payload', async () => {
    const user = userEvent.setup();
    renderCustomersAt('/app/customers');
    await user.click(screen.getByLabelText('Show archived'));

    await user.click(
      screen.getByRole('button', { name: 'Restore Closed Company' }),
    );
    expect(mocks.callableCall).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Confirm restore of Closed Company' }),
    );
    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'restore',
      customerId: 'c3',
    });
  });
});

// --- The clear protocol -----------------------------------------------------------

describe('CustomerForm clear protocol', () => {
  it('sends null for a cleared field and omits a field that was never set', async () => {
    const user = userEvent.setup();
    // c1 has an address set but no phone or email: clearing the address must
    // send the explicit null (the CLEAR), while the untouched, never-set phone
    // and email stay absent from the payload entirely (no change).
    renderCustomersAt('/app/customers/c1/edit');
    await user.clear(screen.getByLabelText('Head office address (optional)'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'update',
      customerId: 'c1',
      customer: { name: 'Acme Facilities', address: null },
    });
    const [input] = mocks.callableCall.mock.calls[0] as unknown as [
      { customer: Record<string, unknown> },
    ];
    expect('phone' in input.customer).toBe(false);
    expect('email' in input.customer).toBe(false);
  });
});

// --- SiteForm: the contact picker replaces the free-text email/phone ---------------

describe('SiteForm contact', () => {
  it('sends the picked contactId and never writes email or phone', async () => {
    const user = userEvent.setup();
    renderCustomersAt('/app/customers/c1/sites/s1/edit');

    await user.click(screen.getByRole('radio', { name: /Ben Brook/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'update',
      customerId: 'c1',
      siteId: 's1',
      site: {
        name: 'Head Office',
        address: '1 High Street, Leeds',
        contactId: 'p2',
      },
    });
    const [input] = mocks.callableCall.mock.calls[0] as unknown as [
      { site: Record<string, unknown> },
    ];
    expect('email' in input.site).toBe(false);
    expect('phone' in input.site).toBe(false);
  });

  it('clears the contact with null when None is chosen on a linked site', async () => {
    const user = userEvent.setup();
    mocks.fixtures.sites.s1.contactId = 'p2';
    renderCustomersAt('/app/customers/c1/sites/s1/edit');

    expect(screen.getByRole('radio', { name: /Ben Brook/ })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'None' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const [input] = mocks.callableCall.mock.calls[0] as unknown as [
      { site: Record<string, unknown> },
    ];
    expect(input.site.contactId).toBeNull();
  });
});

// --- BuildingForm: the responsible party is a contact, never a typed name ---------

describe('BuildingForm responsible party', () => {
  it('sends the picked contact as a linked snapshot', async () => {
    const user = userEvent.setup();
    renderCustomersAt('/app/customers/c1/sites/s1/buildings/b1/edit');

    await user.click(screen.getByRole('radio', { name: /Amy Archer/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'update',
      siteId: 's1',
      buildingId: 'b1',
      building: {
        name: 'Main Block',
        customerId: 'c1',
        responsibleParty: {
          name: 'Amy Archer',
          role: 'Facilities Director',
          email: 'amy@acme.example',
          contactId: 'p1',
        },
      },
    });
  });

  it('offers no way to type a party who is not a contact', () => {
    renderCustomersAt('/app/customers/c1/sites/s1/buildings/b1/edit');

    // The party is what every automated email resolves through, so the free
    // text escape hatch is gone - a person not in the directory is ADDED to it
    // (the picker's own creator), never typed onto the building.
    expect(
      screen.queryByRole('button', { name: 'Enter manually instead' }),
    ).toBeNull();
    expect(
      screen.queryByLabelText('Responsible party name (optional)'),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Add new contact' }),
    ).toBeInTheDocument();
  });
});

// --- Breadcrumbs -----------------------------------------------------------------

describe('breadcrumbs', () => {
  it('renders the real hierarchy names on the site detail page', () => {
    renderCustomersAt('/app/customers/c1/sites/s1');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByText('Customers')).toBeInTheDocument();
    expect(within(nav).getByText('Acme Facilities')).toBeInTheDocument();
    expect(within(nav).getByText('Head Office')).toBeInTheDocument();
  });
});
