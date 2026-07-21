// ============================================================================
// Template builder tests - the editor half of FR-E21.
//
// Mocked at the same module boundaries as the rest of the console suites: the
// auth contract, the RTDB bridge (fixture data by query key), the callable
// hook, and - because the builder is the console's first direct-write surface -
// the firebase/database write primitives, so autosave payloads can be asserted
// without sockets.
// ============================================================================

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { SessionClaims } from '../../auth/claims';
import type { StandardParagraph, Template } from '../../types';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'member' as string,
    user: { uid: 'user-1', email: 'admin@example.com' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
  },
  fixtures: {
    draft: null as Template | null,
    live: null as Template | null,
    paragraphs: null as Record<string, StandardParagraph> | null,
  },
  setMock: vi.fn(async () => undefined),
  removeMock: vi.fn(async () => undefined),
  callableCall: vi.fn(async () => null as unknown),
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { db: vi.fn(() => ({})), functions: vi.fn() },
}));

vi.mock('firebase/database', () => ({
  ref: vi.fn((_db: unknown, path: string) => ({ path })),
  set: mocks.setMock,
  remove: mocks.removeMock,
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly unknown[] }) => {
    let data: unknown;
    switch (key[0]) {
      case 'templateDraft':
        data = mocks.fixtures.draft;
        break;
      case 'template':
        data = mocks.fixtures.live;
        break;
      case 'standardParagraphs':
        data = mocks.fixtures.paragraphs;
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

import { TemplateBuilder } from './TemplateBuilder';

// --- Fixtures ----------------------------------------------------------------

const adminClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

const DRAFT_PATH = 'test/templateDrafts/org-1/t1';

function cleanDraft(): Template {
  return {
    name: 'PAS 79 Fire Risk Assessment',
    version: 2,
    status: 'draft',
    standard: 'pas79',
    sections: [
      {
        id: 's-one',
        code: '01',
        title: 'Fire detection',
        questions: [
          {
            id: 'q-alarm',
            text: 'Is the fire alarm serviced?',
            type: 'yesno',
            required: true,
          },
          {
            id: 'q-category',
            text: 'Alarm category installed',
            type: 'select',
            options: ['L1', 'L2'],
            standardParagraphRef: 'p1',
          },
        ],
      },
    ],
  };
}

const paragraphLibrary: Record<string, StandardParagraph> = {
  p1: {
    reference: '4.2.1',
    title: 'Fire detection and alarm',
    body: 'An appropriate fire detection and alarm system should be provided and maintained.',
    updatedAt: 1,
  },
};

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={['/app/templates/builder/t1']}>
      <Routes>
        <Route
          path="/app/templates/builder/:templateId"
          element={<TemplateBuilder />}
        />
        <Route path="/app/templates" element={<h1>Templates list</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Run the 800 ms autosave debounce and let the mocked write settle. */
async function runAutosave() {
  await act(async () => {
    vi.advanceTimersByTime(800);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv('test');
  mocks.fixtures.draft = cleanDraft();
  mocks.fixtures.live = { ...cleanDraft(), version: 2, status: 'published' };
  mocks.fixtures.paragraphs = { ...paragraphLibrary };
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Tests --------------------------------------------------------------------

describe('TemplateBuilder', () => {
  it('offers to start a draft from the live version and seeds it', async () => {
    mocks.fixtures.draft = null;
    renderBuilder();

    const start = screen.getByRole('button', {
      name: 'Start a new draft from v2',
    });
    await userEvent.click(start);

    expect(mocks.setMock).toHaveBeenCalledTimes(1);
    const [refArg, payload] = mocks.setMock.mock.calls[0] as unknown as [
      { path: string },
      Template,
    ];
    expect(refArg.path).toBe(DRAFT_PATH);
    expect(payload.name).toBe('PAS 79 Fire Risk Assessment');
    expect(payload.status).toBe('draft');
    expect(payload.standard).toBe('pas79');
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0].questions.map((q) => q.id)).toEqual([
      'q-alarm',
      'q-category',
    ]);
  });

  it('autosaves the whole draft object after the debounce', async () => {
    vi.useFakeTimers();
    renderBuilder();

    fireEvent.change(screen.getByLabelText('Template name'), {
      target: { value: 'BS 9792 Residential FRA' },
    });
    expect(screen.getByText('Saving')).toBeInTheDocument();
    expect(mocks.setMock).not.toHaveBeenCalled();

    await runAutosave();

    expect(mocks.setMock).toHaveBeenCalledTimes(1);
    const [refArg, payload] = mocks.setMock.mock.calls[0] as unknown as [
      { path: string },
      Template,
    ];
    expect(refArg.path).toBe(DRAFT_PATH);
    // The WHOLE draft is written, not a delta: name change plus every section
    // and question exactly as authored.
    expect(payload.name).toBe('BS 9792 Residential FRA');
    expect(payload.status).toBe('draft');
    expect(payload.sections[0].code).toBe('01');
    expect(payload.sections[0].questions).toHaveLength(2);
    expect(payload.sections[0].questions[1].options).toEqual(['L1', 'L2']);
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('surfaces the publish-gate failures and disables publishing', () => {
    const draft = cleanDraft();
    draft.sections[0].questions[1].options = []; // select without options
    draft.sections[0].questions.push({
      id: 'q-alarm', // duplicate id
      text: 'Duplicate id question',
      type: 'text',
    });
    draft.sections[0].questions.push({
      id: 'q-ref',
      text: 'Question with a dead reference',
      type: 'text',
      standardParagraphRef: 'p-missing', // unknown paragraph
    });
    mocks.fixtures.draft = draft;
    renderBuilder();

    expect(
      screen.getByText(/a choice question needs at least one option/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/duplicate id "q-alarm"/i)).toBeInTheDocument();
    expect(
      screen.getByText(/referenced standard paragraph no longer exists/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Publish as v3' }),
    ).toBeDisabled();
  });

  it('publishes through the callable after the confirm step, then returns to the list', async () => {
    mocks.callableCall.mockResolvedValueOnce({ version: 3 });
    renderBuilder();

    const publishButton = screen.getByRole('button', { name: 'Publish as v3' });
    expect(publishButton).toBeEnabled();
    await userEvent.click(publishButton);

    // The confirm step spells out the consequence before anything happens.
    expect(
      screen.getByText(
        'Publishing makes v3 available to assessors and cannot be edited afterwards.',
      ),
    ).toBeInTheDocument();
    expect(mocks.callableCall).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Publish v3' }));

    expect(mocks.callableCall).toHaveBeenCalledWith({ templateId: 't1' });
    expect(await screen.findByText('Templates list')).toBeInTheDocument();
  });

  it('round-trips observation, recommendation and paragraph reference into the draft write', async () => {
    vi.useFakeTimers();
    renderBuilder();

    // Expand the first question row.
    fireEvent.click(
      screen.getByRole('button', { name: /Is the fire alarm serviced/ }),
    );

    fireEvent.change(screen.getByLabelText('Observation'), {
      target: { value: 'The alarm service record is out of date.' },
    });
    fireEvent.change(screen.getByLabelText('Recommendation'), {
      target: { value: 'Arrange a BS 5839-1 service visit.' },
    });
    fireEvent.change(screen.getByLabelText('Standard paragraph'), {
      target: { value: 'p1' },
    });

    // The chosen paragraph's body previews inline for the author.
    expect(
      screen.getByText(/An appropriate fire detection and alarm system/),
    ).toBeInTheDocument();

    await runAutosave();

    expect(mocks.setMock).toHaveBeenCalled();
    const calls = mocks.setMock.mock.calls;
    const [, payload] = calls[calls.length - 1] as unknown as [
      { path: string },
      Template,
    ];
    const question = payload.sections[0].questions.find(
      (q) => q.id === 'q-alarm',
    );
    expect(question).toMatchObject({
      observation: 'The alarm service record is out of date.',
      recommendation: 'Arrange a BS 5839-1 service visit.',
      standardParagraphRef: 'p1',
    });
  });
});
