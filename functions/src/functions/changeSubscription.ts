// ============================================================================
// changeSubscription (callable, org admin) - Phase 3 billing, plan section 3.2.
//
// An org admin moves the organisation between self-serve tiers. Direction
// decides mechanics:
//
//   UPGRADE   - immediate. The subscription's price is swapped with
//               proration_behavior 'always_invoice', so the prorated delta is
//               charged now and the webhook unlocks the new entitlements when
//               the resulting events land.
//   DOWNGRADE - at period end, via a Stripe subscription schedule: the current
//               phase runs to the period boundary and a second phase carries
//               the cheaper price. Stripe owns the timing; the webhook's
//               customer.subscription.updated carries the new price when it
//               lands.
//
// WRITE DISCIPLINE: the Stripe webhook is the SINGLE writer of Stripe-derived
// subscription state. This callable returns what changed and lets the webhook
// land the truth; its only RTDB writes are the /activity audit entry and the
// one optimistic field the plan allows - `pendingPlanId` on a downgrade (set),
// or cleared when an upgrade releases a pending downgrade schedule - which the
// webhook later confirms or corrects.
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
import { paths } from '../lib/paths';
import {
  isRestartableStatus,
  isSelfServePlanId,
  isUpgrade,
  periodEndMs,
  type SelfServePlanId,
} from '../lib/billing';
import type { Environment } from '../shared/types';
import type {
  ChangeSubscriptionRequest,
  ChangeSubscriptionResponse,
  OrgSubscription,
  Plan,
} from '../shared/types';

/**
 * Validate the payload. The orgId in the request MUST equal the caller's
 * claims-bound org - it is checked and then never trusted for anything else
 * (every path below is built from the claims value). Exported for unit tests.
 */
export function parseChangeSubscriptionInput(
  data: unknown,
  claimsOrgId: string,
): { planId: SelfServePlanId; preview: boolean } {
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
  return { planId: input.planId, preview: input.preview === true };
}

/** Load one env-nested plan document, or null when the seed has not run. */
async function loadPlan(
  env: Environment,
  planId: SelfServePlanId,
): Promise<Plan | null> {
  const snapshot = await db.ref(paths.platform.plan(env, planId)).get();
  return (snapshot.val() ?? null) as Plan | null;
}

export const changeSubscription = onCall<ChangeSubscriptionRequest>(
  { ...callableOptions, secrets: STRIPE_SECRETS },
  (request) =>
    runCallable<ChangeSubscriptionResponse>(
      createLogger({ fn: 'changeSubscription' }),
      async () => {
        // 1. Attestation, identity, authorisation, throttle, validation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths: envPaths } = envFor(claims);
        await assertRateLimit(uid, 'changeSubscription');
        const orgId = claims.orgId;
        const { planId: targetPlanId, preview } = parseChangeSubscriptionInput(
          request.data,
          orgId,
        );

        // 2. The org must already hold a Stripe-backed subscription.
        const subscriptionPath = envPaths.db.orgSubscription(orgId);
        const snapshot = await db.ref(subscriptionPath).get();
        const subscription = (snapshot.val() ?? null) as OrgSubscription | null;
        if (!subscription?.stripeSubscriptionId) {
          throw fail.failedPrecondition(
            'This organisation does not have an active subscription yet, so ' +
              'there is no plan to change. If that seems wrong, please contact support.',
          );
        }
        // A dead subscription cannot be changed - Stripe refuses updates to a
        // canceled subscription, and an incomplete restart has nothing to
        // prorate. The way forward is the restart flow (resubscribe), and the
        // Billing tab shows exactly that; this guard is the calm server-side
        // truth for anyone who reaches the callable anyway.
        if (isRestartableStatus(subscription.status)) {
          throw fail.failedPrecondition(
            "This organisation's subscription has ended, so there is no plan " +
              'to change. You can restart your subscription from the Billing page.',
          );
        }
        const currentPlanId = subscription.planId;
        if (!isSelfServePlanId(currentPlanId)) {
          throw fail.failedPrecondition(
            "This organisation's plan is managed by our team, so it cannot " +
              'be changed here. Please contact support.',
          );
        }
        if (currentPlanId === targetPlanId) {
          throw fail.invalidArgument(
            'The organisation is already on that plan.',
            { field: 'planId' },
          );
        }

        // 3. The target plan must be sellable (seeded with a Stripe price for
        // this env). The current plan doc may legitimately be absent - the
        // ladder fallback in planRank covers ranking without it.
        const [targetPlan, currentPlan] = await Promise.all([
          loadPlan(env, targetPlanId),
          loadPlan(env, currentPlanId),
        ]);
        if (!targetPlan || !targetPlan.stripePriceId) {
          throw fail.failedPrecondition(
            'That plan is not available at the moment. Please try again ' +
              'shortly or contact support.',
          );
        }

        // 4. The live Stripe subscription: its single item carries the price to
        // swap and the current period boundary a downgrade lands on.
        const stripe = stripeForEnv(env);
        const stripeSub = await stripe.subscriptions.retrieve(
          subscription.stripeSubscriptionId,
        );
        const item = stripeSub.items.data[0];
        const periodEnd = periodEndMs(stripeSub);
        if (!item || periodEnd === null) {
          throw fail.failedPrecondition(
            "We could not read this subscription's billing details. " +
              'Please contact support.',
          );
        }
        const existingScheduleId =
          typeof stripeSub.schedule === 'string'
            ? stripeSub.schedule
            : (stripeSub.schedule?.id ?? undefined);

        const logger = createLogger({ fn: 'changeSubscription', orgId });
        const upgrade = isUpgrade(
          currentPlanId,
          currentPlan,
          targetPlanId,
          targetPlan,
        );

        // ====================================================================
        // PREVIEW: a quote, never a change. Same guards as the real call, but
        // NOTHING is mutated - no Stripe update, no schedule, no RTDB write.
        // Upgrades price the proration via the invoice preview API (the same
        // maths the real always_invoice update runs); downgrades charge
        // nothing now, so the quote is just the period boundary.
        // ====================================================================
        if (preview) {
          if (!upgrade) {
            return { effective: 'period_end', effectiveAt: periodEnd };
          }
          const customerId =
            typeof stripeSub.customer === 'string'
              ? stripeSub.customer
              : stripeSub.customer.id;
          const previewInvoice = await stripe.invoices.createPreview({
            customer: customerId,
            subscription: subscription.stripeSubscriptionId,
            subscription_details: {
              items: [{ id: item.id, price: targetPlan.stripePriceId }],
              proration_behavior: 'always_invoice',
            },
          });
          return {
            effective: 'immediate',
            effectiveAt: Date.now(),
            ...(typeof previewInvoice.total === 'number'
              ? { prorationAmountPence: previewInvoice.total }
              : {}),
          };
        }

        if (upgrade) {
          // ==================================================================
          // UPGRADE: immediate, prorated.
          // ==================================================================
          // A pending downgrade schedule must be released first: Stripe
          // refuses direct item updates on a schedule-managed subscription,
          // and the upgrade supersedes the scheduled change anyway.
          if (existingScheduleId) {
            await stripe.subscriptionSchedules.release(existingScheduleId);
          }
          const updated = await stripe.subscriptions.update(
            subscription.stripeSubscriptionId,
            {
              items: [{ id: item.id, price: targetPlan.stripePriceId }],
              proration_behavior: 'always_invoice',
              // always_invoice creates the proration invoice synchronously and
              // it becomes latest_invoice - expanding it here is the cheap way
              // to surface the delta charged, with no extra API call.
              expand: ['latest_invoice'],
            },
          );
          const latestInvoice = updated.latest_invoice;
          const prorationAmountPence =
            latestInvoice &&
            typeof latestInvoice === 'object' &&
            typeof latestInvoice.total === 'number'
              ? latestInvoice.total
              : undefined;

          // Audit entry; plus the ONE optimistic correction the upgrade owes:
          // a released downgrade schedule makes any stored pendingPlanId a
          // now-false promise, so it is cleared (the webhook confirms).
          const update: Record<string, unknown> = {
            ...activityUpdate(envPaths, orgId, {
              actorUid: uid,
              action: 'billing.plan.upgraded',
              target: orgId,
            }),
          };
          if (existingScheduleId) {
            update[`${subscriptionPath}/pendingPlanId`] = null;
          }
          await db.ref().update(update);

          logger.info('Subscription upgraded', {
            from: currentPlanId,
            to: targetPlanId,
            releasedSchedule: existingScheduleId ?? null,
          });
          return {
            effective: 'immediate',
            effectiveAt: Date.now(),
            ...(prorationAmountPence !== undefined
              ? { prorationAmountPence }
              : {}),
          };
        }

        // ====================================================================
        // DOWNGRADE: at period end, via a subscription schedule.
        // ====================================================================
        // A second downgrade while one is pending: release the stale schedule
        // and recreate from the live subscription, rather than surgically
        // editing phases - from_subscription re-derives the current phase
        // exactly, which is simpler and cannot drift from Stripe's own view.
        if (existingScheduleId) {
          await stripe.subscriptionSchedules.release(existingScheduleId);
        }
        // from_subscription creates a schedule whose single phase mirrors the
        // live subscription through the current period end. The update then
        // restates that phase VERBATIM (Stripe requires the in-flight phase to
        // be passed back unchanged) and appends the cheaper price as the next
        // phase; end_behavior 'release' hands the subscription back to normal
        // management once the change has landed.
        const schedule = await stripe.subscriptionSchedules.create({
          from_subscription: subscription.stripeSubscriptionId,
        });
        const currentPhase = schedule.phases[0];
        await stripe.subscriptionSchedules.update(schedule.id, {
          end_behavior: 'release',
          phases: [
            {
              items: [{ price: item.price.id, quantity: item.quantity ?? 1 }],
              start_date: currentPhase.start_date,
              end_date: currentPhase.end_date,
            },
            {
              items: [
                { price: targetPlan.stripePriceId, quantity: item.quantity ?? 1 },
              ],
            },
          ],
        });

        // Optimistic pendingPlanId (the one field the plan allows) plus the
        // audit entry, in ONE update; the webhook confirms when the schedule's
        // second phase starts.
        await db.ref().update({
          [`${subscriptionPath}/pendingPlanId`]: targetPlanId,
          ...activityUpdate(envPaths, orgId, {
            actorUid: uid,
            action: 'billing.plan.downgradeScheduled',
            target: orgId,
          }),
        });

        logger.info('Subscription downgrade scheduled', {
          from: currentPlanId,
          to: targetPlanId,
          scheduleId: schedule.id,
          effectiveAt: periodEnd,
        });
        return { effective: 'period_end', effectiveAt: periodEnd };
      },
    ),
);
