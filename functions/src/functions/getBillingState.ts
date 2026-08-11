// ============================================================================
// getBillingState (callable) - Phase 3 billing read model (plan 3.1.8, 9).
//
// One read endpoint, two callers:
//   (a) NO orgId - an onboarding user resuming the subscribe journey. Returns
//       their usersOnboarding node and, when they are parked at the payment
//       step, the incomplete subscription's Payment Element client secret so a
//       reload re-enters checkout exactly where it left off.
//   (b) orgId - an org ADMIN reading their organisation's subscription
//       snapshot for the Billing tab. When a payment needs finishing (status
//       'incomplete', 'past_due' or 'unpaid', or paymentState
//       'action_required'), the open invoice's client secret rides along so
//       the tab can mount the Payment Element (3DS completion, paying the
//       outstanding invoice of a suspended org) without a second round trip.
//
// The client never talks to the Stripe API: RTDB snapshots are the display
// truth and this callable is the only bridge to Stripe, used solely to mint
// the pending-payment client secret. Secret retrieval is BEST-EFFORT - a
// Stripe hiccup degrades to the snapshot without one, never a failed call,
// because the state read also drives gates that must not wedge.
//
// STRIPE API NOTE: the pinned API version reads the secret from
// `latest_invoice.confirmation_secret` (see createSubscription.ts header).
// ============================================================================

import type Stripe from 'stripe';
import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  envFor,
  getClaims,
} from '../lib/guards';
import { usersOnboarding } from '../lib/paths';
import { assertObject, optionalString, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import {
  needsPendingPaymentSecret,
  pendingPaymentFromInvoice,
} from '../lib/billing';
import type { PendingPayment } from '../lib/billing';
import { signupEnv, STRIPE_SECRETS, stripeForEnv } from '../lib/stripe';
import type { Logger } from '../lib/logging';
import type {
  Environment,
  GetBillingStateRequest,
  GetBillingStateResponse,
  OrgSubscription,
  UserOnboarding,
} from '../shared/types';

/**
 * Best-effort fetch of the pending-payment facts for a subscription: the
 * latest invoice's confirmation secret and scheduled retry instant, only while
 * that invoice is still OPEN (an incomplete first payment, a 3DS challenge or
 * a dunning retry - see pendingPaymentFromInvoice). Any failure - Stripe
 * unreachable, subscription gone - degrades to {}, never a throw, because the
 * state read also drives gates that must not wedge.
 */
export async function pendingPaymentFor(
  env: Environment,
  subscriptionId: string,
  logger: Logger,
): Promise<PendingPayment> {
  try {
    const stripe = stripeForEnv(env);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['latest_invoice.confirmation_secret'],
    });
    return pendingPaymentFromInvoice(
      subscription.latest_invoice as Stripe.Invoice | string | null,
    );
  } catch (caught) {
    logger.warn('Could not fetch pending payment details', {
      subscriptionId,
      error: caught instanceof Error ? caught.message : String(caught),
    });
    return {};
  }
}

/** Fold the best-effort pending-payment facts into the response, adding each
 *  field only when it exists - absent facts stay absent, not null. */
function applyPendingPayment(
  response: GetBillingStateResponse,
  pending: PendingPayment,
): void {
  if (pending.clientSecret) {
    response.pendingPaymentClientSecret = pending.clientSecret;
  }
  if (pending.nextPaymentAttempt !== undefined) {
    response.nextPaymentAttempt = pending.nextPaymentAttempt;
  }
}

export const getBillingState = onCall<GetBillingStateRequest>(
  { ...callableOptions, secrets: STRIPE_SECRETS },
  (request) =>
    runCallable<GetBillingStateResponse>(
      createLogger({ fn: 'getBillingState' }),
      async () => {
        const logger = createLogger({ fn: 'getBillingState' });

        // Attestation, identity, rate limit. The org-role gate applies only in
        // mode (b) below - an onboarding caller has no org claims yet.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'getBillingState');

        const input = assertObject(request.data ?? {});
        const orgId = optionalString(input, 'orgId', TEXT_LIMITS.shortText);

        // --- Mode (a): onboarding resume (no orgId) -------------------------
        if (!orgId) {
          const onboarding = (
            await db.ref(usersOnboarding(uid)).get()
          ).val() as UserOnboarding | null;
          if (!onboarding) {
            return {};
          }
          const env = signupEnv(request.auth?.token?.testMode === true);
          const response: GetBillingStateResponse = { onboarding, env };
          // The node's subscription id is only visible to the mode that
          // minted it (node.env); after a mode flip the secret cannot be
          // fetched - createSubscription starts the payment afresh instead
          // (its step 4b), so return no secret rather than tripping over
          // resource_missing.
          if (
            onboarding.step === 'payment' &&
            onboarding.subscriptionId &&
            onboarding.env === env
          ) {
            applyPendingPayment(
              response,
              await pendingPaymentFor(env, onboarding.subscriptionId, logger),
            );
          }
          return response;
        }

        // --- Mode (b): org admin's Billing tab ------------------------------
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        if (claims.orgId !== orgId) {
          throw fail.permissionDenied(
            'You can only view billing for your own organisation.',
          );
        }
        const { env, paths } = envFor(claims);
        const subscription = (
          await db.ref(paths.db.orgSubscription(orgId)).get()
        ).val() as OrgSubscription | null;
        if (!subscription) {
          return {};
        }
        const response: GetBillingStateResponse = { subscription };
        // A payment the admin can finish RIGHT NOW (SEV-1 reactivation path
        // included - see needsPendingPaymentSecret). pendingPaymentFor
        // re-fetches from Stripe and only returns facts while the latest
        // invoice is genuinely OPEN, so a stale snapshot can never mint a
        // payment against a settled invoice. Alongside the secret rides
        // nextPaymentAttempt - Stripe's scheduled dunning retry - so a
        // past_due admin can be told WHEN their card will be tried again.
        if (
          needsPendingPaymentSecret(subscription) &&
          subscription.stripeSubscriptionId
        ) {
          applyPendingPayment(
            response,
            await pendingPaymentFor(env, subscription.stripeSubscriptionId, logger),
          );
        }
        return response;
      },
    ),
);
