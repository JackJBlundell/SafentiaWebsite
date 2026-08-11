// ============================================================================
// Floating Getting Started widget tests (Phase 3 §5.6, reworked as a widget).
//
// Mocked at the same module boundaries as the other console suites: the auth
// contract, the RTDB bridge and the firebase/database write surface. The
// bridge mock serves RAW fixture values THROUGH the component's own `select`
// functions, so the tick derivations (presence probes, member count) are
// exercised for real rather than stubbed to their answers.
//
// The widget's two presentations (pill / panel) are state, not data: the
// per-tab expand preference lives in real sessionStorage (jsdom provides one),
// so persistence is asserted against the storage the code actually uses.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { ConsoleState } from '../../types';
import { FloatingGettingStarted } from './FloatingGettingStarted';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'member' as string,
    user: { uid: 'user-1', displayName: 'Jane Doe' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
  },
  /** RAW values by key discriminator, exactly as the listeners would deliver
   *  them (undefined = still attaching, null = loaded-and-absent). */
  raw: {} as Record<string, unknown>,
  /** Every update() call: the target path and the written value. */
  updateCalls: [] as Array<{ path: string; value: unknown }>,
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn(), db: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('firebase/database', () => ({
  ref: vi.fn((_db: unknown, path: string) => ({ path })),
  query: vi.fn((node: unknown) => node),
  limitToFirst: vi.fn(),
  update: vi.fn(async (target: { path: string }, value: unknown) => {
    mocks.updateCalls.push({ path: target.path, value });
  }),
}));

/** Serves the raw fixture for the key, run through the component's own
 *  selector so the derivations are the real ones. The presence probes carry a
 *  'presence' discriminator; the org-root reads their usual shapes. */
function rawFor(key: readonly (string | number)[]): unknown {
  switch (key[0]) {
    case 'orgProfile':
      return mocks.raw.profile;
    case 'buildings':
      return mocks.raw.buildingsRoot;
    case 'orgMembers':
      return mocks.raw.members;
    case 'customers':
      return mocks.raw.customers;
    case 'jobs':
      return mocks.raw.jobs;
    case 'consoleState':
      return mocks.raw.consoleState;
    default:
      return undefined;
  }
}

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({
    key,
    select,
  }: {
    key: readonly (string | number)[];
    select?: (value: unknown) => unknown;
  }) => {
    const raw = rawFor(key);
    return {
      data: raw === undefined ? undefined : select ? select(raw) : raw,
      isLoading: raw === undefined,
      isError: false,
    };
  },
}));

// --- Fixtures ---------------------------------------------------------------

function adminSession() {
  mocks.auth.claims = {
    orgId: 'org-1',
    roles: { admin: true },
    testMode: false,
  };
  mocks.auth.paths = forEnv('live');
}

/** A mid-journey org: profile filled in, a teammate invited, a building added;
 *  no customers probe hit (the building fixture is deliberately independent),
 *  no jobs, templates not yet visited. 3 of 6. */
function midJourneyFixtures() {
  mocks.raw.profile = {
    name: 'Acme Fire Safety',
    brand: { primary: '#123456', secondary: '#654321' },
    contact: { address: '1 High Street, London' },
  };
  mocks.raw.members = { 'user-1': { status: 'active' }, 'user-2': { status: 'active' } };
  mocks.raw.buildingsRoot = { 'site-1': { 'building-1': { name: 'Block A' } } };
  mocks.raw.customers = null;
  mocks.raw.jobs = null;
  mocks.raw.consoleState = null;
}

function renderWidget() {
  return render(
    <MemoryRouter>
      <FloatingGettingStarted />
    </MemoryRouter>,
  );
}

/** The collapsed pill, or null. Located by its accessible name (label + count). */
function queryPill() {
  return screen.queryByRole('button', { name: /Getting started/ });
}

/** Expands the widget from its default collapsed pill. */
async function expandWidget() {
  await userEvent.click(screen.getByRole('button', { name: /Getting started/ }));
  return screen.getByRole('region', { name: 'Getting started' });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mocks.raw = {};
  mocks.updateCalls = [];
  mocks.auth.user = { uid: 'user-1', displayName: 'Jane Doe' };
  adminSession();
});

// --- Tests ------------------------------------------------------------------

describe('FloatingGettingStarted', () => {
  it('renders nothing while any source is still attaching (no unticked flash)', () => {
    midJourneyFixtures();
    mocks.raw.jobs = undefined; // one listener yet to deliver
    renderWidget();
    expect(queryPill()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });

  it('renders nothing for non-admin roles', () => {
    midJourneyFixtures();
    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { assessor: true },
      testMode: false,
    };
    renderWidget();
    expect(queryPill()).toBeNull();
  });

  it('defaults to the collapsed pill, carrying the progress count', () => {
    midJourneyFixtures();
    renderWidget();

    const pill = queryPill();
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute('aria-expanded', 'false');
    expect(pill).toHaveTextContent('3/6');
    // Collapsed means collapsed: no checklist in the document.
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
    expect(screen.queryByText('Add a customer')).toBeNull();
  });

  it('expands into the checklist panel, with honest derived ticks and focus moved in', async () => {
    midJourneyFixtures();
    renderWidget();

    const panel = await expandWidget();
    expect(panel).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('3 of 6 done');

    // Ticked: derived from the profile's address, the two-member roster and
    // the non-empty buildings root.
    for (const label of [
      'Complete your organisation profile',
      'Invite a teammate',
      'Add a building',
    ]) {
      const item = screen.getByText(label).closest('li');
      expect(item).not.toBeNull();
      expect(within(item as HTMLElement).getByText('Done:')).toBeInTheDocument();
    }

    // Unticked: absent customers/jobs nodes and an unvisited templates page -
    // each still offering its deep link.
    const customerItem = screen.getByText('Add a customer').closest('li');
    expect(within(customerItem as HTMLElement).getByText('To do:')).toBeInTheDocument();
    expect(
      within(customerItem as HTMLElement).getByRole('link', { name: 'New customer' }),
    ).toHaveAttribute('href', '/app/customers/new');

    // Located by its description: "Schedule a job" is both the label and the
    // deep link's name, so the unique line disambiguates the row.
    const jobItem = screen
      .getByText('A job books an assessor into a building on a date.')
      .closest('li');
    expect(within(jobItem as HTMLElement).getByText('To do:')).toBeInTheDocument();

    const templatesItem = screen.getByText('View your templates').closest('li');
    expect(within(templatesItem as HTMLElement).getByText('To do:')).toBeInTheDocument();

    // A finished step needs no door: ticked rows carry no action link.
    const doneItem = screen.getByText('Invite a teammate').closest('li');
    expect(within(doneItem as HTMLElement).queryByRole('link')).toBeNull();
  });

  it('collapses on the chevron, returning focus to the pill', async () => {
    midJourneyFixtures();
    renderWidget();
    await expandWidget();

    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse the checklist' }),
    );

    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
    expect(queryPill()).toHaveFocus();
  });

  it('collapses on Escape', async () => {
    midJourneyFixtures();
    renderWidget();
    await expandWidget();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
    expect(queryPill()).toHaveFocus();
  });

  it('persists the expanded preference per tab via sessionStorage', async () => {
    midJourneyFixtures();
    const first = renderWidget();
    await expandWidget();
    first.unmount();

    // A fresh mount in the same tab (a navigation, a reload) reopens expanded.
    const second = renderWidget();
    expect(
      screen.getByRole('region', { name: 'Getting started' }),
    ).toBeInTheDocument();

    // Collapsing clears the preference: the next mount is the default pill.
    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse the checklist' }),
    );
    second.unmount();
    renderWidget();
    expect(queryPill()).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });

  it('ticks the templates item from the stored consoleState visit flag', async () => {
    midJourneyFixtures();
    mocks.raw.consoleState = {
      gettingStarted: { templatesVisited: true },
    } satisfies ConsoleState;
    renderWidget();

    expect(queryPill()).toHaveTextContent('4/6');
    await expandWidget();
    expect(screen.getByRole('status')).toHaveTextContent('4 of 6 done');
    const templatesItem = screen.getByText('View your templates').closest('li');
    expect(within(templatesItem as HTMLElement).getByText('Done:')).toBeInTheDocument();
  });

  it('hides forever only through the two-step confirm, persisting to consoleState', async () => {
    midJourneyFixtures();
    renderWidget();
    await expandWidget();

    // Step one arms the confirm; nothing is written and nothing hides yet.
    await userEvent.click(screen.getByRole('button', { name: 'Hide forever' }));
    expect(mocks.updateCalls).toEqual([]);
    expect(
      screen.getByText('Hide this checklist permanently?'),
    ).toBeInTheDocument();

    // Backing out returns the ordinary footer, still without a write.
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(mocks.updateCalls).toEqual([]);
    expect(screen.getByRole('button', { name: 'Take the tour' })).toBeInTheDocument();

    // Arm again and confirm: the widget disappears and the flag persists.
    await userEvent.click(screen.getByRole('button', { name: 'Hide forever' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, hide it' }));

    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
    expect(queryPill()).toBeNull();
    expect(mocks.updateCalls).toEqual([
      { path: 'consoleState/user-1', value: { gettingStartedDismissed: true } },
    ]);
  });

  it('stays hidden when consoleState already carries the dismissal', () => {
    midJourneyFixtures();
    mocks.raw.consoleState = {
      gettingStartedDismissed: true,
    } satisfies ConsoleState;
    renderWidget();
    expect(queryPill()).toBeNull();
  });

  it('auto-hides once every item is ticked', () => {
    midJourneyFixtures();
    mocks.raw.customers = { 'customer-1': { name: 'Bluewater Estates' } };
    mocks.raw.jobs = { 'job-1': { status: 'scheduled' } };
    mocks.raw.consoleState = {
      gettingStarted: { templatesVisited: true },
    } satisfies ConsoleState;
    renderWidget();
    expect(queryPill()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });

  it('offers the tour replay on the fixed event contract', async () => {
    midJourneyFixtures();
    const heard = vi.fn();
    window.addEventListener('safentia:start-tour', heard);
    renderWidget();
    await expandWidget();

    await userEvent.click(screen.getByRole('button', { name: 'Take the tour' }));

    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener('safentia:start-tour', heard);
  });
});
