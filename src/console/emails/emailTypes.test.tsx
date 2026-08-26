// ============================================================================
// EmailTypesPage tests - the kind matrix's basics, in the sentEmails.test.tsx
// harness style: AuthProvider and the RTDB bridge mocked at the module
// boundary (dispatching on the key's domain prefix), so the tests drive pure
// rendering - grouping, the locked invitation row, and settings reflection -
// with no sockets.
//
// The bundling cases below lean on three kinds whose catalogue policy is
// deliberately different from one another, so the matrix is exercised across
// all three rather than through whichever row happened to be convenient:
//
//   job-reminder          immediate  (already one per assessor per day)
//   review-reminder-admin digest     (a daily sweep by nature)
//   visit-scheduled       collapse   (event-driven; first of the day sends)
//
// If the catalogue ever reclassifies one of them these tests will fail, and
// that is correct: the policy is customer-visible copy, not an internal flag.
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
    // One lock per non-toggleable kind: invitation plus the two
    // operationally-critical billing kinds (payment-failed and
    // subscription-ended - the catalogue's toggle policy). All three are also
    // 'immediate', so each folds its delivery into the padlock and reads
    // 'Always sends immediately' rather than repeating itself in a second cell.
    expect(screen.getAllByText('Always sends immediately')).toHaveLength(3);
    expect(screen.queryByText('Always sends')).toBeNull();
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

// --- Delivery ------------------------------------------------------------------

describe('EmailTypesPage delivery', () => {
  it('states the one-per-day guarantee once, at the top', () => {
    render(<EmailTypesPage />);
    expect(
      screen.getByText(/Nobody receives more than one email of each type per day/),
    ).toBeInTheDocument();
  });

  it('states each kind’s delivery in the signed-off copy', () => {
    render(<EmailTypesPage />);
    const immediate = rowFor('Daily job digest (assessors)');
    expect(within(immediate).getByText('Sends immediately')).toBeInTheDocument();
    expect(within(immediate).getByTitle('Sent as it happens.')).toBeInTheDocument();

    // 'digest' and 'collapse' both read 'Bundled daily' - what lands in the
    // inbox is the same promise - and are separated only by the hint.
    const digest = rowFor('Review reminder (admins)');
    expect(within(digest).getByText('Bundled daily')).toBeInTheDocument();
    expect(
      within(digest).getByTitle(
        'Everything from the day arrives in one summary each morning.',
      ),
    ).toBeInTheDocument();

    const collapse = rowFor('Visit scheduled (customer contacts)');
    expect(within(collapse).getByText('Bundled daily')).toBeInTheDocument();
    expect(
      within(collapse).getByTitle(
        'The first each day is sent as it happens; the rest arrive in one summary the next morning.',
      ),
    ).toBeInTheDocument();
  });

  it('renders delivery as a statement, never as a control', () => {
    render(<EmailTypesPage />);
    // The row's only checkbox is still the enable toggle: the policy is fixed
    // in the catalogue, so nothing about it is switchable here.
    const row = rowFor('Review reminder (admins)');
    expect(within(row).getAllByRole('checkbox')).toHaveLength(1);
    expect(
      within(row).getByRole('checkbox', { name: 'Enabled' }),
    ).toBeInTheDocument();
  });
});

// --- The digest template slot ---------------------------------------------------

describe('EmailTypesPage digest template', () => {
  it('offers a digest template only for kinds that can be bundled', () => {
    render(<EmailTypesPage />);
    // Bundleable: two selects, the second labelled for the bundled copy.
    const bundleable = rowFor('Review reminder (admins)');
    expect(within(bundleable).getByText('Digest template')).toBeInTheDocument();
    expect(within(bundleable).getAllByRole('combobox')).toHaveLength(2);

    // Never bundled: no second slot at all, because nothing could ever render
    // a template assigned to it.
    const immediate = rowFor('Daily job digest (assessors)');
    expect(within(immediate).queryByText('Digest template')).toBeNull();
    expect(within(immediate).getAllByRole('combobox')).toHaveLength(1);
  });

  it('merges a digest assignment without clobbering the other choices', async () => {
    dbMocks.set.mockClear();
    mocks.emailKindSettings = {
      'review-reminder-admin': { enabled: false, templateId: 'tpl-1' },
    };
    render(<EmailTypesPage />);
    fireEvent.change(digestSelect('Review reminder (admins)'), {
      target: { value: 'tpl-1' },
    });
    await waitFor(() => expect(dbMocks.set).toHaveBeenCalledTimes(1));
    // The whole node, not a single field: the disable and the single-email
    // assignment both survive the digest write.
    expect(dbMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining('review-reminder-admin'),
      }),
      { enabled: false, templateId: 'tpl-1', digestTemplateId: 'tpl-1' },
    );
  });

  it('carries an existing digest assignment through an unrelated toggle write', async () => {
    dbMocks.set.mockClear();
    mocks.emailKindSettings = {
      'review-reminder-admin': { digestTemplateId: 'tpl-1' },
    };
    render(<EmailTypesPage />);
    const row = rowFor('Review reminder (admins)');
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Enabled' }));
    await waitFor(() => expect(dbMocks.set).toHaveBeenCalledTimes(1));
    expect(dbMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining('review-reminder-admin'),
      }),
      { enabled: false, digestTemplateId: 'tpl-1' },
    );
  });

  it('drops a digest assignment naming a since-deleted template', async () => {
    // Same guard as the single slot: the rules' template-existence check would
    // reject the whole write, so a toggle flip would fail on a stale id.
    dbMocks.set.mockClear();
    mocks.emailKindSettings = {
      'review-reminder-admin': { digestTemplateId: 'ghost-deleted-template' },
    };
    render(<EmailTypesPage />);
    const row = rowFor('Review reminder (admins)');
    fireEvent.click(within(row).getByRole('checkbox', { name: 'Enabled' }));
    await waitFor(() => expect(dbMocks.set).toHaveBeenCalledTimes(1));
    expect(dbMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining('review-reminder-admin'),
      }),
      { enabled: false },
    );
  });

  it('removes the node when the digest assignment returns to the default', async () => {
    // Defaults are expressed by ABSENCE; with the digest slot back on the
    // built-in copy nothing is left to store, so the node goes rather than
    // lingering as an empty object.
    dbMocks.set.mockClear();
    mocks.emailKindSettings = {
      'review-reminder-admin': { digestTemplateId: 'tpl-1' },
    };
    render(<EmailTypesPage />);
    fireEvent.change(digestSelect('Review reminder (admins)'), {
      target: { value: '' },
    });
    await waitFor(() => expect(dbMocks.set).toHaveBeenCalledTimes(1));
    expect(dbMocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining('review-reminder-admin'),
      }),
      null,
    );
  });
});

// --- The preview dialog's bundled form -------------------------------------------

describe('EmailTypesPage digest preview', () => {
  it('previews the bundled copy of a bundleable kind', () => {
    render(<EmailTypesPage />);
    fireEvent.click(
      within(rowFor('Review reminder (admins)')).getByRole('button', {
        name: 'Preview',
      }),
    );
    // Opens on the single email, which is what almost every send is.
    expect(
      screen.getByText(/FRA review due in 60 days/, { selector: 'p' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Bundled daily' }));
    // The built-in digest subject, with the uniform count phrase resolved
    // against the kind's own plural noun and the four sample rows.
    expect(
      screen.getByText(/4 buildings need a fire risk assessment review/),
    ).toBeInTheDocument();
    // And says which copy it is showing, and why that form exists at all.
    expect(screen.getByText(/built-in digest template/)).toBeInTheDocument();
  });

  it('offers no form switch for a kind that never bundles', () => {
    render(<EmailTypesPage />);
    fireEvent.click(
      within(rowFor('Daily job digest (assessors)')).getByRole('button', {
        name: 'Preview',
      }),
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

// --- Helpers ---------------------------------------------------------------------

/** The matrix row for a kind, addressed the way an admin finds it: by the
 *  label they can read. */
function rowFor(label: string): HTMLElement {
  return screen.getByText(label).closest('li') as HTMLElement;
}

/** The row's SECOND select. Addressed by position rather than by its label
 *  because both selects sit inside wrapping <label>s, and the two rows of the
 *  matrix that matter here always order them single-then-digest. */
function digestSelect(label: string): HTMLElement {
  return within(rowFor(label)).getAllByRole('combobox')[1];
}
