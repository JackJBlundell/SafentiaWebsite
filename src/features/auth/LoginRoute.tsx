// ============================================================================
// LoginRoute - /login, the console's front door (stories 1016/1017, brief 4.1).
//
// Email/password plus Google, mirroring the app's sign-in screen. There is NO
// sign-up path on the web: users arrive by invitation, so offering registration
// here would only manufacture accounts with no membership.
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
          {/* The G mark drawn in currentColor: no external asset, no request,
              and it follows the theme like every other glyph on the site. */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="currentColor"
              d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.4zM12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22zM6.4 14a6 6 0 0 1 0-4V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14zM12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4 5.6-4z"
            />
          </svg>
          Continue with Google
        </Button>
      </div>
    </AuthLayout>
  );
}
