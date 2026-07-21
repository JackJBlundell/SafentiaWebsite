// ============================================================================
// Jobs area tests (stories 2024/2025/2027 + slot scheduling 3001).
//
// Following the console.test.tsx pattern: AuthProvider, the RTDB bridge and the
// callable hook are mocked at the module boundary, so these tests drive pure
// rendering, filtering and payload assembly with no sockets. The RTDB mock
// dispatches on the key's domain prefix, mirroring how the real bridge is
// addressed; the callable mock is stateful so a rejection surfaces exactly as
// the real hook surfaces it (error state -> role=alert).
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { Building, Customer, Job, OrgMember, Site, Template } from '../../types';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'authenticated',
      user: { uid: 'uid-admin' } as unknown,
      claims: {
        orgId: 'org-1',
        roles: { admin: true },
        environment: 'test',
      } as unknown,
      paths: null as unknown,
    },
    jobRows: [] as unknown[],
    /** The timeline's one-day window (keys.jobsForDay). */
    dayJobs: [] as unknown[],
    job: null as unknown,
    assessment: null as unknown,
    customers: null as unknown,
    customer: null as unknown,
    sites: null as unknown,
    site: null as unknown,
    buildingsBySite: {} as Record<string, unknown>,
    building: null as unknown,
    members: null as unknown,
    templates: null as unknown,
    template: null as unknown,
    /** name -> handler; a thrown Error's message becomes the hook's error. */
    handlers: {} as Record<string, (input: unknown) => Promise<unknown>>,
    calls: [] as Array<{ name: string; input: unknown }>,
  };
});

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

// Dispatch on the key's domain prefix, as the real bridge is addressed by key.
// Data is returned in the SELECTED shape (the mock bypasses `select`).
vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: (options: { key: readonly unknown[] }) => {
    const key = options.key;
    const domain = key[0];
    const data =
      domain === 'jobs' && key[2] === 'window'
        ? mocks.jobRows
        : domain === 'jobs' && key[2] === 'day'
          ? mocks.dayJobs
          : domain === 'jobs'
          ? mocks.job
          : domain === 'assessment'
            ? mocks.assessment
            : domain === 'customers'
              ? mocks.customers
              : domain === 'customer'
                ? mocks.customer
                : domain === 'sites'
                  ? mocks.sites
                  : domain === 'site'
                    ? mocks.site
                    : domain === 'buildings'
                      ? mocks.buildingsBySite[String(key[2])]
                      : domain === 'building'
                        ? mocks.building
                        : domain === 'orgMembers'
                          ? mocks.members
                          : domain === 'templates'
                            ? mocks.templates
                            : domain === 'template'
                              ? mocks.template
                              : undefined;
    return { data, isLoading: false, isError: false };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

// Stateful callable mock: resolves through mocks.handlers; a thrown Error's
// message lands in `error` exactly as the real hook's mapped copy does.
vi.mock('../ui/useCallable', async () => {
  const { useState } = await import('react');
  return {
    useCallable: (name: string) => {
      const [error, setError] = useState<string | null>(null);
      return {
        call: async (input: unknown) => {
          mocks.calls.push({ name, input });
          setError(null);
          const handler = mocks.handlers[name];
          try {
            return handler ? await handler(input) : null;
          } catch (caught) {
            setError((caught as Error).message);
            return null;
          }
        },
        pending: false,
        error,
        clearError: () => setError(null),
      };
    },
  };
});

import { JobsBoard } from './JobsBoard';
import { JobWizard } from './JobWizard';
import { JobDetail } from './JobDetail';

// --- Fixtures ----------------------------------------------------------------

const jobFixture = (overrides: Partial<Job> & { id: string }) => ({
  templateId: 't1',
  templateVersion: 3,
  customerId: 'c1',
  siteId: 's1',
  buildingId: 'b1',
  assessorUid: 'uid-jane',
  scheduledFor: Date.UTC(2026, 6, 20, 9, 0),
  scheduledUntil: Date.UTC(2026, 6, 20, 11, 0),
  status: 'scheduled' as const,
  ...overrides,
});

const member = (name: string, assessor = true): OrgMember => ({
  name,
  email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
  roles: assessor ? { assessor: true } : { admin: true },
  status: 'active',
});

beforeEach(() => {
  mocks.auth.paths = forEnv('test');
  mocks.auth.claims = {
    orgId: 'org-1',
    roles: { admin: true },
    environment: 'test',
  };
  mocks.calls = [];
  mocks.handlers = {};

  mocks.customers = {
    c1: { name: 'Acme Housing', status: 'active' } satisfies Customer,
  };
  mocks.sites = {
    s1: { name: 'Riverside Estate' } satisfies Site,
  };
  mocks.buildingsBySite = {
    s1: {
      b1: { name: 'Building One', customerId: 'c1', riskLevel: 'pending' },
      b2: { name: 'Building Two', customerId: 'c1', riskLevel: 'pending' },
    } as Record<string, Building>,
  };
  mocks.members = {
    'uid-jane': member('Jane Assessor'),
    'uid-omar': member('Omar Assessor'),
  };
  mocks.templates = {
    t1: {
      name: 'PAS 79 FRA',
      version: 3,
      status: 'published',
      standard: 'pas79',
      sections: [],
    } satisfies Template,
    t2: {
      name: 'Draft template',
      version: 1,
      status: 'draft',
      sections: [],
    } satisfies Template,
  };

  mocks.jobRows = [
    jobFixture({ id: 'job-1', buildingId: 'b1', status: 'scheduled' }),
    jobFixture({
      id: 'job-2',
      buildingId: 'b2',
      status: 'released',
      scheduledFor: Date.UTC(2026, 6, 21, 13, 0),
      scheduledUntil: Date.UTC(2026, 6, 21, 15, 0),
    }),
  ];

  mocks.dayJobs = [];
  mocks.job = jobFixture({ id: 'job-1' });
  mocks.assessment = null;
  mocks.customer = { name: 'Acme Housing', status: 'active' };
  mocks.site = { name: 'Riverside Estate' };
  mocks.building = { name: 'Building One', customerId: 'c1', riskLevel: 'pending' };
  mocks.template = mocks.templates ? (mocks.templates as Record<string, unknown>).t1 : null;
});

// --- Board (story 2025) -------------------------------------------------------

describe('JobsBoard', () => {
  it('renders a row per job with resolved building, customer and assessor names', () => {
    render(
      <MemoryRouter>
        <JobsBoard />
      </MemoryRouter>,
    );
    expect(screen.getByRole('cell', { name: 'Building One' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Building Two' })).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: 'Acme Housing' })).toHaveLength(2);
    expect(screen.getAllByRole('cell', { name: 'Jane Assessor' })).toHaveLength(2);
    // Canonical status labels (as cells - the filter offers the same words).
    expect(screen.getByRole('cell', { name: 'Scheduled' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Released' })).toBeInTheDocument();
    expect(screen.getByText(/Showing the most recent 2 jobs/)).toBeInTheDocument();
  });

  it('narrows rows with the status filter', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <JobsBoard />
      </MemoryRouter>,
    );
    await user.selectOptions(screen.getByLabelText('Status'), 'released');
    expect(screen.getByRole('cell', { name: 'Building Two' })).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'Building One' }),
    ).not.toBeInTheDocument();
  });

  it('gives the board a page header with the admin schedule action', () => {
    render(
      <MemoryRouter>
        <JobsBoard />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Jobs' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Schedule a job' })).toBeInTheDocument();
  });

  it('summarises the loaded window in the at-a-glance tiles', () => {
    const DAY = 24 * 60 * 60 * 1000;
    // A crafted window relative to now: one future scheduled visit, one past
    // released visit, one future cancelled visit. Upcoming counts the future
    // and not-cancelled (1); awaiting counts scheduled (1); cancelled (1).
    mocks.jobRows = [
      jobFixture({ id: 'j-up', scheduledFor: Date.now() + 10 * DAY, status: 'scheduled' }),
      jobFixture({ id: 'j-past', scheduledFor: Date.now() - 10 * DAY, status: 'released' }),
      jobFixture({ id: 'j-cancel', scheduledFor: Date.now() + 10 * DAY, status: 'cancelled' }),
    ];
    render(
      <MemoryRouter>
        <JobsBoard />
      </MemoryRouter>,
    );
    const region = screen.getByRole('region', { name: 'Jobs at a glance' });
    const tileText = (label: string) =>
      within(region).getByText(label).closest('div')?.textContent ?? '';
    expect(tileText('In view')).toContain('3');
    expect(tileText('Upcoming')).toContain('1');
    expect(tileText('Awaiting visit')).toContain('1');
    expect(tileText('Cancelled')).toContain('1');
  });

  it('shows a value-shaped skeleton while the window is still attaching', () => {
    mocks.jobRows = undefined as unknown as unknown[];
    render(
      <MemoryRouter>
        <JobsBoard />
      </MemoryRouter>,
    );
    // The skeleton's announced status line (role=status is not named from its
    // own text, so match the copy directly).
    expect(screen.getByText('Loading scheduled jobs')).toBeInTheDocument();
    // No empty state masquerades as a loaded-but-empty board while loading.
    expect(
      screen.queryByRole('heading', { name: 'No jobs scheduled yet' }),
    ).not.toBeInTheDocument();
  });

  it('clears every active filter with Clear all', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <JobsBoard />
      </MemoryRouter>,
    );
    await user.selectOptions(screen.getByLabelText('Status'), 'released');
    await user.selectOptions(screen.getByLabelText('Customer'), 'c1');
    // A chip names each active filter, and only the released job remains.
    expect(
      screen.getByRole('button', { name: /Remove filter: Status: Released/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'Building One' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    // Every row is back and the summary row (with its Clear all) is gone.
    expect(screen.getByRole('cell', { name: 'Building One' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Building Two' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Clear all' }),
    ).not.toBeInTheDocument();
  });

  it('distinguishes an empty window from a filtered-empty result', async () => {
    const user = userEvent.setup();
    // A loaded-but-empty window: the honest "nothing scheduled" state.
    mocks.jobRows = [];
    const { unmount } = render(
      <MemoryRouter>
        <JobsBoard />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('heading', { name: 'No jobs scheduled yet' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'No jobs match these filters' }),
    ).not.toBeInTheDocument();
    unmount();

    // A non-empty window whose filters exclude everything: the distinct
    // filtered-empty state, offering a clear-filters recovery.
    mocks.jobRows = [jobFixture({ id: 'job-1', status: 'scheduled' })];
    render(
      <MemoryRouter>
        <JobsBoard />
      </MemoryRouter>,
    );
    await user.selectOptions(screen.getByLabelText('Status'), 'cancelled');
    expect(
      screen.getByRole('heading', { name: 'No jobs match these filters' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Clear all filters' }),
    ).toBeInTheDocument();
  });
});

// --- Wizard (stories 2024 + 3001) ----------------------------------------------

describe('JobWizard', () => {
  const renderWizard = () =>
    render(
      <MemoryRouter initialEntries={['/app/jobs/new']}>
        <Routes>
          <Route path="/app/jobs/new" element={<JobWizard />} />
          <Route path="/app/jobs/:jobId" element={<p>job detail stub</p>} />
        </Routes>
      </MemoryRouter>,
    );

  it('refuses to leave a step until its selections are made', async () => {
    const user = userEvent.setup();
    renderWizard();

    // Step 1 gate: nothing chosen.
    await user.click(screen.getByRole('button', { name: 'Next: what' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose the customer, site and building for this visit.',
    );
    // Still on step 1.
    expect(screen.getByLabelText('Customer')).toBeInTheDocument();

    // Cascading selects unlock as their parents are chosen.
    expect(screen.getByLabelText('Site')).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Customer'), 'c1');
    expect(screen.getByLabelText('Site')).toBeEnabled();
    await user.selectOptions(screen.getByLabelText('Site'), 's1');
    await user.selectOptions(screen.getByLabelText('Building'), 'b1');
    await user.click(screen.getByRole('button', { name: 'Next: what' }));

    // Step 2 gate: no template chosen.
    await user.click(screen.getByRole('button', { name: 'Next: who and when' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose the template this assessment will follow.',
    );
  });

  it('lists only published templates, tagged with their standard', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.selectOptions(screen.getByLabelText('Customer'), 'c1');
    await user.selectOptions(screen.getByLabelText('Site'), 's1');
    await user.selectOptions(screen.getByLabelText('Building'), 'b1');
    await user.click(screen.getByRole('button', { name: 'Next: what' }));

    expect(
      screen.getByRole('option', { name: 'PAS 79 FRA (v3, PAS 79)' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Draft template/ }),
    ).not.toBeInTheDocument();
  });

  it('submits createJob with both slot times as epoch millis', async () => {
    const user = userEvent.setup();
    mocks.handlers.createJob = async () => ({ jobId: 'job-9' });
    renderWizard();

    await user.selectOptions(screen.getByLabelText('Customer'), 'c1');
    await user.selectOptions(screen.getByLabelText('Site'), 's1');
    await user.selectOptions(screen.getByLabelText('Building'), 'b1');
    await user.click(screen.getByRole('button', { name: 'Next: what' }));
    await user.selectOptions(screen.getByLabelText('Template'), 't1');
    await user.click(screen.getByRole('button', { name: 'Next: who and when' }));

    await user.selectOptions(screen.getByLabelText('Assessor'), 'uid-jane');
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-07-20' },
    });
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '09:00' },
    });
    // End before start is refused client-side.
    fireEvent.change(screen.getByLabelText('End time'), {
      target: { value: '08:30' },
    });
    await user.click(screen.getByRole('button', { name: 'Schedule job' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The end time must be after the start time.',
    );
    expect(mocks.calls).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('End time'), {
      target: { value: '10:30' },
    });
    await user.click(screen.getByRole('button', { name: 'Schedule job' }));

    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0].name).toBe('createJob');
    expect(mocks.calls[0].input).toEqual({
      templateId: 't1',
      templateVersion: 3,
      customerId: 'c1',
      siteId: 's1',
      buildingId: 'b1',
      assessorUid: 'uid-jane',
      scheduledFor: new Date('2026-07-20T09:00:00').getTime(),
      scheduledUntil: new Date('2026-07-20T10:30:00').getTime(),
    });
    // Success lands on the new job's detail.
    expect(await screen.findByText('job detail stub')).toBeInTheDocument();
  });
});

// --- Step 3 scheduling UX: snapping + the day timeline ---------------------------

describe('JobWizard scheduling', () => {
  const renderWizard = () =>
    render(
      <MemoryRouter initialEntries={['/app/jobs/new']}>
        <Routes>
          <Route path="/app/jobs/new" element={<JobWizard />} />
          <Route path="/app/jobs/:jobId" element={<p>job detail stub</p>} />
        </Routes>
      </MemoryRouter>,
    );

  /** Walk to step 3 with assessor and date chosen. */
  const toStepThree = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.selectOptions(screen.getByLabelText('Customer'), 'c1');
    await user.selectOptions(screen.getByLabelText('Site'), 's1');
    await user.selectOptions(screen.getByLabelText('Building'), 'b1');
    await user.click(screen.getByRole('button', { name: 'Next: what' }));
    await user.selectOptions(screen.getByLabelText('Template'), 't1');
    await user.click(screen.getByRole('button', { name: 'Next: who and when' }));
    await user.selectOptions(screen.getByLabelText('Assessor'), 'uid-jane');
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-07-20' },
    });
  };

  it('snaps typed times to the nearest 15 minutes instead of erroring', async () => {
    const user = userEvent.setup();
    mocks.handlers.createJob = async () => ({ jobId: 'job-9' });
    renderWizard();
    await toStepThree(user);

    // 09:07 rounds DOWN to 09:00; the end auto-fills at the default 2 hours.
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '09:07' },
    });
    expect(screen.getByLabelText('Start time')).toHaveValue('09:00');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00');

    // 09:08 rounds UP to 09:15; the 2-hour duration travels with the start.
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '09:08' },
    });
    expect(screen.getByLabelText('Start time')).toHaveValue('09:15');
    expect(screen.getByLabelText('End time')).toHaveValue('11:15');

    // The end snaps too, and there is no boundary error - snapping replaced it.
    fireEvent.change(screen.getByLabelText('End time'), {
      target: { value: '10:37' },
    });
    expect(screen.getByLabelText('End time')).toHaveValue('10:30');
    expect(screen.queryByText(/boundary/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // The submitted epochs are the snapped values.
    await user.click(screen.getByRole('button', { name: 'Schedule job' }));
    expect(mocks.calls[0]?.input).toMatchObject({
      scheduledFor: new Date('2026-07-20T09:15:00').getTime(),
      scheduledUntil: new Date('2026-07-20T10:30:00').getTime(),
    });
  });

  it('marks a clash on the timeline when the proposal overlaps a booking', async () => {
    const user = userEvent.setup();
    mocks.dayJobs = [
      jobFixture({
        id: 'job-busy',
        buildingId: 'b1',
        scheduledFor: new Date('2026-07-20T09:00:00').getTime(),
        scheduledUntil: new Date('2026-07-20T11:00:00').getTime(),
      }),
    ];
    renderWizard();
    await toStepThree(user);

    // A non-overlapping proposal is calm.
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '13:00' },
    });
    expect(screen.queryByText(/Clashes with/)).not.toBeInTheDocument();

    // Overlap 10:00-12:00 against 09:00-11:00: the clash line names the visit.
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '10:00' },
    });
    expect(screen.getByText(/Clashes with Building One/)).toBeInTheDocument();
    // Advisory guidance, not an error: no alert until the server refuses.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('places a slot from a click on the timeline and submits those epochs', async () => {
    const user = userEvent.setup();
    mocks.handlers.createJob = async () => ({ jobId: 'job-9' });
    renderWizard();
    await toStepThree(user);

    // jsdom has no layout: give the day surface a real height so the click
    // position maths (clientY -> minute) has something to divide by. The
    // window is 07:00-19:00, so 25% down = 10:00.
    const day = screen.getByRole('img');
    day.getBoundingClientRect = () =>
      ({ top: 0, left: 0, right: 320, bottom: 576, width: 320, height: 576, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    // jsdom lacks a full PointerEvent; a MouseEvent with the pointerdown type
    // reaches React's onPointerDown listener and carries a real clientY.
    fireEvent(
      day,
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 144 }),
    );

    // The inputs follow the timeline: 10:00 plus the default 2-hour duration.
    expect(screen.getByLabelText('Start time')).toHaveValue('10:00');
    expect(screen.getByLabelText('End time')).toHaveValue('12:00');

    await user.click(screen.getByRole('button', { name: 'Schedule job' }));
    expect(mocks.calls[0]?.input).toMatchObject({
      scheduledFor: new Date('2026-07-20T10:00:00').getTime(),
      scheduledUntil: new Date('2026-07-20T12:00:00').getTime(),
    });
  });

  it('moves and resizes the proposal by 15 minutes with the arrow keys', async () => {
    const user = userEvent.setup();
    renderWizard();
    await toStepThree(user);

    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '09:00' },
    });
    const proposal = screen.getByLabelText(/Proposed slot/);

    // Down moves the whole slot a quarter-hour later.
    fireEvent.keyDown(proposal, { key: 'ArrowDown' });
    expect(screen.getByLabelText('Start time')).toHaveValue('09:15');
    expect(screen.getByLabelText('End time')).toHaveValue('11:15');

    // Up moves it back.
    fireEvent.keyDown(proposal, { key: 'ArrowUp' });
    expect(screen.getByLabelText('Start time')).toHaveValue('09:00');
    expect(screen.getByLabelText('End time')).toHaveValue('11:00');

    // Shift+Down grows the visit by a quarter-hour (the start holds).
    fireEvent.keyDown(proposal, { key: 'ArrowDown', shiftKey: true });
    expect(screen.getByLabelText('Start time')).toHaveValue('09:00');
    expect(screen.getByLabelText('End time')).toHaveValue('11:15');
  });
});

// --- Detail (story 2027) --------------------------------------------------------

describe('JobDetail', () => {
  const renderDetail = () =>
    render(
      <MemoryRouter initialEntries={['/app/jobs/job-1']}>
        <Routes>
          <Route path="/app/jobs/:jobId" element={<JobDetail />} />
        </Routes>
      </MemoryRouter>,
    );

  it('shows the schedule, resolved names, and the not-started assessment state', () => {
    renderDetail();
    expect(screen.getAllByText('Building One').length).toBeGreaterThan(0);
    expect(screen.getByText('Riverside Estate')).toBeInTheDocument();
    expect(screen.getByText('Jane Assessor')).toBeInTheDocument();
    expect(screen.getByText(/Not started yet/)).toBeInTheDocument();
    expect(screen.getByText(/09:00 to 11:00|10:00 to 12:00/)).toBeInTheDocument();
  });

  it('offers Open in validation while the assessment is ready for release', () => {
    mocks.assessment = {
      jobId: 'job-1',
      status: 'readyForRelease',
      conductedBy: 'uid-jane',
      conductedAt: Date.UTC(2026, 6, 20, 9, 30),
      workflow: { submittedAt: Date.UTC(2026, 6, 20, 11, 30) },
    };
    renderDetail();
    expect(screen.getByText('Open in validation')).toBeInTheDocument();
  });

  it('reschedules a slot-less legacy visit by start alone, sending no end time', async () => {
    const user = userEvent.setup();
    const legacy = jobFixture({ id: 'job-1' }) as Record<string, unknown>;
    delete legacy.scheduledUntil;
    mocks.job = legacy;
    mocks.handlers.rescheduleJob = async () => ({ updated: true });
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'Reschedule' }));
    // The end input is empty (the visit never had one) and stays empty when
    // the start moves - no default duration is forced onto a legacy visit.
    expect(screen.getByLabelText('End time')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '10:00' },
    });
    expect(screen.getByLabelText('End time')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Reschedule' }));

    expect(mocks.calls[0]?.name).toBe('rescheduleJob');
    expect(mocks.calls[0]?.input).not.toHaveProperty('scheduledUntil');
    expect(mocks.calls[0]?.input).toHaveProperty('scheduledFor');
  });

  it('surfaces a reschedule clash rejection verbatim in a role=alert', async () => {
    const user = userEvent.setup();
    const clash =
      'That slot clashes with Riverside Tower on 20 July 2026 (09:00 to 11:00).';
    mocks.handlers.rescheduleJob = async () => {
      throw new Error(clash);
    };
    renderDetail();

    await user.click(screen.getByRole('button', { name: 'Reschedule' }));
    fireEvent.change(screen.getByLabelText('Start time'), {
      target: { value: '09:30' },
    });
    fireEvent.change(screen.getByLabelText('End time'), {
      target: { value: '11:30' },
    });
    await user.click(screen.getByRole('button', { name: 'Reschedule' }));

    expect(mocks.calls[0]?.name).toBe('rescheduleJob');
    expect(await screen.findByRole('alert')).toHaveTextContent(clash);
  });
});
