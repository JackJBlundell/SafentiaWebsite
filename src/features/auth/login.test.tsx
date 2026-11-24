// ============================================================================
// Sign-in screen tests.
//
// The auth context is mocked at the useAuth boundary rather than at the Firebase
// SDK: the provider's own logic (claims, error mapping) is covered in
// src/auth/AuthProvider.test.tsx, and mocking here keeps these tests independent
// of the Firebase module and the query client, neither of which a screen test
// should care about. Seo is stubbed because vite-react-ssg's <Head> belongs to
// the pre-render pass, not to jsdom.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AuthContextValue, AuthStatus } from '../../auth/AuthProvider';
import { Component, safeReturnTo } from './LoginRoute';

const mocks = vi.hoisted(() => ({
  status: 'signedOut' as AuthStatus,
  signInWithEmail: vi.fn<(email: string, password: string) => Promise<void>>(),
  signInWithGoogle: vi.fn<() => Promise<void>>(),
}));

vi.mock('../../auth/AuthProvider', () => ({
  // The route mounts its own provider (it lives outside the console tree); in
  // tests it is a passthrough so the mocked useAuth below is the only source.
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: (): AuthContextValue =>
    ({
      status: mocks.status,
      user: null,
      emailVerified: false,
      refreshEmailVerification: vi.fn(),
      claims: null,
      paths: null,
      signInWithEmail: mocks.signInWithEmail,
      signInWithGoogle: mocks.signInWithGoogle,
      signUpWithEmail: vi.fn(),
      resendVerificationEmail: vi.fn(),
      signInWithCustomToken: vi.fn(),
      sendReset: vi.fn(),
      changePassword: vi.fn(),
      updateDisplayName: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(),
    }) as AuthContextValue,
}));

vi.mock('../../seo/Seo', () => ({
  Seo: () => null,
}));

function renderLogin(initialEntry = '/login') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/login" element={<Component />} />
        <Route path="/app/*" element={<p>console shell</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.status = 'signedOut';
  mocks.signInWithEmail.mockReset();
  mocks.signInWithGoogle.mockReset();
});

describe('safeReturnTo (open-redirect guard)', () => {
  it('honours console paths only', () => {
    expect(safeReturnTo('/app')).toBe('/app');
    expect(safeReturnTo('/app/jobs/123')).toBe('/app/jobs/123');
    expect(safeReturnTo('/app?tab=jobs')).toBe('/app?tab=jobs');
  });

  it('rejects external, protocol-relative and non-console values', () => {
    expect(safeReturnTo('https://evil.example')).toBe('/app');
    expect(safeReturnTo('//evil.example/app')).toBe('/app');
    expect(safeReturnTo('/pricing')).toBe('/app');
    // Prefix look-alikes are still rejected: "/application" is not the console.
    expect(safeReturnTo('/application')).toBe('/app');
    expect(safeReturnTo(null)).toBe('/app');
  });
});

describe('LoginRoute', () => {
  it('labels both fields so they are reachable by their accessible names', () => {
    renderLogin();
    expect(screen.getByLabelText('Email address')).toHaveAttribute(
      'autocomplete',
      'email',
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
  });

  it('disables the form and relabels the button while a sign-in is pending', async () => {
    // A promise that never settles holds the screen in its submitting state.
    mocks.signInWithEmail.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('Email address'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'pass-word');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const pending = await screen.findByRole('button', { name: 'Signing in...' });
    expect(pending).toBeDisabled();
    expect(screen.getByLabelText('Email address')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
  });

  it('announces the mapped error when sign-in is rejected', async () => {
    const message =
      'Those sign-in details were not recognised. Check your email and password and try again.';
    mocks.signInWithEmail.mockRejectedValue(new Error(message));
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('Email address'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    // Recoverable: the form is live again for another attempt.
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('redirects an already-authenticated visitor into the console', () => {
    mocks.status = 'authenticated';
    renderLogin('/login?returnTo=https://evil.example');
    // The guard discards the external returnTo and lands on /app.
    expect(screen.getByText('console shell')).toBeInTheDocument();
  });

  it('renders the form disabled, never blank, while initialising', () => {
    mocks.status = 'initialising';
    renderLogin();
    expect(screen.getByLabelText('Email address')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });
});
