// ============================================================================
// Building-asset panel tests: the upload validators (the UX mirror of
// storage.rules), the floor-plans panel's empty/admin states, and the service
// schedule's overdue marking.
//
// Mocked at the same module boundaries as console.test.tsx: AuthProvider (the
// contract, not the implementation), the RTDB bridge, and the firebase module,
// so no test opens a socket.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { forEnv } from '../../paths';
import type { SessionClaims } from '../../auth/claims';

// --- Module mocks -------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: null as unknown,
    claims: null as unknown,
    paths: null as unknown,
  },
  rtdb: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
  },
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

vi.mock('firebase/storage', () => ({
  ref: vi.fn(),
  getDownloadURL: vi.fn(async () => 'https://example.com/object'),
  uploadBytesResumable: vi.fn(),
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: () => ({
    data: mocks.rtdb.data,
    isLoading: mocks.rtdb.isLoading,
    isError: mocks.rtdb.isError,
  }),
  subscribeToQuery: vi.fn(() => () => undefined),
}));

import { fileIsDocument, fileIsFloorPlan, fileIsImage } from '../lib/upload';
import { FloorPlansPanel } from './FloorPlansPanel';
import { ServiceSchedulePanel } from './ServiceSchedulePanel';

// --- Fixtures -------------------------------------------------------------------

const MB = 1024 * 1024;

const adminClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true, assessor: true },
  environment: 'test',
};

const assessorClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { assessor: true },
  environment: 'test',
};

/** A File of a declared size without allocating the bytes. */
function makeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv('test');
  mocks.rtdb.data = undefined;
  mocks.rtdb.isLoading = false;
  mocks.rtdb.isError = false;
  vi.clearAllMocks();
});

// --- Upload validators ----------------------------------------------------------

describe('upload validators', () => {
  it('rejects an oversized image with calm copy', () => {
    const check = fileIsImage(makeFile('plan.png', 'image/png', 11 * MB));
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe(
        'This image is larger than 10 MB. Please choose a smaller image.',
      );
    }
  });

  it('accepts a PDF floor plan within the 25 MB ceiling', () => {
    const check = fileIsFloorPlan(makeFile('plan.pdf', 'application/pdf', 20 * MB));
    expect(check.ok).toBe(true);
  });

  it('rejects a floor plan of the wrong type', () => {
    const check = fileIsFloorPlan(makeFile('plan.txt', 'text/plain', 1 * MB));
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe(
        'Floor plans can be an image up to 10 MB or a PDF up to 25 MB.',
      );
    }
  });

  it('rejects a non-image passed to the image validator', () => {
    const check = fileIsImage(makeFile('doc.pdf', 'application/pdf', 1 * MB));
    expect(check.ok).toBe(false);
  });

  it('accepts any document type within 25 MB and rejects above it', () => {
    expect(fileIsDocument(makeFile('cert.docx', 'application/msword', 24 * MB)).ok).toBe(
      true,
    );
    const oversized = fileIsDocument(makeFile('cert.zip', 'application/zip', 26 * MB));
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.reason).toBe(
        'This file is larger than 25 MB. Please choose a smaller file.',
      );
    }
  });
});

// --- FloorPlansPanel --------------------------------------------------------------

describe('FloorPlansPanel', () => {
  it('renders the empty state and the admin add action', () => {
    mocks.rtdb.data = null;
    render(<FloorPlansPanel buildingId="building-1" />);
    expect(
      screen.getByText(
        'No floor plans yet. Assessors can still complete assessments; location flagging becomes available once plans are added.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add floor plans' }),
    ).toBeInTheDocument();
  });

  it('does not offer the add action to a non-admin', () => {
    mocks.auth.claims = assessorClaims;
    mocks.rtdb.data = null;
    render(<FloorPlansPanel buildingId="building-1" />);
    // Plural, matching the multi-file trigger above. Querying the old singular
    // name made this pass whether or not the admin gate held, which is worse
    // than having no test for it.
    expect(
      screen.queryByRole('button', { name: 'Add floor plans' }),
    ).not.toBeInTheDocument();
  });
});

// --- ServiceSchedulePanel ----------------------------------------------------------

describe('ServiceSchedulePanel', () => {
  it('marks a past-due service as overdue', () => {
    const DAY = 24 * 60 * 60 * 1000;
    mocks.rtdb.data = {
      name: 'Riverside House',
      customerId: 'customer-1',
      riskLevel: 'medium',
      serviceSchedule: {
        fireAlarmService: { nextDue: Date.now() - 40 * DAY },
        fireDrill: { nextDue: Date.now() + 200 * DAY },
      },
    };
    render(<ServiceSchedulePanel siteId="site-1" buildingId="building-1" />);
    expect(screen.getByText('Fire alarm service')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    // The comfortably-future service is not flagged.
    expect(screen.queryAllByText('Overdue')).toHaveLength(1);
  });
});
