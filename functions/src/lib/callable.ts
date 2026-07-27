// ============================================================================
// Shared callable configuration.
//
// Every callable is deployed in the one region (lib/region) and with App Check
// ENFORCED at the platform layer (brief 4.6). We ALSO call assertAppCheck inside
// the body so a rejected call returns our structured {code,message,details}
// contract rather than the platform's bare error - defence in depth, with a clean
// client experience. Stating the options once means no Function can forget either.
// ============================================================================

import type { CallableOptions } from 'firebase-functions/v2/https';
import { randomBytes } from 'crypto';
import { REGION } from './region';

/**
 * Standard options for a Safentia callable. enforceAppCheck rejects unattested
 * clients at the platform boundary; the in-body assertAppCheck then shapes the
 * error. invoker defaults to authenticated callers only is not set here because
 * onCall already requires the Functions client SDK; auth is asserted in-body.
 */
export const callableOptions: CallableOptions = {
  region: REGION,
  // Enforced by default; disabled only for an environment that has not yet
  // registered App Check providers (FIRERITE_ENFORCE_APPCHECK=false). Production
  // leaves it unset so enforcement stays ON (brief 4.6). The in-body
  // assertAppCheck honours the same flag, so the two never disagree.
  enforceAppCheck: process.env.FIRERITE_ENFORCE_APPCHECK !== 'false',
  // Cost / runaway ceiling: cap how many concurrent instances a single callable
  // can scale to. App Check + per-user rate limiting (lib/rateLimit) are the
  // request-level controls; this is the blast-radius control, so a burst (a buggy
  // client retry-loop, or abuse that slips the other layers) cannot fan out
  // unbounded instances and run up the bill. Tune up as real load grows.
  maxInstances: 20,
};

/**
 * A cryptographically-strong, URL-safe single-use token for invitations. 32 bytes
 * of entropy is well beyond guessing range; base64url keeps it safe in an email
 * link without escaping. Crypto-random (not Math.random) because this token is a
 * bearer secret that grants org membership on acceptance.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}
