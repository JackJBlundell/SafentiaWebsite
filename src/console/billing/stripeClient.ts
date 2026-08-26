// ============================================================================
// Stripe.js loader - the ONLY module in the web tree allowed to touch
// @stripe/stripe-js (Phase 3 billing, PHASE3_BILLING_PLAN.md §7/§8).
//
// Nothing imports this yet: Phase D (subscribe flow + Settings > Billing tab)
// consumes it. Keeping the loader here, alone, means the SSG constraint and
// the per-mode key selection are enforced in one place rather than re-derived
// by every billing page.
//
// Two Stripe modes, not one: Stripe test mode and live mode are separate
// keyspaces, and the caller's `testMode` claim decides which one a session
// belongs to - the same claim that routes the data root. Callers pass the
// resolved environment; this module never reads the claim itself.
// ============================================================================

import type { Stripe } from "@stripe/stripe-js";
import type { Environment } from "../../types";

import { isUnfilled, webConfig } from "../../config/env";

/** One cached promise per Stripe mode. loadStripe() injects the js.stripe.com
 *  script tag on first call; caching the promise (not the resolved value)
 *  guarantees a single injection per mode even under concurrent first calls. */
const stripePromises: Partial<Record<Environment, Promise<Stripe | null>>> = {};

/**
 * Whether Stripe is configured for the given environment, decided WITHOUT
 * loading Stripe.js: the matching publishable key is present and not the
 * committed `.env` placeholder. Synchronous and side-effect free (it never
 * injects the js.stripe.com script tag - loadStripeForEnv remains the only
 * thing that does), so a page can gate on it during render.
 *
 * The plan step uses this to refuse advancing into createSubscription when a
 * checkout could never complete: without a client key the browser can never
 * confirm the PaymentIntent, so minting a Stripe Customer + subscription for it
 * only litters the account with dead objects. The check is client-side because
 * only the browser knows its own publishable-key state - the server holds the
 * secret keys and cannot tell whether this build shipped a usable client key.
 */
export function isStripeConfiguredForEnv(env: Environment): boolean {
  const key =
    env === "test"
      ? webConfig.stripePublishableKeyTest
      : webConfig.stripePublishableKey;
  return !isUnfilled(key);
}

/**
 * Load Stripe.js for the given environment, or resolve null when the matching
 * publishable key is absent or still the committed `.env` placeholder - the
 * caller renders a not-configured notice and must never crash.
 *
 * `import('@stripe/stripe-js')` happens INSIDE the function, never at module
 * scope: importing Stripe.js touches `window` (it injects a script tag), and
 * the SSG rule is that no module may touch `window` at import time or the
 * public pages fail to pre-render. The dynamic import also keeps Stripe.js out
 * of every non-billing chunk.
 */
export function loadStripeForEnv(
  env: Environment,
): Promise<Stripe | null> {
  const cached = stripePromises[env];
  if (cached) return cached;

  const key =
    env === "test"
      ? webConfig.stripePublishableKeyTest
      : webConfig.stripePublishableKey;

  if (isUnfilled(key)) {
    // Loud for the operator, graceful for the user: the billing UI shows its
    // not-configured notice off the null. Not cached, so filling the key and
    // rebuilding is the only step to recover.
    console.warn(
      `[Safentia] Stripe publishable key for the "${env}" environment is not ` +
        "set (VITE_STRIPE_PUBLISHABLE_KEY" +
        (env === "test" ? "_TEST" : "") +
        " in .env). Billing is not configured.",
    );
    return Promise.resolve(null);
  }

  const promise = import("@stripe/stripe-js").then(({ loadStripe }) =>
    loadStripe(key),
  );
  stripePromises[env] = promise;
  return promise;
}
