// ============================================================================
// cancelSubscription (callable, org admin) - Phase 3 billing, plan section 3.3.
//
// Period-end only: cancelling sets cancel_at_period_end and the org keeps
// access until the date passes; `resume: true` clears the flag any time before
// then. There is no immediate-cancel path - refunds go through support. A
// pending downgrade schedule is deliberately left alone in both directions:
// cancelling and downgrading are orthogonal decisions, and Stripe composes
// them correctly on its own.
//
// WRITE DISCIPLINE: the Stripe webhook is the SINGLE writer of Stripe-derived
// subscription state. The one optimistic exception allowed here is mirroring
// `cancelAtPeriodEnd` so the Billing tab reflects the click instantly; the
// webhook's customer.subscription.updated lands the same truth moments later.
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
  getClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { stripeForEnv, STRIPE_SECRETS } from '../lib/stripe';
import { isRestartableStatus, periodEndMs } from '../lib/billing';
import type {
  CancelSubscriptionRequest,
  CancelSubscriptionResponse,
  OrgSubscription,
} from '../shared/types';

/**
 * Validate the payload. The orgId must equal the caller's claims-bound org and
 * is never trusted beyond that check; `resume` is a literal boolean or absent -
 * rejected, never coerced (brief 18.4). Exported for unit tests.
 */
export function parseCancelSubscriptionInput(
  data: unknown,
  claimsOrgId: string,
): { resume: boolean } {
  const input = assertObject(data);
  const orgId = requireDbKey(input, 'orgId', TEXT_LIMITS.shortText);
  if (orgId !== claimsOrgId) {
    throw fail.permissionDenied(
      'You can only manage billing for your own organisation.',
      { field: 'orgId' },
    );
  }
  const resume = input.resume;
  if (resume !== undefined && typeof resume !== 'boolean') {
    throw fail.invalidArgument('The resume field must be true or false.', {
      field: 'resume',
    });
  }
  return { resume: resume === true };
}

export const cancelSubscription = onCall<CancelSubscriptionRequest>(
  { ...callableOptions, secrets: STRIPE_SECRETS },
  (request) =>
    runCallable<CancelSubscriptionResponse>(
      createLogger({ fn: 'cancelSubscription' }),
      async () => {
        // 1. Attestation, identity, authorisation, throttle, validation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths: envPaths } = envFor(claims);
        await assertRateLimit(uid, 'cancelSubscription');
        const orgId = claims.orgId;
        const { resume } = parseCancelSubscriptionInput(request.data, orgId);

        // 2. The org must hold a Stripe-backed subscription.
        const subscriptionPath = envPaths.db.orgSubscription(orgId);
        const snapshot = await db.ref(subscriptionPath).get();
        const subscription = (snapshot.val() ?? null) as OrgSubscription | null;
        if (!subscription?.stripeSubscriptionId) {
          throw fail.failedPrecondition(
            'This organisation does not have an active subscription, so ' +
              'there is nothing to cancel. If that seems wrong, please contact support.',
          );
        }

        // A dead subscription has nothing left to cancel or resume - the
        // period-end flag is meaningless on a canceled or never-paid
        // subscription, and Stripe would refuse the update raw. The way back
        // is the restart flow (resubscribe).
        if (isRestartableStatus(subscription.status)) {
          throw fail.failedPrecondition(
            "This organisation's subscription has already ended, so there is " +
              'nothing to cancel or resume. You can restart your subscription ' +
              'from the Billing page.',
          );
        }

        // 3. Flip the period-end flag in Stripe - the only Stripe write here.
        const stripe = stripeForEnv(env);
        const updated = await stripe.subscriptions.update(
          subscription.stripeSubscriptionId,
          { cancel_at_period_end: !resume },
        );
        const periodEnd = periodEndMs(updated);
        if (periodEnd === null) {
          throw fail.failedPrecondition(
            "We could not read this subscription's billing period. " +
              'Please contact support.',
          );
        }

        // 4. Optimistic mirror (the one allowed field) + audit entry, in ONE
        // update; the webhook confirms shortly after.
        await db.ref().update({
          [`${subscriptionPath}/cancelAtPeriodEnd`]: updated.cancel_at_period_end,
          ...activityUpdate(envPaths, orgId, {
            actorUid: uid,
            action: resume
              ? 'billing.subscription.resumed'
              : 'billing.subscription.cancelScheduled',
            target: orgId,
          }),
        });

        const logger = createLogger({ fn: 'cancelSubscription', orgId });
        logger.info(resume ? 'Subscription resumed' : 'Cancellation scheduled', {
          env,
          cancelAtPeriodEnd: updated.cancel_at_period_end,
          periodEnd,
        });
        return {
          cancelAtPeriodEnd: updated.cancel_at_period_end,
          periodEnd,
        };
      },
    ),
);
