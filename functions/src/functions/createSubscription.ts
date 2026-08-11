// ============================================================================
// createSubscription (callable) - Phase 3 self-serve subscribe (plan 3.1.3, 9).
//
// The SECOND server step of self-serve onboarding (saveOnboardingDetails is
// the first): a signed-in, VERIFIED-email user with NO organisation picks a
// tier - their organisation's name and details were already saved to the
// onboarding node by saveOnboardingDetails, which is where the name is read
// from (the request's orgName field is deprecated and ignored) - and this callable
// creates the Stripe side of the journey - a Customer and an `incomplete`
// subscription (payment_behavior 'default_incomplete') - then records the
// resume point at usersOnboarding/{uid} and returns the invoice's client
// secret for the Payment Element. NO org exists yet: the org is provisioned by
// the Stripe webhook when the subscription first turns active (plan 3.1.5), so
// an abandoned checkout leaves nothing to roll back.
//
// This is the documented exception to the assertOrgRole canon (plan section 8):
// the caller has no org, so the gate is verified email + rate limit, and a
// caller who ALREADY holds an org claim is turned away (their billing lives in
// the org's Billing tab, not here).
//
// RESUMABILITY (plan 3.1.8). The onboarding node is the single resume point:
// if it already names a subscription that is still 'incomplete', we hand back
// THAT subscription's client secret instead of creating another; and the
// Stripe idempotency key (sub-create:{uid}:{planId}:{nonce}, nonce persisted
// in the node) makes the create itself retry-safe.
//
// STRIPE API NOTE: on the pinned API version (2026, lib/stripe.ts) the invoice
// no longer exposes `payment_intent` - the Payment Element secret is read from
// `latest_invoice.confirmation_secret` (the client_secret of the PaymentIntent
// Stripe creates at invoice finalisation), which is the current canonical
// subscribe-without-Checkout pattern.
// ============================================================================

import type Stripe from 'stripe';
import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions, generateToken } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth } from '../lib/guards';
import { platform, usersOnboarding } from '../lib/paths';
import { assertObject, requireEnum } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { isResumableOnboardingAttempt } from '../lib/billing';
import { signupEnv, STRIPE_SECRETS, stripeForEnv } from '../lib/stripe';
import type {
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  Plan,
  UserOnboarding,
} from '../shared/types';

/** The subscribable tiers. Literal ids per the plan (section 1.2). */
const PLAN_IDS = ['bronze', 'silver', 'gold'] as const;

/**
 * The organisation's name, read from the onboarding node the details step
 * wrote (orgDetails.name; the legacy orgName field is the fallback for a node
 * written before the details step existed). A node without one means the
 * caller skipped the details step - a state the UI cannot reach, said calmly
 * anyway. Pure and exported for the unit tests.
 */
export function onboardingOrgName(
  onboarding: UserOnboarding | null,
): string {
  const name = onboarding?.orgDetails?.name ?? onboarding?.orgName;
  if (!name) {
    throw fail.failedPrecondition(
      "Tell us about your organisation before choosing a plan - your details haven't been saved yet.",
    );
  }
  return name;
}

/** Pull the Payment Element client secret off an expanded subscription's
 *  latest invoice, or undefined when it is not there (unexpanded, or the
 *  invoice has no pending payment). */
function clientSecretOf(
  subscription: Stripe.Subscription,
): string | undefined {
  const invoice = subscription.latest_invoice;
  if (!invoice || typeof invoice === 'string') {
    return undefined;
  }
  return invoice.confirmation_secret?.client_secret ?? undefined;
}

export const createSubscription = onCall<CreateSubscriptionRequest>(
  { ...callableOptions, secrets: STRIPE_SECRETS },
  (request) =>
    runCallable<CreateSubscriptionResponse>(
      createLogger({ fn: 'createSubscription' }),
      async () => {
        const logger = createLogger({ fn: 'createSubscription' });

        // 1. Attestation + identity. NOT getClaims/assertOrgRole: the caller
        // has no org yet by definition. Email must be VERIFIED (plan section
        // 8) - a card should never be chargeable from an unverified address -
        // and present, because it becomes the Stripe Customer's email.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        const token = request.auth?.token;
        if (token?.email_verified !== true) {
          throw fail.failedPrecondition(
            'Please verify your email address before subscribing.',
          );
        }
        const email = token.email;
        if (typeof email !== 'string' || email.length === 0) {
          throw fail.failedPrecondition(
            'Your account has no email address, so it cannot start a subscription.',
          );
        }
        // A caller who already belongs to an organisation manages billing from
        // the org's Billing tab (changeSubscription), never by founding again.
        if (typeof token.orgId === 'string' && token.orgId.length > 0) {
          throw fail.failedPrecondition(
            'Your account already belongs to an organisation, so it cannot start a new subscription.',
          );
        }
        await assertRateLimit(uid, 'createSubscription');

        // 2. Validate the choice. Only the plan travels in the request now:
        // the org's name and details were saved to the onboarding node by
        // saveOnboardingDetails (a request-level orgName, sent by an older
        // client, is deprecated and ignored - the node is the truth).
        const input = assertObject(request.data);
        const planId = requireEnum(input, 'planId', PLAN_IDS);

        // 3. Env straight off the verified token (createOrganisation
        // precedent): there are no org claims to derive it from, and the
        // testMode claim maps one-to-one onto the Stripe mode (lib/stripe.ts).
        const env = signupEnv(token.testMode === true);

        // 4. The plan catalogue is the price source of truth; an unseeded env
        // is a deployment gap, not a client error.
        const planSnapshot = await db.ref(platform.plan(env, planId)).get();
        const plan = planSnapshot.val() as Plan | null;
        if (!plan?.stripePriceId) {
          throw fail.failedPrecondition(
            `Subscription plans are not yet configured for the '${env}' environment. ` +
              'Run the plans seed script for this Stripe mode (see STRIPE_SETUP.md) and try again.',
          );
        }

        const stripe = stripeForEnv(env);
        const onboarding = (
          await db.ref(usersOnboarding(uid)).get()
        ).val() as UserOnboarding | null;
        // The details step is a hard prerequisite: no node (or no name on it)
        // means nothing to found the organisation under.
        const orgName = onboardingOrgName(onboarding);

        // 4b. The node's Stripe ids are only meaningful in the mode that
        // minted them (node.env). An account whose testMode claim changed
        // between attempts (operator grant) carries ids the current mode's
        // API cannot even see - retrieving/cancelling/reusing them throws
        // resource_missing as an opaque 500. So a mode-mismatched node
        // contributes the buyer's TYPED DETAILS but none of its Stripe
        // state: no resume, no orphan cancel (unreachable cross-mode; the
        // abandoned incomplete subscription self-expires in ~23h), a fresh
        // customer and a fresh idempotency nonce. Nodes predating the env
        // stamp read as not-current on purpose - one clean restart beats
        // guessing.
        const modeMatched = onboarding?.env === env ? onboarding : null;
        if (onboarding && !modeMatched) {
          logger.info(
            'Onboarding node belongs to the other Stripe mode; starting the payment afresh',
            { uid, nodeEnv: onboarding.env ?? '(unstamped)', env },
          );
        }

        // 5. Resume before create (plan 3.1.8): an onboarding node that
        // already names a subscription FOR THIS PLAN which is still awaiting
        // payment gets that subscription's client secret back - never a
        // duplicate subscription. A re-pick of a DIFFERENT tier deliberately
        // does not resume (isResumableOnboardingAttempt): the old secret
        // would charge the abandoned tier's price, so it falls through to a
        // fresh create below.
        if (isResumableOnboardingAttempt(modeMatched, planId)) {
          const existing = await stripe.subscriptions.retrieve(
            modeMatched.subscriptionId,
            { expand: ['latest_invoice.confirmation_secret'] },
          );
          if (existing.status === 'incomplete') {
            const clientSecret = clientSecretOf(existing);
            if (clientSecret) {
              // The node already carries the current details (editing them
              // goes through saveOnboardingDetails, which preserves a
              // payment in flight), so there is nothing to re-write here.
              logger.info('Resuming incomplete subscription', {
                uid,
                subscriptionId: existing.id,
              });
              return {
                clientSecret,
                subscriptionId: existing.id,
                stripeCustomerId: modeMatched.stripeCustomerId,
              };
            }
          }
          // Expired/superseded (e.g. incomplete_expired after 23h): fall
          // through and create afresh below.
        }

        // 5b. A tier re-pick strands the previous attempt's incomplete
        // subscription (paying its invoice would charge the abandoned tier's
        // price), so cancel it before creating the new one. Best-effort by
        // design: Stripe throws when the subscription has already expired
        // (incomplete_expired self-cleans after ~23h) or been cancelled, and
        // neither must fail the flow - the fresh create below is the point.
        if (modeMatched?.subscriptionId && modeMatched.planId !== planId) {
          try {
            await stripe.subscriptions.cancel(modeMatched.subscriptionId);
            logger.info('Cancelled orphaned subscription from a tier re-pick', {
              uid,
              subscriptionId: modeMatched.subscriptionId,
            });
          } catch (error) {
            logger.warn('Orphaned subscription cancel failed; continuing', {
              uid,
              subscriptionId: modeMatched.subscriptionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // 6. Reuse the customer a previous attempt created IN THIS MODE, else
        // create one. The customer->org reverse index (lib/stripe.ts) is NOT
        // written here: no org exists yet, and provisionOrganisation writes
        // the mapping atomically with the org itself when the webhook
        // provisions it.
        const stripeCustomerId =
          modeMatched?.stripeCustomerId ??
          (
            await stripe.customers.create({
              email,
              name: orgName,
              metadata: { env, platform: 'safentia', onboardingUid: uid },
            })
          ).id;

        // 7. Create the incomplete subscription. The idempotency nonce is
        // persisted in the onboarding node so a retried call replays the SAME
        // Stripe request rather than minting a second subscription (fresh
        // when the node came from the other mode - its nonce belongs to the
        // request it made THERE).
        const attemptNonce = modeMatched?.attemptNonce ?? generateToken();
        const subscription = await stripe.subscriptions.create(
          {
            customer: stripeCustomerId,
            items: [{ price: plan.stripePriceId }],
            payment_behavior: 'default_incomplete',
            payment_settings: {
              save_default_payment_method: 'on_subscription',
            },
            metadata: { env, planId, onboardingUid: uid },
            expand: ['latest_invoice.confirmation_secret'],
          },
          { idempotencyKey: `sub-create:${uid}:${planId}:${attemptNonce}` },
        );
        const clientSecret = clientSecretOf(subscription);
        if (!clientSecret) {
          throw fail.internal(
            'Stripe did not return a payable invoice for the new subscription. Please try again shortly.',
          );
        }

        // 8. Record the resume point (plan 5.4). Server clock; createdAt is
        // preserved across retries so the node dates the FIRST attempt, and
        // orgDetails ride along so provisioning still has the full details.
        const nextOnboarding: UserOnboarding = {
          step: 'payment',
          planId,
          orgName,
          ...(onboarding?.orgDetails ? { orgDetails: onboarding.orgDetails } : {}),
          // Stamp which mode minted these ids, so a later mode flip discards
          // them instead of tripping over resource_missing (step 4b).
          env,
          stripeCustomerId,
          subscriptionId: subscription.id,
          attemptNonce,
          createdAt: onboarding?.createdAt ?? Date.now(),
        };
        await db.ref(usersOnboarding(uid)).set(nextOnboarding);

        logger.info('Subscription created', {
          uid,
          env,
          planId,
          subscriptionId: subscription.id,
        });
        return { clientSecret, subscriptionId: subscription.id, stripeCustomerId };
      },
    ),
);
