// ============================================================================
// Phase 3 §6 feature gates - branding + email templates.
//
// Pins the enforcement seams around the two plan FEATURES (the countable
// limits have their own suites):
//   - assertFeature: the pure refusal every feature gate throws (the manual
//     send contract - refused outright without emailTemplates).
//   - requestsBrandedFields: which updateOrgProfile writes need the branding
//     feature (sets gated, clears always allowed).
//   - applyBrandingEntitlement: stored branding retained but NOT applied for
//     a gated org (report pipeline seam).
//   - loadKindConfig / sendKindEmail: an assigned org template is ignored
//     without emailTemplates, and the org accent falls back to the Safentia
//     default without branding - while the org's name (identity, not
//     branding) survives. Admin + dispatch are mocked per house pattern.
// ============================================================================

const mockDbData: Record<string, unknown> = {};

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      get: async () => ({ val: () => (path in mockDbData ? mockDbData[path] : null) }),
    }),
  },
  auth: {},
  storage: {},
}));

jest.mock('../lib/email', () => ({
  dispatchEmail: jest.fn(async () => true),
}));

import { forEnv, platform } from '../lib/paths';
import { dispatchEmail } from '../lib/email';
import { effectiveEntitlements } from '../lib/entitlements';
import {
  applyBrandingEntitlement,
  assertFeature,
  assertNotSuspended,
  resolvePlanContext,
} from '../lib/planContext';
import { requestsBrandedFields } from '../functions/updateOrgProfile';
import { loadKindConfig, sendKindEmail } from '../lib/templatedEmail';
import { SAFENTIA_BRAND } from '../lib/emailHtml';
import { SafentiaFunctionError } from '../lib/errors';
import type { Logger } from '../lib/logging';
import type { OrgProfile } from '../shared/types';

const mockDispatch = dispatchEmail as jest.Mock;

const makeLogger = (): Logger => {
  const logger: Logger = {
    correlationId: 'test-correlation',
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => logger,
  };
  return logger;
};

const ENV = 'test' as const;
const ORG = 'org-1';
const env = forEnv(ENV);

const seed = (nodes: Record<string, unknown>) => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  Object.assign(mockDbData, nodes);
};

/** A seeded plan with both email-adjacent features OFF. */
const bronzePlan = {
  name: 'Bronze',
  stripePriceId: 'price_test',
  priceMonthlyPence: 4900,
  currency: 'gbp' as const,
  features: { branding: false, emailTemplates: false, prioritySupport: false },
  limits: { orgStaff: 2, customers: 5, notificationsPerMonth: 100, assessmentTemplates: 1 },
  order: 0,
};

/** Subscription + plan nodes for an active bronze org. */
const bronzeNodes = {
  [env.db.orgSubscription(ORG)]: { planId: 'bronze', status: 'active' },
  [platform.plan(ENV, 'bronze')]: bronzePlan,
};

/** A renderable org template (mirrors the templatedEmail.test shape). */
const orgTemplate = {
  subject: 'Custom subject',
  preheader: 'Custom preheader.',
  heading: 'Custom heading',
  blocks: [{ id: 'p1', type: 'paragraph', text: 'Custom body copy.' }],
  footerNote: 'Custom footer.',
};

const NOW = 1_754_000_000_000;
const GRANDFATHERED = effectiveEntitlements(undefined, undefined, NOW);
const BRONZE = effectiveEntitlements({ planId: 'bronze', status: 'active' }, bronzePlan, NOW);
const SUSPENDED = effectiveEntitlements({ planId: 'bronze', status: 'unpaid' }, bronzePlan, NOW);

beforeEach(() => {
  mockDispatch.mockClear();
});

describe('assertFeature', () => {
  it('passes silently when the feature is on (grandfather rule included)', () => {
    expect(() => assertFeature(GRANDFATHERED, 'emailTemplates', 'upsell')).not.toThrow();
  });

  it('refuses with failed-precondition when the feature is off - the manual send contract', () => {
    try {
      assertFeature(BRONZE, 'emailTemplates', 'Sending your own email templates is included from the Silver plan.');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SafentiaFunctionError);
      const failure = error as SafentiaFunctionError;
      expect(failure.code).toBe('failed-precondition');
      expect(failure.message).toContain('Silver');
    }
  });
});

describe('assertNotSuspended - the createJob/startAssessment suspension gate', () => {
  it('passes silently for a live (or grandfathered) organisation', () => {
    expect(() => assertNotSuspended(BRONZE, 'copy')).not.toThrow();
    expect(() => assertNotSuspended(GRANDFATHERED, 'copy')).not.toThrow();
  });

  it('refuses a suspended organisation with the calm resource-exhausted vocabulary', () => {
    try {
      assertNotSuspended(
        SUSPENDED,
        'Your organisation’s subscription has ended, so new jobs cannot be created. Restart it from the Billing page to continue.',
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SafentiaFunctionError);
      const failure = error as SafentiaFunctionError;
      // The same code the countable limits throw, so the console renders the
      // same calm notice - never a scary failure (§6.3).
      expect(failure.code).toBe('resource-exhausted');
      expect(failure.message).toContain('Billing');
    }
  });

  it('suspends on an EXPIRED grace window too (past_due, graceUntil behind now)', () => {
    const graceExpired = effectiveEntitlements(
      {
        planId: 'bronze',
        status: 'past_due',
        paymentState: 'past_due',
        graceUntil: NOW - 1,
      },
      bronzePlan,
      NOW,
    );
    expect(() => assertNotSuspended(graceExpired, 'copy')).toThrow(
      SafentiaFunctionError,
    );
    // ...while an OPEN window keeps the gate open (§3.5 never-degrade rule).
    const graceOpen = effectiveEntitlements(
      {
        planId: 'bronze',
        status: 'past_due',
        paymentState: 'past_due',
        graceUntil: NOW + 1,
      },
      bronzePlan,
      NOW,
    );
    expect(() => assertNotSuspended(graceOpen, 'copy')).not.toThrow();
  });
});

describe('requestsBrandedFields', () => {
  it('gates setting brand colours or a logo', () => {
    expect(requestsBrandedFields({ brand: { primary: '#112233', secondary: '#445566' } })).toBe(true);
    expect(requestsBrandedFields({ logoUrl: 'orgs/test/org-1/branding/logo.png' })).toBe(true);
  });

  it('leaves identity edits and CLEARs ungated', () => {
    expect(requestsBrandedFields({ name: 'Acme Fire', contact: { email: 'x@y.z' } })).toBe(false);
    // An explicit null is the CLEAR intent - moving towards the default is
    // always allowed (§6.3 never delete, never hide).
    expect(requestsBrandedFields({ logoUrl: null })).toBe(false);
  });
});

describe('applyBrandingEntitlement', () => {
  const profile: OrgProfile = {
    name: 'Acme Fire',
    brand: { primary: '#FF0000', secondary: '#00FF00' },
    logoUrl: 'orgs/test/org-1/branding/logo.png',
    coverImageUrl: 'orgs/test/org-1/branding/cover.jpg',
    fontFamily: 'Georgia',
    contact: { email: 'hello@acme.example' },
  };

  it('passes the profile through untouched when branding is on', () => {
    expect(applyBrandingEntitlement(profile, GRANDFATHERED)).toBe(profile);
  });

  it('strips the branded presentation - and only it - when branding is off', () => {
    expect(applyBrandingEntitlement(profile, BRONZE)).toEqual({
      name: 'Acme Fire',
      brand: { primary: '#D9C554', secondary: '#1E3A8A' },
      contact: { email: 'hello@acme.example' },
    });
  });
});

describe('loadKindConfig - emailTemplates + branding gates', () => {
  it('ignores the assigned template and org accent for a bronze org', async () => {
    seed({
      ...bronzeNodes,
      [env.db.emailKindSetting(ORG, 'visit-scheduled')]: { templateId: 't1' },
      [env.db.emailTemplate(ORG, 't1')]: orgTemplate,
    });
    const config = await loadKindConfig(ENV, ORG, 'visit-scheduled', makeLogger());
    expect(config.template).toBeNull();
    expect(config.templateId).toBeUndefined();
    expect(config.brandingAllowed).toBe(false);
    // The assignment itself is retained in RTDB - nothing was deleted.
    expect(mockDbData[env.db.emailKindSetting(ORG, 'visit-scheduled')]).toEqual({ templateId: 't1' });
  });

  it('applies the assigned template for a grandfathered org (no subscription)', async () => {
    seed({
      [env.db.emailKindSetting(ORG, 'visit-scheduled')]: { templateId: 't1' },
      [env.db.emailTemplate(ORG, 't1')]: orgTemplate,
    });
    const config = await loadKindConfig(ENV, ORG, 'visit-scheduled', makeLogger());
    expect(config.template).toEqual(orgTemplate);
    expect(config.templateId).toBe('t1');
    expect(config.brandingAllowed).toBe(true);
  });
});

describe('sendKindEmail - branding fallback', () => {
  const request = {
    kind: 'visit-scheduled' as const,
    env: ENV,
    orgId: ORG,
    to: 'contact@example.com',
    variables: {},
    brand: { name: 'Acme Fire', accent: '#FF0000' },
  };

  it('dresses the email in the Safentia accent when branding is off, keeping the org name', async () => {
    seed(bronzeNodes);
    expect(await sendKindEmail(request, makeLogger())).toBe(true);
    const [message] = mockDispatch.mock.calls[0];
    expect(message.html).not.toContain('#FF0000');
    expect(message.html).toContain(SAFENTIA_BRAND.accent);
    // Identity is not branding: the email still says who it is from.
    expect(message.html).toContain('Acme Fire');
  });

  it('keeps the org accent when branding is on (grandfathered org)', async () => {
    seed({});
    expect(await sendKindEmail(request, makeLogger())).toBe(true);
    const [message] = mockDispatch.mock.calls[0];
    expect(message.html).toContain('#FF0000');
  });
});

describe('resolvePlanContext', () => {
  it('resolves subscription + env-nested plan + entitlements in one context', async () => {
    seed(bronzeNodes);
    const ctx = await resolvePlanContext(env, ORG);
    expect(ctx.subscription?.planId).toBe('bronze');
    expect(ctx.plan?.name).toBe('Bronze');
    expect(ctx.entitlements.features.branding).toBe(false);
    expect(ctx.entitlements.limits.customers).toBe(5);
  });

  it('grandfathers an org billing has never touched', async () => {
    seed({});
    const ctx = await resolvePlanContext(env, ORG);
    expect(ctx.subscription).toBeUndefined();
    expect(ctx.plan).toBeUndefined();
    expect(ctx.entitlements.limits.customers).toBe(-1);
    expect(ctx.entitlements.features.emailTemplates).toBe(true);
  });
});
