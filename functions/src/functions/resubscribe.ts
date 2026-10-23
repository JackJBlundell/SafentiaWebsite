// ============================================================================
// resubscribe (callable, org admin) - the SEV-1 way back from a dead
// subscription (assessment: "a customer who cancels can never resubscribe
// through the product").
//
// A Stripe subscription that has been cancelled (or expired incomplete) is
// immutable - it cannot be revived - so restarting means a NEW subscription on
// the org's EXISTING customer. This callable is that seam: it is deliberately
// neither createSubscription (which is the members-less onboarding journey and
// turns away callers who hold an org) nor changeSubscription (which mutates a
// live subscription and now refuses dead ones). It requires the mirrored
// status to be restartable ('canceled', or 'incomplete' from a previous
// restart attempt), verifies that against the LIVE Stripe object - RTDB is a
// display mirror, never the authorisation truth for money - and returns the
// new subscription's Payment Element client secret.
//
// WEBHOOK INTERACTION: the new subscription carries metadata { orgId, env,
// planId } and NO onboardingUid, so the webhook's provisioning branch
// (maybeProvisionOnboarding) can never fire; handleSubscriptionUpsert resolves
// the org from the metadata and lands the snapshot - 'incomplete' first (the
// org stays on the suspended floor until money moves - see
// entitlements.isSuspendedStatus), then 'active' when the payment confirms,
// which also clears the member-readable profile.suspended mirror.
//
// RETRY SAFETY: the Stripe idempotency key is derived from the DEAD
// subscription's id, so a retried call replays the same create rather than
// minting siblings; and a still-payable incomplete restart FOR THE SAME PLAN
// is resumed (its existing secret handed back) instead of being duplicated,
// while a re-pick of a different tier cancels the abandoned attempt first -
// its secret would charge the wrong price, and leaving it live would orphan an
// invoice-bearing subscription on the customer.
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
  getLiveClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { stripeForEnv, STRIPE_SECRETS } from '../lib/stripe';
import { paths } from '../lib/paths';
import { isRestartableStatus, isSelfServePlanId, type SelfServePlanId } from '../lib/billing';
import type {
  OrgSubscription,
  Plan,
  ResubscribeRequest,
  ResubscribeResponse,
} from '../shared/types';

/**
 * Validate the payload. The orgId must equal the caller's claims-bound org and
 * is never trusted beyond that check (every path below is built from the
 * claims value); planId must be a self-serve tier. Exported for unit tests.
 */
export function parseResubscribeInput(
  data: unknown,
  claimsOrgId: string,
): { planId: SelfServePlanId } {
  const input = assertObject(data);
  const orgId = requireDbKey(input, 'orgId', TEXT_LIMITS.shortText);
  if (orgId !== claimsOrgId) {
    throw fail.permissionDenied(
      'You can only manage billing for your own organisation.',
      { field: 'orgId' },
    );
  }
  if (!isSelfServePlanId(input.planId)) {
    throw fail.invalidArgument(
      'The planId field must be bronze, silver or gold.',
      { field: 'planId' },
    );
  }
  return { planId: input.planId };
}

/** The Payment Element client secret off an expanded subscription's latest
 *  invoice (createSubscription's clientSecretOf, same pinned-API shape). */
function clientSecretOf(sub: Stripe.Subscription): string | undefined {
  const invoice = sub.latest_invoice;
  if (!invoice || typeof invoice === 'string') {
    return undefined;
  }
  return invoice.confirmation_secret?.client_secret ?? undefined;
}

export const resubscribe = onCall<ResubscribeRequest>(
  { ...callableOptions, secrets: STRIPE_SECRETS },
  (request) =>
    runCallable<ResubscribeResponse>(
      createLogger({ fn: 'resubscribe' }),
      async () => {
        // 1. Attestation, identity, authorisation, throttle, validation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        const claims = await getLiveClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths: envPaths } = envFor(claims);
        await assertRateLimit(uid, 'resubscribe');
        const orgId = claims.orgId;
        const { planId } = parseResubscribeInput(request.data, orgId);

        // 2. The org must have HAD a Stripe-backed subscription, and its
        // mirrored status must be restartable. An org that never subscribed is
        // operator-managed; a live subscription is changed, not restarted.
        const subscriptionPath = envPaths.db.orgSubscription(orgId);
        const snapshot = await db.ref(subscriptionPath).get();
        const subscription = (snapshot.val() ?? null) as OrgSubscription | null;
        if (!subscription?.stripeSubscriptionId || !subscription.stripeCustomerId) {
          throw fail.failedPrecondition(
            'This organisation does not have a subscription to restart. ' +
              'If that seems wrong, please contact support.',
          );
        }
        if (!isRestartableStatus(subscription.status)) {
          throw fail.failedPrecondition(
            "This organisation's subscription is still live, so there is " +
              'nothing to restart. You can change or cancel it from the ' +
              'Billing page instead.',
          );
        }

        // 3. Verify against Stripe - the mirror is display truth, never the
        // authorisation truth for creating a chargeable object. A live-status
        // disagreement means the webhook simply has not landed yet: refuse and
        // let the mirror catch up.
        const stripe = stripeForEnv(env);
        const previous = await stripe.subscriptions.retrieve(
          subscription.stripeSubscriptionId,
          { expand: ['latest_invoice.confirmation_secret'] },
        );
        if (
          previous.status !== 'canceled' &&
          previous.status !== 'incomplete_expired' &&
          previous.status !== 'incomplete'
        ) {
          throw fail.failedPrecondition(
            "This organisation's subscription is still live on our payment " +
              'provider. Please try again in a moment.',
          );
        }

        const logger = createLogger({ fn: 'resubscribe', orgId });

        // 4. A previous restart attempt still awaiting its first payment:
        // resume it for the SAME plan (hand back its secret - never mint a
        // sibling), cancel it for a DIFFERENT plan (its secret would charge
        // the abandoned tier's price).
        if (previous.status === 'incomplete') {
          const previousPlanId = previous.metadata?.planId;
          const secret = clientSecretOf(previous);
          if (previousPlanId === planId && secret) {
            logger.info('Resuming incomplete restart attempt', {
              subscriptionId: previous.id,
            });
            return { clientSecret: secret, subscriptionId: previous.id };
          }
          await stripe.subscriptions.cancel(previous.id);
          logger.info('Cancelled superseded restart attempt', {
            subscriptionId: previous.id,
          });
        }

        // 5. The plan catalogue is the price source of truth (createSubscription
        // precedent): an unseeded env is a deployment gap, not a client error.
        const planSnapshot = await db.ref(paths.platform.plan(env, planId)).get();
        const plan = planSnapshot.val() as Plan | null;
        if (!plan?.stripePriceId) {
          throw fail.failedPrecondition(
            'That plan is not available at the moment. Please try again ' +
              'shortly or contact support.',
          );
        }

        // 6. The new subscription, on the SAME customer (their card history
        // and invoices stay in one place). metadata: orgId lets the webhook
        // resolve the org directly, and the ABSENCE of onboardingUid keeps the
        // provisioning branch inert. The idempotency key is derived from the
        // dead subscription's id: deterministic across retries of this restart,
        // and naturally fresh for a future restart (which will be replacing a
        // different dead subscription).
        const created = await stripe.subscriptions.create(
          {
            customer: subscription.stripeCustomerId,
            items: [{ price: plan.stripePriceId }],
            payment_behavior: 'default_incomplete',
            payment_settings: {
              save_default_payment_method: 'on_subscription',
            },
            metadata: { env, planId, orgId },
            expand: ['latest_invoice.confirmation_secret'],
          },
          { idempotencyKey: `sub-restart:${orgId}:${planId}:${subscription.stripeSubscriptionId}` },
        );
        const clientSecret = clientSecretOf(created);
        if (!clientSecret) {
          throw fail.internal(
            'Stripe did not return a payable invoice for the new subscription. Please try again shortly.',
          );
        }

        // 7. Audit only - the webhook is the single writer of Stripe-derived
        // subscription state, and its customer.subscription.created delivery
        // lands the 'incomplete' snapshot moments after this returns.
        await db.ref().update(
          activityUpdate(envPaths, orgId, {
            actorUid: uid,
            action: 'billing.subscription.restarted',
            target: orgId,
          }),
        );

        logger.info('Restart subscription created', {
          env,
          planId,
          subscriptionId: created.id,
          replaced: subscription.stripeSubscriptionId,
        });
        return { clientSecret, subscriptionId: created.id };
      },
    ),
);
