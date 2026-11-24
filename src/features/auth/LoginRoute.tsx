// ============================================================================
// LoginRoute - /login, the console's front door (stories 1016/1017, brief 4.1).
//
// Email/password plus Google, mirroring the app's sign-in screen. This door
// also opens the self-serve journey (Phase 3): the marketing site's "Get
// started" lands here, and a session with no membership falls through to the
// console's onboarding gates (org details -> plan -> payment -> setup). The
// brand panel carries a quiet book-a-demonstration footnote for anyone who
// wants the guided path first.
//
// Error copy comes pre-mapped from the AuthProvider (non-enumerating, no raw
// Firebase codes), so this screen only decides where to put it, never what it
// says. While the first token resolves the form renders disabled rather than
// blank, so the pre-rendered page never flashes empty.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { Seo } from '../../seo/Seo';
import { AuthLayout } from './AuthLayout';
import styles from './AuthLayout.module.css';
import { GoogleMark } from './GoogleMark';

/**
 * Open-redirect guard for ?returnTo=. A sign-in page that forwards an untrusted
 * URL is a phishing primitive: a real-looking sign-in link that bounces the
 * victim to an attacker's site after a genuine sign-in. So the allow-list is
 * deliberately narrow - only console paths ("/app", "/app/...", "/app?...") are
 * honoured, which also rejects absolute and protocol-relative ("//host") URLs.
 * Anything else falls back to the console root.
 */
export function safeReturnTo(value: string | null): string {
  if (
    value &&
    // Dot-segments and backslashes are refused outright: "/app/../x" passes a
    // prefix check but URL-normalises to "/x", making the allow-list a fiction.
    !value.includes('..') &&
    !value.includes('\\') &&
    (value === '/app' || value.startsWith('/app/') || value.startsWith('/app?'))
  ) {
    return value;
  }
  return '/app';
}

/**
 * The route entry wraps the screen in its own AuthProvider: /login mounts
 * outside the console tree, so no provider exists above it. Mounting one here is
 * prerender-safe - the provider only touches Firebase from effects, which never
 * run in the build pass, so the emitted HTML is the (disabled) form.
 */
export function Component() {
  return (
    <AuthProvider>
      <LoginScreen />
    </AuthProvider>
  );
}

function LoginScreen() {
  const { status, signInWithEmail, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const destination = safeReturnTo(searchParams.get('returnTo'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in: straight to the console. noMembership proceeds too - the
  // console owns the holding screen that explains the missing membership
  // (story 1022); keeping such users here would strand them on a sign-in form
  // they have already passed.
  useEffect(() => {
    if (status === 'authenticated' || status === 'noMembership') {
      navigate(destination, { replace: true });
    }
  }, [status, destination, navigate]);

  // Disabled while the first token resolves so the user never types into a form
  // that is about to redirect out from under them.
  const disabled = submitting || status === 'initialising';

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await signInWithEmail(email, password);
      navigate(destination, { replace: true });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Something went wrong signing you in. Please try again.',
      );
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    if (disabled) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // A closed popup resolves silently (a cancellation, not an error), so
      // navigation is left to the status effect above, which only fires once a
      // session actually exists.
      await signInWithGoogle();
      setSubmitting(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Something went wrong signing you in. Please try again.',
      );
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <Seo
        title="Sign in"
        description="Sign in to the Safentia console."
        path="/login"
        noIndex
      />
      <div className={styles.stack}>
        <div>
          <h1 className={styles.title}>Sign in</h1>
        </div>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-email">
              Email address
            </label>
            <input
              id="login-email"
              className={styles.input}
              type="email"
              name="email"
              autoComplete="email"
              required
              disabled={disabled}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              className={styles.input}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              disabled={disabled}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <Button type="submit" block disabled={disabled}>
            {submitting ? 'Signing in...' : 'Sign in'}
          </Button>

          <Link to="/forgot-password" className={styles.inlineLink}>
            Forgot your password?
          </Link>
        </form>

        <div className={styles.divider} aria-hidden="true">
          or
        </div>

        <Button
          variant="secondary"
          block
          disabled={disabled}
          onClick={handleGoogle}
        >
          <GoogleMark />
          Continue with Google
        </Button>

        <p className={styles.switchPrompt}>
          New to Safentia?{' '}
          <Link to="/signup" className={styles.switchLink}>
            Create an account
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
