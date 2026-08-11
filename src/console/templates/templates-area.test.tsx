// ============================================================================
// Templates area tests: the admin gate, the merged published+draft directory,
// duplicate-creation minting fresh ids, the version history's job-derived
// usage counts, and the paragraph library's deletion guard. Auth, the RTDB
// bridge and the firebase/database write surface are mocked at their module
// boundaries (the same pattern as staff.test.tsx); these are rendering and
// write-payload tests, not network tests.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { Job, StandardParagraph, Template } from '../../types';

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: { uid: 'admin-1', email: 'admin@example.com' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  },
  /** Data served by the useRtdbQuery mock, keyed by the key's first segment. */
  rtdb: {} as Record<string, unknown>,
  /** Every set() call: the target path and the written value. */
  setCalls: [] as Array<{ path: string; value: unknown }>,
  /** Every remove() call's target path. */
  removeCalls: [] as string[],
  /** push() mints deterministic fresh keys. */
  mintCounter: 0,
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn(), db: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly (string | number)[] }) => ({
    data: mocks.rtdb[String(key[0])],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('firebase/database', () => ({
  ref: vi.fn((_db: unknown, path: string) => ({ path })),
  push: vi.fn(() => ({ key: `minted-${++mocks.mintCounter}` })),
  set: vi.fn(async (target: { path: string }, value: unknown) => {
    mocks.setCalls.push({ path: target.path, value });
  }),
  remove: vi.fn(async (target: { path: string }) => {
    mocks.removeCalls.push(target.path);
  }),
  // TemplatesList's mount effect records the Getting Started templates tick
  // via update(); swallowed here so the write-payload assertions (setCalls)
  // stay about the behaviour under test.
  update: vi.fn(async () => {}),
}));

import { TemplatesRoutes } from './TemplatesRoutes';
import { TemplatesList } from './TemplatesList';

const adminClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

const baseTemplate: Template = {
  name: 'PAS 79 base',
  version: 3,
  status: 'published',
  standard: 'pas79',
  sections: [
    {
      id: 'sec-1',
      code: '01',
      title: 'Means of escape',
      questions: [
        { id: 'q-1', text: 'Are escape routes clear?', type: 'yesno' },
      ],
    },
  ],
};

function renderTemplatesAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <TemplatesRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv('test');
  mocks.rtdb = {};
  mocks.setCalls = [];
  mocks.removeCalls = [];
  mocks.mintCounter = 0;
});

describe('TemplatesRoutes gate', () => {
  it('shows the calm admin gate to a non-admin at a direct URL', () => {
    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { assessor: true },
      environment: 'test',
    };
    mocks.rtdb = { templates: { t1: baseTemplate }, templateDrafts: null };
    renderTemplatesAt('/');
    expect(
      screen.getByRole('heading', { name: 'Administrator access required' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('PAS 79 base')).not.toBeInTheDocument();
  });
});

describe('TemplatesList', () => {
  it('merges published templates with drafts-only entries', () => {
    mocks.rtdb = {
      templates: { t1: baseTemplate },
      templateDrafts: {
        t1: { ...baseTemplate, status: 'draft' },
        t2: {
          name: 'My custom template',
          version: 0,
          status: 'draft',
          standard: 'custom',
          sections: [],
        },
      },
    };
    renderTemplatesAt('/');
    // The published row shows its live version plus the draft in flight.
    expect(screen.getByText('PAS 79 base')).toBeInTheDocument();
    expect(screen.getByText('v3 + draft in progress')).toBeInTheDocument();
    expect(screen.getByText('PAS 79-1:2020')).toBeInTheDocument();
    // The never-published draft appears honestly.
    expect(screen.getByText('My custom template')).toBeInTheDocument();
    expect(screen.getByText('Draft, never published')).toBeInTheDocument();
  });

  it('badges only the system-provided base templates', () => {
    mocks.rtdb = {
      templates: {
        // The seeded base template's WELL-KNOWN id (functions/src/seed/ids.ts).
        'tmpl-pas79-default': baseTemplate,
        // An org copy of the same content under a pushed id: no badge.
        t1: { ...baseTemplate, name: 'Our PAS 79 copy' },
      },
      templateDrafts: null,
    };
    renderTemplatesAt('/');
    expect(screen.getAllByText('Base template')).toHaveLength(1);
    expect(screen.getByText('Our PAS 79 copy')).toBeInTheDocument();
  });

  it('creates a duplicate draft with freshly minted section and question ids', async () => {
    const user = userEvent.setup();
    mocks.rtdb = { templates: { t1: baseTemplate }, templateDrafts: null };
    render(
      <MemoryRouter>
        <TemplatesList />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'New template' }));
    await user.type(screen.getByLabelText('Template name'), 'Copy of base');
    await user.selectOptions(screen.getByLabelText('Start from'), 't1');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(mocks.setCalls).toHaveLength(1);
    const { path, value } = mocks.setCalls[0];
    const draft = value as Template;
    // Written to the DRAFT node under a freshly minted template id.
    expect(path).toContain('templateDrafts/org-1/minted-');
    expect(draft.name).toBe('Copy of base');
    expect(draft.status).toBe('draft');
    expect(draft.version).toBe(0);
    // The duplicate keeps the source's standard for its report profile.
    expect(draft.standard).toBe('pas79');
    // Content copied, ids MINTED FRESH: answer keys are question ids and must
    // never collide across templates.
    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0].title).toBe('Means of escape');
    expect(draft.sections[0].id).not.toBe('sec-1');
    expect(draft.sections[0].id).toMatch(/^minted-/);
    expect(draft.sections[0].questions[0].text).toBe('Are escape routes clear?');
    expect(draft.sections[0].questions[0].id).not.toBe('q-1');
    expect(draft.sections[0].questions[0].id).toMatch(/^minted-/);
  });
});

describe('TemplateVersions', () => {
  it('counts assessments from the jobs pinning each templateId + version pair', () => {
    const frozen = (version: number): Template => ({
      ...baseTemplate,
      version,
      status: 'published',
    });
    const job = (templateId: string, templateVersion: number): Job => ({
      templateId,
      templateVersion,
      customerId: 'c1',
      siteId: 's1',
      buildingId: 'b1',
      assessorUid: 'u1',
      scheduledFor: 1,
      status: 'released',
    });
    mocks.rtdb = {
      template: baseTemplate,
      // The REAL SDK shape for this integer-keyed node: once the keys look
      // dense enough, the snapshot is coerced to an ARRAY with null holes.
      // Index 4 is a publish claim placeholder mid-flight - not a version.
      templateVersions: [
        null,
        null,
        frozen(2),
        frozen(3),
        { publishing: true, claimedAt: 1 },
      ],
      jobs: {
        j1: job('t1', 3),
        j2: job('t1', 3),
        j3: job('t1', 2),
        // Another template's job must not count towards t1.
        j4: job('t-other', 3),
      },
    };
    renderTemplatesAt('/t1/versions');
    expect(screen.getByRole('heading', { name: 'Version 3' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Version 2' })).toBeInTheDocument();
    expect(screen.getByText(/2 assessments/)).toBeInTheDocument();
    expect(screen.getByText(/1 assessment\b/)).toBeInTheDocument();
    // Null holes and the claim placeholder must not become phantom cards.
    expect(screen.queryByRole('heading', { name: 'Version 0' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Version 1' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Version 4' })).toBeNull();
  });
});

describe('ParagraphLibrary', () => {
  const paragraphs: Record<string, StandardParagraph> = {
    p1: { reference: '4.2.1', title: 'Escape routes', body: 'Keep clear.', updatedAt: 1 },
    p2: { reference: '9.9.9', body: 'Unused paragraph.', updatedAt: 1 },
  };

  it('blocks deleting a paragraph a template still references', async () => {
    const user = userEvent.setup();
    mocks.rtdb = {
      standardParagraphs: paragraphs,
      templates: {
        t1: {
          ...baseTemplate,
          sections: [
            {
              id: 'sec-1',
              code: '01',
              title: 'Means of escape',
              questions: [
                {
                  id: 'q-1',
                  text: 'Are escape routes clear?',
                  type: 'yesno',
                  standardParagraphRef: 'p1',
                },
              ],
            },
          ],
        },
      },
      templateDrafts: null,
    };
    renderTemplatesAt('/paragraphs');
    await user.click(
      screen.getByRole('button', { name: 'Delete paragraph 4.2.1' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Referenced by 1 template (PAS 79 base). Remove the references first.',
    );
    // Even a second click must not delete while the reference stands.
    await user.click(
      screen.getByRole('button', { name: 'Delete paragraph 4.2.1' }),
    );
    expect(mocks.removeCalls).toHaveLength(0);
  });

  it('deletes an unreferenced paragraph after the confirm step', async () => {
    const user = userEvent.setup();
    mocks.rtdb = {
      standardParagraphs: paragraphs,
      templates: null,
      templateDrafts: null,
    };
    renderTemplatesAt('/paragraphs');
    await user.click(
      screen.getByRole('button', { name: 'Delete paragraph 9.9.9' }),
    );
    expect(mocks.removeCalls).toHaveLength(0);
    await user.click(
      screen.getByRole('button', { name: 'Confirm delete of paragraph 9.9.9' }),
    );
    expect(mocks.removeCalls).toHaveLength(1);
    expect(mocks.removeCalls[0]).toContain('standardParagraphs/org-1/p2');
  });
});
