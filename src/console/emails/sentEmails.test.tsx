// ============================================================================
// Emails area tests - the send log (SentEmailsPage) and the EmailsRoutes admin
// gate, moved here from the activity tests when the log gained its own area
// (section 6b).
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
    emailRows: [] as unknown[],
    emailTemplates: null as unknown,
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
      domain === 'emailLog'
        ? mocks.emailRows
        : domain === 'emailTemplates'
          ? mocks.emailTemplates
          : undefined;
    return { data, isLoading: false, isError: false };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

import { EmailsRoutes } from './EmailsRoutes';

// --- Fixtures ----------------------------------------------------------------

beforeEach(() => {
  mocks.auth.paths = forEnv('test');
  // Reset the signed-in principal to an admin each test; the non-admin gating
  // test narrows the roles in place and must not leak into its neighbours.
  mocks.auth.claims = {
    orgId: 'org-1',
    roles: { admin: true },
    environment: 'test',
  } as unknown;
  mocks.emailTemplates = {
    'tpl-1': { name: 'Autumn invitation copy' },
  };
  mocks.emailRows = [
    {
      id: 'm3',
      to: 'j***@example.com',
      subject: 'You have been invited to Safentia',
      category: 'invitation',
      sentAt: Date.UTC(2026, 5, 12, 9, 0),
      outcome: 'sent',
      kindId: 'invitation',
      templateId: 'tpl-1',
    },
    {
      id: 'm2',
      to: 'r***@borough.gov.uk',
      subject: 'A review is due',
      category: 'review-reminder',
      sentAt: Date.UTC(2026, 5, 11, 9, 0),
      outcome: 'skipped-no-provider',
      kindId: 'review-reminder-admin',
    },
    // A legacy entry from before the templating seam: no kindId, no
    // templateId. The page must render it without a crash.
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

/** EmailsRoutes owns the admin gate and the tab switcher, so the tests drive
 *  it through a router at the relevant URL, exactly as the shell mounts it. */
function renderEmailsRoutes(path = '/app/emails') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/emails/*" element={<EmailsRoutes />} />
      </Routes>
    </MemoryRouter>,
  );
}

// --- Send log -----------------------------------------------------------------

describe('SentEmailsPage', () => {
  it('renders the send rows for an admin, redacted recipients as stored', () => {
    renderEmailsRoutes();
    expect(
      screen.getByRole('cell', { name: 'You have been invited to Safentia' }),
    ).toBeInTheDocument();
    // The recipient is shown exactly as the server redacted it.
    expect(
      screen.getByRole('cell', { name: 'j***@example.com' }),
    ).toBeInTheDocument();
    // The window statement is honest about how much is loaded and the redaction
    // (the sentence appears in both the lede and the note).
    expect(screen.getByText(/The most recent 3 sends/)).toBeInTheDocument();
    expect(
      screen.getAllByText(/Recipients are stored redacted for privacy\./).length,
    ).toBeGreaterThan(0);
  });

  it('labels each type via the catalogue, raw category for legacy entries', () => {
    renderEmailsRoutes();
    // kindId resolved through the mirrored catalogue.
    expect(
      screen.getByRole('cell', { name: 'Review reminder (admins)' }),
    ).toBeInTheDocument();
    // The legacy entry has no kindId, so its Type cell degrades to the raw
    // category string it has always carried - meaning 'released' appears twice
    // on that row: once in Type (the degraded label) and once in Category.
    expect(screen.getAllByRole('cell', { name: 'released' })).toHaveLength(2);
  });

  it("resolves template names, showing 'Built-in' when none was recorded", () => {
    renderEmailsRoutes();
    expect(
      screen.getByRole('cell', { name: 'Autumn invitation copy' }),
    ).toBeInTheDocument();
    // Entries without a templateId used the default copy.
    expect(screen.getAllByRole('cell', { name: 'Built-in' })).toHaveLength(2);
  });

  it('shows the raw id for a template deleted after the send', () => {
    mocks.emailTemplates = null;
    renderEmailsRoutes();
    expect(screen.getByRole('cell', { name: 'tpl-1' })).toBeInTheDocument();
  });

  it('labels each outcome in words, never colour alone', () => {
    renderEmailsRoutes();
    // The badge text carries the meaning; scoped to the badge span so the
    // "Sent" column header does not double-match.
    expect(screen.getByText('Sent', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Skipped (no provider)')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('narrows sends with the category filter, derived from the loaded window', async () => {
    const user = userEvent.setup();
    renderEmailsRoutes();
    await user.selectOptions(screen.getByLabelText('Category'), 'invitation');
    expect(
      screen.getByRole('cell', { name: 'You have been invited to Safentia' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'A review is due' }),
    ).not.toBeInTheDocument();
  });

  it('narrows sends with the kind filter, labelled via the catalogue', async () => {
    const user = userEvent.setup();
    renderEmailsRoutes();
    await user.selectOptions(
      screen.getByLabelText('Type'),
      'review-reminder-admin',
    );
    expect(screen.getByRole('cell', { name: 'A review is due' })).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'You have been invited to Safentia' }),
    ).not.toBeInTheDocument();
    // The option itself carries the catalogue label, not the raw id.
    expect(
      screen.getByRole('option', { name: 'Review reminder (admins)' }),
    ).toBeInTheDocument();
  });

  it('shows the empty state when no emails have been sent', () => {
    mocks.emailRows = [];
    renderEmailsRoutes();
    expect(
      screen.getByText('No emails have been sent yet.', { exact: false }),
    ).toBeInTheDocument();
  });
});

// --- Admin gate ----------------------------------------------------------------

describe('EmailsRoutes', () => {
  it('shows the sub-nav tabs to an admin', () => {
    renderEmailsRoutes();
    expect(screen.getByRole('link', { name: 'Sent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Templates' })).toBeInTheDocument();
  });

  it('gates the whole area for a non-admin reaching it by direct URL', () => {
    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { assessor: true },
      environment: 'test',
    } as unknown;
    renderEmailsRoutes();
    // The page never mounts; the access notice stands in for it, so the
    // admin-only listener is never attached.
    expect(screen.getByText('Administrator access required')).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'You have been invited to Safentia' }),
    ).toBeNull();
  });
});
