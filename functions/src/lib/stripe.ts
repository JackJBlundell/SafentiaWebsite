// ============================================================================
// Stripe client seam (Phase 3 billing, plan sections 2, 4.3, 8).
//
// Every billing Function talks to Stripe through this module, never by
// constructing its own client. Three concerns live here and nowhere else:
//
//   1. MODE AWARENESS. The platform's test/live split (the caller's testMode
//      claim -> Environment) maps one-to-one onto Stripe's test/live modes, so
//      there are TWO secret keys and TWO webhook signing secrets. stripeForEnv
//      picks the right key for the env; webhookSecretForMode picks the right
//      signing secret for the endpoint's ?mode= param. Nothing outside this
//      file ever reads a STRIPE_* env var.
//
//   2. THE CUSTOMER REVERSE INDEX. Customer-level webhook events can arrive
//      without org metadata; ops/stripeCustomers/{env}/{customerId} -> orgId
//      (written at customer creation) is how they resolve. Server-only ops
//      namespace, rules-denied to clients (lib/paths.ts precedent).
//
//   3. WEBHOOK EVENT CLAIMS. Stripe retries webhooks, so every event must be
//      claimed exactly once before acting (claim-before-act, plan 4.3). The
//      claim is an RTDB transaction on ops/stripeEvents/{env}/{eventId}:
//      claim-iff-absent, status 'processing'; mark 'done' on success; RELEASE
//      (delete) on failure so the Stripe retry can reclaim and reprocess.
//      One deliberate exception to claim-iff-absent: a 'processing' marker
//      older than STALE_PROCESSING_CLAIM_MS is RECLAIMED by the same
//      transaction, because a crashed invocation (OOM, instance kill, timeout)
//      never reaches release and would otherwise block every retry of that
//      event forever. 'done' markers are never reclaimed - done is done.
//
// Wiring requirements (see STRIPE_SETUP.md):
//   - Secrets: firebase functions:secrets:set STRIPE_SECRET_KEY /
//     STRIPE_WEBHOOK_SECRET / STRIPE_SECRET_KEY_TEST / STRIPE_WEBHOOK_SECRET_TEST
//   - Attachment: every Function that touches Stripe must list STRIPE_SECRETS
//     in its options, or the env vars are not mounted and isStripeConfigured()
//     stays false (same contract as lib/email.ts).
//
// The admin SDK is imported lazily (email.ts precedent) so pure-unit consumers
// of this module (jest) never touch firebase-admin initialisation, and so the
// Stripe SDK itself is only constructed when a key is actually present.
// ============================================================================

import Stripe from 'stripe';
import { defineSecret } from 'firebase-functions/params';
import type { Environment } from '../shared/types';
import { envFromTestMode, ops } from './paths';
import type { RtdbPath } from './paths';

// ============================================================================
// Secrets
// ============================================================================

/** Live-mode secret key (sk_live_...). */
export const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
/** Live-mode webhook endpoint signing secret (whsec_...). */
export const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
/** Test-mode secret key (sk_test_...). */
export const STRIPE_SECRET_KEY_TEST = defineSecret('STRIPE_SECRET_KEY_TEST');
/** Test-mode webhook endpoint signing secret (whsec_...). */
export const STRIPE_WEBHOOK_SECRET_TEST = defineSecret('STRIPE_WEBHOOK_SECRET_TEST');

/**
 * The full secret set, ready to spread into a Function's `secrets` option.
 * Billing Functions attach all four rather than cherry-picking: a callable
 * serves both envs depending on the caller's testMode claim, and the webhook
 * serves both endpoints, so partial attachment would only create a
 * configured-in-one-mode-only failure that surfaces as a runtime throw.
 */
export const STRIPE_SECRETS = [
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_SECRET_KEY_TEST,
  STRIPE_WEBHOOK_SECRET_TEST,
];

// ============================================================================
// Mode-aware client
// ============================================================================

/**
 * The Stripe API version every request is pinned to. This is stripe@22's own
 * pinned default ('2026-07-29.dahlia' - the version its TypeScript types are
 * generated against), stated explicitly so an SDK upgrade cannot silently move
 * the wire format: after upgrading, this literal must be updated deliberately
 * alongside a review of the changelog, and the compiler enforces that because
 * the SDK types the field as the literal it ships with.
 */
const STRIPE_API_VERSION = '2026-07-29.dahlia' as const;

/** Resolve the secret-key env var for one env. Split out so the configured
 *  check and the constructor cannot drift apart on which var they read. */
function secretKeyForEnv(env: Environment): string | undefined {
  return env === 'live'
    ? process.env.STRIPE_SECRET_KEY
    : process.env.STRIPE_SECRET_KEY_TEST;
}

/**
 * True only when the mode's secret key is configured AND attached to the
 * calling Function's deployment (both are required for the env var to exist -
 * isEmailConfigured precedent). Callers that can degrade gracefully check
 * this; callers that cannot let stripeForEnv throw its structured error.
 */
export function isStripeConfigured(env: Environment): boolean {
  return Boolean(secretKeyForEnv(env));
}

/**
 * Lazily-constructed clients, one per mode. Module-level cache: the Functions
 * runtime reuses the process across invocations, so the client (and its agent
 * connection pool) is built once per mode per instance, not once per request.
 */
const clients: Partial<Record<Environment, Stripe>> = {};

/**
 * The Stripe client for one env: 'live' -> live secret key, 'test' -> test
 * secret key. Throws a clear configuration error when the mode's key is absent
 * so a misdeployed Function fails loudly at the call site rather than sending
 * requests with an empty credential.
 */
export function stripeForEnv(env: Environment): Stripe {
  const cached = clients[env];
  if (cached) {
    return cached;
  }
  const key = secretKeyForEnv(env);
  if (!key) {
    throw new Error(
      `Stripe is not configured for the '${env}' environment: secret ` +
        `${env === 'live' ? 'STRIPE_SECRET_KEY' : 'STRIPE_SECRET_KEY_TEST'} ` +
        'is not set, or is not attached to this Function (STRIPE_SECRETS must ' +
        "appear in the Function's secrets option). See STRIPE_SETUP.md.",
    );
  }
  const client = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    appInfo: { name: 'safentia' },
  });
  clients[env] = client;
  return client;
}

/**
 * The webhook signing secret for one endpoint mode ('live'|'test' - the
 * webhook's ?mode= param, which is also exactly the Environment enum). Throws
 * when unconfigured for the same fail-loud reason as stripeForEnv: signature
 * verification against an empty secret must never be attempted.
 */
export function webhookSecretForMode(mode: 'live' | 'test'): string {
  const secret =
    mode === 'live'
      ? process.env.STRIPE_WEBHOOK_SECRET
      : process.env.STRIPE_WEBHOOK_SECRET_TEST;
  if (!secret) {
    throw new Error(
      `Stripe webhook secret is not configured for '${mode}' mode: secret ` +
        `${mode === 'live' ? 'STRIPE_WEBHOOK_SECRET' : 'STRIPE_WEBHOOK_SECRET_TEST'} ` +
        'is not set, or is not attached to this Function. See STRIPE_SETUP.md.',
    );
  }
  return secret;
}

// ============================================================================
// Customer reverse index (plan 4.3)
// ============================================================================

/** RTDB location of the customer -> org reverse-index entry for one env. */
export function stripeCustomerIndexPath(
  env: Environment,
  customerId: string,
): RtdbPath {
  return ops.stripeCustomer(env, customerId);
}

/**
 * Record which org owns a Stripe customer, written at customer creation.
 * Overwrite-safe: the mapping is immutable in practice (one customer per org
 * per mode), so a retried create simply rewrites the same value.
 */
export async function recordStripeCustomer(
  env: Environment,
  customerId: string,
  orgId: string,
): Promise<void> {
  const { db } = await import('../admin');
  await db.ref(stripeCustomerIndexPath(env, customerId)).set(orgId);
}

/**
 * Resolve the org that owns a Stripe customer, or null when the customer is
 * unknown (the webhook logs-and-200s that case rather than erroring - an
 * unknown customer is a fact, not a retryable failure).
 */
export async function orgForStripeCustomer(
  env: Environment,
  customerId: string,
): Promise<string | null> {
  const { db } = await import('../admin');
  const snapshot = await db.ref(stripeCustomerIndexPath(env, customerId)).get();
  const value: unknown = snapshot.val();
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ============================================================================
// Webhook event claims (plan 4.3)
// ============================================================================

/** The claim record held while (and after) an event is processed. */
export interface StripeEventClaim {
  type: string;
  /** When THIS attempt claimed the event (re-stamped on a stale reclaim). */
  receivedAt: number;
  status: 'processing' | 'done';
  /** How many times the event has been claimed: 1 on first claim, incremented
   *  each time a stale 'processing' marker is reclaimed. Optional because
   *  markers written before this field existed lack it (read as 1). */
  attempts?: number;
  /** Set by markStripeEventDone; absent while processing. */
  doneAt?: number;
}

/**
 * How old a 'processing' marker must be before a retry may reclaim it. The
 * webhook Function's timeout is 60 seconds (stripeWebhook.ts pins it
 * explicitly), so no legitimate invocation can still be running 10 minutes
 * after it claimed - a marker that old belongs to an invocation that died
 * before it could release (crash, OOM, instance kill). 10 minutes is 10x the
 * timeout for clock-skew headroom, and comfortably inside Stripe's multi-day
 * retry schedule, so a reclaimable event always still has retries coming.
 */
export const STALE_PROCESSING_CLAIM_MS = 10 * 60 * 1000;

/**
 * Claim a webhook event for processing: transaction on
 * ops/stripeEvents/{env}/{eventId}, set {type, receivedAt, status:'processing'}
 * iff the node is absent OR holds a 'processing' marker older than
 * STALE_PROCESSING_CLAIM_MS (a crashed invocation's orphan - see the constant).
 * Returns true when THIS caller won the claim and must process the event;
 * false when the event is genuinely held (in-flight work younger than the
 * threshold, or done) - respond 200 and do nothing.
 */
export async function claimStripeEvent(
  env: Environment,
  eventId: string,
  type: string,
): Promise<boolean> {
  const { db } = await import('../admin');
  const result = await db
    .ref(ops.stripeEvent(env, eventId))
    .transaction((current: StripeEventClaim | null) => {
      if (current !== null) {
        const staleProcessing =
          current.status === 'processing' &&
          // A marker with no provable receivedAt cannot show it is fresh, so
          // it is treated as stale rather than blocking the event forever.
          (typeof current.receivedAt !== 'number' ||
            Date.now() - current.receivedAt > STALE_PROCESSING_CLAIM_MS);
        if (!staleProcessing) {
          // Genuinely held (fresh processing, or done): returning undefined
          // aborts the transaction, which surfaces as committed:false -
          // exactly the "someone else has it" signal.
          return undefined;
        }
        // Reclaim the orphan: fresh receivedAt, bumped attempt count.
        const reclaim: StripeEventClaim = {
          type,
          receivedAt: Date.now(),
          status: 'processing',
          attempts:
            (typeof current.attempts === 'number' ? current.attempts : 1) + 1,
        };
        return reclaim;
      }
      const claim: StripeEventClaim = {
        type,
        receivedAt: Date.now(),
        status: 'processing',
        attempts: 1,
      };
      return claim;
    });
  return result.committed;
}

/**
 * Mark a claimed event fully processed. The done-marker persists as the
 * idempotency record against late Stripe retries; the scheduled cleanup sweeps
 * markers older than 30 days (plan 4.3).
 */
export async function markStripeEventDone(
  env: Environment,
  eventId: string,
): Promise<void> {
  const { db } = await import('../admin');
  await db
    .ref(ops.stripeEvent(env, eventId))
    .update({ status: 'done', doneAt: Date.now() });
}

/**
 * Release a claim after a processing failure: the node is DELETED so the
 * Stripe retry (we return 500) can claim afresh and reprocess. Deleting rather
 * than flagging keeps the claim transaction a pure claim-iff-absent.
 */
export async function releaseStripeEvent(
  env: Environment,
  eventId: string,
): Promise<void> {
  const { db } = await import('../admin');
  await db.ref(ops.stripeEvent(env, eventId)).remove();
}

// ----------------------------------------------------------------------------
// Which environment a SELF-SERVE SIGNUP runs in.
// ----------------------------------------------------------------------------

/**
 * The env (and therefore the Stripe mode) for the pre-org onboarding flow:
 * normally the caller's testMode claim, exactly like everywhere else - but the
 * FIRERITE_FORCE_TEST_SIGNUPS=true runtime env var overrides it to 'test' for
 * EVERY signup, so a whole deployment can be pointed at Stripe test mode
 * during a testing window without granting per-account claims (the
 * FIRERITE_ENFORCE_APPCHECK precedent: an operator flag on the deployment,
 * never client input). Scope is deliberately the SIGNUP flow only
 * (saveOnboardingDetails / createSubscription / getBillingState's onboarding
 * branch): an existing org member's env keeps coming from their claims, so a
 * live organisation can never be dragged into test mode by this flag.
 */
export function signupEnv(tokenTestMode: boolean | undefined): Environment {
  if (process.env.FIRERITE_FORCE_TEST_SIGNUPS === 'true') {
    return 'test';
  }
  return envFromTestMode(tokenTestMode === true);
}
