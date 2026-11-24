// ============================================================================
// SignupRoute - /signup, self-serve account creation (Phase 3 front door).
//
// Full name + email + password, or Google. A new account is signed in at once
// and sent a confirmation email; the console's email-verification gate holds it
// until the link is opened, then the ordinary onboarding gates take over
// (org details -> plan -> payment -> setup). The marketing "Get started"
// buttons land here; "Sign in" stays on /login.
//
// Security posture:
//   - the password policy (src/auth/passwordStrength.ts) is enforced before
//     submit, with a live meter; Firebase Auth's own password policy is the
//     server-side backstop;
//   - App Check is bootstrapped by the AuthProvider, and Firebase rate-limits
//     account creation per IP;
//   - a hidden honeypot field silently drops naive form-filling bots;
//   - error copy comes pre-mapped (no raw Firebase codes on screen).
// ============================================================================

import React, { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '../../auth/AuthProvider';
import {
  PASSWORD_MAX_LENGTH,
  STRENGTH_LABELS,
  passwordProblems,
  passwordStrength,
} from '../../auth/passwordStrength';
import { Button } from '../../components/Button';
import { Seo } from '../../seo/Seo';
import { AuthLayout } from './AuthLayout';
import styles from './AuthLayout.module.css';
import { GoogleMark } from './GoogleMark';

const CONSOLE_PATH = '/app';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Prerender-safe for the same reason as /login: the provider only touches
 *  Firebase from effects, so the build pass emits the (disabled) form. */
export function Component() {
  return (
    <AuthProvider>
      <SignupScreen />
    </AuthProvider>
  );
}

function SignupScreen() {
  const { status, signUpWithEmail, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const strengthId = useId();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Honeypot: invisible to people and assistive tech, filled by naive bots.
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in (including a brand-new account): into the console, whose
  // gates decide between verification, onboarding and the dashboard.
  useEffect(() => {
    if (status === 'authenticated' || status === 'noMembership') {
      navigate(CONSOLE_PATH, { replace: true });
    }
  }, [status, navigate]);

  const disabled = submitting || status === 'initialising';
  const context = useMemo(() => ({ email, name }), [email, name]);
  const problems = useMemo(
    () => passwordProblems(password, context),
    [password, context],
  );
  const strength = passwordStrength(password, context);

  function validate(): string | null {
    if (name.trim().length < 2) {
      return 'Enter your full name.';
    }
    if (!EMAIL_PATTERN.test(email.trim())) {
      return 'Enter a valid email address.';
    }
    if (problems.length > 0) {
      return `Choose a stronger password. ${problems[0]}`;
    }
    if (password !== confirm) {
      return 'Those passwords do not match. Check both and try again.';
    }
    return null;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) {
      return;
    }
    setAttempted(true);
    setError(null);
    if (website) {
      // A bot filled the honeypot. Look busy, create nothing.
      setSubmitting(true);
      return;
    }
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setSubmitting(true);
    try {
      await signUpWithEmail(name, email, password);
      navigate(CONSOLE_PATH, { replace: true });
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Something went wrong creating your account. Please try again.',
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
      // Cancellation resolves silently; the status effect navigates once a
      // session exists.
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
        title="Create your account"
        description="Create a Safentia account and get started."
        path="/signup"
        noIndex
      />
      <div className={styles.stack}>
        <div>
          <h1 className={styles.title}>Create your account</h1>
          <p className={styles.intro}>
            Set up your Safentia account. We will email you a link to confirm
            your address.
          </p>
        </div>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="signup-name">
              Full name
            </label>
            <input
              id="signup-name"
              className={styles.input}
              type="text"
              name="name"
              autoComplete="name"
              maxLength={100}
              required
              disabled={disabled}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="signup-email">
              Email address
            </label>
            <input
              id="signup-email"
              className={styles.input}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              required
              disabled={disabled}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label className={styles.label} htmlFor="signup-password">
                Password
              </label>
              <button
                type="button"
                className={styles.revealToggle}
                onClick={() => setShowPassword((shown) => !shown)}
                aria-controls="signup-password signup-confirm"
                aria-pressed={showPassword}
                disabled={disabled}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <input
              id="signup-password"
              className={styles.input}
              type={showPassword ? 'text' : 'password'}
              name="new-password"
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              required
              disabled={disabled}
              aria-describedby={strengthId}
              aria-invalid={attempted && problems.length > 0}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <div id={strengthId} className={styles.strength}>
              <div
                className={styles.strengthBar}
                data-level={password ? strength : undefined}
                aria-hidden="true"
              >
                {[1, 2, 3, 4].map((segment) => (
                  <span
                    key={segment}
                    className={styles.strengthSegment}
                    data-on={password && strength >= segment ? '' : undefined}
                  />
                ))}
              </div>
              <p className={styles.strengthLabel} aria-live="polite">
                {password
                  ? `Password strength: ${STRENGTH_LABELS[strength]}`
                  : 'At least 10 characters, mixing letters with numbers or symbols.'}
              </p>
              {password && problems.length > 0 && (
                <ul className={styles.strengthHints}>
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="signup-confirm">
              Confirm password
            </label>
            <input
              id="signup-confirm"
              className={styles.input}
              type={showPassword ? 'text' : 'password'}
              name="confirm-password"
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              required
              disabled={disabled}
              aria-invalid={attempted && confirm !== password}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>

          <div className={styles.honeypot} aria-hidden="true">
            <label htmlFor="signup-website">Website</label>
            <input
              id="signup-website"
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </div>

          <Button type="submit" block disabled={disabled}>
            {submitting ? 'Creating your account...' : 'Create account'}
          </Button>

          <p className={styles.fineprint}>
            By creating an account you agree to our{' '}
            <Link to="/legal/terms">Terms</Link> and{' '}
            <Link to="/legal/privacy">Privacy notice</Link>.
          </p>
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
          Already have an account?{' '}
          <Link to="/login" className={styles.switchLink}>
            Sign in
          </Link>
        </p>
      </div>
    </AuthLayout>
  );
}
