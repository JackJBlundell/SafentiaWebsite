// ============================================================================
// EmailTypesPage tests - the kind matrix's basics, in the sentEmails.test.tsx
// harness style: AuthProvider and the RTDB bridge mocked at the module
// boundary (dispatching on the key's domain prefix), so the tests drive pure
// rendering - grouping, the locked invitation row, and settings reflection -
// with no sockets.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    emailKindSettings: null as unknown,
    emailTemplates: null as unknown,
    orgProfile: null as unknown,
  };
});

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: (options: { key: readonly unknown[] }) => {
    const domain = options.key[0];
    const data =
      domain === 'emailKindSettings'
        ? mocks.emailKindSettings
        : domain === 'emailTemplates'
          ? mocks.emailTemplates
          : domain === 'orgProfile'
            ? mocks.orgProfile
            : undefined;
    return { data, isLoading: false, isError: false };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

// The page imports firebase for its settings writes; the write test below
// captures `set` at the module boundary, so the app object never initialises.
vi.mock('../../firebase', () => ({
  firebase: { db: () => ({}) },
}));

const dbMocks = vi.hoisted(() => ({
  set: vi.fn(() => Promise.resolve()),
}));

vi.mock('firebase/database', () => ({
  ref: vi.fn((_db: unknown, path: string) => ({ path })),
  set: dbMocks.set,
}));

import EmailTypesPage from './EmailTypesPage';

// --- Fixtures ----------------------------------------------------------------

beforeEach(() => {
  mocks.auth.paths = forEnv('test');
  mocks.emailKindSettings = {
    'job-reminder': { enabled: false },
  };
  mocks.emailTemplates = {
    'tpl-1': {
      name: 'Autumn invitation copy',
      subject: 'Hello',
      heading: 'Hello',
      blocks: [],
      updatedAt: 1,
      updatedBy: 'uid-1',
    },
  };
  mocks.orgProfile = { name: 'Acme Fire', brand: { primary: '#336699' } };
});

// --- Tests -------------------------------------------------------------------

describe('EmailTypesPage', () => {
  it('renders the audience groups with their kinds', () => {
    render(<EmailTypesPage />);
    expect(screen.getByText('Your team')).toBeInTheDocument();
    expect(screen.getByText('Customer contacts')).toBeInTheDocument();
    expect(screen.getByText('Invitations')).toBeInTheDocument();
    expect(screen.getByText('Daily job digest (assessors)')).toBeInTheDocument();
    expect(
      screen.getByText('Visit scheduled (customer contacts)'),
    ).toBeInTheDocument();
    // 'manual' has no row: it is not a configurable kind.
    expect(screen.queryByText('Manual email')).not.toBeInTheDocument();
  });

  it('locks the invitation kind: checked, disabled, and explained', () => {
    render(<EmailTypesPage />);
    const lock = screen.getByRole('checkbox', {
      name: /Invitation always sends/i,
    });
    expect(lock).toBeChecked();
    expect(lock).toBeDisabled();
    // One 'Always sends' lock per non-toggleable kind: invitation plus the
    // two operationally-critical billing kinds (payment-failed and
    // subscription-ended - the catalogue's toggle policy).
    expect(screen.getAllByText('Always sends')).toHaveLength(3);
  });

  it('reflects a stored disable and offers org templates for assignment', () => {
    render(<EmailTypesPage />);
    // job-reminder is stored {enabled:false}; every other toggle stays on
    // because ABSENT MEANS ENABLED.
    const toggles = screen.getAllByRole('checkbox', { name: 'Enabled' });
    expect(toggles.filter((box) => !(box as HTMLInputElement).checked)).toHaveLength(1);
    // Each kind's select offers the built-in default plus the org template.
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('option', { name: 'Autumn invitation copy' }).length,
    ).toBe(selects.length);
  });

  it('drops a stale templateId (deleted template) when merging a toggle write', async () => {
    // Regression: the rules' template-existence .validate rejects any settings
    // node naming a template that no longer exists, so re-writing a stale
    // assignment on a toggle flip would fail the WHOLE write. The merge must
    // drop it - matching the matrix, which already shows 'Built-in default'.
    dbMocks.set.mockClear();
    mocks.emailKindSettings = {
      'job-reminder': { templateId: 'ghost-deleted-template' },
    };
    render(<EmailTypesPage />);
    const row = screen
      .getByText('Daily job digest (assessors)')
      .closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Enabled' }));
    await waitFor(() => expect(dbMocks.set).toHaveBeenCalledTimes(1));
    expect(dbMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('job-reminder') }),
      { enabled: false },
    );
  });

  it('keeps a still-existing templateId when merging a toggle write', async () => {
    dbMocks.set.mockClear();
    mocks.emailKindSettings = {
      'job-reminder': { templateId: 'tpl-1' },
    };
    render(<EmailTypesPage />);
    const row = screen
      .getByText('Daily job digest (assessors)')
      .closest('li') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Enabled' }));
    await waitFor(() => expect(dbMocks.set).toHaveBeenCalledTimes(1));
    expect(dbMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('job-reminder') }),
      { enabled: false, templateId: 'tpl-1' },
    );
  });
});
