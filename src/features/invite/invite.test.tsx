// ============================================================================
// Invitation-acceptance screen tests.
//
// Mocking follows login.test.tsx: the auth context is mocked at the useAuth
// boundary (the provider's own logic is covered elsewhere) and Seo is stubbed
// because vite-react-ssg's <Head> belongs to the pre-render pass, not jsdom.
// The callables are mocked at the firebase/functions seam so the REAL
// useCallable runs, proving the screen surfaces the server's calm copy verbatim
// and branches on the reason discriminator rather than on parsed prose.
//
// The screen drives THREE callables, so the seam dispatches by name: previewing
// decides which question the visitor is asked, accepting answers it, and
// setActiveOrganisation makes the space just joined the one the console opens
// in (without it, accepting while signed in elsewhere silently lands the member
// back in their previous space).
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AuthContextValue } from '../../auth/AuthProvider';
import { Component } from './InviteRoute';

const mocks = vi.hoisted(() => ({
  preview: vi.fn<(input: unknown) => Promise<{ data: unknown }>>(),
  accept: vi.fn<(input: unknown) => Promise<{ data: unknown }>>(),
  setActive: vi.fn<(input: unknown) => Promise<{ data: unknown }>>(),
  userEmail: null as string | null,
  signInWithEmail: vi.fn<(email: string, password: string) => Promise<void>>(),
  signInWithCustomToken: vi.fn<(token: string) => Promise<void>>(),
  signOut: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../auth/AuthProvider', () => ({
  // The route mounts its own provider (it lives outside the console tree); in
  // tests it is a passthrough so the mocked useAuth below is the only source.
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: (): AuthContextValue =>
    ({
      status: mocks.userEmail ? 'authenticated' : 'signedOut',
      user: mocks.userEmail ? { email: mocks.userEmail } : null,
      emailVerified: true,
      claims: null,
      paths: null,
      signInWithEmail: mocks.signInWithEmail,
      signInWithGoogle: vi.fn(),
      signInWithCustomToken: mocks.signInWithCustomToken,
      sendReset: vi.fn(),
      changePassword: vi.fn(),
      updateDisplayName: vi.fn(),
      refreshSession: vi.fn(),
      refreshEmailVerification: vi.fn(),
      signOut: mocks.signOut,
    }) as unknown as AuthContextValue,
}));

vi.mock('../../seo/Seo', () => ({
  Seo: () => null,
}));

// The callable seam: httpsCallable hands back the mock for the NAMED function,
// and the firebase facade never initialises (nothing in jsdom should touch the
// real SDK).
vi.mock('firebase/functions', () => ({
  httpsCallable: (_functions: unknown, name: string) => {
    if (name === 'previewInvitation') return mocks.preview;
    if (name === 'acceptInvitation') return mocks.accept;
    return mocks.setActive;
  },
}));
vi.mock('../../firebase', () => ({
  firebase: { functions: () => ({}) },
}));

const INVITED = 'marcus.webb@meridian-estates.test';

/** The happy-path preview: a first-time recipient with no account yet. */
function previewResolves(overrides: Record<string, unknown> = {}) {
  mocks.preview.mockResolvedValue({
    data: {
      email: INVITED,
      orgName: 'Meridian Fire Safety',
      accountExists: false,
      ...overrides,
    },
  });
}

function renderInvite(initialEntry = '/invite?token=tok-123') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/invite" element={<Component />} />
        <Route path="/login" element={<p>sign-in page</p>} />
        <Route path="/app/*" element={<p>console shell</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.preview.mockReset();
  mocks.accept.mockReset();
  mocks.setActive.mockReset();
  mocks.setActive.mockResolvedValue({ data: { orgId: 'org-1', roles: [] } });
  mocks.signInWithEmail.mockReset();
  mocks.signInWithCustomToken.mockReset();
  mocks.signOut.mockReset();
  mocks.userEmail = null;
});

describe('InviteRoute', () => {
  it('shows the calm incomplete-link state when the token is missing', () => {
    renderInvite('/invite');
    expect(
      screen.getByText(
        'This invitation link is incomplete. Ask your administrator to send a new one.',
      ),
    ).toBeInTheDocument();
    // No form to mis-submit: the page is a dead end, not a trap, and nothing is
    // asked of the server.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('names the invited address read-only on the create-account branch', async () => {
    previewResolves();
    renderInvite();

    const email = await screen.findByLabelText('Email address');
    expect(email).toHaveValue(INVITED);
    expect(email).toHaveAttribute('readonly');
    expect(mocks.preview).toHaveBeenCalledWith({ token: 'tok-123' });
  });

  it('blocks submission when the passwords do not match, without calling the server', async () => {
    previewResolves();
    const user = userEvent.setup();
    renderInvite();

    await user.type(await screen.findByLabelText('Full name'), 'Marcus Webb');
    await user.type(screen.getByLabelText('Password'), 'pass-word-1');
    await user.type(screen.getByLabelText('Confirm password'), 'different');
    await user.click(
      screen.getByRole('button', { name: 'Create your account and join' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Those passwords do not match. Check both and try again.',
    );
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('creates the account, signs in with the minted token and enters the console', async () => {
    previewResolves();
    mocks.accept.mockResolvedValue({
      data: { orgId: 'org-1', uid: 'u-1', customToken: 'custom-abc' },
    });
    const user = userEvent.setup();
    renderInvite();

    await user.type(await screen.findByLabelText('Full name'), '  Marcus Webb ');
    await user.type(screen.getByLabelText('Password'), 'pass-word-1');
    await user.type(screen.getByLabelText('Confirm password'), 'pass-word-1');
    await user.click(
      screen.getByRole('button', { name: 'Create your account and join' }),
    );

    await waitFor(() =>
      expect(mocks.accept).toHaveBeenCalledWith({
        token: 'tok-123',
        password: 'pass-word-1',
        displayName: 'Marcus Webb',
      }),
    );
    // The whole point of the reshape: no manual re-entry of the credentials the
    // visitor just chose.
    expect(mocks.signInWithCustomToken).toHaveBeenCalledWith('custom-abc');
    expect(await screen.findByText('console shell')).toBeInTheDocument();
  });

  it('signs an existing account in BEFORE accepting, and never asks it for a new password', async () => {
    previewResolves({ accountExists: true });
    mocks.signInWithEmail.mockResolvedValue(undefined);
    mocks.accept.mockResolvedValue({ data: { orgId: 'org-1', uid: 'u-1' } });
    const user = userEvent.setup();
    renderInvite();

    expect(
      await screen.findByRole('heading', { name: 'Sign in to accept' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), 'existing-password');
    await user.click(screen.getByRole('button', { name: 'Sign in and accept' }));

    await waitFor(() =>
      expect(mocks.signInWithEmail).toHaveBeenCalledWith(
        INVITED,
        'existing-password',
      ),
    );
    expect(mocks.accept).toHaveBeenCalledWith({ token: 'tok-123' });
    expect(await screen.findByText('console shell')).toBeInTheDocument();
  });

  it('does not accept when the existing account fails to sign in', async () => {
    const message =
      'Those sign-in details were not recognised. Check your email and password and try again.';
    previewResolves({ accountExists: true });
    mocks.signInWithEmail.mockRejectedValue(new Error(message));
    const user = userEvent.setup();
    renderInvite();

    await user.type(await screen.findByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in and accept' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it('shows the dead-end screens on LOAD, before anything is asked of the visitor', async () => {
    mocks.preview.mockRejectedValue({
      details: {
        message: 'This invitation has expired.',
        details: { reason: 'expired' },
      },
    });
    renderInvite();

    expect(
      await screen.findByRole('heading', { name: 'This invitation has expired.' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('offers a single confirmation when the visitor is already the invited account', async () => {
    mocks.userEmail = INVITED;
    previewResolves({ accountExists: true });
    mocks.accept.mockResolvedValue({ data: { orgId: 'org-1', uid: 'u-1' } });
    const user = userEvent.setup();
    renderInvite();

    await user.click(
      await screen.findByRole('button', { name: 'Accept invitation' }),
    );

    await waitFor(() =>
      expect(mocks.accept).toHaveBeenCalledWith({ token: 'tok-123' }),
    );
    expect(await screen.findByText('console shell')).toBeInTheDocument();
  });

  it('makes the space just joined the active one, carrying the customer', async () => {
    // The reported bug: a member accepting a PORTAL invitation while signed in
    // to another space was returned to that other space, so the acceptance
    // looked as though it had done nothing.
    mocks.userEmail = INVITED;
    previewResolves({ accountExists: true, customerName: 'Meridian Estates' });
    mocks.accept.mockResolvedValue({
      data: { orgId: 'org-1', uid: 'u-1', customerId: 'cus-7' },
    });
    const user = userEvent.setup();
    renderInvite();

    await user.click(
      await screen.findByRole('button', { name: 'Accept invitation' }),
    );

    await waitFor(() =>
      expect(mocks.setActive).toHaveBeenCalledWith({
        orgId: 'org-1',
        customerId: 'cus-7',
      }),
    );
    expect(await screen.findByText('console shell')).toBeInTheDocument();
  });

  it('still enters the console when the space switch fails', async () => {
    // The membership landed; only the switch did not, so the join must not be
    // reported as a failure. The console asks which space to open instead.
    mocks.userEmail = INVITED;
    previewResolves({ accountExists: true });
    mocks.accept.mockResolvedValue({ data: { orgId: 'org-1', uid: 'u-1' } });
    mocks.setActive.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderInvite();

    await user.click(
      await screen.findByRole('button', { name: 'Accept invitation' }),
    );

    expect(await screen.findByText('console shell')).toBeInTheDocument();
  });

  it('offers a way out when the visitor is signed in as someone else', async () => {
    mocks.userEmail = 'helen.carter@meridian-estates.test';
    previewResolves();
    const user = userEvent.setup();
    renderInvite();

    expect(
      await screen.findByRole('heading', {
        name: 'You are signed in as someone else.',
      }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Sign out and continue' }),
    );
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it("surfaces the callable's calm copy verbatim, plus the new-invitation hint", async () => {
    const message = 'This invitation is no longer valid.';
    previewResolves();
    mocks.accept.mockRejectedValue({ details: { message } });
    const user = userEvent.setup();
    renderInvite();

    await user.type(await screen.findByLabelText('Full name'), 'Marcus Webb');
    await user.type(screen.getByLabelText('Password'), 'pass-word-1');
    await user.type(screen.getByLabelText('Confirm password'), 'pass-word-1');
    await user.click(
      screen.getByRole('button', { name: 'Create your account and join' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(
      'ask your administrator to send a new invitation',
    );
    // Recoverable: the form is live again for another attempt.
    expect(
      screen.getByRole('button', { name: 'Create your account and join' }),
    ).toBeEnabled();
  });
});
