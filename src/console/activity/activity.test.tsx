// ============================================================================
// Activity log and log book tests (stories 2062/2063).
//
// Following the console.test.tsx pattern: the AuthProvider and the RTDB bridge
// are mocked at the module boundary, so these tests drive pure rendering and
// filtering with no sockets. The RTDB mock dispatches on the key's domain
// prefix, mirroring how the real bridge is addressed.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { forEnv } from '../../paths';
import { LOG_BOOK_TYPES, type LogBookType, type OrgMember } from '../../types';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'authenticated',
      user: { uid: 'uid-1' } as unknown,
      claims: {
        orgId: 'org-1',
        roles: { admin: true },
        environment: 'test',
      } as unknown,
      paths: null as unknown,
    },
    activityRows: [] as unknown[],
    logBookRows: [] as unknown[],
    emailRows: [] as unknown[],
    members: null as unknown,
    customers: null as unknown,
    buildingsRoot: null as unknown,
  };
});

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

// Dispatch on the key's domain prefix, as the real bridge is addressed by key.
vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: (options: { key: readonly unknown[] }) => {
    const domain = options.key[0];
    const data =
      domain === 'activity'
        ? mocks.activityRows
        : domain === 'logBook'
          ? mocks.logBookRows
          : domain === 'emailLog'
            ? mocks.emailRows
            : domain === 'orgMembers'
              ? mocks.members
              : domain === 'customers'
                ? mocks.customers
                : domain === 'buildings'
                  ? mocks.buildingsRoot
                  : undefined;
    return { data, isLoading: false, isError: false };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

import { ActivityPage } from './ActivityPage';
import { ActivityRoutes } from './ActivityRoutes';
import {
  buildLogBookCsv,
  escapeCsvField,
  LOG_BOOK_TYPE_LABELS,
  LogBookPanel,
} from './LogBookPanel';

// --- Fixtures ----------------------------------------------------------------

const member = (name: string): OrgMember => ({
  name,
  email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
  roles: { admin: true },
  status: 'active',
});

beforeEach(() => {
  mocks.auth.paths = forEnv('test');
  // Reset the signed-in principal to an admin each test; the non-admin gating
  // tests narrow the roles in place and must not leak into their neighbours.
  mocks.auth.claims = {
    orgId: 'org-1',
    roles: { admin: true },
    environment: 'test',
  } as unknown;
  mocks.members = { 'uid-jane': member('Jane Assessor') };
  mocks.customers = null;
  mocks.buildingsRoot = null;
  mocks.activityRows = [
    {
      id: 'a2',
      actorUid: 'uid-jane',
      action: 'assessment.released',
      target: 'assessment/asmt-9',
      at: Date.UTC(2026, 5, 12, 14, 3),
    },
    {
      id: 'a1',
      actorUid: 'uid-ghost',
      action: 'job.created',
      target: 'job/job-4',
      at: Date.UTC(2026, 5, 11, 9, 30),
    },
  ];
  mocks.logBookRows = [
    {
      id: 'e2',
      type: 'falseAlarm',
      payload: { notes: 'Burnt toast, second floor' },
      byUid: 'uid-jane',
      at: Date.UTC(2026, 5, 12, 8, 15),
    },
    {
      id: 'e1',
      type: 'fireIncident',
      payload: { notes: 'Bin fire in the yard', brigadeCalled: true },
      byUid: 'uid-ghost',
      at: Date.UTC(2026, 5, 10, 17, 45),
    },
  ];
  mocks.emailRows = [
    {
      id: 'm3',
      to: 'j***@example.com',
      subject: 'You have been invited to Safentia',
      category: 'invitation',
      sentAt: Date.UTC(2026, 5, 12, 9, 0),
      outcome: 'sent',
    },
    {
      id: 'm2',
      to: 'r***@borough.gov.uk',
      subject: 'A review is due',
      category: 'review-reminder',
      sentAt: Date.UTC(2026, 5, 11, 9, 0),
      outcome: 'skipped-no-provider',
    },
    {
      id: 'm1',
      to: 'a***@acme.test',
      subject: 'Your report has been released',
      category: 'released',
      sentAt: Date.UTC(2026, 5, 10, 9, 0),
      outcome: 'failed',
    },
  ];
});

// --- Activity page -------------------------------------------------------------

/** ActivityPage renders react-router Links (viable targets, filters), so it
 *  needs a router in the harness exactly as the console tests wrap pages. */
function renderActivityPage() {
  return render(
    <MemoryRouter initialEntries={['/app/activity']}>
      <ActivityPage />
    </MemoryRouter>,
  );
}

describe('ActivityPage', () => {
  it('renders rows with resolved actor names, labelling departed members', () => {
    renderActivityPage();
    expect(screen.getByRole('cell', { name: 'Jane Assessor' })).toBeInTheDocument();
    // An actor with no membership record reads as former staff - never the
    // raw uid, never blank (src/console/lib/actorName.ts).
    expect(
      screen.getByRole('cell', { name: 'Former staff member' }),
    ).toBeInTheDocument();
    // The action cell is humanised; the raw audit code stays on the title.
    expect(
      screen.getByRole('cell', { name: 'Released an assessment' }),
    ).toBeInTheDocument();
    expect(screen.getByTitle('assessment.released')).toBeInTheDocument();
    // The window statement is honest about how much is loaded.
    expect(
      screen.getByText(/Showing the most recent 2 events/),
    ).toBeInTheDocument();
  });

  it('narrows rows with the free-text search', async () => {
    const user = userEvent.setup();
    renderActivityPage();
    await user.type(screen.getByLabelText('Search'), 'released');
    expect(
      screen.getByRole('cell', { name: 'Released an assessment' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'Job created' }),
    ).not.toBeInTheDocument();
  });

  it('narrows rows with the action-kind select', async () => {
    const user = userEvent.setup();
    renderActivityPage();
    await user.selectOptions(screen.getByLabelText('Action'), 'job.created');
    // job.created is not a code the humaniser knows, so it degrades to
    // spaced sentence-cased words rather than machine vocabulary.
    expect(screen.getByRole('cell', { name: 'Job created' })).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'Released an assessment' }),
    ).not.toBeInTheDocument();
  });

  it('scopes rows to a customer, including events on its buildings', async () => {
    mocks.customers = {
      'cust-1': { name: 'Acme Housing' },
      'cust-2': { name: 'Borough Estates' },
    };
    mocks.buildingsRoot = {
      'site-1': {
        'bld-1': { name: 'North Tower', customerId: 'cust-1', riskLevel: 'low' },
      },
    };
    mocks.activityRows = [
      { id: 'a3', actorUid: 'uid-jane', action: 'customer.updated', target: 'cust-1', at: Date.UTC(2026, 5, 13) },
      { id: 'a2', actorUid: 'uid-jane', action: 'building.created', target: 'bld-1', at: Date.UTC(2026, 5, 12) },
      { id: 'a1', actorUid: 'uid-jane', action: 'customer.created', target: 'cust-2', at: Date.UTC(2026, 5, 11) },
    ];
    const user = userEvent.setup();
    renderActivityPage();
    await user.selectOptions(screen.getByLabelText('Customer'), 'cust-1');
    // The customer's own event and its building's event stay; the other
    // customer's event goes.
    expect(screen.getByRole('cell', { name: 'Updated a customer' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Created a building' })).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'Created a customer' }),
    ).not.toBeInTheDocument();
  });

  it('scopes rows to a single building', async () => {
    mocks.buildingsRoot = {
      'site-1': {
        'bld-1': { name: 'North Tower', customerId: 'cust-1', riskLevel: 'low' },
      },
    };
    mocks.activityRows = [
      { id: 'a2', actorUid: 'uid-jane', action: 'building.created', target: 'bld-1', at: Date.UTC(2026, 5, 12) },
      { id: 'a1', actorUid: 'uid-jane', action: 'customer.created', target: 'cust-1', at: Date.UTC(2026, 5, 11) },
    ];
    const user = userEvent.setup();
    renderActivityPage();
    await user.selectOptions(screen.getByLabelText('Building'), 'bld-1');
    expect(screen.getByRole('cell', { name: 'Created a building' })).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'Created a customer' }),
    ).not.toBeInTheDocument();
  });

  it('links customer targets to their console route, never assessments', () => {
    mocks.activityRows = [
      { id: 'a2', actorUid: 'uid-jane', action: 'customer.created', target: 'cust-1', at: Date.UTC(2026, 5, 12) },
      { id: 'a1', actorUid: 'uid-jane', action: 'assessment.released', target: 'asmt-9', at: Date.UTC(2026, 5, 11) },
    ];
    renderActivityPage();
    expect(screen.getByRole('link', { name: 'cust-1' })).toHaveAttribute(
      'href',
      '/app/customers/cust-1',
    );
    // Released assessments have no console view yet, so no dead link.
    expect(screen.queryByRole('link', { name: 'asmt-9' })).toBeNull();
    expect(screen.getByRole('cell', { name: 'asmt-9' })).toBeInTheDocument();
  });
});

// --- Email log -----------------------------------------------------------------

/** ActivityRoutes owns the admin gate and the tab switcher, so the email tests
 *  drive it through a router at the relevant URL, exactly as the app mounts it. */
function renderActivityRoutes(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/activity/*" element={<ActivityRoutes />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EmailLogPanel', () => {
  it('renders the send rows for an admin, redacted recipients as stored', () => {
    renderActivityRoutes('/app/activity/emails');
    expect(
      screen.getByRole('cell', { name: 'You have been invited to Safentia' }),
    ).toBeInTheDocument();
    // The recipient is shown exactly as the server redacted it.
    expect(
      screen.getByRole('cell', { name: 'j***@example.com' }),
    ).toBeInTheDocument();
    // The window statement is honest about how much is loaded and the redaction
    // (the sentence appears in both the lede and the note).
    expect(
      screen.getByText(/The most recent 3 sends/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Recipients are stored redacted for privacy\./).length,
    ).toBeGreaterThan(0);
  });

  it('labels each outcome in words, never colour alone', () => {
    renderActivityRoutes('/app/activity/emails');
    // The badge text carries the meaning; scoped to the badge span so the
    // "Sent" column header does not double-match.
    expect(screen.getByText('Sent', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Skipped (no provider)')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('narrows sends with the category filter, derived from the loaded window', async () => {
    const user = userEvent.setup();
    renderActivityRoutes('/app/activity/emails');
    await user.selectOptions(screen.getByLabelText('Category'), 'invitation');
    expect(
      screen.getByRole('cell', { name: 'You have been invited to Safentia' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'A review is due' }),
    ).not.toBeInTheDocument();
  });

  it('shows the empty state when no emails have been sent', () => {
    mocks.emailRows = [];
    renderActivityRoutes('/app/activity/emails');
    expect(
      screen.getByText('No emails have been sent yet.', { exact: false }),
    ).toBeInTheDocument();
  });

  it('shows the Emails tab to an admin but hides it from a non-admin', () => {
    const { unmount } = renderActivityRoutes('/app/activity');
    expect(screen.getByRole('link', { name: 'Emails' })).toBeInTheDocument();
    unmount();

    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { assessor: true },
      environment: 'test',
    } as unknown;
    renderActivityRoutes('/app/activity');
    expect(screen.queryByRole('link', { name: 'Emails' })).toBeNull();
  });

  it('gates the emails route for a non-admin reaching it by direct URL', () => {
    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { assessor: true },
      environment: 'test',
    } as unknown;
    renderActivityRoutes('/app/activity/emails');
    // The panel never mounts; the access notice stands in for it, so the
    // admin-only listener is never attached.
    expect(
      screen.getByText('Administrator access required'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'You have been invited to Safentia' }),
    ).toBeNull();
  });
});

// --- Log book panel ------------------------------------------------------------

describe('LogBookPanel', () => {
  it('renders entries with kind labels, recorder names and payload details', () => {
    render(<LogBookPanel buildingId="bld-1" />);
    // The kind label appears twice: once as a filter chip, once as the badge.
    expect(screen.getAllByText('False alarm')).toHaveLength(2);
    expect(screen.getByText('Recorded by Jane Assessor')).toBeInTheDocument();
    expect(screen.getByText('Recorded by Former staff member')).toBeInTheDocument();
    expect(screen.getByText('Burnt toast, second floor')).toBeInTheDocument();
    // A boolean payload field renders as plain language, not "true".
    expect(screen.getByText('Brigade called')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('narrows entries with the kind filter chips', async () => {
    const user = userEvent.setup();
    render(<LogBookPanel buildingId="bld-1" />);
    await user.click(screen.getByRole('button', { name: 'Fire incident' }));
    expect(screen.getByText('Bin fire in the yard')).toBeInTheDocument();
    expect(screen.queryByText('Burnt toast, second floor')).not.toBeInTheDocument();
  });
});

// --- CSV building ---------------------------------------------------------------

/** Minimal RFC 4180 line parser, enough to prove the escaping round-trips. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

describe('log book CSV', () => {
  it('escapes fields containing commas and quotes so they round-trip', () => {
    const awkward = 'she said "evacuate", then reset the panel';
    expect(escapeCsvField(awkward)).toBe(
      '"she said ""evacuate"", then reset the panel"',
    );
    expect(escapeCsvField('plain')).toBe('plain');

    const csv = buildLogBookCsv([
      {
        at: Date.UTC(2026, 5, 12, 14, 3),
        type: 'fireIncident',
        recordedBy: 'Doe, Jane "JD"',
        payload: { notes: awkward },
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
    expect(parseCsvLine(lines[0])).toEqual([
      'Recorded at',
      'Entry type',
      'Recorded by',
      'Details',
    ]);
    const row = parseCsvLine(lines[1]);
    expect(row[1]).toBe('Fire incident');
    expect(row[2]).toBe('Doe, Jane "JD"');
    expect(row[3]).toBe(`Notes: ${awkward}`);
    // British date, 24-hour time (rendered in the local timezone, so the hour
    // itself is not pinned; the format is).
    expect(row[0]).toMatch(/Jun 2026/);
    expect(row[0]).toMatch(/\b\d{2}:\d{2}\b/);
    expect(row[0]).not.toMatch(/am|pm/i);
  });

  it('neutralises spreadsheet formula prefixes (CSV formula injection)', () => {
    // A field whose first non-whitespace character is =, +, - or @ would be
    // executed as a formula when the export opens in a spreadsheet, so the
    // escaper prefixes a single quote to force the cell to read as text.
    expect(escapeCsvField('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(escapeCsvField('+HYPERLINK("http://evil")')).toBe(
      '"\'+HYPERLINK(""http://evil"")"',
    );
    expect(escapeCsvField('  @cmd')).toBe("'  @cmd");
    expect(escapeCsvField('-2, then reset')).toBe('"\'-2, then reset"');
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('reset at =noon')).toBe('reset at =noon');
  });

  it('has a human label for every log book kind', () => {
    // The Record<LogBookType, string> type already forces exhaustiveness at
    // compile time; this guards against an empty or whitespace label slipping in.
    for (const kind of LOG_BOOK_TYPES) {
      const label: string = LOG_BOOK_TYPE_LABELS[kind as LogBookType];
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});
