// ============================================================================
// Invitation-acceptance screen tests.
//
// Mocking follows login.test.tsx: the auth context is mocked at the useAuth
// boundary (the provider's own logic is covered elsewhere) and Seo is stubbed
// because vite-react-ssg's <Head> belongs to the pre-render pass, not jsdom.
// The callable is mocked at the firebase/functions seam so the REAL useCallable
// runs, proving the screen surfaces the server's calm copy verbatim.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AuthContextValue } from '../../auth/AuthProvider';
import { Component } from './InviteRoute';

const mocks = vi.hoisted(() => ({
  callable: vi.fn<(input: unknown) => Promise<{ data: unknown }>>(),
  userEmail: null as string | null,
}));

vi.mock('../../auth/AuthProvider', () => ({
  // The route mounts its own provider (it lives outside the console tree); in
  // tests it is a passthrough so the mocked useAuth below is the only source.
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: (): AuthContextValue =>
    ({
      status: mocks.userEmail ? 'authenticated' : 'signedOut',
      user: mocks.userEmail ? { email: mocks.userEmail } : null,
      claims: null,
      paths: null,
      signInWithEmail: vi.fn(),
      signInWithGoogle: vi.fn(),
      sendReset: vi.fn(),
      changePassword: vi.fn(),
      updateDisplayName: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(),
    }) as unknown as AuthContextValue,
}));

vi.mock('../../seo/Seo', () => ({
  Seo: () => null,
}));

// The callable seam: httpsCallable hands back our mock, and the firebase
// facade never initialises (nothing in jsdom should touch the real SDK).
vi.mock('firebase/functions', () => ({
  httpsCallable: () => mocks.callable,
}));
vi.mock('../../firebase', () => ({
  firebase: { functions: () => ({}) },
}));

function renderInvite(initialEntry = '/invite?token=tok-123') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/invite" element={<Component />} />
        <Route path="/login" element={<p>sign-in page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Fill the three fields and press the submit button. */
async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  { confirm = 'pass-word-1' } = {},
) {
  await user.type(screen.getByLabelText('Full name'), '  Marcus Webb ');
  await user.type(screen.getByLabelText('Password'), 'pass-word-1');
  await user.type(screen.getByLabelText('Confirm password'), confirm);
  await user.click(
    screen.getByRole('button', { name: 'Create your account and join' }),
  );
}

beforeEach(() => {
  mocks.callable.mockReset();
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
    // No form to mis-submit: the page is a dead end, not a trap.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('blocks submission when the passwords do not match, without calling the server', async () => {
    const user = userEvent.setup();
    renderInvite();

    await fillAndSubmit(user, { confirm: 'different' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Those passwords do not match. Check both and try again.',
    );
    expect(mocks.callable).not.toHaveBeenCalled();
  });

  it('submits the token, password and trimmed display name', async () => {
    mocks.callable.mockResolvedValue({ data: { orgId: 'org-1', uid: 'u-1' } });
    const user = userEvent.setup();
    renderInvite();

    await fillAndSubmit(user);

    expect(mocks.callable).toHaveBeenCalledWith({
      token: 'tok-123',
      password: 'pass-word-1',
      displayName: 'Marcus Webb',
    });
  });

  it('shows the ready state with a route to sign in after success', async () => {
    mocks.callable.mockResolvedValue({ data: { orgId: 'org-1', uid: 'u-1' } });
    const user = userEvent.setup();
    renderInvite();

    await fillAndSubmit(user);

    expect(
      await screen.findByRole('heading', { name: 'Your account is ready.' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(screen.getByText('sign-in page')).toBeInTheDocument();
  });

  it("surfaces the callable's calm copy verbatim, plus the new-invitation hint", async () => {
    const message = 'This invitation is no longer available.';
    mocks.callable.mockRejectedValue({ details: { message } });
    const user = userEvent.setup();
    renderInvite();

    await fillAndSubmit(user);

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

  it('names the signed-in email without blocking acceptance', () => {
    mocks.userEmail = 'helen.carter@meridian-estates.test';
    renderInvite();
    expect(
      screen.getByText(/signed in as helen.carter@meridian-estates.test/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeEnabled();
  });
});
