// ============================================================================
// createCardUpdateIntent (callable, org admin) - Phase 3 billing, plan
// section 3.4.
//
// Mints the SetupIntent the Billing tab mounts Payment Element around when an
// admin replaces the organisation's card. This callable only opens the door:
// the webhook's setup_intent.succeeded handler (matching on the metadata
// written here) performs the default-payment-method swap and detaches the old
// card - the client is never trusted to finalise, and no card data beyond what
// Stripe returns to its own Element ever transits our code (SAQ-A).
//
// No RTDB writes at all: nothing has changed until the webhook lands the new
// card, and the webhook is the single writer of Stripe-derived state.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getLiveClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { stripeForEnv, STRIPE_SECRETS } from '../lib/stripe';
import type {
  CreateCardUpdateIntentRequest,
  CreateCardUpdateIntentResponse,
  OrgSubscription,
} from '../shared/types';

/**
 * Validate the payload: just the orgId, which must equal the caller's
 * claims-bound org and is never trusted beyond that check. Exported for unit
 * tests.
 */
export function parseCreateCardUpdateIntentInput(
  data: unknown,
  claimsOrgId: string,
): void {
  const input = assertObject(data);
  const orgId = requireDbKey(input, 'orgId', TEXT_LIMITS.shortText);
  if (orgId !== claimsOrgId) {
    throw fail.permissionDenied(
      'You can only manage billing for your own organisation.',
      { field: 'orgId' },
    );
  }
}

export const createCardUpdateIntent = onCall<CreateCardUpdateIntentRequest>(
  { ...callableOptions, secrets: STRIPE_SECRETS },
  (request) =>
    runCallable<CreateCardUpdateIntentResponse>(
      createLogger({ fn: 'createCardUpdateIntent' }),
      async () => {
        // 1. Attestation, identity, authorisation, throttle, validation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        const claims = await getLiveClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths: envPaths } = envFor(claims);
        await assertRateLimit(uid, 'createCardUpdateIntent');
        const orgId = claims.orgId;
        parseCreateCardUpdateIntentInput(request.data, orgId);

        // 2. The org must have a Stripe customer to attach the card to.
        const snapshot = await db
          .ref(envPaths.db.orgSubscription(orgId))
          .get();
        const subscription = (snapshot.val() ?? null) as OrgSubscription | null;
        if (!subscription?.stripeCustomerId) {
          throw fail.failedPrecondition(
            'This organisation is not set up for card payments yet, so ' +
              'there is no card to update. If that seems wrong, please contact support.',
          );
        }

        // 3. Mint the SetupIntent. The metadata is the webhook's routing key:
        // setup_intent.succeeded matches purpose 'card_update' and applies the
        // new payment method to this org's customer.
        const stripe = stripeForEnv(env);
        const setupIntent = await stripe.setupIntents.create({
          customer: subscription.stripeCustomerId,
          usage: 'off_session',
          payment_method_types: ['card'],
          metadata: { orgId, env, purpose: 'card_update' },
        });
        if (!setupIntent.client_secret) {
          // Stripe returns the secret on creation; its absence is a fault on
          // our side of the fence, not the caller's.
          throw fail.internal();
        }

        const logger = createLogger({ fn: 'createCardUpdateIntent', orgId });
        logger.info('Card-update SetupIntent created', {
          env,
          setupIntentId: setupIntent.id,
        });
        return { clientSecret: setupIntent.client_secret };
      },
    ),
);
