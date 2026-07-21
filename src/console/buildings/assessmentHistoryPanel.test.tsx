// ============================================================================
// AssessmentHistoryPanel tests (story 2037): the history table's ordering,
// exact stage labels and actor names; the released-report rows' resolved
// Download link; and the admin/auditor-only two-step Regenerate calling
// generateReport with the source assessment id.
//
// Mocked at the house boundaries: AuthProvider, the RTDB bridge (fixtures by
// query-key domain), firebase/storage and firebase/functions - the REAL
// useCallable runs so the payload it sends is asserted.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forEnv } from '../../paths';
import type { SessionClaims } from '../../auth/claims';
import type { Assessment, OrgMember, Report } from '../../types';

// --- Module mocks -------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: null as unknown,
    claims: null as unknown,
    paths: null as unknown,
  },
  fixtures: {
    assessments: null as Record<string, Assessment> | null,
    reports: null as Record<string, Report> | null,
    members: undefined as Record<string, OrgMember> | null | undefined,
  },
  callable: vi.fn(async () => ({
    data: { reportId: 'rep-2', pdfPath: 'orgs/org-1/reports/rep-2.pdf' },
  })),
  getDownloadURL: vi.fn(async () => 'https://example.com/report.pdf'),
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

vi.mock('firebase/functions', () => ({
  httpsCallable: () => mocks.callable,
}));

vi.mock('firebase/storage', () => ({
  ref: vi.fn(),
  getDownloadURL: () => mocks.getDownloadURL(),
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

// Fixtures by query-key domain, mirroring what each live listener delivers.
vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly (string | number)[] }) => {
    let data: unknown;
    switch (key[0]) {
      case 'buildingAssessments':
        data = mocks.fixtures.assessments;
        break;
      case 'reports':
        data = mocks.fixtures.reports;
        break;
      case 'orgMembers':
        data = mocks.fixtures.members;
        break;
      default:
        data = null;
    }
    return { data, isLoading: false, isError: false };
  },
}));

import { AssessmentHistoryPanel } from './AssessmentHistoryPanel';

// --- Fixtures -------------------------------------------------------------------

const adminClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

/** JUNE 1 < JULY 1: two conducted dates the ordering assertions read back. */
const JUNE_1 = Date.UTC(2026, 5, 1);
const JULY_1 = Date.UTC(2026, 6, 1);

function assessment(overrides: Partial<Assessment>): Assessment {
  return {
    jobId: 'job-1',
    templateId: 'tpl-1',
    templateVersion: 1,
    templateSnapshot: {} as Assessment['templateSnapshot'],
    customerId: 'c1',
    siteId: 's1',
    buildingId: 'bld-1',
    conductedBy: 'uid-amy',
    conductedAt: JUNE_1,
    status: 'released',
    ...overrides,
  } as Assessment;
}

beforeEach(() => {
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv('test');
  mocks.fixtures.assessments = null;
  mocks.fixtures.reports = null;
  mocks.fixtures.members = {
    'uid-amy': { name: 'Amy Archer' } as OrgMember,
  };
  mocks.callable.mockClear();
  mocks.getDownloadURL.mockClear();
  mocks.getDownloadURL.mockResolvedValue('https://example.com/report.pdf');
});

describe('AssessmentHistoryPanel', () => {
  it('lists assessments newest first with exact stage labels and actor names', () => {
    mocks.fixtures.assessments = {
      'job-old': assessment({ conductedAt: JUNE_1, status: 'released' }),
      'job-new': assessment({
        conductedAt: JULY_1,
        status: 'infoRequired',
        conductedBy: 'uid-gone',
      }),
    };
    render(<AssessmentHistoryPanel buildingId="bld-1" />);

    const rows = screen.getAllByRole('row').slice(1); // drop the header row
    // Newest (July) first, with the EXACT client-facing stage words.
    expect(rows[0]).toHaveTextContent('More information required');
    expect(rows[1]).toHaveTextContent('Released');
    // The departed assessor renders honestly, never as a raw uid.
    expect(rows[0]).toHaveTextContent('Former staff member');
    expect(rows[1]).toHaveTextContent('Amy Archer');
    expect(rows[1]).toHaveTextContent('1 June 2026');
  });

  it('shows honest empty states for a building with no history', () => {
    render(<AssessmentHistoryPanel buildingId="bld-1" />);
    expect(
      screen.getByText('No assessments have been conducted for this building yet.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No reports have been released for this building yet/),
    ).toBeInTheDocument();
  });

  it('resolves a released report into a Download link', async () => {
    mocks.fixtures.reports = {
      'rep-1': {
        pdfPath: 'orgs/org-1/reports/rep-1.pdf',
        generatedAt: JULY_1,
        assessmentId: 'job-1',
      },
    };
    render(<AssessmentHistoryPanel buildingId="bld-1" />);
    expect(screen.getByText('Generated 1 July 2026')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute('href', 'https://example.com/report.pdf');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('degrades to honest copy when the report object is unreachable', async () => {
    mocks.getDownloadURL.mockRejectedValue(new Error('denied'));
    mocks.fixtures.reports = {
      'rep-1': { pdfPath: 'orgs/org-1/reports/rep-1.pdf', generatedAt: JULY_1 },
    };
    render(<AssessmentHistoryPanel buildingId="bld-1" />);
    expect(
      await screen.findByText('The report file could not be reached. Please try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('regenerates only after the confirm step, with the source assessment id', async () => {
    mocks.fixtures.reports = {
      'rep-1': {
        pdfPath: 'orgs/org-1/reports/rep-1.pdf',
        generatedAt: JULY_1,
        assessmentId: 'job-1',
      },
    };
    render(<AssessmentHistoryPanel buildingId="bld-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    // First press arms the confirmation; nothing has been sent yet.
    expect(mocks.callable).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm regenerate' }));
    await waitFor(() =>
      expect(mocks.callable).toHaveBeenCalledWith({ assessmentId: 'job-1' }),
    );
  });

  it('hides Regenerate from members who are neither admin nor auditor', () => {
    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { assessor: true },
      environment: 'test',
    } satisfies SessionClaims;
    mocks.fixtures.reports = {
      'rep-1': {
        pdfPath: 'orgs/org-1/reports/rep-1.pdf',
        generatedAt: JULY_1,
        assessmentId: 'job-1',
      },
    };
    render(<AssessmentHistoryPanel buildingId="bld-1" />);
    expect(
      screen.queryByRole('button', { name: 'Regenerate' }),
    ).not.toBeInTheDocument();
  });

  it('shows Regenerate to an auditor', () => {
    mocks.auth.claims = {
      orgId: 'org-1',
      roles: { auditor: true },
      environment: 'test',
    } satisfies SessionClaims;
    mocks.fixtures.reports = {
      'rep-1': {
        pdfPath: 'orgs/org-1/reports/rep-1.pdf',
        generatedAt: JULY_1,
        assessmentId: 'job-1',
      },
    };
    render(<AssessmentHistoryPanel buildingId="bld-1" />);
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });
});
