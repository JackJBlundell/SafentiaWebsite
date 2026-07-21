// ============================================================================
// InviteRoute - /invite, the web invitation-acceptance page.
//
// The invitation email's primary link lands here carrying the bearer token in
// the query string. The page NEVER validates the token client-side: the token
// is a bearer secret and /invitations is unreadable to clients by design, so
// the only judge of validity is the acceptInvitation callable itself. The page
// therefore shows the form to anyone holding a token-shaped link and lets the
// server answer - a non-enumerating posture (a probing visitor learns nothing
// they did not already hold).
//
// The server matches or creates the account by the INVITATION's email, never
// by whoever happens to be signed in here, so the copy states that plainly and
// a signed-in visitor gets a quiet note rather than a redirect.
//
// Pre-rendered like /login: Firebase is only touched from submit handlers, so
// the build pass emits the plain form.
// ============================================================================

import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { Seo } from '../../seo/Seo';
import { useCallable } from '../../console/ui/useCallable';
import { AuthLayout } from '../auth/AuthLayout';
import styles from '../auth/AuthLayout.module.css';
import type { AcceptInvitationInput, AcceptInvitationResult } from '../../types';

/**
 * Wrapped in its own AuthProvider for the same reason as LoginRoute: this route
 * mounts outside the console tree, and the provider is prerender-safe (Firebase
 * is only touched from effects, which never run in the build pass). Mounting it
 * lets the screen mention an existing session without ever depending on one.
 */
export function Component() {
  return (
    <AuthProvider>
      <InviteScreen />
    </AuthProvider>
  );
}

function InviteScreen() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const token = (searchParams.get('token') ?? '').trim();

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  const accept = useCallable<AcceptInvitationInput, AcceptInvitationResult>(
    'acceptInvitation',
  );

  const seo = (
    <Seo
      title="Accept your invitation"
      description="Accept your invitation to join your organisation on Safentia."
      path="/invite"
      noIndex
    />
  );

  // No token in the link: nothing to submit, so a calm dead end rather than a
  // form that can only fail.
  if (!token) {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            <h1 className={styles.title}>Accept your invitation</h1>
            <p className={styles.intro}>
              This invitation link is incomplete. Ask your administrator to send
              a new one.
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (accepted) {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            <h1 className={styles.title}>Your account is ready.</h1>
            <p className={styles.intro}>
              Sign in with the email address this invitation was sent to and the
              password you just chose.
            </p>
          </div>
          <Button to="/login" block>
            Sign in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  const disabled = accept.pending;
  // The client-side error (confirm mismatch) and the callable's calm copy share
  // one slot; whichever happened last is what the visitor needs to act on.
  const error = clientError ?? accept.error;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) {
      return;
    }
    setClientError(null);
    if (password !== confirm) {
      setClientError('Those passwords do not match. Check both and try again.');
      return;
    }
    const name = displayName.trim();
    const result = await accept.call({
      token,
      password,
      ...(name ? { displayName: name } : {}),
    });
    if (result) {
      setAccepted(true);
    }
  }

  return (
    <AuthLayout>
      {seo}
      <div className={styles.stack}>
        <div>
          <h1 className={styles.title}>Accept your invitation</h1>
          <p className={styles.intro}>
            Choose a password to create your account and join your organisation
            on Safentia. Your account uses the email address this invitation was
            sent to.
          </p>
          {user?.email && (
            // A quiet note, not a blocker: acceptance is keyed to the
            // invitation's own email, so an existing session here is simply
            // irrelevant, and saying so avoids the "am I joining as the wrong
            // person?" doubt.
            <p className={styles.intro}>
              You are currently signed in as {user.email}. Accepting creates or
              uses the account belonging to the invitation&apos;s own email
              address, not this session.
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
            {accept.error && !clientError && (
              <> If you need a fresh link, ask your administrator to send a new invitation.</>
            )}
          </p>
        )}

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="invite-name">
              Full name
            </label>
            <input
              id="invite-name"
              className={styles.input}
              type="text"
              name="name"
              autoComplete="name"
              required
              disabled={disabled}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="invite-password">
              Password
            </label>
            <input
              id="invite-password"
              className={styles.input}
              type="password"
              name="new-password"
              autoComplete="new-password"
              required
              disabled={disabled}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor="invite-confirm">
              Confirm password
            </label>
            <input
              id="invite-confirm"
              className={styles.input}
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              required
              disabled={disabled}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>

          <Button type="submit" block disabled={disabled}>
            {accept.pending ? 'Creating your account...' : 'Create your account and join'}
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
