// ============================================================================
// Settings area tests: the admin gate, the organisation profile form and the
// RAG settings save path. Module boundaries mocked as in console.test.tsx; the
// RAG derivation itself has its own exhaustive unit tests in
// ragDerivation.test.ts. The create-organisation dialog is operator-only and
// tested with its home, the super-admin area (admin.test.tsx).
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { forEnv } from '../../paths';
import type { OrgProfile } from '../../types';

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: { uid: 'admin-1', email: 'admin@example.com' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
    refreshSession: vi.fn(async () => undefined),
    signOut: vi.fn(),
  },
  rtdb: {} as Record<string, unknown>,
  callable: vi.fn(async (_name: string, _input: unknown) => ({}) as unknown),
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
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

vi.mock('../ui/useCallable', () => ({
  useCallable: (name: string) => ({
    call: (input: unknown) => mocks.callable(name, input),
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

// riskPresentation needs a Theme; the preview only reads these leaves.
vi.mock('../../design/ThemeProvider', () => ({
  useTheme: () => ({
    theme: {
      rag: {
        red: '#c00',
        amber: '#a60',
        green: '#080',
        redSurface: '#fee',
        amberSurface: '#ffe',
        greenSurface: '#efe',
      },
      colors: { textMuted: '#666', surfaceSunken: '#eee' },
    },
  }),
}));

import { SettingsRoutes } from './SettingsRoutes';
import { ImageCropDialog } from '../ui/ImageCropDialog';

const adminClaims = { orgId: 'org-1', roles: { admin: true }, environment: 'test' };

const profile: OrgProfile = {
  name: 'Acme Fire Safety',
  brand: { primary: '#1a5fb4', secondary: '#26a269' },
  contact: { email: 'office@acme.example' },
};

function renderSettingsAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <SettingsRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv('test');
  mocks.auth.refreshSession.mockClear();
  mocks.rtdb = {
    orgProfile: profile,
    orgSettings: null,
    customers: null,
    sites: null,
    buildings: null,
  };
  mocks.callable.mockClear();
  mocks.callable.mockResolvedValue({ updated: true });
});

describe('SettingsRoutes gate', () => {
  it('shows the calm admin gate to a non-admin at a direct URL', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { finance: true }, environment: 'test' };
    renderSettingsAt('/');
    expect(
      screen.getByRole('heading', { name: 'Administrator access required' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Organisation name')).not.toBeInTheDocument();
  });
});

describe('OrganisationSettingsPage', () => {
  it('seeds the form from the live profile and saves only the changed fields', async () => {
    const user = userEvent.setup();
    renderSettingsAt('/');
    const nameInput = screen.getByLabelText('Organisation name');
    expect(nameInput).toHaveValue('Acme Fire Safety');
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme Fire & Safety Ltd');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.callable).toHaveBeenCalledWith('updateOrgProfile', {
      profile: { name: 'Acme Fire & Safety Ltd' },
    });
  });

  it('renders each font option in its own typeface', async () => {
    const user = userEvent.setup();
    renderSettingsAt('/');
    await user.click(screen.getByRole('button', { name: /Font family/ }));
    const georgia = screen.getByRole('option', { name: /^Georgia/ });
    // The option previews itself: its style carries the resolved font stack.
    expect(georgia.style.fontFamily).toContain('Georgia');
    expect(georgia.style.fontFamily).toContain('Inter');
    const defaultOption = screen.getByRole('option', {
      name: /Safentia default \(Inter\)/,
    });
    expect(defaultOption.style.fontFamily).toContain('Inter Variable');
  });

  it('sends fontFamily null when the default is chosen after a saved font', async () => {
    const user = userEvent.setup();
    mocks.rtdb.orgProfile = { ...profile, fontFamily: 'Georgia' };
    renderSettingsAt('/');
    await user.click(screen.getByRole('button', { name: /Font family/ }));
    await user.click(
      screen.getByRole('option', { name: /Safentia default \(Inter\)/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.callable).toHaveBeenCalledWith('updateOrgProfile', {
      profile: { fontFamily: null },
    });
  });

  it('surfaces an unlisted font as a Custom option, preselected', () => {
    mocks.rtdb.orgProfile = { ...profile, fontFamily: 'Comic Sans MS' };
    renderSettingsAt('/');
    expect(
      screen.getByRole('button', { name: /Custom: Comic Sans MS/ }),
    ).toBeInTheDocument();
  });

  it('previews where the branding appears, reflecting the org name and a typed colour', async () => {
    const user = userEvent.setup();
    renderSettingsAt('/');

    // Both preview captions are present.
    expect(screen.getByText('How your report header will look')).toBeInTheDocument();
    expect(screen.getByText('How notification emails will look')).toBeInTheDocument();

    // The org name lands on both the report cover line and the email wordmark.
    expect(screen.getByTestId('branding-report-org')).toHaveTextContent('Acme Fire Safety');
    expect(screen.getByTestId('branding-email-wordmark')).toHaveTextContent(
      'Acme Fire Safety',
    );

    // A typed brand colour flows straight into the report accent rule and the
    // email accent bar (the same colour those consumers paint with).
    const primary = screen.getByLabelText('Primary colour');
    await user.clear(primary);
    await user.type(primary, '#aa0000');
    expect(screen.getByTestId('branding-report-rule')).toHaveStyle({
      background: '#aa0000',
    });
    expect(screen.getByTestId('branding-email-accent')).toHaveStyle({
      background: '#aa0000',
    });
  });

  it('blocks saving while a brand colour is not six-digit hex', async () => {
    const user = userEvent.setup();
    renderSettingsAt('/');
    const primary = screen.getByLabelText('Primary colour');
    await user.clear(primary);
    await user.type(primary, '#12');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Brand colours must be six-digit hex values',
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});

describe('RagSettingsPage', () => {
  it('seeds from the proposed defaults and saves the edited config', async () => {
    const user = userEvent.setup();
    renderSettingsAt('/rag');
    const redShare = screen.getByLabelText('High risk when red findings reach (%)');
    expect(redShare).toHaveValue(10);
    await user.clear(redShare);
    await user.type(redShare, '20');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(mocks.callable).toHaveBeenCalledWith('updateOrgSettings', {
      ragConfig: {
        redShareForHigh: 0.2,
        amberRedShareForMedium: 0.25,
        openHighActionForcesHigh: true,
        overdueActionEscalates: true,
      },
    });
  });

  it('rejects a zero red threshold with a hard error and blocks saving', async () => {
    const user = userEvent.setup();
    renderSettingsAt('/rag');
    const redShare = screen.getByLabelText('High risk when red findings reach (%)');
    await user.clear(redShare);
    await user.type(redShare, '0');
    expect(
      screen.getByText('The red threshold must be above zero.'),
    ).toBeInTheDocument();
    expect(redShare).toHaveAttribute('aria-invalid', 'true');
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    expect(mocks.callable).not.toHaveBeenCalled();
  });

  it('notes a medium bar below the red bar without blocking the save', async () => {
    const user = userEvent.setup();
    renderSettingsAt('/rag');
    // Defaults are red 10% / amber+red 25%: no note. Drop the medium bar
    // BENEATH the red bar and the informational note appears, but saving stays
    // possible - the derivation checks the red bar first, so the configuration
    // is unusual, not wrong.
    const note = 'Most organisations set the medium bar below the red bar.';
    expect(screen.queryByText(note)).not.toBeInTheDocument();
    const amberShare = screen.getByLabelText(
      'Medium risk when amber and red findings reach (%)',
    );
    await user.clear(amberShare);
    await user.type(amberShare, '5');
    expect(screen.getByText(note)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(mocks.callable).toHaveBeenCalledWith('updateOrgSettings', {
      ragConfig: {
        redShareForHigh: 0.1,
        amberRedShareForMedium: 0.05,
        openHighActionForcesHigh: true,
        overdueActionEscalates: true,
      },
    });
  });
});

describe('ImageCropDialog', () => {
  // jsdom has no canvas or object URLs: stub the 2D context, PNG export and
  // image decoding so the dialog's flow (load, position, confirm, resolve a
  // Blob) can run end to end.
  beforeEach(() => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 800;
      naturalHeight = 600;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = function (
      callback: (blob: Blob | null) => void,
    ) {
      callback(new Blob(['png-bytes'], { type: 'image/png' }));
    };
  });

  it('confirms the crop and resolves a PNG blob', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(
      <ImageCropDialog
        file={new Blob(['source'], { type: 'image/png' })}
        onDone={onDone}
      />,
    );
    const confirm = await screen.findByRole('button', { name: 'Use this logo' });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getByLabelText('Zoom')).toBeInTheDocument();
    await user.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const blob = onDone.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });

  it('cancels with null and never exports', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(
      <ImageCropDialog
        file={new Blob(['source'], { type: 'image/png' })}
        onDone={onDone}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onDone).toHaveBeenCalledWith(null);
  });
});
