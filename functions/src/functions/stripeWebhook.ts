// ============================================================================
// stripeWebhook - the Stripe event receiver (Phase 3, plan section 4).
//
// THE FIRST v2 onRequest FUNCTION IN THIS CODEBASE. Every other Function is an
// onCall behind callableOptions (App Check + auth asserted in-body), but Stripe
// is not a Functions-SDK client: it POSTs raw JSON with an HMAC signature. So
// this endpoint sits deliberately OUTSIDE App Check and callableOptions - its
// sole authentication is `stripe.webhooks.constructEvent` verifying the
// `stripe-signature` header over `req.rawBody` against our signing secret
// (which is exactly why it must be an onRequest: only onRequest exposes the
// raw, unparsed body the signature is computed over).
//
// Mode model (plan 4.1): ONE deployed endpoint, TWO Stripe webhook endpoints
// registered against it - `?mode=test` and `?mode=live` - each with its own
// signing secret. The mode picks the secret, the verified event's `livemode`
// flag is cross-checked against it, and the env tree written is the mode
// (`test` -> /test, `live` -> /live), so a test-mode event can never touch
// live revenue data even if an endpoint is misregistered.
//
// Idempotency (plan 4.3): claim-before-act on ops/stripeEvents/{env}/{eventId}.
// Stripe retries until it sees 2xx, so: duplicate claim -> 200 (work is in
// flight or done); success -> done-marker persists as the idempotency record;
// thrown error -> claim RELEASED + 500 so the retry can reprocess.
//
// Truth model (plan 4.3): the event payload is only a NOTIFICATION. Object
// state is re-fetched from the Stripe API before any RTDB write, because
// events can arrive out of order and `event.data.object` is a point-in-time
// snapshot that may already be stale; re-fetching makes ordering irrelevant -
// whatever event lands, the write reflects current truth.
// ============================================================================

import { onRequest } from 'firebase-functions/v2/https';
import type { Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import type Stripe from 'stripe';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import type { Logger } from '../lib/logging';
import { forEnv, platform, usersOnboarding } from '../lib/paths';
import {
  STRIPE_SECRETS,
  stripeForEnv,
  webhookSecretForMode,
  claimStripeEvent,
  markStripeEventDone,
  releaseStripeEvent,
  orgForStripeCustomer,
  recordStripeCustomer,
} from '../lib/stripe';
import { provisionOrganisation } from '../lib/provisionOrganisation';
import { isSuspendedStatus } from '../lib/entitlements';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { loadKindConfig, sendKindEmail } from '../lib/templatedEmail';
import { orgEmailBrand } from '../lib/emailTemplates';
import { WEB_ORIGIN } from '../lib/webOrigin';
import type {
  EmailKindId,
  Environment,
  FinanceEvent,
  FinanceEventType,
  OrgMember,
  OrgProfile,
  OrgSubscription,
  Plan,
  SubscriptionStatus,
  UserOnboarding,
} from '../shared/types';

// ============================================================================
// Constants
// ============================================================================

/** Grace window opened on the first failed payment (plan 3.5): entitlements
 *  stay untouched for 14 days - never degrade a live safety tool over a card
 *  hiccup. */
const GRACE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The exact subscribed-event list (plan 4.2). Anything else returns 200
 *  immediately WITHOUT claiming: an unhandled type performs no writes, so
 *  there is no idempotency to protect, and skipping the claim keeps the
 *  ops/stripeEvents tree from accumulating markers for events we ignore. */
const HANDLED_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'payment_method.attached',
  'payment_method.detached',
  'payment_method.automatically_updated',
  'customer.updated',
  'charge.refunded',
  'setup_intent.succeeded',
]);

// ============================================================================
// Small helpers
// ============================================================================

/** Drop undefined values so the object is safe for an RTDB `update` (which
 *  rejects undefined; null is the explicit "delete this key" signal). */
function prune<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** Stripe expandable fields are `string | Object` - collapse to the id. */
function idOf(ref: string | { id: string } | null | undefined): string | undefined {
  if (typeof ref === 'string') {
    return ref;
  }
  return ref?.id;
}

/** Non-empty-string metadata value, else undefined. */
function metaString(
  metadata: Stripe.Metadata | null | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ============================================================================
// Subscription snapshot mapping (plan 4.4)
// ============================================================================

/** Stripe's status union -> our mirrored SubscriptionStatus. `incomplete` and
 *  `incomplete_expired` both collapse to 'incomplete' (the org, if any, was
 *  never entitled); `paused` has no home in our vocabulary (we never pause
 *  collection) so it maps to 'unpaid' - the safe direction: it degrades to
 *  blocked-creates rather than silently granting entitlement. */
function mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'incomplete':
    case 'incomplete_expired':
      return 'incomplete';
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'unpaid':
    default:
      return 'unpaid';
  }
}

/** planId from the price lookup key `safentia_{planId}_monthly` (plan section
 *  2 naming), parsed defensively: a renamed or absent lookup key falls back to
 *  the subscription's `metadata.planId` (set by createSubscription), and an
 *  unresolvable plan yields undefined rather than a junk id. */
function planIdFromSubscription(sub: Stripe.Subscription): string | undefined {
  const lookupKey = sub.items?.data?.[0]?.price?.lookup_key;
  if (typeof lookupKey === 'string') {
    const match = /^safentia_(.+)_monthly$/.exec(lookupKey);
    if (match) {
      return match[1];
    }
  }
  return metaString(sub.metadata, 'planId');
}

/**
 * Map a re-fetched Stripe subscription to the OrgSubscription block. Note
 * `current_period_end` lives on the subscription ITEM in the pinned API
 * version (2026-07-29.dahlia moved it off the subscription object); seconds ->
 * ms epoch for RTDB.
 */
function subscriptionSnapshot(sub: Stripe.Subscription): OrgSubscription {
  const item = sub.items?.data?.[0];
  const periodEnd = item?.current_period_end;
  return prune({
    stripeCustomerId: idOf(sub.customer),
    stripeSubscriptionId: sub.id,
    status: mapStatus(sub.status),
    planId: planIdFromSubscription(sub),
    priceId: item?.price?.id,
    currentPeriodEnd: typeof periodEnd === 'number' ? periodEnd * 1000 : undefined,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    updatedAt: Date.now(),
  });
}

/**
 * Write the subscription snapshot to organisations/{orgId}/subscription via
 * `update` (merge): fields the webhook does not own (e.g. pendingPlanId,
 * paymentState written by the dunning handlers) survive unless `extra`
 * explicitly nulls them.
 *
 * Every status transition also maintains the MEMBER-READABLE suspension
 * mirror, organisations/{orgId}/profile/suspended (SEV-1 fix): the
 * subscription node is admin-read by design, so this single boolean is what
 * lets non-admin staff see an honest "subscription paused" notice instead of
 * raw server errors. It is derived from the same isSuspendedStatus predicate
 * the entitlements module resolves suspension with, so the flag and the
 * zero-create floor can never disagree. The webhook is its ONLY writer:
 * updateOrgProfile's field whitelist rejects `suspended` from client input,
 * and the rules deny all client writes under /organisations.
 */
async function writeSubscriptionSnapshot(
  env: Environment,
  orgId: string,
  sub: Stripe.Subscription,
  extra: Partial<Record<keyof OrgSubscription, unknown>> = {},
): Promise<void> {
  const { db } = await import('../admin');
  const snapshot = { ...subscriptionSnapshot(sub), ...extra };
  await db.ref(forEnv(env).db.orgSubscription(orgId)).update(snapshot);
  const status =
    typeof snapshot.status === 'string'
      ? (snapshot.status as SubscriptionStatus)
      : undefined;
  await db.ref(forEnv(env).db.orgProfile(orgId)).update({
    // null DELETES the key, so a healthy org's profile carries no billing
    // residue at all - the flag exists only while the org is suspended.
    suspended: isSuspendedStatus(status) ? true : null,
  });
}

// ============================================================================
// Org resolution + finance feed
// ============================================================================

/** orgId from object metadata first (subscription/invoice/setup-intent
 *  metadata carries it once an org exists), else the customer reverse index
 *  (plan 4.3). Null = genuinely unknown - the caller logs and returns 200,
 *  because an unknown org is a fact, not a retryable failure. */
async function resolveOrgId(
  env: Environment,
  metadata: Stripe.Metadata | null | undefined,
  customerId: string | undefined,
): Promise<string | null> {
  const fromMetadata = metaString(metadata, 'orgId');
  if (fromMetadata) {
    return fromMetadata;
  }
  if (customerId) {
    return orgForStripeCustomer(env, customerId);
  }
  return null;
}

/**
 * Write one entry to the super-admin finance feed (plan 5.5). Only events the
 * mirrored FinanceEventType vocabulary can express are fed: payments, failures,
 * refunds and subscription lifecycle. Card-maintenance events (setup_intent /
 * payment_method.* / customer.updated) update the paymentMethod block but write
 * NO feed entry - the plan's 5.5 type union deliberately excludes them, and the
 * union is the mirrored contract. `orgName` is denormalised from the org
 * profile at write time (one cheap read) so the feed renders without lookups.
 *
 * IDEMPOTENT BY CONSTRUCTION: the child key is the Stripe event id (`set`, not
 * `push`), so a redelivery that reprocesses (e.g. after a released or
 * stale-reclaimed claim) overwrites its own entry rather than double-counting
 * revenue. That is safe because every handler feeds AT MOST ONE entry per
 * event - each dispatch branch calls this at most once. The FinancePage reads
 * the feed orderByChild('at'), so the key shape is invisible to the UI.
 */
async function appendFinanceEvent(
  env: Environment,
  stripeEventId: string,
  orgId: string,
  type: FinanceEventType,
  extras: { planId?: string; amountPence?: number; currency?: string } = {},
): Promise<void> {
  const { db } = await import('../admin');
  let orgName = '';
  if (orgId) {
    const snapshot = await db.ref(forEnv(env).db.orgProfile(orgId)).get();
    const profile: unknown = snapshot.val();
    if (
      profile &&
      typeof profile === 'object' &&
      typeof (profile as { name?: unknown }).name === 'string'
    ) {
      orgName = (profile as { name: string }).name;
    }
  }
  const entry: FinanceEvent = prune({
    at: Date.now(),
    type,
    orgId,
    orgName,
    stripeEventId,
    ...extras,
  });
  await db.ref(platform.financeEvent(env, stripeEventId)).set(entry);
}

// ============================================================================
// Billing emails (Phase 3 assessment HIGH 1)
//
// Stripe's own dunning emails are OFF - we own the comms - so the webhook is
// where the organisation hears about its money: a payment failure, a receipt,
// the subscription ending. Everything here is BEST-EFFORT BY CONSTRUCTION: the
// fan-out helper catches its own failures, because an email hiccup must never
// 500 the webhook (the state writes above it have already committed, and a
// Stripe retry would find the event claim held and do nothing - failing the
// response would only mark a healthy delivery as failed in the dashboard).
//
// The audience is the org's ACTIVE ADMINS (the customerContracts precedent):
// billing is admin-read everywhere else in the product, so admins are who can
// act on these. Per-member emailPreferences do NOT gate any of them - they are
// not one of the quietenable member categories - and the two toggleAllowed:
// false kinds ('payment-failed', 'subscription-ended') cannot be silenced at
// the org level either; sendKindEmail still honours the org toggle for
// 'payment-receipt'.
// ============================================================================

/** The three billing kinds this webhook sends; a narrowed alias so a send site
 *  cannot pass a non-billing kind by accident. */
type BillingEmailKind = Extract<
  EmailKindId,
  'payment-failed' | 'payment-receipt' | 'subscription-ended'
>;

/** Where every billing CTA points: the org admin's Billing tab. */
const BILLING_URL = `${WEB_ORIGIN}/app/settings/billing`;

/** Pence -> pounds, always with the pence shown ("£129.00", never "£129") -
 *  the BillingSettingsPage.formatPence contract, so email and console state
 *  the same figure the same way. */
function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** A deadline or period date, written the way a person reads a date (the
 *  customerContracts formatDate contract). */
function formatDay(millis: number): string {
  return new Date(millis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The plan's display name for receipt copy, falling back to the raw planId
 *  (an unseeded catalogue must not blank the receipt) and to '' when the org
 *  has no plan at all. Read failures fall back the same way - this feeds copy,
 *  never a decision. */
async function planDisplayName(
  env: Environment,
  planId: string | undefined,
): Promise<string> {
  if (!planId) {
    return '';
  }
  try {
    const { db } = await import('../admin');
    const snapshot = await db.ref(platform.plan(env, planId)).get();
    const plan = snapshot.val() as Plan | null;
    return plan?.name ?? planId;
  } catch {
    return planId;
  }
}

/**
 * Fan one billing email kind out to every active org admin. One members read,
 * one profile read, ONE loadKindConfig hoisted across the audience (the
 * customerContracts pattern), then sendKindEmail per admin - which itself
 * never throws. The whole helper is wrapped so no billing-email failure can
 * ever escape into the webhook response.
 */
async function sendBillingEmailToAdmins(
  env: Environment,
  orgId: string,
  kind: BillingEmailKind,
  variables: Record<string, string>,
  logger: Logger,
): Promise<void> {
  try {
    const { db } = await import('../admin');
    const paths = forEnv(env).db;
    const [membersSnap, profileSnap] = await Promise.all([
      db.ref(paths.orgMembers(orgId)).get(),
      db.ref(paths.orgProfile(orgId)).get(),
    ]);
    const members =
      (membersSnap.val() as Record<string, OrgMember> | null) ?? {};
    const admins = Object.values(members).filter(
      (member) =>
        member?.status === 'active' &&
        member.roles?.admin === true &&
        typeof member.email === 'string' &&
        member.email.length > 0,
    );
    if (admins.length === 0) {
      // Every org is provisioned with an admin, so this is a data fault worth
      // a warning - but it is still only an email that cannot land.
      logger.warn('Billing email found no active admin recipients', {
        orgId,
        kind,
      });
      return;
    }
    const profile = profileSnap.val() as OrgProfile | null;
    const orgName = profile?.name ?? 'Your organisation';
    const brand = orgEmailBrand(profile);
    const config = await loadKindConfig(env, orgId, kind, logger);
    for (const admin of admins) {
      await sendKindEmail(
        {
          kind,
          env,
          orgId,
          to: admin.email as string,
          variables: { 'org.name': orgName, ...variables },
          brand,
          kindLink: BILLING_URL,
          config,
        },
        logger,
      );
    }
  } catch (error) {
    // Best-effort contract (header note): the state writes are committed and
    // the response must stay 200 - log loudly and move on.
    logger.warn('Billing email fan-out failed; webhook state is unaffected', {
      orgId,
      kind,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================================
// Onboarding provisioning (plan 3.1 step 5)
// ============================================================================

/** Read usersOnboarding/{uid}, or null when absent/malformed. */
async function readOnboarding(uid: string): Promise<UserOnboarding | null> {
  const { db } = await import('../admin');
  const snapshot = await db.ref(usersOnboarding(uid)).get();
  const value: unknown = snapshot.val();
  return value && typeof value === 'object' ? (value as UserOnboarding) : null;
}

/**
 * Provision the organisation for a first-subscribe onboarding, if this
 * subscription is one and it has just become entitled. Trigger conditions:
 * the subscription's `metadata.onboardingUid` (stamped by createSubscription)
 * names an onboarding record that references THIS subscription and has no
 * orgId yet, and the mapped status is 'active' or 'trialing'.
 *
 * Both `customer.subscription.updated -> active` and `invoice.paid` route
 * here - whichever webhook event lands first wins, and the loser is a no-op
 * because provisionOrganisation is idempotent per stripeSubscriptionId (and
 * the already-provisioned record short-circuits before even calling it).
 *
 * Returns the orgId when this subscription belongs to an onboarding journey,
 * with `provisionedNow` distinguishing THIS event's provisioning from a
 * previously-provisioned record (the feed vocabulary depends on it: only the
 * event that actually founded the org is 'subscription_started'); null when
 * the subscription is not an onboarding one.
 */
async function maybeProvisionOnboarding(
  env: Environment,
  sub: Stripe.Subscription,
  logger: Logger,
): Promise<{ orgId: string; provisionedNow: boolean } | null> {
  const uid = metaString(sub.metadata, 'onboardingUid');
  if (!uid) {
    return null;
  }
  const onboarding = await readOnboarding(uid);
  if (!onboarding || onboarding.subscriptionId !== sub.id) {
    // A stale or replaced onboarding (e.g. the user abandoned and re-subscribed,
    // pointing the record at a newer subscription): nothing to provision.
    logger.info('Onboarding record does not reference this subscription', {
      subscriptionId: sub.id,
    });
    return null;
  }
  if (onboarding.orgId) {
    // Already provisioned - resolve, do not re-run (and do not report this
    // event as the one that started the subscription).
    return { orgId: onboarding.orgId, provisionedNow: false };
  }
  const status = mapStatus(sub.status);
  if (status !== 'active' && status !== 'trialing') {
    return null; // Not yet entitled - a later event will trigger provisioning.
  }

  const { db, auth } = await import('../admin');
  const user = await auth.getUser(uid);
  const { orgId, alreadyProvisioned } = await provisionOrganisation(
    {
      env,
      uid,
      email: user.email ?? '',
      orgName: onboarding.orgDetails?.name ?? onboarding.orgName ?? '',
      ...(onboarding.orgDetails ? { orgDetails: onboarding.orgDetails } : {}),
      subscription: subscriptionSnapshot(sub),
    },
    logger,
  );
  logger.info('Organisation provisioned from webhook', { orgId, alreadyProvisioned });

  // Advance the onboarding record (the client is watching it - plan 3.1 step
  // 6) and write the customer reverse index so every later customer-level
  // event resolves to this org.
  await db.ref(usersOnboarding(uid)).update({ step: 'setup', orgId });
  const customerId = idOf(sub.customer);
  if (customerId) {
    await recordStripeCustomer(env, customerId, orgId);
  }
  // A lost provisioning race (alreadyProvisioned) still resolves the orgId,
  // but only the winning delivery reports provisionedNow.
  return { orgId, provisionedNow: !alreadyProvisioned };
}

// ============================================================================
// Per-event handlers (plan 4.4 mapping)
// ============================================================================

/** customer.subscription.created / customer.subscription.updated. */
async function handleSubscriptionUpsert(
  env: Environment,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  const raw = event.data.object as Stripe.Subscription;
  const sub = await stripe.subscriptions.retrieve(raw.id);

  // Provisioning first: for a first-subscribe journey the org does not exist
  // until this call creates it, and it returns the orgId the snapshot below
  // must land under.
  const onboardingOrg = await maybeProvisionOnboarding(env, sub, logger);
  const orgId =
    onboardingOrg?.orgId ??
    (await resolveOrgId(env, sub.metadata, idOf(sub.customer)));
  if (!orgId) {
    // Pre-provisioning onboarding subscription (still incomplete) or a
    // genuinely unknown customer: nothing to write yet - log and 200.
    logger.info('Subscription event with no resolvable org', {
      subscriptionId: sub.id,
      eventType: event.type,
    });
    return;
  }

  // Prior snapshot read BEFORE the new one lands: the subscription-ended
  // email below is TRANSITION-gated (it goes out once, when the org first
  // drops to an unentitled status, never on every event that repeats it), and
  // the plan_changed feed gate below compares against the same prior state.
  const { db } = await import('../admin');
  const prior = (
    await db.ref(forEnv(env).db.orgSubscription(orgId)).get()
  ).val() as OrgSubscription | null;

  await writeSubscriptionSnapshot(env, orgId, sub);

  // The display card. Checkout saves the card as the SUBSCRIPTION's default
  // (save_default_payment_method: 'on_subscription'), so the customer's
  // invoice_settings stays empty and the customer-level refresh would show
  // "no card on file" for every self-serve subscriber. The subscription's own
  // default is the truth here; when it has one, mirror it. Best-effort - a
  // card block must never fail a state write.
  const subPmId = idOf(sub.default_payment_method);
  if (subPmId) {
    try {
      const pm = await stripe.paymentMethods.retrieve(subPmId);
      await writePaymentMethodBlock(env, orgId, pm);
    } catch (error) {
      logger.warn('Subscription default card mirror failed', {
        orgId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Feed vocabulary: the event that just provisioned an org (or a
  // subscription created against an existing org) is 'subscription_started'.
  // Any OTHER update feeds 'plan_changed' ONLY when the resolved plan (planId
  // or priceId) actually differs from the prior stored snapshot - renewals,
  // metadata edits and dunning status moves rewrite state above but feed
  // nothing, so a real plan change is never buried in every-event noise. An
  // absent prior snapshot cannot prove sameness, so it feeds (a genuinely
  // first-seen shape for this org is worth an operator line).
  const planId = planIdFromSubscription(sub);
  const priceId = sub.items?.data?.[0]?.price?.id;
  const isStart =
    onboardingOrg?.provisionedNow ||
    event.type === 'customer.subscription.created';
  const planChanged =
    !prior || prior.planId !== planId || prior.priceId !== priceId;
  if (isStart || planChanged) {
    const type: FinanceEventType = isStart
      ? 'subscription_started'
      : 'plan_changed';
    await appendFinanceEvent(env, event.id, orgId, type, { planId });
  }

  // Grace exhausted (plan 3.5): Stripe gave up retrying and marked the
  // subscription unpaid. Tell the admins ONCE - only when the org was not
  // already suspended (a prior unpaid/canceled/incomplete org has had this
  // email, or its access never began) - and never fail the webhook over it.
  if (
    mapStatus(sub.status) === 'unpaid' &&
    !isSuspendedStatus(prior?.status)
  ) {
    await sendBillingEmailToAdmins(env, orgId, 'subscription-ended', {}, logger);
  }
}

/** customer.subscription.deleted. */
async function handleSubscriptionDeleted(
  env: Environment,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  const raw = event.data.object as Stripe.Subscription;
  // Deleted subscriptions remain retrievable, so the re-fetch-truth rule still
  // applies (the retrieved status distinguishes canceled vs incomplete_expired).
  const sub = await stripe.subscriptions.retrieve(raw.id);

  // Abandoned first-subscribe: Stripe expires an untouched `incomplete`
  // subscription after ~23h as `incomplete_expired`. If an onboarding record
  // references it (and was never provisioned), reset the journey to the plan
  // step so the user can start over cleanly (plan 3.1 step 8).
  if (sub.status === 'incomplete_expired') {
    const uid = metaString(sub.metadata, 'onboardingUid');
    if (uid) {
      const onboarding = await readOnboarding(uid);
      if (onboarding && onboarding.subscriptionId === sub.id && !onboarding.orgId) {
        const { db } = await import('../admin');
        // `set` rather than `update`: the reset must CLEAR the payment fields
        // (planId, stripeCustomerId, subscriptionId), keeping only the journey
        // origin.
        const resetRecord: UserOnboarding = {
          step: 'plan',
          createdAt: onboarding.createdAt,
        };
        await db.ref(usersOnboarding(uid)).set(resetRecord);
        logger.info('Onboarding reset after incomplete_expired subscription', {
          subscriptionId: sub.id,
        });
        return; // No org ever existed: nothing else to write.
      }
    }
  }

  const orgId = await resolveOrgId(env, sub.metadata, idOf(sub.customer));
  if (!orgId) {
    logger.info('Subscription deletion with no resolvable org', {
      subscriptionId: sub.id,
    });
    return;
  }
  // Prior status BEFORE the write, for the same transition gate the upsert
  // handler applies: an org that was already suspended (unpaid grace
  // exhaustion, an earlier cancellation, an expired restart attempt) has
  // already had its subscription-ended email.
  const { db } = await import('../admin');
  const prior = (
    await db.ref(forEnv(env).db.orgSubscription(orgId)).get()
  ).val() as OrgSubscription | null;

  // Status forced to 'canceled': whatever terminal state Stripe reports, the
  // org's subscription is over. Dunning state is cleared - there is nothing
  // left to collect.
  await writeSubscriptionSnapshot(env, orgId, sub, {
    status: 'canceled',
    paymentState: null,
    graceUntil: null,
  });
  await appendFinanceEvent(env, event.id, orgId, 'subscription_canceled', {
    planId: planIdFromSubscription(sub),
  });

  // The final-cancellation notice (best-effort, transition-gated as above).
  if (!isSuspendedStatus(prior?.status)) {
    await sendBillingEmailToAdmins(env, orgId, 'subscription-ended', {}, logger);
  }
}

/** Resolve the subscription an invoice belongs to (dahlia API: the linkage
 *  lives at invoice.parent.subscription_details.subscription). */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  return idOf(invoice.parent?.subscription_details?.subscription);
}

/** invoice.paid / invoice.payment_failed / invoice.payment_action_required. */
async function handleInvoiceEvent(
  env: Environment,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  const raw = event.data.object as Stripe.Invoice;
  const invoice = await stripe.invoices.retrieve(raw.id as string);
  const subId = invoiceSubscriptionId(invoice);
  const sub = subId ? await stripe.subscriptions.retrieve(subId) : null;

  // invoice.paid is often the FIRST event that proves a new subscription is
  // funded, so it must also be able to drive first-subscribe provisioning
  // (whichever of it and subscription.updated lands first wins; the helper is
  // idempotent).
  const onboardingOrg =
    event.type === 'invoice.paid' && sub
      ? await maybeProvisionOnboarding(env, sub, logger)
      : null;

  const orgId =
    onboardingOrg?.orgId ??
    (await resolveOrgId(
      env,
      sub?.metadata ?? invoice.metadata,
      idOf(invoice.customer),
    ));
  if (!orgId) {
    logger.info('Invoice event with no resolvable org', {
      invoiceId: invoice.id,
      eventType: event.type,
    });
    return;
  }

  const { db } = await import('../admin');
  const subscriptionRef = db.ref(forEnv(env).db.orgSubscription(orgId));

  switch (event.type) {
    case 'invoice.paid': {
      // Dunning cleared (plan 3.5): explicit nulls DELETE the keys. The fresh
      // subscription snapshot also lands the rolled-forward currentPeriodEnd.
      if (sub) {
        await writeSubscriptionSnapshot(env, orgId, sub, {
          paymentState: null,
          graceUntil: null,
        });
      } else {
        await subscriptionRef.update({
          paymentState: null,
          graceUntil: null,
          updatedAt: Date.now(),
        });
      }
      await appendFinanceEvent(env, event.id, orgId, 'payment', {
        planId: sub ? planIdFromSubscription(sub) : undefined,
        amountPence: invoice.amount_paid,
        currency: invoice.currency,
      });
      // Receipt to the org admins (best-effort - the fan-out helper absorbs
      // its own failures). Every PAID invoice earns one; a £0 invoice (plan
      // credit, a full-discount period) is bookkeeping, not a payment.
      if (invoice.amount_paid > 0) {
        const paidItem = sub?.items?.data?.[0];
        const paidPeriodEnd = paidItem?.current_period_end;
        await sendBillingEmailToAdmins(
          env,
          orgId,
          'payment-receipt',
          {
            'invoice.amountFormatted': formatPence(invoice.amount_paid),
            'invoice.number': invoice.number ?? invoice.id ?? '',
            'plan.name': await planDisplayName(
              env,
              sub ? planIdFromSubscription(sub) : undefined,
            ),
            'period.endDate':
              typeof paidPeriodEnd === 'number'
                ? formatDay(paidPeriodEnd * 1000)
                : '',
            'invoice.url': invoice.hosted_invoice_url ?? '',
          },
          logger,
        );
      }
      return;
    }
    case 'invoice.payment_failed': {
      // Transition detection BEFORE the write: the payment-failed email goes
      // out on the FIRST failure of a dunning cycle only. Stripe retries the
      // card for days and fires this event each time; an org already past_due
      // has had its warning, and repeating it every retry is noise that
      // teaches admins to ignore the one email they must not.
      const prior = (await subscriptionRef.get()).val() as
        | OrgSubscription
        | null;
      const alreadyPastDue = prior?.paymentState === 'past_due';

      // Open the 14-day grace window (plan 3.5). Entitlements stay untouched
      // while it runs - the banner and the Billing tab do the chasing. The
      // window ANCHORS at the cycle's first failure: now that grace expiry is
      // enforced (lib/entitlements.isGraceExpired), letting every retry roll
      // the deadline forward would quietly break the date the first email
      // promised - so a retry keeps the deadline it inherited.
      const graceUntil =
        alreadyPastDue && typeof prior?.graceUntil === 'number'
          ? prior.graceUntil
          : Date.now() + GRACE_WINDOW_MS;
      await subscriptionRef.update({
        paymentState: 'past_due',
        graceUntil,
        updatedAt: Date.now(),
      });
      await appendFinanceEvent(env, event.id, orgId, 'payment_failed', {
        amountPence: invoice.amount_due,
        currency: invoice.currency,
      });
      if (!alreadyPastDue) {
        await sendBillingEmailToAdmins(
          env,
          orgId,
          'payment-failed',
          {
            'invoice.amountFormatted': formatPence(invoice.amount_due),
            'invoice.number': invoice.number ?? invoice.id ?? '',
            'grace.endDate': formatDay(graceUntil),
          },
          logger,
        );
      }
      return;
    }
    case 'invoice.payment_action_required': {
      // 3DS or similar challenge outstanding: no grace window - the money is
      // not failing, it is waiting on the cardholder (plan 3.5).
      await subscriptionRef.update({
        paymentState: 'action_required',
        updatedAt: Date.now(),
      });
      // Feed vocabulary has no 'action_required'; 'payment_failed' is the
      // truthful nearest term - the collection attempt did not complete.
      await appendFinanceEvent(env, event.id, orgId, 'payment_failed', {
        amountPence: invoice.amount_due,
        currency: invoice.currency,
      });
      return;
    }
  }
}

/** Refresh the display-only paymentMethod block (brand/last4/exp - SAQ-A:
 *  nothing beyond display metadata is ever stored) from a PaymentMethod. */
async function writePaymentMethodBlock(
  env: Environment,
  orgId: string,
  pm: Stripe.PaymentMethod | null,
): Promise<void> {
  const { db } = await import('../admin');
  const block = pm?.card
    ? {
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      }
    : null; // No default card -> the block is deleted, the tab shows "no card".
  await db
    .ref(forEnv(env).db.orgSubscription(orgId))
    .update({ paymentMethod: block, updatedAt: Date.now() });
}

/** Re-read the customer's CURRENT default payment method and mirror it. The
 *  shared tail of every card-maintenance event: whatever the event claimed,
 *  the customer's invoice_settings is the truth. */
async function refreshPaymentMethodFromCustomer(
  env: Environment,
  stripe: Stripe,
  customerId: string,
  logger: Logger,
): Promise<void> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) {
    logger.info('Card event for a deleted customer', { customerId });
    return;
  }
  const orgId = await resolveOrgId(env, customer.metadata, customerId);
  if (!orgId) {
    logger.info('Card event with no resolvable org', { customerId });
    return;
  }
  // Customer-level default first; failing that, the active subscription's own
  // default (where checkout's save_default_payment_method: 'on_subscription'
  // puts the card). Without the fallback, the payment_method.attached event
  // that fires seconds after checkout would DELETE the very card the
  // subscription just saved.
  let defaultPmId = idOf(customer.invoice_settings?.default_payment_method);
  if (!defaultPmId) {
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
    });
    defaultPmId = idOf(subs.data[0]?.default_payment_method);
  }
  const pm = defaultPmId
    ? await stripe.paymentMethods.retrieve(defaultPmId)
    : null;
  await writePaymentMethodBlock(env, orgId, pm);
}

/** setup_intent.succeeded - the card-update flow's server half (plan 3.4).
 *  The client only ever confirms the SetupIntent; making the new card the
 *  default and detaching the old one is done HERE, because the client is
 *  never trusted to finalise billing state. */
async function handleSetupIntentSucceeded(
  env: Environment,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  const raw = event.data.object as Stripe.SetupIntent;
  const si = await stripe.setupIntents.retrieve(raw.id);
  if (metaString(si.metadata, 'purpose') !== 'card_update') {
    // Some other SetupIntent (none exist today): acknowledge and ignore.
    logger.info('setup_intent.succeeded without card_update purpose', {
      setupIntentId: si.id,
    });
    return;
  }
  const customerId = idOf(si.customer);
  const newPmId = idOf(si.payment_method);
  if (!customerId || !newPmId) {
    logger.warn('card_update SetupIntent missing customer or payment method', {
      setupIntentId: si.id,
    });
    return;
  }
  const orgId = await resolveOrgId(env, si.metadata, customerId);
  if (!orgId) {
    logger.info('card_update SetupIntent with no resolvable org', { customerId });
    return;
  }

  // Swap the default: read the outgoing card first, promote the new one, then
  // detach the old (only when it is genuinely a different card - re-adding the
  // same card must not detach it).
  const customer = await stripe.customers.retrieve(customerId);
  const previousPmId = customer.deleted
    ? undefined
    : idOf(customer.invoice_settings?.default_payment_method);
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: newPmId },
  });
  if (previousPmId && previousPmId !== newPmId) {
    await stripe.paymentMethods.detach(previousPmId);
  }
  const pm = await stripe.paymentMethods.retrieve(newPmId);
  await writePaymentMethodBlock(env, orgId, pm);
  logger.info('Default payment method updated', { orgId });
}

/** payment_method.attached / detached / automatically_updated. */
async function handlePaymentMethodEvent(
  env: Environment,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  const raw = event.data.object as Stripe.PaymentMethod;
  // A detached payment method has customer:null on the object; the customer it
  // left is in previous_attributes. Either way the refresh reads the CUSTOMER'S
  // current default, so which PM the event was about does not matter.
  const previous = event.data.previous_attributes as
    | { customer?: string | { id: string } | null }
    | undefined;
  const customerId = idOf(raw.customer) ?? idOf(previous?.customer);
  if (!customerId) {
    logger.info('Payment-method event with no customer', { eventType: event.type });
    return;
  }
  await refreshPaymentMethodFromCustomer(env, stripe, customerId, logger);
}

/** customer.updated - sync default-PM changes (e.g. made in the Stripe
 *  dashboard) into the display block. */
async function handleCustomerUpdated(
  env: Environment,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  const raw = event.data.object as Stripe.Customer;
  await refreshPaymentMethodFromCustomer(env, stripe, raw.id, logger);
}

/** charge.refunded - finance feed only; subscription state is untouched (a
 *  refund does not change entitlement, and any status effect arrives via its
 *  own subscription event). */
async function handleChargeRefunded(
  env: Environment,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  const raw = event.data.object as Stripe.Charge;
  const charge = await stripe.charges.retrieve(raw.id);
  const orgId = await resolveOrgId(env, charge.metadata, idOf(charge.customer));
  if (!orgId) {
    logger.info('Refund with no resolvable org', { chargeId: charge.id });
    return;
  }
  await appendFinanceEvent(env, event.id, orgId, 'refund', {
    amountPence: charge.amount_refunded,
    currency: charge.currency,
  });
}

/** Route one claimed event to its handler (plan 4.4 table). */
async function dispatchEvent(
  env: Environment,
  stripe: Stripe,
  event: Stripe.Event,
  logger: Logger,
): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return handleSubscriptionUpsert(env, stripe, event, logger);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(env, stripe, event, logger);
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required':
      return handleInvoiceEvent(env, stripe, event, logger);
    case 'setup_intent.succeeded':
      return handleSetupIntentSucceeded(env, stripe, event, logger);
    case 'payment_method.attached':
    case 'payment_method.detached':
    case 'payment_method.automatically_updated':
      return handlePaymentMethodEvent(env, stripe, event, logger);
    case 'customer.updated':
      return handleCustomerUpdated(env, stripe, event, logger);
    case 'charge.refunded':
      return handleChargeRefunded(env, stripe, event, logger);
  }
}

// ============================================================================
// The HTTP handler (exported separately so the unit tests can drive it with a
// fake req/res without going through the Functions framework).
// ============================================================================

export async function stripeWebhookHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const logger = createLogger({ fn: 'stripeWebhook' });

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const mode = req.query.mode;
  if (mode !== 'test' && mode !== 'live') {
    res.status(400).send('Missing or invalid mode');
    return;
  }
  const env: Environment = mode;

  // Signature verification - the endpoint's entire authentication. Any failure
  // (absent header, wrong secret, tampered body) is a 400: Stripe treats 4xx
  // as delivery failure and surfaces it in the dashboard.
  let event: Stripe.Event;
  const stripe = stripeForEnv(env);
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      signature as string,
      webhookSecretForMode(mode),
    );
  } catch (error) {
    logger.warn('Webhook signature verification failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    res.status(400).send('Invalid signature');
    return;
  }

  // Cross-check: a live-mode event must arrive on the ?mode=live registration
  // and vice versa, or the endpoints were misregistered - reject rather than
  // write the wrong env tree.
  if (event.livemode !== (mode === 'live')) {
    logger.warn('Webhook livemode/mode mismatch', {
      eventId: event.id,
      livemode: event.livemode,
      mode,
    });
    res.status(400).send('livemode does not match endpoint mode');
    return;
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    res.status(200).send('Ignored');
    return;
  }

  // Claim-before-act (plan 4.3): lose the claim -> a previous delivery is in
  // flight or done -> acknowledge and stop.
  const claimed = await claimStripeEvent(env, event.id, event.type);
  if (!claimed) {
    logger.info('Duplicate webhook delivery', { eventId: event.id, type: event.type });
    res.status(200).send('Already handled');
    return;
  }

  try {
    await dispatchEvent(env, stripe, event, logger);
    await markStripeEventDone(env, event.id);
    res.status(200).send('OK');
  } catch (error) {
    // Release the claim and 500: Stripe retries with backoff, and the retry
    // will re-claim and reprocess from scratch (every handler is idempotent -
    // snapshot writes converge on API truth, provisioning is claimed).
    logger.error('Webhook processing failed', {
      eventId: event.id,
      type: event.type,
      reason: error instanceof Error ? error.message : String(error),
    });
    await releaseStripeEvent(env, event.id);
    res.status(500).send('Processing failed');
  }
}

/**
 * The deployed Function. maxInstances 5: webhook volume is a handful of events
 * per subscription per month, so 5 concurrent instances is generous headroom
 * while capping the blast radius of a runaway retry storm.
 */
export const stripeWebhook = onRequest(
  {
    region: REGION,
    // The email provider secret rides alongside the Stripe ones: the dunning
    // and receipt sends dispatch from this Function, and without the mounted
    // key they would degrade to logged intents (lib/email) on every event.
    secrets: [...STRIPE_SECRETS, ...EMAIL_PROVIDER_SECRETS],
    maxInstances: 5,
    // Pinned explicitly (it is also the platform default) because the
    // stale-claim reclaim in lib/stripe.ts depends on it: no invocation can
    // hold a 'processing' claim past this ceiling, so a claim older than
    // STALE_PROCESSING_CLAIM_MS (10 minutes - 10x this) is provably an orphan
    // and a Stripe retry may reclaim it. Stripe keeps retrying for days, far
    // beyond both figures, so a timed-out invocation always gets a redelivery.
    timeoutSeconds: 60,
  },
  stripeWebhookHandler,
);
