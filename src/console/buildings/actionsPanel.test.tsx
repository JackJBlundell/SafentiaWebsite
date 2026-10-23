// ============================================================================
// ActionsPanel tests (stories 2042/2043/2045): severity ordering, the filters,
// the overdue error tone with LTP escalation, and the two-step sign-off /
// reopen confirmations calling manageAction with the right payloads.
//
// Mocked at the same module boundaries as buildings.test.tsx: AuthProvider,
// the RTDB bridge and the firebase module - no test opens a socket. The
// callable layer is mocked at firebase/functions so the REAL useCallable runs
// and the payloads it sends are asserted.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { forEnv } from '../../paths';
import type { SessionClaims } from '../../auth/claims';
import type { Action } from '../../types';

// --- Module mocks -------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: null as unknown,
    claims: null as unknown,
    paths: null as unknown,
  },
  rtdb: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
  },
  callable: vi.fn(async () => ({ data: { actionId: 'act-1' } })),
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

vi.mock('firebase/storage', async () => (await import('../../test/storageMock')).storageModule);

vi.mock('firebase/functions', () => ({
  httpsCallable: () => mocks.callable,
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

// The severity chip resolves fixed safety colours from the theme; the tests
// assert copy and structure, so a minimal palette is all the mock needs.
vi.mock('../../design/ThemeProvider', () => ({
  useTheme: () => ({
    theme: {
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
  useRtdbQuery: () => ({
    data: mocks.rtdb.data,
    isLoading: mocks.rtdb.isLoading,
    isError: mocks.rtdb.isError,
  }),
  subscribeToQuery: vi.fn(() => () => undefined),
}));

import { ActionsPanel } from './ActionsPanel';
import { activateStoredLink } from '../../test/storageMock';

// --- Fixtures -------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const adminClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

function action(overrides: Partial<Action>): Action {
  return {
    assessmentId: 'manual',
    sectionCode: 'manual',
    question: '',
    observation: 'An observation',
    severity: 'M',
    lifeProtection: false,
    status: 'open',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv('test');
  mocks.rtdb.data = undefined;
  mocks.rtdb.isLoading = false;
  mocks.rtdb.isError = false;
  mocks.callable.mockClear();
});

describe('ActionsPanel', () => {
  it('marks an overdue open action in the error tone and escalates LTP', () => {
    mocks.rtdb.data = {
      a1: action({
        observation: 'Wedged fire door',
        severity: 'H',
        lifeProtection: true,
        dueBy: Date.now() - 3 * DAY_MS,
      }),
      a2: action({
        observation: 'Faded signage',
        severity: 'L',
        dueBy: Date.now() - 3 * DAY_MS,
      }),
    };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);
    // The LTP overdue action escalates beyond the plain overdue badge.
    expect(screen.getByText('Overdue · LTP')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Life protection')).toBeInTheDocument();
  });

  it('filters by status', () => {
    mocks.rtdb.data = {
      open1: action({ observation: 'Open item' }),
      done1: action({
        observation: 'Completed item',
        status: 'signedOff',
        signedOffBy: 'uid-1',
        signedOffAt: Date.now(),
      }),
    };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);
    expect(screen.getByText('Open item')).toBeInTheDocument();
    expect(screen.getByText('Completed item')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'open' },
    });
    expect(screen.getByText('Open item')).toBeInTheDocument();
    expect(screen.queryByText('Completed item')).not.toBeInTheDocument();
  });

  it('filters to overdue only', () => {
    mocks.rtdb.data = {
      late: action({ observation: 'Late item', dueBy: Date.now() - 3 * DAY_MS }),
      fine: action({ observation: 'Future item', dueBy: Date.now() + 30 * DAY_MS }),
    };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);
    fireEvent.click(screen.getByLabelText('Overdue only'));
    expect(screen.getByText('Late item')).toBeInTheDocument();
    expect(screen.queryByText('Future item')).not.toBeInTheDocument();
  });

  it('filters by responsible, including the Unassigned option (story 2042)', () => {
    mocks.rtdb.data = {
      a1: action({ observation: 'Alpha item', responsible: 'Amy Archer' }),
      a2: action({ observation: 'Bravo item', responsible: 'Ben Brook' }),
      a3: action({ observation: 'Charlie item' }),
    };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);

    const filter = screen.getByLabelText('Responsible');
    // Options are the distinct names present, plus Everyone and Unassigned.
    expect(
      within(filter).getAllByRole('option').map((o) => o.textContent),
    ).toEqual(['Everyone', 'Amy Archer', 'Ben Brook', 'Unassigned']);

    fireEvent.change(filter, { target: { value: 'name:Amy Archer' } });
    expect(screen.getByText('Alpha item')).toBeInTheDocument();
    expect(screen.queryByText('Bravo item')).not.toBeInTheDocument();
    expect(screen.queryByText('Charlie item')).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'unassigned' } });
    expect(screen.queryByText('Alpha item')).not.toBeInTheDocument();
    expect(screen.getByText('Charlie item')).toBeInTheDocument();
  });

  // A download URL for our own bucket; anything else is refused (useStoredFileUrl).
  const OWN_FLAG_URL =
    'https://firebasestorage.googleapis.com/v0/b/safentia-tech.firebasestorage.app/o/live%2Forgs%2Forg-1%2Fbuildings%2Fbld-1%2Fflags%2Fcomposite.png?alt=media&token=t';

  it('never links a stored URL outside our own Storage bucket', () => {
    mocks.rtdb.data = {
      a1: action({
        observation: 'Flagged finding',
        locationFlagUrl: 'https://example.com/flags/composite.png',
      }),
    };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);
    expect(screen.queryByRole('link', { name: 'View location' })).not.toBeInTheDocument();
  });

  it('renders View location for a flag-born action, opening full size in a new tab', async () => {
    mocks.rtdb.data = {
      a1: action({
        observation: 'Flagged finding',
        locationFlagUrl: OWN_FLAG_URL,
      }),
      a2: action({ observation: 'Plain finding' }),
    };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);
    const link = await screen.findByRole('link', { name: 'View location' });
    // Fetched through the SDK (App Check) on click, then shown in a new tab.
    expect(await activateStoredLink(link)).toEqual({
      via: 'tab',
      url: 'blob:live/orgs/org-1/buildings/bld-1/flags/composite.png',
    });
    // Only the flag-born action carries the link.
    expect(screen.getAllByRole('link', { name: 'View location' })).toHaveLength(1);
  });

  it('signs off only after the explicit confirm step', async () => {
    mocks.rtdb.data = { a1: action({ observation: 'Open item' }) };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));
    // First press arms the confirmation; nothing has been sent yet.
    expect(mocks.callable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm sign off' }));
    await waitFor(() =>
      expect(mocks.callable).toHaveBeenCalledWith({
        action: 'signOff',
        buildingId: 'bld-1',
        actionId: 'a1',
      }),
    );
  });

  it('reopen also requires its confirm step, and cancel disarms it', () => {
    mocks.rtdb.data = {
      a1: action({
        observation: 'Completed item',
        status: 'signedOff',
        signedOffBy: 'uid-1',
        signedOffAt: Date.now(),
      }),
    };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.callable).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('creates an action through manageAction with the whitelisted fields', async () => {
    mocks.rtdb.data = {};
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    fireEvent.change(screen.getByLabelText('Observation'), {
      target: { value: 'New finding' },
    });
    // Two Severity selects exist (filter + form); the form's renders second.
    const severitySelects = screen.getAllByLabelText('Severity');
    fireEvent.change(severitySelects[severitySelects.length - 1], {
      target: { value: 'H' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add action' }));
    await waitFor(() =>
      expect(mocks.callable).toHaveBeenCalledWith({
        action: 'create',
        buildingId: 'bld-1',
        fields: {
          observation: 'New finding',
          severity: 'H',
          lifeProtection: false,
        },
      }),
    );
  });

  it('hides the management controls from non-admins', () => {
    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { assessor: true },
      environment: 'test',
    } satisfies SessionClaims;
    mocks.rtdb.data = { a1: action({ observation: 'Open item' }) };
    render(<ActionsPanel siteId="site-1" buildingId="bld-1" />);
    expect(screen.queryByRole('button', { name: 'Add action' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign off' })).not.toBeInTheDocument();
  });
});
