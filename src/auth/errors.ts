// ============================================================================
// Auth error mapping (story 1016, brief 4.1 / 18.3) - ported unchanged from
// FireRite/src/auth/errors.ts; the file is platform-free by design.
//
// Two hard rules drive this file:
//   1. NON-ENUMERATING: we must never reveal whether an email is registered. So
//      "user-not-found" and "wrong-password" (and their modern merged code
//      "invalid-credential") all map to ONE generic message.
//   2. NO RAW FIREBASE CODES on screen. Every code maps to calm, British-English,
//      actionable copy. Unknown codes fall back to a safe generic message.
// ============================================================================

/** A single, deliberately vague message for any credential failure, so an
 *  attacker cannot probe which emails exist. */
const GENERIC_CREDENTIAL_MESSAGE =
  'Those sign-in details were not recognised. Check your email and password and try again.';

const MESSAGES: Record<string, string> = {
  // All credential mismatches collapse to the same copy (non-enumerating).
  'auth/invalid-credential': GENERIC_CREDENTIAL_MESSAGE,
  'auth/user-not-found': GENERIC_CREDENTIAL_MESSAGE,
  'auth/wrong-password': GENERIC_CREDENTIAL_MESSAGE,
  'auth/invalid-email': GENERIC_CREDENTIAL_MESSAGE,

  'auth/user-disabled':
    'This account has been locked. Please contact your organisation administrator.',
  'auth/too-many-requests':
    'Too many attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed':
    'No connection. Check your signal and try again.',
  'auth/requires-recent-login':
    'For your security, please sign in again before making this change.',
  'auth/weak-password':
    'Choose a stronger password of at least six characters.',
  'auth/email-already-in-use':
    'An account already exists for this email address.',
};

/** Map any thrown auth error to safe, user-facing copy. Accepts the raw error
 *  object so call sites can pass the caught value straight through. */
export function authErrorMessage(error: unknown): string {
  const code = extractCode(error);
  if (code && MESSAGES[code]) {
    return MESSAGES[code];
  }
  return 'Something went wrong signing you in. Please try again.';
}

function extractCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
