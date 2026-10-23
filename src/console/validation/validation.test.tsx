// ============================================================================
// Validation area tests: the role gate, the two-section queue, the full-
// fidelity review rendering, the flag basket -> requestInfo batch, the accept
// guard while flags are outstanding, and the release confirm/result flow.
// Auth, the RTDB bridge, the theme and the callable hook are mocked at their
// module boundaries (the console test pattern); these are rendering and
// interaction tests, not network tests.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { forEnv } from '../../paths';
import type {
  Assessment,
  AssessmentAnswer,
  Building,
  Job,
  OrgMember,
  Template,
} from '../../types';
import { INFO_REQUEST_DUE_DAYS } from '../../types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The end of the LOCAL day containing `millis` - the instant the review
 *  screen sends as a response deadline ("due by the 28th" means all of the
 *  28th). Mirrors AssessmentReview's date-input round trip so the expected
 *  value tracks the running clock instead of a date that goes stale. */
function endOfLocalDay(millis: number): number {
  const date = new Date(millis);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  ).getTime();
}

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: { uid: 'auditor-1', email: 'auditor@example.com' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  },
  /** Data served by the useRtdbQuery mock: exact joined key first, then the
   *  key's first segment as a fallback (single-map nodes like orgMembers). */
  rtdb: {} as Record<string, unknown>,
  callable: vi.fn(async (_name: string, _input: unknown) => ({}) as unknown),
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

// Report PDFs are checked and fetched at the firebase/storage boundary, so the
// released download works without touching Storage (the buildings tests'
// pattern).
vi.mock('firebase/storage', async () => (await import('../../test/storageMock')).storageModule);

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
  useRtdbQuery: ({ key }: { key: readonly (string | number)[] }) => {
    const exact = key.join('/');
    const data = exact in mocks.rtdb ? mocks.rtdb[exact] : mocks.rtdb[String(key[0])];
    return { data, isLoading: false, isError: false };
  },
}));

vi.mock('../ui/useCallable', () => ({
  useCallable: (name: string) => ({
    call: (input: unknown) => mocks.callable(name, input),
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import { ValidationRoutes } from './ValidationRoutes';
import { activateStoredLink, storageMock } from '../../test/storageMock';

const auditorClaims = {
  orgId: 'org-1',
  roles: { auditor: true },
  environment: 'test',
};

const snapshot: Template = {
  name: 'PAS 79 Fire Risk Assessment',
  version: 3,
  status: 'published',
  standard: 'pas79',
  sections: [
    {
      id: 'sec-1',
      code: '01',
      title: 'Occupancy profile',
      questions: [
        { id: 'q-1', text: 'Who occupies the premises?', type: 'longtext' },
        { id: 'q-2', text: 'Is there a sleeping risk?', type: 'yesno' },
      ],
    },
    {
      id: 'sec-2',
      code: '02',
      title: 'Ignition sources',
      questions: [
        {
          id: 'q-3',
          text: 'Is the fixed electrical installation satisfactory?',
          type: 'nonConformity',
        },
      ],
    },
  ],
};

function assessment(status: Assessment['status']): Assessment {
  return {
    jobId: 'job-1',
    buildingId: 'b-1',
    customerId: 'c-1',
    templateSnapshot: snapshot,
    conductedBy: 'uid-sam',
    conductedAt: Date.UTC(2026, 6, 1),
    responsibleParty: { name: 'Helen Carter', role: 'Facilities Director' },
    workflow: { submittedAt: Date.UTC(2026, 6, 2, 9, 30) },
    status,
  };
}

const answers: Record<string, AssessmentAnswer> = {
  'q-1': { text: 'Office workers across three floors.' },
  'q-2': { value: false },
  'q-3': {
    value: false,
    severity: 'H',
    observation: 'Distribution board overloaded with daisy-chained extension leads.',
  },
};

const members: Record<string, OrgMember> = {
  'uid-sam': {
    name: 'Sam Porter',
    email: 'sam@example.com',
    roles: { assessor: true },
    status: 'active',
  },
};

const job: Job = {
  templateId: 't-1',
  templateVersion: 3,
  customerId: 'c-1',
  siteId: 'site-1',
  buildingId: 'b-1',
  assessorUid: 'uid-sam',
  scheduledFor: Date.UTC(2026, 5, 30),
  status: 'readyForValidation',
};

const building: Building = {
  name: 'Meridian Tower A',
  customerId: 'c-1',
  riskLevel: 'medium',
  serviceSchedule: { fireDrill: { nextDue: Date.UTC(2026, 8, 1) } },
};

function seedReview(status: Assessment['status']) {
  mocks.rtdb = {
    'assessment/org-1/job-1': assessment(status),
    'assessmentAnswers/org-1/job-1': answers,
    orgMembers: members,
    'jobs/org-1/job-1': job,
    'building/org-1/site-1/b-1': building,
    'customer/org-1/c-1': { name: 'Meridian Estates', status: 'active' },
  };
}

function renderValidationAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ValidationRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.auth.claims = auditorClaims;
  mocks.auth.paths = forEnv('test');
  mocks.rtdb = {};
  mocks.callable.mockClear();
  mocks.callable.mockResolvedValue({});
  storageMock.reset();
});

describe('ValidationRoutes gate', () => {
  it('shows the calm no-access panel to a viewer at a direct URL', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { viewer: true }, environment: 'test' };
    seedReview('readyForValidation');
    renderValidationAt('/');
    expect(
      screen.getByRole('heading', { name: 'Auditor access required' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Awaiting validation')).not.toBeInTheDocument();
  });

  it('admits an admin without the auditor role', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { admin: true }, environment: 'test' };
    renderValidationAt('/');
    expect(screen.getByRole('heading', { name: 'Validation' })).toBeInTheDocument();
  });
});

describe('ValidationQueue', () => {
  it('renders both sections from the stage subscriptions', () => {
    seedReview('readyForValidation');
    mocks.rtdb['assessments/org-1/status/readyForValidation'] = {
      'job-1': assessment('readyForValidation'),
    };
    mocks.rtdb['assessments/org-1/status/infoRequired'] = {
      'job-2': { ...assessment('infoRequired'), jobId: 'job-1' },
    };
    mocks.rtdb['assessments/org-1/status/readyForRelease'] = {
      'job-3': {
        ...assessment('readyForRelease'),
        jobId: 'job-1',
        workflow: {
          submittedAt: Date.UTC(2026, 6, 2, 9, 30),
          acceptedAt: Date.UTC(2026, 6, 3, 11, 0),
        },
      },
    };
    renderValidationAt('/');
    const awaiting = screen.getByRole('heading', { name: 'Awaiting validation' });
    expect(awaiting).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Waiting on assessor' })).toBeInTheDocument();
    // The accepted-but-unreleased section, so readyForRelease work stays visible.
    expect(screen.getByRole('heading', { name: 'Ready for release' })).toBeInTheDocument();
    // Building and assessor resolve through the job -> building -> members reads.
    expect(screen.getAllByText('Meridian Tower A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sam Porter').length).toBeGreaterThan(0);
    // Rendered in the runner's local timezone; compute the expectation the
    // same way the screen does rather than pinning a zone-dependent string.
    const expectedSubmitted = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(Date.UTC(2026, 6, 2, 9, 30));
    expect(screen.getByText(expectedSubmitted)).toBeInTheDocument();
  });

  it('shows the exact empty state when nothing is queued', () => {
    mocks.rtdb = { orgMembers: members };
    renderValidationAt('/');
    expect(screen.getByRole('heading', { name: 'Nothing waiting' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Submitted assessments appear here the moment an assessor sends them.',
      ),
    ).toBeInTheDocument();
  });

  it('badges a row whose job has since been cancelled', () => {
    seedReview('readyForValidation');
    mocks.rtdb['jobs/org-1/job-1'] = { ...job, status: 'cancelled' };
    mocks.rtdb['assessments/org-1/status/readyForValidation'] = {
      'job-1': assessment('readyForValidation'),
    };
    renderValidationAt('/');
    expect(screen.getByText('Job cancelled')).toBeInTheDocument();
  });
});

describe('AssessmentReview rendering', () => {
  it('badges the review header when the assessment came from a cancelled job', () => {
    seedReview('readyForValidation');
    mocks.rtdb['jobs/org-1/job-1'] = { ...job, status: 'cancelled' };
    renderValidationAt('/job-1');
    expect(screen.getByText('Job cancelled')).toBeInTheDocument();
    // The contractual stage badge still renders alongside it.
    expect(screen.getByText('Ready for validation')).toBeInTheDocument();
  });

  it('renders the snapshot sections, typed answers and a severity-chipped non-conformity', () => {
    seedReview('readyForValidation');
    renderValidationAt('/job-1');
    // The exact contractual stage label.
    expect(screen.getByText('Ready for validation')).toBeInTheDocument();
    // Sections come from the embedded snapshot, in order.
    expect(screen.getByRole('heading', { name: 'Occupancy profile' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ignition sources' })).toBeInTheDocument();
    // Typed answers: longtext words, yesno as the answer word.
    expect(screen.getByText('Office workers across three floors.')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
    // The non-conformity: severity chip word and observation. The value carries
    // no lifeProtection flag, so a High severity alone must NOT show the marker
    // (the marker mirrors what releaseAssessment reads, not the severity).
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(
      screen.getByText('Distribution board overloaded with daisy-chained extension leads.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Life Protection')).not.toBeInTheDocument();
    // The finding carries no responsible/dueBy of its own, so the card falls
    // back to the labelled defaults; the aside shows the plain assessment fact.
    expect(
      screen.getByText('Helen Carter (Facilities Director) (assessment default)'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Helen Carter (Facilities Director)').length).toBe(1);
    expect(screen.getByText(/days of release \(severity default\)/)).toBeInTheDocument();
    // Progress summary counts answered questions per section.
    const progress = screen.getByRole('list', { name: 'Answered questions per section' });
    expect(within(progress).getAllByText('2 of 2').length).toBe(1);
    expect(within(progress).getAllByText('1 of 1').length).toBe(1);
  });

  it('renders a finding from its structured value: LTP flag, own responsible and due date', () => {
    seedReview('readyForValidation');
    mocks.rtdb['assessmentAnswers/org-1/job-1'] = {
      ...answers,
      // A MEDIUM finding flagged Life Protection, with its own responsible
      // party and due date - exactly the fields releaseAssessment prefers.
      'q-3': {
        value: {
          actionRequired: true,
          responsible: 'Site maintenance contractor',
          dueBy: Date.UTC(2026, 7, 15),
          lifeProtection: true,
        },
        severity: 'M',
        observation: 'Emergency lighting battery failed on stair core B.',
      },
    };
    renderValidationAt('/job-1');
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('Life Protection')).toBeInTheDocument();
    expect(screen.getByText('Site maintenance contractor')).toBeInTheDocument();
    expect(screen.getByText('By 15 August 2026')).toBeInTheDocument();
    // No default labels when the finding carries its own fields.
    expect(screen.queryByText(/assessment default/)).not.toBeInTheDocument();
    expect(screen.queryByText(/severity default/)).not.toBeInTheDocument();
  });

  it('states plainly when the assessor marked no action required', () => {
    seedReview('readyForValidation');
    mocks.rtdb['assessmentAnswers/org-1/job-1'] = {
      ...answers,
      'q-3': {
        value: { actionRequired: false, lifeProtection: false },
        severity: 'L',
        observation: 'Minor housekeeping note only.',
      },
    };
    renderValidationAt('/job-1');
    expect(
      screen.getByText(/Assessor marked: no action required/),
    ).toBeInTheDocument();
    // No action will be created, so no due window or marker is promised.
    expect(screen.queryByText(/days of release/)).not.toBeInTheDocument();
    expect(screen.queryByText('Life Protection')).not.toBeInTheDocument();
  });

  it('marks an unanswered question honestly', () => {
    seedReview('readyForValidation');
    mocks.rtdb['assessmentAnswers/org-1/job-1'] = { 'q-1': answers['q-1'] };
    renderValidationAt('/job-1');
    expect(screen.getAllByText('Not answered').length).toBe(2);
  });

  it('shows the open info-request thread in the infoRequired state', () => {
    seedReview('infoRequired');
    mocks.rtdb['assessmentAnswers/org-1/job-1'] = {
      ...answers,
      'q-3': {
        ...answers['q-3'],
        infoRequest: { byUid: 'auditor-1', message: 'Please photograph the board.' },
      },
    };
    renderValidationAt('/job-1');
    expect(screen.getByText('More information requested')).toBeInTheDocument();
    expect(screen.getByText('Please photograph the board.')).toBeInTheDocument();
    expect(
      screen.getAllByText(/must respond|must resubmit/).length,
    ).toBeGreaterThan(0);
    // No flag affordance outside readyForValidation.
    expect(
      screen.queryByRole('button', { name: 'Request more information' }),
    ).not.toBeInTheDocument();
  });

  it('surfaces the released report: pending while resolving, then a download link at the resolved URL', async () => {
    seedReview('released');
    // The building's reports node carries one report for THIS assessment
    // (assessmentId matches the route param), so it is preferred over any
    // newest-report fallback.
    mocks.rtdb['reports/org-1/building/b-1'] = {
      'rep-1': {
        pdfPath: 'orgs/org-1/reports/rep-1.pdf',
        generatedAt: Date.UTC(2026, 6, 4),
        assessmentId: 'job-1',
      },
    };
    renderValidationAt('/job-1');
    // While the report file is being checked the pending copy shows.
    expect(
      screen.getByText('Preparing the report for download'),
    ).toBeInTheDocument();
    // Once checked, the primary affordance fetches the PDF through the SDK on
    // click and opens it in a new tab without leaking the opener.
    const link = await screen.findByRole('link', { name: 'Download report' });
    expect(await activateStoredLink(link)).toMatchObject({
      via: 'download',
      url: 'blob:orgs/org-1/reports/rep-1.pdf',
    });
  });

  it('falls back to the newest building report when none matches the assessment', async () => {
    seedReview('released');
    // Two older reports, neither carrying assessmentId (they predate the
    // field); the newest by generatedAt is the one offered.
    mocks.rtdb['reports/org-1/building/b-1'] = {
      'rep-old': {
        pdfPath: 'orgs/org-1/reports/rep-old.pdf',
        generatedAt: Date.UTC(2026, 5, 1),
      },
      'rep-new': {
        pdfPath: 'orgs/org-1/reports/rep-new.pdf',
        generatedAt: Date.UTC(2026, 6, 10),
      },
    };
    renderValidationAt('/job-1');
    expect(
      await screen.findByRole('link', { name: 'Download report' }),
    ).toBeInTheDocument();
  });

  it('links to the building detail page for the full assessment history and reports', () => {
    seedReview('readyForValidation');
    renderValidationAt('/job-1');
    const historyLink = screen.getByRole('link', {
      name: "View this building's full assessment history and reports",
    });
    // job -> siteId and the assessment's customerId/buildingId build the URL.
    expect(historyLink).toHaveAttribute(
      'href',
      '/app/customers/c-1/sites/site-1/buildings/b-1',
    );
  });

  it('shows the being-generated note when a released assessment has no report yet', () => {
    seedReview('released');
    renderValidationAt('/job-1');
    expect(
      screen.getByText('The report is being generated. It will appear here shortly.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Download report' }),
    ).not.toBeInTheDocument();
  });
});

describe('ReleasedList', () => {
  function released(releasedAt: number, releasedBy = 'uid-sam'): Assessment {
    return {
      ...assessment('released'),
      workflow: {
        submittedAt: Date.UTC(2026, 6, 2, 9, 30),
        acceptedAt: Date.UTC(2026, 6, 3, 11, 0),
        releasedAt,
        releasedBy,
      },
    };
  }

  it('lists released assessments newest first, each linking to its review', () => {
    seedReview('released');
    mocks.rtdb['assessments/org-1/status/released'] = {
      'job-1': released(Date.UTC(2026, 6, 4, 10, 0)),
      'job-2': { ...released(Date.UTC(2026, 6, 6, 10, 0)), jobId: 'job-1' },
    };
    renderValidationAt('/released');

    expect(screen.getByRole('heading', { name: 'Released' })).toBeInTheDocument();
    // Building, customer and releaser resolve through the cached reads.
    expect(screen.getAllByText('Meridian Tower A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Meridian Estates').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sam Porter').length).toBeGreaterThan(0);
    // The stored building risk shows as a RAG chip (medium), never re-derived.
    // The risk column is the H/M/L dot; its words are the accessible name.
    expect(
      screen.getAllByRole('img', { name: 'Medium risk' }).length,
    ).toBeGreaterThan(0);
    // Every row opens its assessment review page.
    const rowLinks = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/app/validation/job-'));
    expect(rowLinks.length).toBeGreaterThan(0);
    expect(rowLinks.some((link) => link.getAttribute('href') === '/app/validation/job-2')).toBe(true);
    // Newest release first: job-2 (6 Jul) sorts above job-1 (4 Jul).
    const table = screen.getByRole('table', { name: 'Released assessments' });
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByRole('link', { name: /Meridian Tower A/ }))
      .toHaveAttribute('href', '/app/validation/job-2');
  });

  it('names the template each release was carried out under', () => {
    seedReview('released');
    mocks.rtdb['assessments/org-1/status/released'] = {
      'job-1': released(Date.UTC(2026, 6, 4, 10, 0)),
    };
    renderValidationAt('/released');
    // The PINNED snapshot, with its version and declared standard.
    expect(
      screen.getByText('PAS 79 Fire Risk Assessment v3 · PAS 79'),
    ).toBeInTheDocument();
  });

  it('offers the report from the row, labelled with the building it covers', async () => {
    seedReview('released');
    mocks.rtdb['assessments/org-1/status/released'] = {
      'job-1': released(Date.UTC(2026, 6, 4, 10, 0)),
    };
    mocks.rtdb['reports/org-1/building/b-1'] = {
      'rep-1': {
        pdfPath: 'orgs/org-1/reports/rep-1.pdf',
        generatedAt: Date.UTC(2026, 6, 4, 10, 5),
        assessmentId: 'job-1',
      },
    };
    renderValidationAt('/released');
    const link = await screen.findByRole('link', {
      name: 'Download the report for Meridian Tower A',
    });
    expect(await activateStoredLink(link)).toMatchObject({
      via: 'download',
      url: 'blob:orgs/org-1/reports/rep-1.pdf',
    });
  });

  it('says the report is not ready rather than offering a dead download', () => {
    seedReview('released');
    mocks.rtdb['assessments/org-1/status/released'] = {
      'job-1': released(Date.UTC(2026, 6, 4, 10, 0)),
    };
    // The building has an older report, but none for THIS assessment yet:
    // generation is asynchronous and trails the release.
    mocks.rtdb['reports/org-1/building/b-1'] = {
      'rep-old': {
        pdfPath: 'orgs/org-1/reports/rep-old.pdf',
        generatedAt: Date.UTC(2026, 1, 1),
        assessmentId: 'job-0',
      },
    };
    renderValidationAt('/released');
    expect(screen.getByText(/Report not ready/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download PDF/ })).toBeNull();
  });

  it('shows the honest empty state when nothing has been released', () => {
    mocks.rtdb = { orgMembers: members };
    renderValidationAt('/released');
    expect(
      screen.getByRole('heading', { name: 'Nothing released yet' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'No assessments have been released yet. Released assessments appear here the moment an auditor releases them.',
      ),
    ).toBeInTheDocument();
  });

  it('degrades a dangling building to its id rather than a broken row', () => {
    mocks.rtdb = {
      orgMembers: members,
      'assessments/org-1/status/released': {
        'job-1': released(Date.UTC(2026, 6, 4, 10, 0)),
      },
      // No job/building/customer nodes seeded: the ids stand in.
    };
    renderValidationAt('/released');
    expect(screen.getByText('b-1')).toBeInTheDocument();
    expect(screen.getByText('c-1')).toBeInTheDocument();
    // A dash carrying the reason, so the risk column stays one glyph wide even
    // when the building record is missing.
    expect(
      screen.getByRole('img', { name: 'Risk unavailable' }),
    ).toBeInTheDocument();
  });
});

describe('Flagging and decisions', () => {
  it('collects two questions in the basket and sends both in one requestInfo call', async () => {
    const user = userEvent.setup();
    seedReview('readyForValidation');
    mocks.callable.mockResolvedValue({ flagged: 2 });
    renderValidationAt('/job-1');

    const flagButtons = screen.getAllByRole('button', { name: 'Request more information' });
    await user.click(flagButtons[0]);
    await user.type(
      screen.getByLabelText('What more do you need from the assessor?'),
      'Please expand on the occupancy profile.',
    );
    // q-1's affordance is now its composer, so the remaining buttons are q-2
    // and q-3; flag the non-conformity (q-3) as the second request.
    await user.click(
      screen.getAllByRole('button', { name: 'Request more information' })[1],
    );
    const basket = screen.getByRole('list', { name: 'Flagged questions' });
    const messages = within(basket).getAllByLabelText('Message to the assessor');
    expect(messages.length).toBe(2);
    await user.type(messages[1], 'Please photograph the distribution board.');

    await user.click(screen.getByRole('button', { name: 'Send to assessor' }));
    // ONE deadline covers the whole batch, defaulted INFO_REQUEST_DUE_DAYS
    // ahead and sent with it - a round of questions is one conversation.
    expect(mocks.callable).toHaveBeenCalledWith('requestInfo', {
      assessmentId: 'job-1',
      requests: [
        { questionId: 'q-1', message: 'Please expand on the occupancy profile.' },
        { questionId: 'q-3', message: 'Please photograph the distribution board.' },
      ],
      dueBy: endOfLocalDay(Date.now() + INFO_REQUEST_DUE_DAYS * DAY_MS),
    });
    expect(await screen.findByText(/has been notified|have been notified/)).toBeInTheDocument();
  });

  it('sends an edited deadline as the end of that day, and refuses to send without one', async () => {
    const user = userEvent.setup();
    seedReview('readyForValidation');
    mocks.callable.mockResolvedValue({ flagged: 1 });
    renderValidationAt('/job-1');

    await user.click(
      screen.getAllByRole('button', { name: 'Request more information' })[0],
    );
    await user.type(
      screen.getByLabelText('What more do you need from the assessor?'),
      'Please expand on the occupancy profile.',
    );

    // Cleared deadline: the send is refused in the UI rather than bouncing off
    // the server, and the hint says which of the two blockers applies.
    const dueBy = screen.getByLabelText('Response due by');
    await user.clear(dueBy);
    expect(screen.getByRole('button', { name: 'Send to assessor' })).toBeDisabled();
    expect(
      screen.getByText('Set a valid response deadline before sending.'),
    ).toBeInTheDocument();

    // An auditor's own date is honoured, converted to the END of that local day
    // ("due by the 20th" gives the assessor all of the 20th).
    const chosen = new Date(Date.now() + 20 * DAY_MS);
    const month = String(chosen.getMonth() + 1).padStart(2, '0');
    const day = String(chosen.getDate()).padStart(2, '0');
    await user.type(dueBy, `${chosen.getFullYear()}-${month}-${day}`);
    await user.click(screen.getByRole('button', { name: 'Send to assessor' }));
    expect(mocks.callable).toHaveBeenCalledWith('requestInfo', {
      assessmentId: 'job-1',
      requests: [
        { questionId: 'q-1', message: 'Please expand on the occupancy profile.' },
      ],
      dueBy: endOfLocalDay(chosen.getTime()),
    });
  });

  it('disables Accept while the basket is non-empty and accepts after confirm when clear', async () => {
    const user = userEvent.setup();
    seedReview('readyForValidation');
    mocks.callable.mockResolvedValue({ accepted: true });
    renderValidationAt('/job-1');

    const accept = screen.getByRole('button', { name: 'Accept - ready for release' });
    expect(accept).toBeEnabled();
    await user.click(
      screen.getAllByRole('button', { name: 'Request more information' })[0],
    );
    expect(accept).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remove from basket' }));
    expect(accept).toBeEnabled();

    await user.click(accept);
    expect(mocks.callable).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Accept this assessment\? It will move to 'Complete, ready for release'\./),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm accept' }));
    expect(mocks.callable).toHaveBeenCalledWith('acceptAssessment', {
      assessmentId: 'job-1',
    });
  });

  it('disables Accept with the reason while flagged questions await a response', () => {
    seedReview('readyForValidation');
    // Two requests with no assessor response yet: OPEN by the same
    // response-presence test acceptAssessment applies, so accepting would be
    // refused server-side - the button says why instead of inviting the error.
    mocks.rtdb['assessmentAnswers/org-1/job-1'] = {
      ...answers,
      'q-1': {
        ...answers['q-1'],
        infoRequest: { byUid: 'auditor-1', message: 'Expand on the occupancy.' },
      },
      'q-3': {
        ...answers['q-3'],
        infoRequest: { byUid: 'auditor-1', message: 'Photograph the board.' },
      },
    };
    renderValidationAt('/job-1');
    expect(
      screen.getByRole('button', { name: 'Accept - ready for release' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/2 flagged questions are.*awaiting the assessor/s),
    ).toBeInTheDocument();
  });

  it('enables Accept once every information request has a response', () => {
    seedReview('readyForValidation');
    mocks.rtdb['assessmentAnswers/org-1/job-1'] = {
      ...answers,
      'q-3': {
        ...answers['q-3'],
        infoRequest: {
          byUid: 'auditor-1',
          message: 'Photograph the board.',
          response: 'Photo attached to the answer.',
        },
      },
    };
    renderValidationAt('/job-1');
    expect(
      screen.getByRole('button', { name: 'Accept - ready for release' }),
    ).toBeEnabled();
    expect(screen.queryByText(/awaiting the assessor/)).not.toBeInTheDocument();
  });

  it('releases only after the confirm step and surfaces the actionsCreated count', async () => {
    const user = userEvent.setup();
    seedReview('readyForRelease');
    mocks.callable.mockResolvedValue({ released: true, actionsCreated: 4 });
    renderValidationAt('/job-1');

    expect(
      screen.getByRole('button', { name: 'Accept - ready for release' }),
    ).toBeDisabled();
    const release = screen.getByRole('button', { name: 'Release' });
    expect(release).toBeEnabled();
    await user.click(release);
    expect(mocks.callable).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Releasing creates the action plan and generates the report\./),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm release' }));
    expect(mocks.callable).toHaveBeenCalledWith('releaseAssessment', {
      assessmentId: 'job-1',
    });
    expect(
      await screen.findByText(/4 actions were created for the building's action plan/),
    ).toBeInTheDocument();
  });
});
