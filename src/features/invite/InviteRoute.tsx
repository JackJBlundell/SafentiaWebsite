// ============================================================================
// InviteRoute - /invite, the web invitation-acceptance page.
//
// The invitation email's primary link lands here carrying the bearer token in
// the query string. The page still NEVER judges the token itself: /invitations
// is unreadable to clients by design, so both the preview and the acceptance
// are server decisions. On mount it calls previewInvitation, which answers the
// three questions the screen cannot answer alone - which address was invited,
// which organisation is inviting, and whether an account for that address
// already exists - and reports a dead invitation up front so the visitor is
// never asked to fill in a form that could not have succeeded.
//
// From there exactly one of four things is asked of the visitor:
//   - no account yet          -> choose a password; we sign them in with the
//                                custom token acceptInvitation mints, so they
//                                never retype what they just chose;
//   - account already exists  -> sign in as it FIRST (the server requires it:
//                                a token holder must not be able to bind
//                                someone else's account), then accept;
//   - already signed in as it -> one confirmation;
//   - signed in as someone else -> sign out and continue.
//
// Pre-render safe: Firebase is touched only from effects and handlers, neither
// of which runs in the build pass, so the emitted HTML is the loading state.
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AuthProvider, useAuth } from '../../auth/AuthProvider';
import { activateSpace } from '../../auth/activateSpace';
import { forgetSpaceChoice, rememberSpaceChoice } from '../../auth/spaceChoice';
import { Button } from '../../components/Button';
import { Seo } from '../../seo/Seo';
import { useCallable } from '../../console/ui/useCallable';
import { AuthLayout } from '../auth/AuthLayout';
import styles from '../auth/AuthLayout.module.css';
import {
  INVITE_FAILURE_REASONS,
  type AcceptInvitationInput,
  type AcceptInvitationResult,
  type InviteFailureReason,
  type PreviewInvitationInput,
  type PreviewInvitationResult,
} from '../../types';

/** Where a successful acceptance lands. The console owns everything after this
 *  point, including the holding screen for a membership that has not yet
 *  reached the session's claims. */
const CONSOLE_PATH = '/app';

/**
 * Read the refusal reason the invitation callables attach to their
 * failed-precondition errors. Every refusal shares one transport code, so
 * without this the page can only show one raw message on the first screen a new
 * customer ever sees.
 */
function inviteFailureReason(
  details: Record<string, unknown> | null,
): InviteFailureReason | null {
  const reason = details?.['reason'];
  return typeof reason === 'string' &&
    (INVITE_FAILURE_REASONS as readonly string[]).includes(reason)
    ? (reason as InviteFailureReason)
    : null;
}

/**
 * Wrapped in its own AuthProvider for the same reason as LoginRoute: this route
 * mounts outside the console tree. The provider is prerender-safe (it touches
 * Firebase only from effects, which never run in the build pass), and here it
 * does real work rather than decoration: the sign-in branches need it, and so
 * does signing a brand-new member in with their custom token.
 */
export function Component() {
  return (
    <AuthProvider>
      <InviteScreen />
    </AuthProvider>
  );
}

/** Which question the screen is currently putting to the visitor. */
type Branch =
  | 'loading'
  | 'no-token'
  | 'used'
  | 'expired'
  | 'unavailable'
  | 'sign-up'
  | 'sign-in'
  | 'confirm'
  | 'wrong-account'
  | 'busy'
  | 'signed-in-elsewhere';

function InviteScreen() {
  const {
    status,
    user,
    signInWithEmail,
    signInWithGoogle,
    signInWithCustomToken,
    refreshSession,
    signOut,
  } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = (searchParams.get('token') ?? '').trim();

  const [preview, setPreview] = useState<PreviewInvitationResult | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set only when acceptance succeeded but the automatic sign-in did not, which
  // is the one case left where the visitor has to visit /login themselves.
  const [joinedWithoutSession, setJoinedWithoutSession] = useState(false);

  const previewCall = useCallable<PreviewInvitationInput, PreviewInvitationResult>(
    'previewInvitation',
  );
  const accept = useCallable<AcceptInvitationInput, AcceptInvitationResult>(
    'acceptInvitation',
  );
  const loadPreview = previewCall.call;

  // Resolve the invitation once per mount. The ref guard is what makes "once"
  // true under React's development double-invocation of effects; useCallable
  // would drop the duplicate anyway, but then the retained result would depend
  // on which call won.
  const requested = useRef(false);
  useEffect(() => {
    if (!token || requested.current) {
      return;
    }
    requested.current = true;
    void loadPreview({ token }).then((result) => {
      if (result) {
        setPreview(result);
      }
    });
  }, [token, loadPreview]);

  const previewReason = inviteFailureReason(previewCall.failure?.details ?? null);
  const acceptReason = inviteFailureReason(accept.failure?.details ?? null);
  const deadReason = previewReason ?? acceptReason;
  // The invited address matches the session, so this visitor is already the
  // person the invitation names.
  const sessionMatches = Boolean(
    preview && user?.email && user.email.toLowerCase() === preview.email.toLowerCase(),
  );

  let branch: Branch;
  if (!token) {
    branch = 'no-token';
  } else if (joinedWithoutSession) {
    branch = 'signed-in-elsewhere';
  } else if (submitting) {
    branch = 'busy';
  } else if (deadReason === 'used') {
    branch = 'used';
  } else if (deadReason === 'expired') {
    branch = 'expired';
  } else if (previewCall.failure && !preview) {
    // The preview was refused for a reason with no dedicated screen (an unknown
    // token, a removed contact, a portal clash). Nothing on this page can fix
    // any of them, so they share one honest dead end.
    branch = 'unavailable';
  } else if (!preview || status === 'initialising') {
    branch = 'loading';
  } else if (sessionMatches) {
    branch = 'confirm';
  } else if (user) {
    branch = 'wrong-account';
  } else if (preview.accountExists || acceptReason === 'sign-in-required') {
    // The server refusing with sign-in-required means an account exists that
    // the preview did not see (it was created between the two calls), so the
    // screen corrects itself to the sign-in branch rather than leaving the
    // visitor on a sign-up form that will keep failing.
    branch = 'sign-in';
  } else {
    branch = 'sign-up';
  }

  // Move focus to the heading whenever the question changes, so a keyboard or
  // screen-reader user is told what is now being asked instead of being left
  // wherever the previous branch's controls used to be.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const initialBranch = useRef(true);
  useEffect(() => {
    if (initialBranch.current) {
      // The first paint has not moved anyone; stealing focus on load would jump
      // the page out from under the visitor for no reason.
      initialBranch.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [branch]);

  const seo = (
    <Seo
      title="Accept your invitation"
      description="Accept your invitation to join your organisation on Safentia."
      path="/invite"
      noIndex
    />
  );

  /** The heading every screen shares, focusable so branch changes can announce. */
  const heading = (text: string) => (
    <h1 className={styles.title} ref={headingRef} tabIndex={-1}>
      {text}
    </h1>
  );

  /** What the visitor is joining, named the way they will recognise it: their
   *  own organisation for a portal invite, the assessing org otherwise. */
  const joining = preview?.customerName ?? preview?.orgName ?? 'your organisation';

  /**
   * Who sent the invitation, shown only on a portal invite.
   *
   * A customer contact receives this out of the blue: an email asking them to
   * create an account somewhere they have never heard of, naming only their OWN
   * company. That reads like phishing, and a cautious contact is right to
   * hesitate. Naming the assessing organisation is the piece of context that
   * makes the request legible, so it belongs on the screen and not just in the
   * email they may no longer be looking at. Staff invites do not need it: for
   * them `joining` is already the inviting organisation.
   */
  const invitedBy =
    preview?.customerName && preview.orgName ? (
      <p className={styles.intro}>
        <strong>{preview.orgName}</strong> carries out fire risk assessments for{' '}
        {preview.customerName} and has invited you to see the results.
      </p>
    ) : null;

  /**
   * Finish an acceptance: sign the new account in with the token the server
   * minted for it, then make the space it just joined the ACTIVE one, then hand
   * over to the console. An account that already existed had to be signed in to
   * get here, so it only does the last two steps.
   *
   * The activation is the whole point of this function for an existing account.
   * Claims hold exactly one space, and accepting does not change them: without
   * this, somebody who accepts an invitation while signed in elsewhere is
   * returned to their PREVIOUS space and the acceptance looks as though it did
   * nothing at all.
   */
  const completeJoin = useCallback(
    async (result: AcceptInvitationResult) => {
      if (result.customToken) {
        try {
          await signInWithCustomToken(result.customToken);
        } catch {
          // The membership exists either way, so this is not a failed join -
          // only a failed convenience. Send them to sign in normally rather
          // than implying anything went wrong with the invitation.
          setJoinedWithoutSession(true);
          return;
        }
      }
      try {
        await activateSpace(result.orgId, result.customerId);
        await refreshSession();
        // They have just said where they want to be, so the console must not
        // stop to ask again on arrival.
        rememberSpaceChoice(result.uid);
      } catch {
        // The membership landed; only the switch did not. Clearing the recorded
        // choice degrades to the space picker, which states the situation and
        // lets them enter the space themselves - far better than silently
        // dropping them back where they started and implying the join failed.
        forgetSpaceChoice(result.uid);
      }
      navigate(CONSOLE_PATH, { replace: true });
    },
    [navigate, refreshSession, signInWithCustomToken],
  );

  async function handleCreateAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setClientError(null);
    if (password !== confirm) {
      setClientError('Those passwords do not match. Check both and try again.');
      return;
    }
    setSubmitting(true);
    const name = displayName.trim();
    const result = await accept.call({
      token,
      password,
      ...(name ? { displayName: name } : {}),
    });
    if (result) {
      await completeJoin(result);
      return;
    }
    setSubmitting(false);
  }

  async function handleSignInAndAccept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !preview) {
      return;
    }
    setClientError(null);
    setSubmitting(true);
    try {
      // Sign in FIRST: acceptInvitation refuses an existing account unless the
      // caller's own session proves it is that account.
      await signInWithEmail(preview.email, password);
    } catch (caught) {
      setClientError(
        caught instanceof Error
          ? caught.message
          : 'Something went wrong signing you in. Please try again.',
      );
      setSubmitting(false);
      return;
    }
    const result = await accept.call({ token });
    if (result) {
      await completeJoin(result);
      return;
    }
    setSubmitting(false);
  }

  async function handleGoogle() {
    if (submitting) {
      return;
    }
    setClientError(null);
    setSubmitting(true);
    try {
      // Deliberately NOT chained into an acceptance: a closed popup resolves
      // silently, so there is no session to accept with and no error to report.
      // Signing in flips the screen to the confirmation branch, where the
      // visitor presses Accept once - honest, and never a silent no-op.
      await signInWithGoogle();
    } catch (caught) {
      setClientError(
        caught instanceof Error
          ? caught.message
          : 'Something went wrong signing you in. Please try again.',
      );
    }
    setSubmitting(false);
  }

  async function handleConfirm() {
    if (submitting) {
      return;
    }
    setClientError(null);
    setSubmitting(true);
    const result = await accept.call({ token });
    if (result) {
      await completeJoin(result);
      return;
    }
    setSubmitting(false);
  }

  async function handleSignOut() {
    if (submitting) {
      return;
    }
    setClientError(null);
    await signOut();
  }

  // The client-side error and the callables' calm copy share one slot; whichever
  // happened last is what the visitor needs to act on. Only the two refusals
  // that have their OWN screen are excluded, so a dead end never also shows an
  // inline alert while every other refusal still says something.
  const hasOwnScreen = acceptReason === 'used' || acceptReason === 'expired';
  const inlineError = clientError ?? (hasOwnScreen ? null : accept.error);
  const errorBlock = inlineError && (
    <p role="alert" className={styles.error}>
      {inlineError}
      {!clientError && (
        <> If you need a fresh link, ask your administrator to send a new invitation.</>
      )}
    </p>
  );

  /** The invited address, shown read-only: acceptance is keyed to it and no
   *  form on this page can change which address was invited. */
  const emailField = preview && (
    <div className={styles.field}>
      <label className={styles.label} htmlFor="invite-email">
        Email address
      </label>
      <input
        id="invite-email"
        className={styles.input}
        type="email"
        name="email"
        autoComplete="username"
        readOnly
        value={preview.email}
      />
    </div>
  );

  if (branch === 'no-token') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('Accept your invitation')}
            <p className={styles.intro}>
              This invitation link is incomplete. Ask your administrator to send
              a new one.
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (branch === 'loading') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('Accept your invitation')}
            <p className={styles.intro} role="status">
              Checking your invitation...
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (branch === 'busy') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('Setting things up')}
            <p className={styles.intro} role="status">
              One moment while we add you to {joining}.
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (branch === 'signed-in-elsewhere') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('You are in.')}
            <p className={styles.intro}>
              Your account is set up and you have joined {joining}. Sign in with{' '}
              {preview?.email} to get started.
            </p>
          </div>
          <Button to="/login" block>
            Sign in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  // A dead invitation is not a form error - resubmitting can never fix it - so
  // it replaces the form with the one thing the visitor can actually do next.
  if (branch === 'used') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('This invitation has already been used.')}
            <p className={styles.intro}>
              An account already exists for the email address this invitation was
              sent to. Sign in with it instead. If you have forgotten your
              password, you can reset it from the sign-in page.
            </p>
          </div>
          <Button to="/login" block>
            Sign in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (branch === 'expired') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('This invitation has expired.')}
            <p className={styles.intro}>
              Invitations are only valid for a short time. Ask your administrator
              to send you a new one, and it will bring you straight back here.
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (branch === 'unavailable') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('This invitation is not available.')}
            <p className={styles.intro}>
              {previewCall.error} Ask your administrator to send you a new
              invitation, and it will bring you straight back here.
            </p>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (branch === 'wrong-account') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('You are signed in as someone else.')}
            <p className={styles.intro}>
              This invitation was sent to {preview?.email}, but you are signed in
              as {user?.email}. Sign out and we will bring you straight back
              here to accept it.
            </p>
          </div>
          {errorBlock}
          <Button block onClick={handleSignOut}>
            Sign out and continue
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (branch === 'confirm') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('Accept your invitation')}
            <p className={styles.intro}>
              You are signed in as {preview?.email}. Accept to join {joining} on
              Safentia.
            </p>
            {invitedBy}
          </div>
          {errorBlock}
          <Button block onClick={handleConfirm}>
            Accept invitation
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (branch === 'sign-in') {
    return (
      <AuthLayout>
        {seo}
        <div className={styles.stack}>
          <div>
            {heading('Sign in to accept')}
            <p className={styles.intro}>
              You already have a Safentia account for this address. Sign in with
              your existing password and we will add you to {joining}.
            </p>
            {invitedBy}
          </div>

          {errorBlock}

          <form className={styles.form} onSubmit={handleSignInAndAccept} noValidate>
            {emailField}

            <div className={styles.field}>
              <label className={styles.label} htmlFor="invite-current-password">
                Password
              </label>
              <input
                id="invite-current-password"
                className={styles.input}
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            <Button type="submit" block>
              Sign in and accept
            </Button>
          </form>

          <div className={styles.divider} aria-hidden="true">
            or
          </div>

          <Button variant="secondary" block onClick={handleGoogle}>
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

  return (
    <AuthLayout>
      {seo}
      <div className={styles.stack}>
        <div>
          {heading('Create your account')}
          <p className={styles.intro}>
            Choose a password to create your account and join {joining} on
            Safentia. Your account uses the address this invitation was sent to,
            shown below.
          </p>
          {invitedBy}
        </div>

        {errorBlock}

        <form className={styles.form} onSubmit={handleCreateAccount} noValidate>
          {emailField}

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
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>

          <Button type="submit" block>
            Create your account and join
          </Button>
        </form>
      </div>
    </AuthLayout>
  );
}
