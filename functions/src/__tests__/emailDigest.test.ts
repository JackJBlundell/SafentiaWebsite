// ============================================================================
// emailDigest - the delivery seam that decides whether an email goes NOW or
// waits for tomorrow's flush (EMAIL_BUNDLING_PLAN.md §2, §4.1).
//
// Two contracts are defended here, and they pull in opposite directions.
//
// The QUIET contract: for each (recipient address, email kind) at most one
// email per UK calendar day. That is made of four moving parts, and each is
// pinned below - the address normalisation that collapses three spellings of
// one person onto one slot, the per-kind policy that says immediate/collapse/
// digest, the day-slot claim that tells the first event of the day from the
// rest, and the cap that refuses to let a runaway sweep grow an unreadable
// bundle without owning up to it.
//
// The LOUD contract, which always wins: bundling is an optimisation, delivery
// is the product. Every failure inside this module - an unreadable slot, a
// rejected queue write, an `undefined` RTDB will not accept - must degrade to
// sending immediately, never to silence. A duplicate email is survivable; a
// fire-safety reminder swallowed by the machinery meant to tidy it is not. The
// 'failure posture' block is the most important in this file.
//
// The anti-starvation rule earns its own test: a `collapse` kind may only take
// the immediate path when the bundle is EMPTY as well as the slot free. Drop
// the emptiness test and a kind that fires every morning before the flush
// starves its own bundle for ever, and the cap eventually discards real email.
//
// firebase-admin is faked with a settable RTDB whose `transaction` honours the
// SDK's abort contract (returning undefined commits nothing) - the
// manualEmailLimits/usageCounters pattern - and whose `update` records exactly
// what was written, so the no-undefined guarantee can be asserted on the wire
// rather than inferred. The renderer seam (lib/templatedEmail) is mocked too:
// this module's job is routing, and rendering is already pinned next door in
// templatedEmail.test.ts.
// ============================================================================

/** Settable fake RTDB: path -> stored value. `mock`-prefixed so jest permits
 *  the hoisted factories to close over them. */
const mockDbData: Record<string, unknown> = {};
/** Every payload handed to a multi-path `update()`, exactly as written. */
const mockUpdateCalls: Array<Record<string, unknown>> = [];
/** Substring of a path that should blow up, for the degradation tests. */
let mockThrowOn: string | null = null;
let mockPushCounter = 0;
/** What the mocked renderer reports back (false = the provider refused). */
let mockSendResult = true;
/** What the mocked config loader reports for the org's on/off toggle. */
let mockKindEnabled = true;

function mockShouldThrow(path: string | undefined): boolean {
  return mockThrowOn !== null && (path ?? '').includes(mockThrowOn);
}

jest.mock('../admin', () => ({
  db: {
    ref: (path?: string) => ({
      get: async () => {
        if (mockShouldThrow(path)) throw new Error('RTDB unavailable');
        const key = path ?? '';
        return { val: () => (key in mockDbData ? mockDbData[key] : null) };
      },
      transaction: async (update: (current: unknown) => unknown) => {
        if (mockShouldThrow(path)) throw new Error('RTDB unavailable');
        const key = path ?? '';
        const current = key in mockDbData ? mockDbData[key] : null;
        const next = update(current);
        if (next === undefined) {
          // The SDK's abort: nothing written, committed false.
          return { committed: false, snapshot: { val: () => current } };
        }
        mockDbData[key] = next;
        return { committed: true, snapshot: { val: () => next } };
      },
      push: () => {
        mockPushCounter += 1;
        return { key: `push-${mockPushCounter}` };
      },
      update: async (values: Record<string, unknown>) => {
        for (const key of Object.keys(values)) {
          if (mockShouldThrow(key)) throw new Error('RTDB write rejected');
        }
        mockUpdateCalls.push(values);
        for (const [key, value] of Object.entries(values)) {
          mockDbData[key] = value;
        }
      },
    }),
  },
}));

jest.mock('../lib/templatedEmail', () => ({
  sendKindEmail: jest.fn(async () => mockSendResult),
  loadKindConfig: jest.fn(async (_env: string, _orgId: string, kind: string) => ({
    kind,
    enabled: mockKindEnabled,
    template: null,
    digestTemplate: null,
    brandingAllowed: true,
  })),
}));

import {
  MAX_BUNDLE_ITEMS,
  URGENT_VISIT_WINDOW_MS,
  claimDaySlot,
  deliverKindEmail,
  isBundlingEnabled,
  isImminentVisit,
  recipientHash,
} from '../lib/emailDigest';
import type { DeliverRequest } from '../lib/emailDigest';
import { EMAIL_KINDS } from '../lib/emailKindCatalogue';
import type { EmailKindDefinition } from '../lib/emailKindCatalogue';
import { loadKindConfig, sendKindEmail } from '../lib/templatedEmail';
import { ops } from '../lib/paths';
import { ukDay } from '../lib/ukCalendar';
import type { Logger } from '../lib/logging';
import type { EmailKindId } from '../shared/types';

const mockSend = sendKindEmail as jest.Mock;
const mockLoadConfig = loadKindConfig as jest.Mock;

const ENV = 'live' as const;
const ORG = 'org-1';
const TO = 'contact@example.com';

/** One of each policy, taken from the catalogue rather than assumed, so a
 *  reclassification breaks the fixture rather than quietly retargeting a test. */
const IMMEDIATE_KIND: EmailKindId = 'invitation';
const COLLAPSE_KIND: EmailKindId = 'visit-scheduled';
const DIGEST_KIND: EmailKindId = 'review-reminder-admin';

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

const request = (
  kind: EmailKindId,
  extra: Partial<DeliverRequest> = {},
): DeliverRequest => ({
  kind,
  env: ENV,
  orgId: ORG,
  to: TO,
  variables: { 'org.name': 'Acme Fire Safety Ltd' },
  brand: { name: 'Acme Fire Safety Ltd', accent: '#336699' },
  ...extra,
});

const hash = () => recipientHash(TO);
const bundlePath = (kind: EmailKindId) => ops.emailBundle(ENV, ORG, hash(), kind);
const slotPath = (kind: EmailKindId) => ops.emailDay(ENV, ORG, hash(), kind);
const today = () => ukDay(Date.now());

/** Every path under the bundle's `items` collection that actually got written. */
const storedItemPaths = (): string[] =>
  Object.keys(mockDbData).filter((path) => path.includes('/items/'));

/** Dotted paths of every `undefined` reachable in a value. RTDB rejects the
 *  whole write when it meets one, so this must always come back empty. */
function undefinedPathsIn(value: unknown, trail = ''): string[] {
  if (value === undefined) return [trail || '(root)'];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      undefinedPathsIn(entry, `${trail}[${index}]`),
    );
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    undefinedPathsIn(entry, trail ? `${trail}.${key}` : key),
  );
}

const originalBundlingFlag = process.env.EMAIL_BUNDLING_ENABLED;

beforeEach(() => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  mockUpdateCalls.length = 0;
  mockThrowOn = null;
  mockPushCounter = 0;
  mockSendResult = true;
  mockKindEnabled = true;
  mockSend.mockClear();
  mockLoadConfig.mockClear();
  delete process.env.EMAIL_BUNDLING_ENABLED;
});

afterAll(() => {
  if (originalBundlingFlag === undefined) {
    delete process.env.EMAIL_BUNDLING_ENABLED;
  } else {
    process.env.EMAIL_BUNDLING_ENABLED = originalBundlingFlag;
  }
});

// ============================================================================
// recipientHash - the key the whole guarantee hangs off. If two spellings of
// one address hashed differently the person would get one email per spelling,
// which is exactly the failure this module exists to remove.
// ============================================================================
describe('recipientHash', () => {
  it('collapses case and surrounding whitespace onto ONE key', () => {
    const canonical = recipientHash('jo@example.com');
    expect(recipientHash('JO@Example.COM')).toBe(canonical);
    expect(recipientHash('  jo@example.com  ')).toBe(canonical);
    expect(recipientHash('\tJo@Example.com\n')).toBe(canonical);
    expect(new Set([
      recipientHash('jo@example.com'),
      recipientHash('JO@Example.COM'),
      recipientHash('  Jo@example.com '),
    ]).size).toBe(1);
  });

  it('separates different addresses', () => {
    expect(recipientHash('jo@example.com')).not.toBe(
      recipientHash('jo+1@example.com'),
    );
    expect(recipientHash('jo@example.com')).not.toBe(
      recipientHash('jo@example.co.uk'),
    );
  });

  it('is 32 lower-case hex characters, so it is always a legal RTDB key', () => {
    const key = recipientHash('jo@example.com');
    expect(key).toHaveLength(32);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    // The '.' that makes an address an illegal key is gone.
    expect(key).not.toContain('.');
  });
});

// ============================================================================
// isImminentVisit - the ONLY documented bypass of the one-per-day rule. Too
// wide and the exception eats the rule; too narrow and a contact waits in for
// an assessor who is not coming.
// ============================================================================
describe('isImminentVisit', () => {
  const NOW = Date.UTC(2026, 7, 10, 9, 0, 0);

  it('is true for a visit inside the 48-hour window', () => {
    expect(isImminentVisit(NOW + 60 * 60 * 1000, NOW)).toBe(true);
    expect(isImminentVisit(NOW + 47 * 60 * 60 * 1000, NOW)).toBe(true);
  });

  it('is false for a visit beyond the window', () => {
    expect(isImminentVisit(NOW + 3 * 24 * 60 * 60 * 1000, NOW)).toBe(false);
    expect(isImminentVisit(NOW + 21 * 24 * 60 * 60 * 1000, NOW)).toBe(false);
  });

  it('is false for a visit already in the past - nobody is waiting', () => {
    expect(isImminentVisit(NOW - 1, NOW)).toBe(false);
    expect(isImminentVisit(NOW - 24 * 60 * 60 * 1000, NOW)).toBe(false);
  });

  it('draws both boundaries exactly: [now, now + 48h] inclusive', () => {
    expect(URGENT_VISIT_WINDOW_MS).toBe(48 * 60 * 60 * 1000);
    expect(isImminentVisit(NOW, NOW)).toBe(true);
    expect(isImminentVisit(NOW + URGENT_VISIT_WINDOW_MS, NOW)).toBe(true);
    expect(isImminentVisit(NOW + URGENT_VISIT_WINDOW_MS + 1, NOW)).toBe(false);
  });
});

// ============================================================================
// isBundlingEnabled - the rollback lever. It defaults ON because bundling IS
// the delivery path; only the literal string 'false' takes it out, so a stray
// '0' or 'no' cannot silently revert an environment to the old behaviour.
// ============================================================================
describe('isBundlingEnabled', () => {
  it('defaults ON when the variable is unset', () => {
    expect(isBundlingEnabled()).toBe(true);
  });

  it('is switched off ONLY by the literal string "false"', () => {
    process.env.EMAIL_BUNDLING_ENABLED = 'false';
    expect(isBundlingEnabled()).toBe(false);
    for (const value of ['true', 'False', 'FALSE', '0', 'no', '', 'off']) {
      process.env.EMAIL_BUNDLING_ENABLED = value;
      expect(isBundlingEnabled()).toBe(true);
    }
  });

  it('is read per call, so the lever takes effect without a redeploy', () => {
    expect(isBundlingEnabled()).toBe(true);
    process.env.EMAIL_BUNDLING_ENABLED = 'false';
    expect(isBundlingEnabled()).toBe(false);
    delete process.env.EMAIL_BUNDLING_ENABLED;
    expect(isBundlingEnabled()).toBe(true);
  });
});

// ============================================================================
// claimDaySlot - what makes "at most one" EXACT rather than approximate. The
// flush claims the very same slot, which is what stops a bundle delivered at
// 08:15 being joined by an immediate send at 09:00.
// ============================================================================
describe('claimDaySlot', () => {
  it('claims a free slot and stores the day', async () => {
    const claimed = await claimDaySlot(ENV, ORG, hash(), COLLAPSE_KIND, '2026-08-10');
    expect(claimed).toBe(true);
    expect(mockDbData[slotPath(COLLAPSE_KIND)]).toBe('2026-08-10');
  });

  it('refuses a slot already held for the SAME day', async () => {
    mockDbData[slotPath(COLLAPSE_KIND)] = '2026-08-10';
    const claimed = await claimDaySlot(ENV, ORG, hash(), COLLAPSE_KIND, '2026-08-10');
    expect(claimed).toBe(false);
    expect(mockDbData[slotPath(COLLAPSE_KIND)]).toBe('2026-08-10');
  });

  it('takes over a slot left from a PREVIOUS day', async () => {
    mockDbData[slotPath(COLLAPSE_KIND)] = '2026-08-09';
    const claimed = await claimDaySlot(ENV, ORG, hash(), COLLAPSE_KIND, '2026-08-10');
    expect(claimed).toBe(true);
    // One node holding a date, not a child per day: nothing to sweep up.
    expect(mockDbData[slotPath(COLLAPSE_KIND)]).toBe('2026-08-10');
  });

  it('keeps slots separate per kind and per recipient', async () => {
    await claimDaySlot(ENV, ORG, hash(), COLLAPSE_KIND, '2026-08-10');
    expect(
      await claimDaySlot(ENV, ORG, hash(), DIGEST_KIND, '2026-08-10'),
    ).toBe(true);
    expect(
      await claimDaySlot(ENV, ORG, recipientHash('other@example.com'), COLLAPSE_KIND, '2026-08-10'),
    ).toBe(true);
  });
});

// ============================================================================
// Policy routing - which of the three catalogue policies a send takes, and the
// two hatches (the rollback lever and `urgent`) that skip the queue whatever
// the policy says.
// ============================================================================
describe('deliverKindEmail - policy routing', () => {
  it('sends an immediate kind now and NEVER queues it', async () => {
    // Even with the slot taken and a bundle already waiting, an immediate kind
    // ignores both: security and billing mail may never be held.
    mockDbData[slotPath(IMMEDIATE_KIND)] = today();
    mockDbData[`${bundlePath(IMMEDIATE_KIND)}/count`] = 3;

    const outcome = await deliverKindEmail(request(IMMEDIATE_KIND), makeLogger());

    expect(outcome).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockUpdateCalls).toHaveLength(0);
    expect(storedItemPaths()).toEqual([]);
  });

  it('sends an urgent request now whatever the policy says, and queues nothing', async () => {
    // The imminent-visit exception, on a kind that would otherwise bundle
    // because its slot is already spent for today.
    mockDbData[slotPath(COLLAPSE_KIND)] = today();

    const outcome = await deliverKindEmail(
      request(COLLAPSE_KIND, { urgent: true }),
      makeLogger(),
    );

    expect(outcome).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(storedItemPaths()).toEqual([]);
  });

  it('sends an urgent DIGEST-policy request immediately too', async () => {
    const outcome = await deliverKindEmail(
      request(DIGEST_KIND, { urgent: true }),
      makeLogger(),
    );
    expect(outcome).toBe('sent');
    expect(storedItemPaths()).toEqual([]);
  });

  it('never queues a kind the catalogue gives no digest block, even at collapse policy', async () => {
    // There is nothing to render a bundle of it WITH, so bundling it would be
    // queueing email that could never be delivered.
    const original = EMAIL_KINDS[COLLAPSE_KIND];
    const { digest: _dropped, ...withoutDigest } = original;
    (EMAIL_KINDS as Record<EmailKindId, EmailKindDefinition>)[COLLAPSE_KIND] =
      withoutDigest;
    try {
      mockDbData[slotPath(COLLAPSE_KIND)] = today();

      const outcome = await deliverKindEmail(request(COLLAPSE_KIND), makeLogger());

      expect(outcome).toBe('sent');
      expect(storedItemPaths()).toEqual([]);
    } finally {
      (EMAIL_KINDS as Record<EmailKindId, EmailKindDefinition>)[COLLAPSE_KIND] =
        original;
    }
  });

  it('degrades every kind to an immediate send when the rollback lever is pulled', async () => {
    process.env.EMAIL_BUNDLING_ENABLED = 'false';

    for (const kind of [IMMEDIATE_KIND, COLLAPSE_KIND, DIGEST_KIND]) {
      expect(await deliverKindEmail(request(kind), makeLogger())).toBe('sent');
    }
    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(mockUpdateCalls).toHaveLength(0);
    // No slot was touched either - the lever restores the pre-bundling world.
    expect(Object.keys(mockDbData)).toEqual([]);
  });

  it("reports 'skipped' when the provider refuses an immediate send", async () => {
    mockSendResult = false;
    expect(await deliverKindEmail(request(IMMEDIATE_KIND), makeLogger())).toBe(
      'skipped',
    );
  });
});

// ============================================================================
// 'collapse' - the first event of the day is news and sends in the kind's
// ordinary copy; everything after it is noise and bundles.
// ============================================================================
describe("deliverKindEmail - 'collapse'", () => {
  it('sends the FIRST event of the day and claims the slot', async () => {
    const outcome = await deliverKindEmail(request(COLLAPSE_KIND), makeLogger());

    expect(outcome).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
    // Claimed BEFORE the send, so a provider failure burns the day rather than
    // reopening the gate for a broken address to be retried all day.
    expect(mockDbData[slotPath(COLLAPSE_KIND)]).toBe(today());
    expect(storedItemPaths()).toEqual([]);
    // The already-resolved config rides along, so the renderer does not
    // re-read the settings node it was just handed.
    expect(mockSend.mock.calls[0][0].config).toMatchObject({
      kind: COLLAPSE_KIND,
      enabled: true,
    });
  });

  it('queues everything after the first: the second send of the day bundles', async () => {
    const first = await deliverKindEmail(request(COLLAPSE_KIND), makeLogger());
    const second = await deliverKindEmail(request(COLLAPSE_KIND), makeLogger());

    expect([first, second]).toEqual(['sent', 'queued']);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockDbData[`${bundlePath(COLLAPSE_KIND)}/count`]).toBe(1);
    expect(mockDbData[`${bundlePath(COLLAPSE_KIND)}/to`]).toBe(TO);
  });

  it('queues when the slot was already claimed today (by an earlier send or by the flush)', async () => {
    mockDbData[slotPath(COLLAPSE_KIND)] = today();

    const outcome = await deliverKindEmail(request(COLLAPSE_KIND), makeLogger());

    expect(outcome).toBe('queued');
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDbData[`${bundlePath(COLLAPSE_KIND)}/count`]).toBe(1);
  });

  it('ANTI-STARVATION: queues when the slot is FREE but the bundle is not empty', async () => {
    // Without this, a kind firing every morning before the 08:15 flush would
    // starve its own bundle for ever: the immediate send claims the slot, the
    // flush finds the slot taken and defers, and the pending items grow until
    // the cap starts discarding them - the one failure mode where bundling
    // would lose email outright. A non-empty bundle must always win the next
    // morning's flush, so nothing may claim the slot ahead of it.
    mockDbData[`${bundlePath(COLLAPSE_KIND)}/count`] = 1;
    expect(slotPath(COLLAPSE_KIND) in mockDbData).toBe(false);

    const outcome = await deliverKindEmail(request(COLLAPSE_KIND), makeLogger());

    expect(outcome).toBe('queued');
    expect(mockSend).not.toHaveBeenCalled();
    // The decisive assertion: the free slot is STILL free, waiting for the flush.
    expect(slotPath(COLLAPSE_KIND) in mockDbData).toBe(false);
    expect(mockDbData[`${bundlePath(COLLAPSE_KIND)}/count`]).toBe(2);
  });

  it('takes the immediate path again on a NEW day, once the slot has rolled over', async () => {
    mockDbData[slotPath(COLLAPSE_KIND)] = '2000-01-01';

    const outcome = await deliverKindEmail(request(COLLAPSE_KIND), makeLogger());

    expect(outcome).toBe('sent');
    expect(mockDbData[slotPath(COLLAPSE_KIND)]).toBe(today());
  });
});

// ============================================================================
// 'digest' - sweep-driven mail that is a daily batch by nature. It never sends
// immediately, so it never claims here: the FLUSH claims the slot when it
// delivers, which is what keeps the whole family to one email per morning.
// ============================================================================
describe("deliverKindEmail - 'digest'", () => {
  it('never sends immediately - it queues even on a completely clean slate', async () => {
    expect(Object.keys(mockDbData)).toEqual([]);

    const outcome = await deliverKindEmail(request(DIGEST_KIND), makeLogger());

    expect(outcome).toBe('queued');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does NOT claim the day slot - the flush does that when it delivers', async () => {
    await deliverKindEmail(request(DIGEST_KIND), makeLogger());
    expect(slotPath(DIGEST_KIND) in mockDbData).toBe(false);
  });

  it('accumulates a whole sweep into one bundle, counting every item', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await deliverKindEmail(request(DIGEST_KIND), makeLogger())).toBe(
        'queued',
      );
    }
    expect(mockDbData[`${bundlePath(DIGEST_KIND)}/count`]).toBe(5);
    expect(storedItemPaths()).toHaveLength(5);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('bundles three spellings of one address into ONE bundle', async () => {
    for (const to of ['contact@example.com', 'CONTACT@Example.com', '  contact@example.com ']) {
      await deliverKindEmail(request(DIGEST_KIND, { to }), makeLogger());
    }
    expect(mockDbData[`${bundlePath(DIGEST_KIND)}/count`]).toBe(3);
    // The stored address is trimmed, so the flush has something sendable.
    expect(mockDbData[`${bundlePath(DIGEST_KIND)}/to`]).toBe('contact@example.com');
  });
});

// ============================================================================
// The org's own on/off toggle, resolved BEFORE queueing: a kind an admin has
// switched off must never sit in a bundle for a day and then be dropped by the
// flush - it should never enter the queue at all.
// ============================================================================
describe('deliverKindEmail - a kind the organisation has switched off', () => {
  it("is skipped, not queued, and never dispatched", async () => {
    mockKindEnabled = false;
    const logger = makeLogger();

    const outcome = await deliverKindEmail(request(DIGEST_KIND), logger);

    expect(outcome).toBe('skipped');
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateCalls).toHaveLength(0);
    expect(Object.keys(mockDbData)).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
      expect.objectContaining({ kind: DIGEST_KIND, orgId: ORG }),
    );
  });

  it('honours a preloaded config without re-reading the settings node', async () => {
    const outcome = await deliverKindEmail(
      request(DIGEST_KIND, {
        config: {
          kind: DIGEST_KIND,
          enabled: false,
          template: null,
          digestTemplate: null,
          brandingAllowed: true,
        },
      }),
      makeLogger(),
    );

    expect(outcome).toBe('skipped');
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });
});

// ============================================================================
// The cap. A digest of 200 rows is already past being read; beyond it the
// overflow is COUNTED, never silently truncated - the reader is told the list
// was cut, and the flush logs it.
// ============================================================================
describe('deliverKindEmail - the bundle cap', () => {
  it('stores the item that lands exactly ON the cap', async () => {
    mockDbData[`${bundlePath(DIGEST_KIND)}/count`] = MAX_BUNDLE_ITEMS - 1;

    const outcome = await deliverKindEmail(request(DIGEST_KIND), makeLogger());

    expect(outcome).toBe('queued');
    expect(mockDbData[`${bundlePath(DIGEST_KIND)}/count`]).toBe(MAX_BUNDLE_ITEMS);
    expect(storedItemPaths()).toHaveLength(1);
  });

  it("returns 'skipped' past the cap, counting the overflow instead of storing it", async () => {
    mockDbData[`${bundlePath(DIGEST_KIND)}/count`] = MAX_BUNDLE_ITEMS;
    const logger = makeLogger();

    const outcome = await deliverKindEmail(request(DIGEST_KIND), logger);

    expect(outcome).toBe('skipped');
    // All-or-nothing: the count did not advance past the cap...
    expect(mockDbData[`${bundlePath(DIGEST_KIND)}/count`]).toBe(MAX_BUNDLE_ITEMS);
    // ...no item was stored...
    expect(storedItemPaths()).toEqual([]);
    expect(mockUpdateCalls).toHaveLength(0);
    // ...and the overflow was counted so the copy can own up to it.
    expect(mockDbData[`${bundlePath(DIGEST_KIND)}/dropped`]).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('full'),
      expect.objectContaining({ kind: DIGEST_KIND, cap: MAX_BUNDLE_ITEMS }),
    );
  });

  it('accumulates the dropped counter across repeated overflow', async () => {
    mockDbData[`${bundlePath(DIGEST_KIND)}/count`] = MAX_BUNDLE_ITEMS;
    await deliverKindEmail(request(DIGEST_KIND), makeLogger());
    await deliverKindEmail(request(DIGEST_KIND), makeLogger());
    await deliverKindEmail(request(DIGEST_KIND), makeLogger());
    expect(mockDbData[`${bundlePath(DIGEST_KIND)}/dropped`]).toBe(3);
  });
});

// ============================================================================
// THE FAILURE POSTURE. The single most important guarantee in the module:
// bundling is an optimisation, delivery is the product. Anything unexpected in
// the machinery - an unreadable slot, a rejected write, a surprise - falls back
// to the behaviour the platform had before this module existed. Nothing here
// may throw, and nothing here may end in silence.
// ============================================================================
describe('deliverKindEmail - failure posture', () => {
  it('falls back to an immediate send when the QUEUE WRITE is rejected', async () => {
    mockThrowOn = 'emailBundles';
    const logger = makeLogger();

    const outcome = await deliverKindEmail(request(DIGEST_KIND), logger);

    expect(outcome).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('sending immediately'),
      expect.objectContaining({ kind: DIGEST_KIND, orgId: ORG }),
    );
  });

  it('falls back to an immediate send when ONLY the item write is rejected, after the count has already advanced', async () => {
    // The narrow window inside appendToBundle: the aborting count transaction
    // commits, then the multi-path item write is refused. The email still goes
    // out, which is the guarantee that matters.
    //
    // NOTE for the flush: this leaves the bundle holding a count of 1 with no
    // item behind it. The flush must therefore treat `count` as advisory and
    // render from the items it can actually read, never emit a digest for a
    // bundle whose items are empty, and reset the count when it clears one.
    mockThrowOn = '/items/';
    const logger = makeLogger();

    const outcome = await deliverKindEmail(request(DIGEST_KIND), logger);

    expect(outcome).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(storedItemPaths()).toEqual([]);
    expect(mockDbData[`${bundlePath(DIGEST_KIND)}/count`]).toBe(1);
  });

  it('falls back to an immediate send when the SLOT READ throws', async () => {
    mockThrowOn = 'emailDays';

    const outcome = await deliverKindEmail(request(COLLAPSE_KIND), makeLogger());

    expect(outcome).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('falls back to an immediate send when the config load throws', async () => {
    mockLoadConfig.mockRejectedValueOnce(new Error('settings unreadable'));

    const outcome = await deliverKindEmail(request(DIGEST_KIND), makeLogger());

    expect(outcome).toBe('sent');
  });

  it('NEVER throws, whatever the machinery does', async () => {
    mockThrowOn = 'ops/';
    for (const kind of [IMMEDIATE_KIND, COLLAPSE_KIND, DIGEST_KIND]) {
      await expect(
        deliverKindEmail(request(kind), makeLogger()),
      ).resolves.toBeDefined();
    }
  });

  it('degrades to skipped - never to a throw - when the fallback send is also refused', async () => {
    mockThrowOn = 'ops/';
    mockSendResult = false;

    await expect(
      deliverKindEmail(request(DIGEST_KIND), makeLogger()),
    ).resolves.toBe('skipped');
  });
});

// ============================================================================
// The stored item. RTDB rejects `undefined` ANYWHERE in a written value - one
// absent optional field would reject the whole multi-path update and take the
// send down the failure path - so an absent field must be OMITTED, never set
// to undefined.
// ============================================================================
describe('deliverKindEmail - the queued item', () => {
  const storedItem = () => mockUpdateCalls[0][`${bundlePath(DIGEST_KIND)}/items/push-1`];

  it('writes no undefined anywhere, omitting the optional fields the caller left out', async () => {
    await deliverKindEmail(request(DIGEST_KIND), makeLogger());

    const item = storedItem() as Record<string, unknown>;
    expect(undefinedPathsIn(mockUpdateCalls[0])).toEqual([]);
    expect('kindLink' in item).toBe(false);
    expect('kindRows' in item).toBe(false);
    expect('digestRow' in item).toBe(false);
    // JSON round-trip is the same thing said the way the wire sees it.
    expect(JSON.parse(JSON.stringify(item))).toEqual(item);
  });

  it('carries everything the flush needs to render later without re-reading the world', async () => {
    const before = Date.now();
    await deliverKindEmail(
      request(DIGEST_KIND, {
        kindLink: 'https://safentia.co.uk/app/customers',
        kindRows: [{ label: 'Building', value: 'Rose Court' }],
        digestRow: { label: 'Rose Court', value: 'Review due in 30 days' },
      }),
      makeLogger(),
    );

    const item = storedItem() as Record<string, unknown>;
    expect(undefinedPathsIn(mockUpdateCalls[0])).toEqual([]);
    expect(item).toMatchObject({
      variables: { 'org.name': 'Acme Fire Safety Ltd' },
      // The brand at QUEUE time, so a bundle renders in the colours the event
      // actually happened under.
      brand: { name: 'Acme Fire Safety Ltd', accent: '#336699' },
      kindLink: 'https://safentia.co.uk/app/customers',
      kindRows: [{ label: 'Building', value: 'Rose Court' }],
      digestRow: { label: 'Rose Court', value: 'Review due in 30 days' },
    });
    expect(item.at as number).toBeGreaterThanOrEqual(before);
  });

  it('writes the address and the item in ONE update - a bundle can never hold items with nowhere to send them', async () => {
    await deliverKindEmail(request(DIGEST_KIND), makeLogger());

    expect(mockUpdateCalls).toHaveLength(1);
    expect(Object.keys(mockUpdateCalls[0]).sort()).toEqual(
      [
        `${bundlePath(DIGEST_KIND)}/items/push-1`,
        `${bundlePath(DIGEST_KIND)}/to`,
      ].sort(),
    );
  });
});
