// ============================================================================
// ForgotPasswordRoute - /forgot-password (story 1020, brief 4.1).
//
// The one rule that shapes this screen: NON-ENUMERATING. Whatever address is
// entered, the outcome reads identically, so nobody can use this form to probe
// which emails hold an account (the provider already swallows user-not-found).
// Only a genuine transport failure - where no email could have been sent to
// anyone - shows an error, because that state is retryable and reveals nothing.
// ============================================================================

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthProvider, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { Seo } from '../../seo/Seo';
import { AuthLayout } from './AuthLayout';
import styles from './AuthLayout.module.css';

/**
 * Wrapped in its own AuthProvider for the same reason as LoginRoute: this route
 * mounts outside the console tree, and the provider is prerender-safe (Firebase
 * is only touched from effects, which never run in the build pass).
 */
export function Component() {
  return (
    <AuthProvider>
      <ForgotPasswordScreen />
    </AuthProvider>
  );
}

function ForgotPasswordScreen() {
  const { sendReset } = useAuth();

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await sendReset(email);
      setSent(true);
    } catch (caught) {
      // A transport failure only: nothing account-specific ever reaches here.
      // The form stays populated so retrying is one press.
      setError(
        caught instanceof Error
          ? caught.message
          : 'The reset email could not be sent. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <Seo
        title="Reset your password"
        description="Request a password reset email for your Safentia account."
        path="/forgot-password"
        noIndex
      />
      <div className={styles.stack}>
        <div>
          <h1 className={styles.title}>Reset your password</h1>
          <p className={styles.intro}>
            Enter the email address you sign in with and we will send you a link
            to choose a new password.
          </p>
        </div>

        {sent ? (
          // The same confirmation regardless of whether the account exists.
          <p role="status" className={styles.confirmation}>
            If an account exists for that address, a reset email is on its way.
          </p>
        ) : (
          <>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}

            <form className={styles.form} onSubmit={handleSubmit} noValidate>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="reset-email">
                  Email address
                </label>
                <input
                  id="reset-email"
                  className={styles.input}
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  disabled={submitting}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <Button type="submit" block disabled={submitting}>
                {submitting ? 'Sending...' : 'Send reset email'}
              </Button>
            </form>
          </>
        )}

        <Link to="/login" className={styles.inlineLink}>
          Back to sign in
        </Link>
      </div>
    </AuthLayout>
  );
}
