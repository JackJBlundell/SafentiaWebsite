// ============================================================================
// AuthProvider - the single source of session truth for the web console; the
// web twin of FireRite/src/auth/AuthProvider.tsx (stories 1016/1017/1020/1022/
// 1030, brief 4.1).
//
// Responsibilities:
//   - email/password and Google sign-in, password reset, sign-out;
//   - persist the session across reloads (Firebase persists the user; we
//     re-resolve claims on every token change so a mid-session claim change or
//     a `locked`/`archived` account takes effect on the next refresh);
//   - resolve { orgId, roles, environment } from custom claims and expose the
//     env-bound path builders, so no screen ever picks the data root itself;
//   - on sign-out, clear the query cache so a shared machine never shows the
//     next user stale data.
//
// It deliberately exposes a single discriminated `status` so the router can
// route with NO flash of the wrong UI (story 1022): until we have resolved the
// first token, status is 'initialising' and the shell shows a splash.
//
// Differences from the app version, all deliberate:
//   - the Web SDK's popup flow replaces the native Google Sign-In module;
//   - no sign-up: web users arrive by invitation, never self-service;
//   - no FCM token registration (web push is not part of this brief);
//   - no Crashlytics/analytics pipeline - failures that the app reported are
//     logged with console.error under a short prefix instead.
// ============================================================================

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  getIdTokenResult,
  onIdTokenChanged,
  reauthenticateWithCredential,
  reload,
  sendPasswordResetEmail,
  signInWithCustomToken as fbSignInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  updatePassword as fbUpdatePassword,
  updateProfile,
  type User,
} from 'firebase/auth';
import { onValue, ref } from 'firebase/database';
import { firebase, startFirebase } from '../firebase';
import { AppCheckNotice } from '../components/AppCheckNotice';
import { forEnv } from '../paths';
import type { EnvPaths } from '../paths';
import { queryClient } from '../query/queryClient';
import { resetRtdbSubscriptions } from '../query/useRtdbQuery';
import { authErrorMessage } from './errors';
import { resolveClaims, type SessionClaims } from './claims';
import { forgetSpaceChoice } from './spaceChoice';

/** The mutually-exclusive states the console can be in. The router switches on
 *  this, so the set is exhaustive by design (no implicit "unknown" gap). */
export type AuthStatus =
  | 'initialising' // first token not yet resolved - show splash, never a screen
  | 'signedOut' // no user - show the sign-in screen
  | 'noMembership' // signed in but no org claim yet - holding screen (story 1022)
  | 'authenticated'; // signed in with a resolved org membership

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Whether Firebase records this account's email address as verified. Held as
   *  STATE rather than read off `user`, because `reload()` mutates the User
   *  object in place: a component reading `user.emailVerified` would never
   *  re-render when the flag changes under it. False whenever signed out. */
  emailVerified: boolean;
  claims: SessionClaims | null;
  /** Env-bound path builders for the active session. Present iff authenticated. */
  paths: EnvPaths | null;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  /** Exchange a server-minted custom token for a session. Used by /invite: the
   *  accept callable mints one for the account it just created, so a new member
   *  lands inside the console without retyping the password they just chose. */
  signInWithCustomToken: (token: string) => Promise<void>;
  sendReset: (email: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateDisplayName: (name: string) => Promise<void>;
  /** Force an ID-token refresh so a server-side claims change (e.g. switching the
   *  active organisation) takes effect immediately, re-scoping the session.
   *
   *  Resolves with the claims the refreshed token ACTUALLY carries, so a caller
   *  that asked for a specific outcome can check it got one. That matters for
   *  the space switch: `setActiveOrganisation` answering 200 and this refresh
   *  resolving are both true of a switch that silently did not land (the re-mint
   *  had not reached the token we fetched), and nothing throws on that path.
   *  Null means no session or no membership - including the two early exits,
   *  where there is no user left to resolve claims for. Callers with nothing to
   *  verify (the invite flow, the staleness watcher) may ignore it. */
  refreshSession: () => Promise<SessionClaims | null>;
  /** Re-read the account record from Firebase and republish `emailVerified`.
   *  The client's copy is a snapshot taken at sign-in, so an operator setting
   *  the flag server-side is invisible until this runs - without it a user
   *  whose account was just repaired would stay locked out until they signed
   *  out. Resolves with the freshly-read value. */
  refreshEmailVerification: () => Promise<boolean>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('initialising');
  const [user, setUser] = useState<User | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [claims, setClaims] = useState<SessionClaims | null>(null);

  // Bootstrap Firebase (App Check) exactly once, before the token listener
  // below attaches (effects run in declaration order). A failure here is loud
  // but must not block the auth listener: an unattested call still fails closed
  // at the rules layer.
  useEffect(() => {
    try {
      startFirebase();
    } catch (error) {
      console.error('[Safentia auth] startFirebase', error);
    }
  }, []);

  // The heart of session handling: onIdTokenChanged fires on sign-in, sign-out,
  // token refresh AND claim changes (the Function refreshes the token after
  // writing claims). We re-resolve claims every time, so a locked/archived
  // account or a role change applies on the next refresh without a manual login.
  useEffect(() => {
    const unsubscribe = onIdTokenChanged(firebase.auth(), async (nextUser) => {
      if (!nextUser) {
        setUser(null);
        setEmailVerified(false);
        setClaims(null);
        setStatus('signedOut');
        return;
      }
      try {
        // forceRefresh false: the listener already fires with the freshest
        // token, so we read claims as-is and avoid an extra round trip.
        const result = await getIdTokenResult(nextUser);
        // Ordering guard: getIdTokenResult is async, and a sign-out can be
        // fully processed while it is in flight. Without this check the stale
        // continuation would run AFTER the sign-out handler and resurrect an
        // "authenticated" session on a machine the user believes they signed
        // out of - a security failure on shared devices, not a cosmetic race.
        if (firebase.auth().currentUser !== nextUser) {
          return;
        }
        const resolved = resolveClaims(result);
        setUser(nextUser);
        setEmailVerified(nextUser.emailVerified);
        setClaims(resolved);
        setStatus(resolved ? 'authenticated' : 'noMembership');
      } catch (error) {
        // Failing to resolve claims (e.g. offline at first load) must not
        // strand the user on a blank screen; treat as no-membership so the
        // holding screen explains the situation rather than crashing.
        console.error('[Safentia auth] resolveClaims', error);
        if (firebase.auth().currentUser !== nextUser) {
          return;
        }
        setUser(nextUser);
        setEmailVerified(nextUser.emailVerified);
        setClaims(null);
        setStatus('noMembership');
      }
    });
    return unsubscribe;
  }, []);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      try {
        await signInWithEmailAndPassword(firebase.auth(), email.trim(), password);
        // The token listener does the rest (claims, routing).
      } catch (error) {
        // Re-throw mapped, non-enumerating copy for the screen to display.
        throw new Error(authErrorMessage(error));
      }
    },
    [],
  );

  const signInWithGoogle = useCallback(async () => {
    try {
      // The popup flow replaces the app's native Google Sign-In: no client ID to
      // configure here, the SDK uses the authDomain. Redirect flows lose state on
      // some browsers' storage partitioning, so popup is the deliberate choice.
      await signInWithPopup(firebase.auth(), new GoogleAuthProvider());
    } catch (error) {
      const code =
        typeof error === 'object' && error && 'code' in error
          ? (error as { code: string }).code
          : '';
      // Closing the popup is a cancellation, not an error - mirror the app,
      // which returns silently when the user backs out of the account picker.
      if (
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request'
      ) {
        return;
      }
      throw new Error(authErrorMessage(error));
    }
  }, []);

  const signInWithCustomToken = useCallback(async (token: string) => {
    try {
      await fbSignInWithCustomToken(firebase.auth(), token);
      // As with the other sign-in methods, the token listener does the rest
      // (claims, routing); nothing is set here that it would have to undo.
    } catch (error) {
      // A custom token is minted seconds before use, so a rejection here is
      // effectively always transport or an expired mint. Map it like every
      // other auth failure so no raw Firebase code reaches the screen.
      throw new Error(authErrorMessage(error));
    }
  }, []);

  const sendReset = useCallback(async (email: string) => {
    // We never reveal whether the email exists; the screen shows a generic
    // confirmation regardless (story 1020). We still surface true transport
    // failures (e.g. no network) so the user knows to retry.
    try {
      await sendPasswordResetEmail(firebase.auth(), email.trim());
    } catch (error) {
      const code =
        typeof error === 'object' && error && 'code' in error
          ? (error as { code: string }).code
          : '';
      // user-not-found must look identical to success (non-enumerating), so we
      // swallow only that case and re-throw genuine failures.
      if (code === 'auth/user-not-found') {
        return;
      }
      throw new Error(authErrorMessage(error));
    }
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      const current = firebase.auth().currentUser;
      if (!current || !current.email) {
        throw new Error('You need to be signed in to change your password.');
      }
      try {
        // Re-authenticate with the CURRENT password first (story 1030 AC1) so an
        // unattended signed-in machine cannot silently change the password.
        const credential = EmailAuthProvider.credential(
          current.email,
          currentPassword,
        );
        await reauthenticateWithCredential(current, credential);
        await fbUpdatePassword(current, newPassword);
      } catch (error) {
        throw new Error(authErrorMessage(error));
      }
    },
    [],
  );

  const updateDisplayName = useCallback(async (name: string) => {
    const current = firebase.auth().currentUser;
    if (!current) {
      throw new Error('You need to be signed in to update your profile.');
    }
    await updateProfile(current, { displayName: name.trim() });
    // Reflect the change locally without waiting for a token event.
    setUser(firebase.auth().currentUser);
  }, []);

  const signOut = useCallback(async () => {
    // Drop the recorded space choice BEFORE the session ends, while we still
    // know whose it was. sessionStorage outlives a sign-out within the same tab,
    // so without this, signing out and back in on one tab skips the picker and
    // drops the person straight into whichever space they last chose - which
    // reads as the picker being unreliable, because it only ever appeared once.
    // Signing in is exactly when someone expects to be asked where they are
    // going, so the record must not survive the session that created it.
    const current = firebase.auth().currentUser;
    if (current) {
      forgetSpaceChoice(current.uid);
    }
    await fbSignOut(firebase.auth());
    // The query cache is NOT cleared here. At this moment the console is still
    // mounted with its RTDB listeners attached; a snapshot landing between a
    // clear() and React unmounting those listeners would re-insert the previous
    // user's data into the module-level cache, where it would sit (staleTime
    // Infinity) for the next user of a shared machine. The clear runs from the
    // status effect below, AFTER the signedOut transition has unmounted every
    // listener.
  }, []);

  // The shared-machine guarantee (story 1030): once the session ends, nothing of
  // it survives in the query cache. Clearing on the signedOut TRANSITION - an
  // effect, after React has committed the unmount of the console tree and every
  // RTDB listener's cleanup has run - closes the window where a late snapshot
  // from a still-attached listener could repopulate a cache that was cleared
  // too early.
  const previousStatus = useRef<AuthStatus>('initialising');
  useEffect(() => {
    const wasSession =
      previousStatus.current === 'authenticated' ||
      previousStatus.current === 'noMembership';
    if (status === 'signedOut' && wasSession) {
      queryClient.clear();
    }
    previousStatus.current = status;
  }, [status]);

  // The same discipline for switching space: every cached entry was read under
  // the OLD space's claims and paths, none of it is valid in the new one. The
  // clear keys off the SPACE transition so it runs in this ancestor's effect,
  // after the console subtree's listener effects (children run first) have
  // detached from the old space's paths. Clear, not invalidate: invalidation
  // would refetch keys no screen should own any more.
  //
  // The identity is the org AND the customer, not the org alone: moving between
  // an organisation's staff console and one of its own customer portals keeps
  // the same orgId while changing what the session is allowed to see, and a
  // cache surviving that crossing would show staff-scoped data inside the
  // customer's portal.
  const previousSpace = useRef<string | null>(null);
  useEffect(() => {
    const nextSpace = claims
      ? `${claims.orgId}:${claims.customerId ?? ''}`
      : null;
    if (previousSpace.current && nextSpace && previousSpace.current !== nextSpace) {
      queryClient.clear();
      // Must FOLLOW the clear, never precede it: it is what re-attaches the
      // listeners whose data the clear just removed. Without it the console sat
      // on its loading state indefinitely after a switch - see the space-change
      // reset in query/useRtdbQuery.
      resetRtdbSubscriptions();
    }
    previousSpace.current = nextSpace;
  }, [claims]);

  const paths = useMemo<EnvPaths | null>(
    () => (claims ? forEnv(claims.environment) : null),
    [claims],
  );

  const refreshSession = useCallback(async (): Promise<SessionClaims | null> => {
    const current = firebase.auth().currentUser;
    if (!current) {
      return null;
    }
    // Force a fresh token so a just-written claims change applies now rather than
    // on the next hourly refresh. onIdTokenChanged also fires and re-runs the full
    // resolve; we resolve here too so callers can await the new claims being in
    // effect.
    const result = await getIdTokenResult(current, true);
    // Same ordering guard as the token listener: if the user signed out while
    // the forced refresh was in flight (org switch racing a sign-out), setting
    // "authenticated" here would resurrect the dead session.
    if (firebase.auth().currentUser !== current) {
      return null;
    }
    const resolved = resolveClaims(result);
    setUser(current);
    setEmailVerified(current.emailVerified);
    setClaims(resolved);
    setStatus(resolved ? 'authenticated' : 'noMembership');
    // Returned as well as published: the state update is asynchronous, so a
    // caller awaiting this call cannot read the new claims off the context it
    // was rendered with. Handing back the resolved value is the only way a
    // switch can check, in the same breath, that it actually happened.
    return resolved;
  }, []);

  const refreshEmailVerification = useCallback(async () => {
    const current = firebase.auth().currentUser;
    if (!current) {
      return false;
    }
    await reload(current);
    // Same ordering guard as the token listener: a sign-out completing while
    // the reload was in flight must not republish the dead session's flag.
    if (firebase.auth().currentUser !== current) {
      return false;
    }
    setEmailVerified(current.emailVerified);
    return current.emailVerified;
  }, []);

  // Claims-staleness watcher: writeClaims (functions/src/lib/claims.ts) stamps
  // `metadata/{uid}/refreshAt` after every claims write, so a demotion, lock or
  // role change is signalled the moment it happens. Watching that marker and
  // forcing a token refresh makes the change take effect within seconds instead
  // of on the next hourly token rotation. Two deliberate choices:
  //   - a PLAIN SDK onValue, not the useRtdbQuery bridge: this provider mounts
  //     ABOVE the QueryClientProvider (ConsoleRoute nests it inside us), so the
  //     query cache does not exist here;
  //   - the path is written inline because src/paths is frozen for this change
  //     set and has no web-side tokenRefresh builder yet; it mirrors
  //     functions/src/lib/paths.ts `tokenRefresh` exactly.
  // The first snapshot after attach reports the CURRENT marker value, not a
  // change, so it is skipped - otherwise every sign-in would trigger a redundant
  // forced refresh.
  const uid = user?.uid ?? null;
  useEffect(() => {
    if (!uid) {
      return;
    }
    let initialSnapshot = true;
    const unsubscribe = onValue(
      ref(firebase.db(), `metadata/${uid}/refreshAt`),
      () => {
        if (initialSnapshot) {
          initialSnapshot = false;
          return;
        }
        void refreshSession().catch((error) => {
          // A failed forced refresh must not crash the shell; the hourly token
          // rotation remains the backstop, exactly as before this watcher.
          console.error('[Safentia auth] claims refresh', error);
        });
      },
      (error) => {
        // Rules allow each user to read their own /metadata node, so an error
        // here is transport-level; log and fall back to the hourly rotation.
        console.error('[Safentia auth] claims marker listener', error);
      },
    );
    return unsubscribe;
  }, [uid, refreshSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      emailVerified,
      claims,
      paths,
      signInWithEmail,
      signInWithGoogle,
      signInWithCustomToken,
      sendReset,
      changePassword,
      updateDisplayName,
      refreshSession,
      refreshEmailVerification,
      signOut,
    }),
    [
      status,
      user,
      emailVerified,
      claims,
      paths,
      signInWithEmail,
      signInWithGoogle,
      signInWithCustomToken,
      sendReset,
      changePassword,
      updateDisplayName,
      refreshSession,
      refreshEmailVerification,
      signOut,
    ],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <AppCheckNotice />
    </AuthContext.Provider>
  );
}

/** Read the session. Throws if used outside the provider so a wiring mistake is
 *  loud at development time rather than a confusing null at runtime. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }
  return ctx;
}
