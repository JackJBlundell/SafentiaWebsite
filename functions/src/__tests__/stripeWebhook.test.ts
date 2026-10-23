// ============================================================================
// stripeWebhook - the Stripe event receiver's contract (plan section 4).
//
// The handler is driven directly with fake req/res, with every seam mocked:
// the Stripe client (retrieve calls + constructEvent), the admin RTDB, the
// claim helpers and provisionOrganisation. What is pinned here is the parts
// that guard money and tenant data: request gating (method/mode/signature/
// livemode), claim-before-act idempotency, the re-fetched subscription ->
// OrgSubscription snapshot mapping, first-subscribe provisioning, the dunning
// state machine, the finance feed, and the release-on-failure retry contract.
// ============================================================================

// Settable fake RTDB: path -> stored value. `mock`-prefixed so the hoisted
// jest.mock factories may close over them (templatedEmail.test.ts pattern).
const mockDbData: Record<string, unknown> = {};

/** Merge an update payload into the flat store; null values DELETE keys, the
 *  RTDB semantics the dunning-clear path depends on. */
function applyUpdate(path: string, payload: Record<string, unknown>): void {
  const current = { ...((mockDbData[path] as Record<string, unknown>) ?? {}) };
  for (const [key, value] of Object.entries(payload)) {
    if (value === null) {
      delete current[key];
    } else {
      current[key] = value;
    }
  }
  mockDbData[path] = current;
}

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      get: async () => ({ val: () => (path in mockDbData ? mockDbData[path] : null) }),
      update: async (payload: Record<string, unknown>) => applyUpdate(path, payload),
      set: async (value: unknown) => {
        mockDbData[path] = value;
      },
    }),
  },
  auth: {
    getUser: jest.fn(async () => ({ email: 'founder@example.com' })),
  },
}));

// The fake Stripe client the handler receives from the mocked stripeForEnv.
const mockStripe = {
  webhooks: { constructEvent: jest.fn() },
  subscriptions: {
    retrieve: jest.fn(),
    // The card-maintenance fallback (no customer default -> the active
    // subscription's own default) lists subscriptions; empty by default so
    // existing detach/attach cases keep their no-card outcome.
    list: jest.fn(async () => ({ data: [] })),
  },
  invoices: { retrieve: jest.fn() },
  setupIntents: { retrieve: jest.fn() },
  paymentMethods: { retrieve: jest.fn(), detach: jest.fn() },
  customers: { retrieve: jest.fn(), update: jest.fn() },
  charges: { retrieve: jest.fn() },
};

jest.mock('../lib/stripe', () => ({
  STRIPE_SECRETS: [],
  stripeForEnv: jest.fn(() => mockStripe),
  webhookSecretForMode: jest.fn(() => 'whsec_fake'),
  claimStripeEvent: jest.fn(async () => true),
  markStripeEventDone: jest.fn(async () => undefined),
  releaseStripeEvent: jest.fn(async () => undefined),
  orgForStripeCustomer: jest.fn(async () => null),
  recordStripeCustomer: jest.fn(async () => undefined),
}));

jest.mock('../lib/provisionOrganisation', () => ({
  provisionOrganisation: jest.fn(async () => ({
    orgId: 'org-new',
    alreadyProvisioned: false,
  })),
}));

// The templated-email seam, mocked whole: what the webhook contract owns is
// WHICH kind goes to WHOM on WHICH transition, not the rendering (that has its
// own suites). loadKindConfig resolves the enabled default so the fan-out
// reaches sendKindEmail.
jest.mock('../lib/templatedEmail', () => ({
  loadKindConfig: jest.fn(async (_env: string, _orgId: string, kind: string) => ({
    kind,
    enabled: true,
    template: null,
    brandingAllowed: true,
  })),
  sendKindEmail: jest.fn(async () => true),
}));

import {
  claimStripeEvent,
  markStripeEventDone,
  releaseStripeEvent,
  orgForStripeCustomer,
  recordStripeCustomer,
} from '../lib/stripe';
import { provisionOrganisation } from '../lib/provisionOrganisation';
import { loadKindConfig, sendKindEmail } from '../lib/templatedEmail';
import { forEnv, platform, usersOnboarding } from '../lib/paths';
import { stripeWebhookHandler } from '../functions/stripeWebhook';
import type { OrgSubscription, UserOnboarding } from '../shared/types';

const mockClaim = claimStripeEvent as jest.Mock;
const mockDone = markStripeEventDone as jest.Mock;
const mockRelease = releaseStripeEvent as jest.Mock;
const mockOrgForCustomer = orgForStripeCustomer as jest.Mock;
const mockRecordCustomer = recordStripeCustomer as jest.Mock;
const mockProvision = provisionOrganisation as jest.Mock;
const mockLoadKindConfig = loadKindConfig as jest.Mock;
const mockSendKindEmail = sendKindEmail as jest.Mock;
const mockConstructEvent = mockStripe.webhooks.constructEvent;

const ENV = 'test' as const;
const SUB_PATH = (orgId: string) => forEnv(ENV).db.orgSubscription(orgId);
const FEED_PATH = platform.financeEvents(ENV);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Finance-feed entries land at platform/financeEvents/{env}/{stripeEventId}
 *  via `set` (deterministic key = idempotent on redelivery, assessment H4);
 *  collect whatever the run wrote, in key order. */
function feedEntries(): unknown[] {
  return Object.keys(mockDbData)
    .filter((key) => key.startsWith(`${FEED_PATH}/`))
    .sort()
    .map((key) => mockDbData[key]);
}

// ----------------------------------------------------------------------------
// Fakes: request, response, Stripe objects
// ----------------------------------------------------------------------------

interface FakeRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => FakeRes;
  send: (body: unknown) => FakeRes;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

/** The handler wants a full Express Response; the fake implements exactly the
 *  two members the handler uses, so one cast at the boundary keeps the fake
 *  honest without stubbing ninety unused members. */
function asRes(res: FakeRes): Parameters<typeof stripeWebhookHandler>[1] {
  return res as unknown as Parameters<typeof stripeWebhookHandler>[1];
}

function makeReq(overrides: Record<string, unknown> = {}): Parameters<typeof stripeWebhookHandler>[0] {
  return {
    method: 'POST',
    query: { mode: 'test' },
    headers: { 'stripe-signature': 'sig' },
    rawBody: Buffer.from('{}'),
    ...overrides,
  } as unknown as Parameters<typeof stripeWebhookHandler>[0];
}

/** Run the handler for one crafted (already "verified") event. */
async function deliver(event: Record<string, unknown>): Promise<FakeRes> {
  mockConstructEvent.mockReturnValue(event);
  const res = makeRes();
  await stripeWebhookHandler(makeReq(), asRes(res));
  return res;
}

function fakeSubscription(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    metadata: {},
    items: {
      data: [
        {
          current_period_end: 1_900_000_000,
          price: { id: 'price_silver', lookup_key: 'safentia_silver_monthly' },
        },
      ],
    },
    ...overrides,
  };
}

function subscriptionEvent(
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'evt_1',
    type,
    livemode: false,
    data: { object: { id: 'sub_1' } },
    ...extra,
  };
}

function fakeInvoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'in_1',
    customer: 'cus_1',
    amount_due: 2900,
    amount_paid: 2900,
    currency: 'gbp',
    metadata: {},
    parent: { subscription_details: { subscription: 'sub_1' } },
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
    jest.clearAllMocks();
  mockClaim.mockResolvedValue(true);
  mockOrgForCustomer.mockResolvedValue(null);
  mockProvision.mockResolvedValue({ orgId: 'org-new', alreadyProvisioned: false });
});

// ----------------------------------------------------------------------------
// Request gating
// ----------------------------------------------------------------------------

describe('request gating', () => {
  test('non-POST is rejected 405', async () => {
    const res = makeRes();
    await stripeWebhookHandler(makeReq({ method: 'GET' }), asRes(res));
    expect(res.statusCode).toBe(405);
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  test('missing or invalid mode is rejected 400 before verification', async () => {
    for (const query of [{}, { mode: 'production' }]) {
      const res = makeRes();
      await stripeWebhookHandler(makeReq({ query }), asRes(res));
      expect(res.statusCode).toBe(400);
    }
    expect(mockConstructEvent).not.toHaveBeenCalled();
  });

  test('a bad signature is rejected 400', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found');
    });
    const res = makeRes();
    await stripeWebhookHandler(makeReq(), asRes(res));
    expect(res.statusCode).toBe(400);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test('a livemode/mode mismatch is rejected 400', async () => {
    const res = await deliver(subscriptionEvent('customer.subscription.updated', { livemode: true }));
    expect(res.statusCode).toBe(400);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test('an unhandled event type is acknowledged 200 without claiming', async () => {
    const res = await deliver({ id: 'evt_x', type: 'invoice.finalized', livemode: false, data: { object: {} } });
    expect(res.statusCode).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockStripe.invoices.retrieve).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Idempotency
// ----------------------------------------------------------------------------

describe('idempotency', () => {
  test('a duplicate delivery is acknowledged 200 with NO side effects', async () => {
    mockClaim.mockResolvedValue(false);
    const res = await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(res.statusCode).toBe(200);
    expect(mockStripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(mockDone).not.toHaveBeenCalled();
    expect(Object.keys(mockDbData)).toHaveLength(0);
  });

  test('a handler failure releases the claim and returns 500 for retry', async () => {
    mockStripe.subscriptions.retrieve.mockRejectedValue(new Error('Stripe down'));
    const res = await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(res.statusCode).toBe(500);
    expect(mockRelease).toHaveBeenCalledWith(ENV, 'evt_1');
    expect(mockDone).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Subscription snapshot mapping
// ----------------------------------------------------------------------------

describe('subscription events', () => {
  test('subscription.updated rewrites the org snapshot from re-fetched truth', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' }, cancel_at_period_end: true }),
    );
    const res = await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(res.statusCode).toBe(200);
    // Truth was re-fetched, never trusted from the event payload.
    expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot).toMatchObject({
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
      planId: 'silver', // parsed from safentia_silver_monthly
      priceId: 'price_silver',
      currentPeriodEnd: 1_900_000_000_000, // seconds -> ms
      cancelAtPeriodEnd: true,
    });
    expect(mockDone).toHaveBeenCalledWith(ENV, 'evt_1');
  });

  test('incomplete_expired maps to the "incomplete" status union member', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'incomplete_expired', metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    expect((mockDbData[SUB_PATH('org-1')] as OrgSubscription).status).toBe('incomplete');
  });

  test('an unparseable lookup key falls back to metadata.planId', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({
        metadata: { orgId: 'org-1', planId: 'gold' },
        items: { data: [{ current_period_end: 1_900_000_000, price: { id: 'p', lookup_key: null } }] },
      }),
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    expect((mockDbData[SUB_PATH('org-1')] as OrgSubscription).planId).toBe('gold');
  });

  test('deleted -> status canceled, dunning cleared, feed subscription_canceled', async () => {
    mockDbData[SUB_PATH('org-1')] = { paymentState: 'past_due', graceUntil: 111 };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'canceled', metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.deleted'));
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.status).toBe('canceled');
    expect(snapshot.paymentState).toBeUndefined();
    expect(snapshot.graceUntil).toBeUndefined();
    expect(feedEntries()).toEqual([
      expect.objectContaining({ type: 'subscription_canceled', orgId: 'org-1', stripeEventId: 'evt_1' }),
    ]);
  });
});

// ----------------------------------------------------------------------------
// Member-readable suspension mirror (SEV-1 fix 3): profile/suspended is
// maintained alongside every status write - non-admins cannot read the
// subscription node, so this one boolean is their honest signal.
// ----------------------------------------------------------------------------

describe('suspension mirror (profile.suspended)', () => {
  const PROFILE_PATH = forEnv(ENV).db.orgProfile('org-1');

  test('a transition to unpaid writes the member-readable flag', async () => {
    mockDbData[PROFILE_PATH] = { name: 'Acme Fire Ltd' };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'unpaid', metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(mockDbData[PROFILE_PATH]).toMatchObject({
      name: 'Acme Fire Ltd',
      suspended: true,
    });
  });

  test('subscription.deleted (canceled) sets the flag', async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'canceled', metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.deleted'));
    expect(
      (mockDbData[PROFILE_PATH] as { suspended?: boolean }).suspended,
    ).toBe(true);
  });

  test('a transition to active REMOVES the flag - no billing residue on a healthy profile', async () => {
    mockDbData[PROFILE_PATH] = { name: 'Acme Fire Ltd', suspended: true };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }), // status: active
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(mockDbData[PROFILE_PATH]).toEqual({ name: 'Acme Fire Ltd' });
  });

  test('a restart subscription (metadata orgId, NO onboardingUid) lands incomplete, stays suspended and never provisions', async () => {
    // The resubscribe callable's new subscription: the provisioning branch
    // must be inert (no onboardingUid) and the org must stay on the suspended
    // floor until the first payment confirms.
    mockDbData[PROFILE_PATH] = { name: 'Acme Fire Ltd', suspended: true };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({
        id: 'sub_2',
        status: 'incomplete',
        metadata: { orgId: 'org-1', planId: 'silver', env: 'test' },
      }),
    );
    await deliver(
      subscriptionEvent('customer.subscription.created', {
        data: { object: { id: 'sub_2' } },
      }),
    );
    expect(mockProvision).not.toHaveBeenCalled();
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.status).toBe('incomplete');
    expect(snapshot.stripeSubscriptionId).toBe('sub_2');
    expect(
      (mockDbData[PROFILE_PATH] as { suspended?: boolean }).suspended,
    ).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// First-subscribe provisioning (plan 3.1 step 5)
// ----------------------------------------------------------------------------

describe('onboarding provisioning', () => {
  const onboarding: UserOnboarding = {
    step: 'payment',
    planId: 'silver',
    orgName: 'Acme Fire Ltd',
    stripeCustomerId: 'cus_1',
    subscriptionId: 'sub_1',
    createdAt: 123,
  };

  test('active transition with onboarding metadata provisions ONCE and advances the record', async () => {
    mockDbData[usersOnboarding('uid-1')] = { ...onboarding };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { onboardingUid: 'uid-1', env: ENV, planId: 'silver', orgId: '' } }),
    );
    const res = await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(res.statusCode).toBe(200);
    expect(mockProvision).toHaveBeenCalledTimes(1);
    expect(mockProvision.mock.calls[0][0]).toMatchObject({
      env: ENV,
      uid: 'uid-1',
      email: 'founder@example.com',
      orgName: 'Acme Fire Ltd',
      subscription: expect.objectContaining({ stripeSubscriptionId: 'sub_1', status: 'active' }),
    });
    // Onboarding advanced for the watching client; reverse index recorded.
    expect(mockDbData[usersOnboarding('uid-1')]).toMatchObject({ step: 'setup', orgId: 'org-new' });
    expect(mockRecordCustomer).toHaveBeenCalledWith(ENV, 'cus_1', 'org-new');
    // Snapshot landed under the NEW org, and the feed says the sub started.
    expect(mockDbData[SUB_PATH('org-new')]).toMatchObject({ status: 'active', planId: 'silver' });
    expect(feedEntries()).toEqual([
      expect.objectContaining({ type: 'subscription_started', orgId: 'org-new' }),
    ]);
  });

  test('a not-yet-entitled (incomplete) onboarding subscription does not provision', async () => {
    mockDbData[usersOnboarding('uid-1')] = { ...onboarding };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'incomplete', metadata: { onboardingUid: 'uid-1' } }),
    );
    const res = await deliver(subscriptionEvent('customer.subscription.created'));
    expect(res.statusCode).toBe(200); // unknown org is a fact, not a failure
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockDbData[usersOnboarding('uid-1')]).toMatchObject({ step: 'payment' });
  });

  test('invoice.paid also drives provisioning when it lands first', async () => {
    mockDbData[usersOnboarding('uid-1')] = { ...onboarding };
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { onboardingUid: 'uid-1' } }),
    );
    await deliver(subscriptionEvent('invoice.paid', { data: { object: { id: 'in_1' } } }));
    expect(mockProvision).toHaveBeenCalledTimes(1);
    expect(mockDbData[usersOnboarding('uid-1')]).toMatchObject({ step: 'setup', orgId: 'org-new' });
  });

  test('a later update on an ALREADY-provisioned onboarding feeds plan_changed, not subscription_started', async () => {
    // The onboarding node lingers (step setup/done) with its orgId set; a
    // subsequent subscription.updated must not re-report the subscription as
    // started - only the provisioning delivery owns that feed entry.
    mockDbData[usersOnboarding('uid-1')] = { ...onboarding, step: 'setup', orgId: 'org-new' };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { onboardingUid: 'uid-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockDbData[SUB_PATH('org-new')]).toMatchObject({ status: 'active' });
    expect(feedEntries()).toEqual([
      expect.objectContaining({ type: 'plan_changed', orgId: 'org-new' }),
    ]);
  });

  test('incomplete_expired deletion resets the onboarding record to the plan step', async () => {
    mockDbData[usersOnboarding('uid-1')] = { ...onboarding };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'incomplete_expired', metadata: { onboardingUid: 'uid-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.deleted'));
    expect(mockProvision).not.toHaveBeenCalled();
    // Payment fields CLEARED, journey origin kept.
    expect(mockDbData[usersOnboarding('uid-1')]).toEqual({ step: 'plan', createdAt: 123 });
  });
});

// ----------------------------------------------------------------------------
// Dunning (plan 3.5)
// ----------------------------------------------------------------------------

describe('dunning', () => {
  test('invoice.payment_failed opens past_due with a 14-day grace window', async () => {
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'past_due', metadata: { orgId: 'org-1' } }),
    );
    const before = Date.now();
    await deliver(subscriptionEvent('invoice.payment_failed', { data: { object: { id: 'in_1' } } }));
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.paymentState).toBe('past_due');
    expect(snapshot.graceUntil).toBeGreaterThanOrEqual(before + 14 * DAY_MS);
    expect(snapshot.graceUntil).toBeLessThanOrEqual(Date.now() + 14 * DAY_MS);
    expect(feedEntries()).toEqual([
      expect.objectContaining({ type: 'payment_failed', amountPence: 2900, currency: 'gbp' }),
    ]);
  });

  test('invoice.payment_action_required sets action_required without a grace window', async () => {
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('invoice.payment_action_required', { data: { object: { id: 'in_1' } } }));
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.paymentState).toBe('action_required');
    expect(snapshot.graceUntil).toBeUndefined();
  });

  test('invoice.paid clears dunning state and feeds a payment entry', async () => {
    mockDbData[SUB_PATH('org-1')] = { paymentState: 'past_due', graceUntil: 111 };
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('invoice.paid', { data: { object: { id: 'in_1' } } }));
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.paymentState).toBeUndefined();
    expect(snapshot.graceUntil).toBeUndefined();
    expect(snapshot.currentPeriodEnd).toBe(1_900_000_000_000); // rolled forward
    expect(feedEntries()).toEqual([
      expect.objectContaining({ type: 'payment', amountPence: 2900, currency: 'gbp', orgId: 'org-1' }),
    ]);
  });
});

// ----------------------------------------------------------------------------
// Billing emails (assessment HIGH 1): the webhook is where the organisation
// hears about its money. What is pinned is the TRANSITION gating (first
// failure only, terminal end only once), the audience (active admins only),
// and the best-effort contract (an email failure never fails the response).
// ----------------------------------------------------------------------------

describe('billing emails', () => {
  const MEMBERS_PATH = forEnv(ENV).db.orgMembers('org-1');
  const PROFILE_PATH = forEnv(ENV).db.orgProfile('org-1');
  const BILLING_URL = 'https://safentia.co.uk/app/settings/billing';

  /** Two active admins, one assessor, one invited admin: only the first two
   *  may ever receive a billing email. */
  const seedAudience = () => {
    mockDbData[MEMBERS_PATH] = {
      'uid-a': { status: 'active', roles: { admin: true }, email: 'a@acme.example' },
      'uid-b': { status: 'active', roles: { admin: true }, email: 'b@acme.example' },
      'uid-c': { status: 'active', roles: { assessor: true }, email: 'c@acme.example' },
      'uid-d': { status: 'invited', roles: { admin: true }, email: 'd@acme.example' },
    };
    mockDbData[PROFILE_PATH] = { name: 'Acme Fire Ltd' };
  };

  test('the FIRST invoice.payment_failed emails every active admin - and only them', async () => {
    seedAudience();
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice({ number: 'SAF-0042' }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'past_due', metadata: { orgId: 'org-1' } }),
    );
    const res = await deliver(subscriptionEvent('invoice.payment_failed', { data: { object: { id: 'in_1' } } }));
    expect(res.statusCode).toBe(200);
    expect(mockSendKindEmail).toHaveBeenCalledTimes(2);
    const recipients = mockSendKindEmail.mock.calls.map(([req]) => req.to).sort();
    expect(recipients).toEqual(['a@acme.example', 'b@acme.example']);
    expect(mockSendKindEmail.mock.calls[0][0]).toMatchObject({
      kind: 'payment-failed',
      env: ENV,
      orgId: 'org-1',
      kindLink: BILLING_URL,
      variables: expect.objectContaining({
        'org.name': 'Acme Fire Ltd',
        'invoice.amountFormatted': '£29.00',
        'invoice.number': 'SAF-0042',
        // The grace deadline renders as a person-readable date.
        'grace.endDate': expect.stringMatching(/^\d{1,2} [A-Z][a-z]+ \d{4}$/),
      }),
    });
    // The kind config is hoisted ONCE across the audience (the
    // customerContracts pattern), not re-read per admin.
    expect(mockLoadKindConfig).toHaveBeenCalledTimes(1);
  });

  test('a RETRY failure sends no second email and keeps the original grace deadline', async () => {
    seedAudience();
    mockDbData[SUB_PATH('org-1')] = { paymentState: 'past_due', graceUntil: 555 };
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'past_due', metadata: { orgId: 'org-1' } }),
    );
    const res = await deliver(subscriptionEvent('invoice.payment_failed', { data: { object: { id: 'in_1' } } }));
    expect(res.statusCode).toBe(200);
    expect(mockSendKindEmail).not.toHaveBeenCalled();
    // The 14-day promise anchors at the cycle's FIRST failure: a retry must
    // not roll the enforced deadline forward.
    expect((mockDbData[SUB_PATH('org-1')] as OrgSubscription).graceUntil).toBe(555);
    // The finance feed still records every failed attempt.
    expect(feedEntries()).toHaveLength(1);
  });

  test('invoice.paid above zero sends a receipt with plan, period and hosted-invoice link', async () => {
    seedAudience();
    mockDbData[platform.plan(ENV, 'silver')] = { name: 'Silver' };
    mockStripe.invoices.retrieve.mockResolvedValue(
      fakeInvoice({ number: 'SAF-0042', hosted_invoice_url: 'https://invoice.stripe.com/i/abc' }),
    );
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('invoice.paid', { data: { object: { id: 'in_1' } } }));
    expect(mockSendKindEmail).toHaveBeenCalledTimes(2);
    expect(mockSendKindEmail.mock.calls[0][0]).toMatchObject({
      kind: 'payment-receipt',
      kindLink: BILLING_URL,
      variables: expect.objectContaining({
        'invoice.amountFormatted': '£29.00',
        'invoice.number': 'SAF-0042',
        'plan.name': 'Silver',
        'period.endDate': expect.stringMatching(/^\d{1,2} [A-Z][a-z]+ \d{4}$/),
        'invoice.url': 'https://invoice.stripe.com/i/abc',
      }),
    });
  });

  test('a £0 invoice.paid is bookkeeping, not a receipt', async () => {
    seedAudience();
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice({ amount_paid: 0 }));
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('invoice.paid', { data: { object: { id: 'in_1' } } }));
    expect(mockSendKindEmail).not.toHaveBeenCalled();
  });

  test('the transition TO unpaid sends subscription-ended; repeating it does not', async () => {
    seedAudience();
    mockDbData[SUB_PATH('org-1')] = { status: 'past_due' };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'unpaid', metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(mockSendKindEmail).toHaveBeenCalledTimes(2);
    expect(mockSendKindEmail.mock.calls[0][0]).toMatchObject({
      kind: 'subscription-ended',
      kindLink: BILLING_URL,
      variables: { 'org.name': 'Acme Fire Ltd' },
    });

    // A later event repeating the unpaid status is NOT a transition.
    mockSendKindEmail.mockClear();
    await deliver(subscriptionEvent('customer.subscription.updated', { id: 'evt_2' }));
    expect(mockSendKindEmail).not.toHaveBeenCalled();
  });

  test('subscription.deleted from a live status sends subscription-ended once', async () => {
    seedAudience();
    mockDbData[SUB_PATH('org-1')] = { status: 'active' };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'canceled', metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.deleted'));
    expect(mockSendKindEmail).toHaveBeenCalledTimes(2);
    expect(mockSendKindEmail.mock.calls[0][0]).toMatchObject({ kind: 'subscription-ended' });
  });

  test('subscription.deleted for an ALREADY-suspended org sends nothing (the unpaid transition emailed)', async () => {
    seedAudience();
    mockDbData[SUB_PATH('org-1')] = { status: 'unpaid' };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'canceled', metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.deleted'));
    expect(mockSendKindEmail).not.toHaveBeenCalled();
  });

  test('an email failure NEVER fails the webhook: state written, 200, claim kept', async () => {
    seedAudience();
    mockDbData[SUB_PATH('org-1')] = { status: 'active' };
    mockSendKindEmail.mockRejectedValueOnce(new Error('provider down'));
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'canceled', metadata: { orgId: 'org-1' } }),
    );
    const res = await deliver(subscriptionEvent('customer.subscription.deleted'));
    expect(res.statusCode).toBe(200);
    expect((mockDbData[SUB_PATH('org-1')] as OrgSubscription).status).toBe('canceled');
    expect(mockDone).toHaveBeenCalledWith(ENV, 'evt_1');
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('no active admins is a warning, not a failure', async () => {
    // Members tree missing entirely (a data fault): the send is skipped.
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ status: 'past_due', metadata: { orgId: 'org-1' } }),
    );
    const res = await deliver(subscriptionEvent('invoice.payment_failed', { data: { object: { id: 'in_1' } } }));
    expect(res.statusCode).toBe(200);
    expect(mockSendKindEmail).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Finance feed org-name denormalisation
// ----------------------------------------------------------------------------

describe('finance feed', () => {
  test('entries denormalise orgName from the org profile when present', async () => {
    // No prior snapshot stored: a first-seen subscription shape feeds (the
    // plan_changed gate cannot prove sameness against nothing).
    mockDbData[forEnv(ENV).db.orgProfile('org-1')] = { name: 'Acme Fire Ltd' };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(feedEntries()).toEqual([
      expect.objectContaining({ orgName: 'Acme Fire Ltd', type: 'plan_changed', planId: 'silver' }),
    ]);
  });

  test('the same Stripe event reprocessed twice writes ONE feed entry (deterministic key, H4)', async () => {
    mockStripe.invoices.retrieve.mockResolvedValue(fakeInvoice());
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('invoice.paid', { data: { object: { id: 'in_1' } } }));
    // A redelivery that reprocesses (released or stale-reclaimed claim):
    // same event id -> same child key -> overwrite, never a second revenue
    // line in the feed.
    await deliver(subscriptionEvent('invoice.paid', { data: { object: { id: 'in_1' } } }));
    expect(feedEntries()).toEqual([
      expect.objectContaining({ type: 'payment', stripeEventId: 'evt_1' }),
    ]);
    // The child key IS the Stripe event id.
    expect(mockDbData[`${FEED_PATH}/evt_1`]).toBeDefined();
  });

  test('a real plan change (priceId/planId differ from the stored snapshot) feeds plan_changed (H5)', async () => {
    mockDbData[SUB_PATH('org-1')] = {
      planId: 'bronze',
      priceId: 'price_bronze',
      status: 'active',
    };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }), // now silver
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(feedEntries()).toEqual([
      expect.objectContaining({ type: 'plan_changed', planId: 'silver' }),
    ]);
  });

  test('a same-plan subscription.updated (renewal/metadata/dunning move) feeds NOTHING but still writes state (H5)', async () => {
    mockDbData[SUB_PATH('org-1')] = {
      planId: 'silver',
      priceId: 'price_silver',
      status: 'past_due',
    };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }), // silver, active
    );
    await deliver(subscriptionEvent('customer.subscription.updated'));
    // No feed noise for an unchanged plan...
    expect(feedEntries()).toEqual([]);
    // ...but the snapshot write itself still happened.
    expect(mockDbData[SUB_PATH('org-1')]).toMatchObject({
      status: 'active',
      planId: 'silver',
    });
  });

  test('subscription.created still feeds subscription_started even with an identical stored plan', async () => {
    mockDbData[SUB_PATH('org-1')] = { planId: 'silver', priceId: 'price_silver' };
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('customer.subscription.created'));
    expect(feedEntries()).toEqual([
      expect.objectContaining({ type: 'subscription_started', planId: 'silver' }),
    ]);
  });
});

// ----------------------------------------------------------------------------
// Card-maintenance events + refunds + unknown customers (plan 4.4)
// ----------------------------------------------------------------------------

describe('payment-method maintenance events', () => {
  beforeEach(() => {
    mockStripe.customers.retrieve.mockResolvedValue({
      id: 'cus_1',
      metadata: { orgId: 'org-1' },
      invoice_settings: { default_payment_method: 'pm_1' },
    });
    mockStripe.paymentMethods.retrieve.mockResolvedValue({
      id: 'pm_1',
      card: { brand: 'mastercard', last4: '5100', exp_month: 7, exp_year: 2030 },
    });
  });

  test('payment_method.attached mirrors the customer CURRENT default into the block', async () => {
    const res = await deliver(subscriptionEvent('payment_method.attached', {
      data: { object: { id: 'pm_1', customer: 'cus_1' } },
    }));
    expect(res.statusCode).toBe(200);
    expect(mockDbData[SUB_PATH('org-1')]).toMatchObject({
      paymentMethod: { brand: 'mastercard', last4: '5100', expMonth: 7, expYear: 2030 },
    });
    // Card maintenance writes NO finance-feed entry (5.5 union excludes it).
    expect(feedEntries()).toEqual([]);
  });

  test('payment_method.detached resolves the customer from previous_attributes and clears the block', async () => {
    mockDbData[SUB_PATH('org-1')] = {
      paymentMethod: { brand: 'visa', last4: '4242', expMonth: 1, expYear: 2029 },
    };
    mockStripe.customers.retrieve.mockResolvedValue({
      id: 'cus_1',
      metadata: { orgId: 'org-1' },
      invoice_settings: { default_payment_method: null },
    });
    const res = await deliver(subscriptionEvent('payment_method.detached', {
      data: {
        object: { id: 'pm_1', customer: null },
        previous_attributes: { customer: 'cus_1' },
      },
    }));
    expect(res.statusCode).toBe(200);
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.paymentMethod).toBeUndefined();
  });

  test('customer.updated syncs a dashboard-made default-PM change', async () => {
    const res = await deliver(subscriptionEvent('customer.updated', {
      data: { object: { id: 'cus_1' } },
    }));
    expect(res.statusCode).toBe(200);
    expect(mockDbData[SUB_PATH('org-1')]).toMatchObject({
      paymentMethod: expect.objectContaining({ last4: '5100' }),
    });
  });
});

describe('refunds', () => {
  test('charge.refunded appends a refund feed entry and touches no subscription state', async () => {
    mockOrgForCustomer.mockResolvedValue('org-1');
    mockStripe.charges.retrieve.mockResolvedValue({
      id: 'ch_1',
      customer: 'cus_1',
      metadata: {},
      amount_refunded: 4900,
      currency: 'gbp',
    });
    const res = await deliver(subscriptionEvent('charge.refunded', {
      data: { object: { id: 'ch_1' } },
    }));
    expect(res.statusCode).toBe(200);
    expect(feedEntries()).toEqual([
      expect.objectContaining({
        type: 'refund',
        orgId: 'org-1',
        amountPence: 4900,
        currency: 'gbp',
        stripeEventId: 'evt_1',
      }),
    ]);
    expect(mockDbData[SUB_PATH('org-1')]).toBeUndefined();
  });
});

describe('unknown customers', () => {
  test('an event for a customer with no reverse-index entry is acknowledged 200 with no writes', async () => {
    mockOrgForCustomer.mockResolvedValue(null); // genuinely unknown
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ metadata: {} }),
    );
    const res = await deliver(subscriptionEvent('customer.subscription.updated'));
    expect(res.statusCode).toBe(200);
    expect(Object.keys(mockDbData)).toHaveLength(0);
    expect(feedEntries()).toEqual([]);
    // Still marked done: an unknown customer is a fact, not a retryable failure.
    expect(mockDone).toHaveBeenCalledWith(ENV, 'evt_1');
  });
});

// ----------------------------------------------------------------------------
// Card update (plan 3.4)
// ----------------------------------------------------------------------------

describe('card update', () => {
  test('setup_intent.succeeded (card_update) swaps the default PM and mirrors the block', async () => {
    mockStripe.setupIntents.retrieve.mockResolvedValue({
      id: 'seti_1',
      customer: 'cus_1',
      payment_method: 'pm_new',
      metadata: { purpose: 'card_update', orgId: 'org-1' },
    });
    mockStripe.customers.retrieve.mockResolvedValue({
      id: 'cus_1',
      metadata: {},
      invoice_settings: { default_payment_method: 'pm_old' },
    });
    mockStripe.paymentMethods.retrieve.mockResolvedValue({
      id: 'pm_new',
      card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 },
    });
    const res = await deliver(subscriptionEvent('setup_intent.succeeded', { data: { object: { id: 'seti_1' } } }));
    expect(res.statusCode).toBe(200);
    expect(mockStripe.customers.update).toHaveBeenCalledWith('cus_1', {
      invoice_settings: { default_payment_method: 'pm_new' },
    });
    expect(mockStripe.paymentMethods.detach).toHaveBeenCalledWith('pm_old');
    expect(mockDbData[SUB_PATH('org-1')]).toMatchObject({
      paymentMethod: { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 },
    });
  });
});

// ----------------------------------------------------------------------------
// Superseded subscriptions (security fix): an event for a subscription that is
// NOT the org's current stripeSubscriptionId and is terminally dead
// (canceled / incomplete_expired) must not overwrite the live snapshot, stamp
// a retention clock, or open dunning. A different-id LIVE subscription is a
// genuine replacement and is adopted.
// ----------------------------------------------------------------------------

describe('superseded subscriptions', () => {
  const LIVE_PRIOR: Partial<OrgSubscription> = {
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_new',
    status: 'active',
    planId: 'silver',
    priceId: 'price_silver',
  };

  function seedPrior(prior: Partial<OrgSubscription>): void {
    mockDbData[SUB_PATH('org-1')] = { ...prior };
  }

  test.each(['canceled', 'incomplete_expired'])(
    'subscription.updated for an old %s subscription is ignored',
    async (status) => {
      seedPrior(LIVE_PRIOR);
      mockStripe.subscriptions.retrieve.mockResolvedValue(
        fakeSubscription({ id: 'sub_old', status, metadata: { orgId: 'org-1' } }),
      );
      const res = await deliver(
        subscriptionEvent('customer.subscription.updated', { data: { object: { id: 'sub_old' } } }),
      );
      expect(res.statusCode).toBe(200);
      expect(mockDbData[SUB_PATH('org-1')]).toEqual(LIVE_PRIOR);
      expect(feedEntries()).toEqual([]);
      expect(mockSendKindEmail).not.toHaveBeenCalled();
    },
  );

  test('subscription.deleted for an old canceled subscription does not cancel the org', async () => {
    seedPrior(LIVE_PRIOR);
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ id: 'sub_old', status: 'canceled', metadata: { orgId: 'org-1' } }),
    );
    const res = await deliver(
      subscriptionEvent('customer.subscription.deleted', { data: { object: { id: 'sub_old' } } }),
    );
    expect(res.statusCode).toBe(200);
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot).toEqual(LIVE_PRIOR);
    expect(snapshot.retentionUntil).toBeUndefined();
    expect(feedEntries()).toEqual([]);
  });

  test('a late invoice.payment_failed on an expired restart attempt opens no dunning', async () => {
    seedPrior(LIVE_PRIOR);
    mockStripe.invoices.retrieve.mockResolvedValue(
      fakeInvoice({ parent: { subscription_details: { subscription: 'sub_old' } } }),
    );
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ id: 'sub_old', status: 'incomplete_expired', metadata: { orgId: 'org-1' } }),
    );
    await deliver(subscriptionEvent('invoice.payment_failed', { data: { object: { id: 'in_1' } } }));
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.paymentState).toBeUndefined();
    expect(snapshot.graceUntil).toBeUndefined();
    expect(snapshot).toEqual(LIVE_PRIOR);
  });

  test('a NEW live subscription replacing a canceled one is adopted', async () => {
    seedPrior({ ...LIVE_PRIOR, stripeSubscriptionId: 'sub_old', status: 'canceled' });
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ id: 'sub_new', status: 'active', metadata: { orgId: 'org-1' } }),
    );
    await deliver(
      subscriptionEvent('customer.subscription.created', { data: { object: { id: 'sub_new' } } }),
    );
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.stripeSubscriptionId).toBe('sub_new');
    expect(snapshot.status).toBe('active');
  });

  test('a different-id subscription that is NOT terminal (past_due) is still applied', async () => {
    seedPrior(LIVE_PRIOR);
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ id: 'sub_other', status: 'past_due', metadata: { orgId: 'org-1' } }),
    );
    await deliver(
      subscriptionEvent('customer.subscription.updated', { data: { object: { id: 'sub_other' } } }),
    );
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.stripeSubscriptionId).toBe('sub_other');
  });

  test('deletion of the CURRENT subscription still cancels the org', async () => {
    seedPrior(LIVE_PRIOR);
    mockStripe.subscriptions.retrieve.mockResolvedValue(
      fakeSubscription({ id: 'sub_new', status: 'canceled', metadata: { orgId: 'org-1' } }),
    );
    await deliver(
      subscriptionEvent('customer.subscription.deleted', { data: { object: { id: 'sub_new' } } }),
    );
    const snapshot = mockDbData[SUB_PATH('org-1')] as OrgSubscription;
    expect(snapshot.status).toBe('canceled');
    expect(snapshot.retentionUntil).toBeGreaterThan(Date.now());
  });
});
