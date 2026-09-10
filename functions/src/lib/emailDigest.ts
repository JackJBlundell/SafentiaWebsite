// ============================================================================
// emailDigest - the delivery seam that keeps one person from being emailed a
// hundred times in a morning (EMAIL_BUNDLING_PLAN.md).
//
// THE GUARANTEE: for each (recipient address, email kind), AT MOST ONE EMAIL
// PER UK CALENDAR DAY. Everything else that happened that day is bundled into
// it and sent by the flush the following morning.
//
// Every send site now calls `deliverKindEmail` instead of `sendKindEmail`.
// This module decides only WHETHER a send happens now; when it does, it hands
// straight to lib/templatedEmail, which still owns rendering, branding, plan
// gating, the org's on/off toggle and the send log. There is exactly one
// renderer and one dispatcher, as there was before - this seam sits in front
// of them, never beside them.
//
// Two pieces of server-only state make the guarantee, both under the global
// `ops` tree that rules default-deny (lib/paths):
//
//   emailDays/{env}/{orgId}/{hash}/{kindId}  = 'YYYY-MM-DD'
//       The last UK day an email of this kind reached this address. ONE node
//       holding a date string, not a child per day, so it never grows and needs
//       no cleanup sweep of its own. Claimed by transaction, which is what
//       makes the "at most one" exact under concurrent sends.
//
//   emailBundles/{env}/{orgId}/{hash}/{kindId}
//       The pending items for that pair: `to`, a `count`, a `dropped` overflow
//       counter, `items/{pushId}`, and - only mid-flush - `inflight/{flushId}`.
//
// Both are keyed by a HASH of the address, never the address itself: RTDB keys
// may not contain '.', and hashing also keeps addresses out of path strings and
// therefore out of the logs that quote them (brief 18.4). The address lives in
// the bundle's `to` child, transiently, and goes when the bundle is flushed.
// The same RTDB rule applies to the variable names an item carries, which are
// namespaced with dots - they are escaped on the way in and unescaped on the
// way out, in one place, below.
//
// FAILURE POSTURE, inherited whole from sendKindEmail: this function NEVER
// THROWS and a business send must never fail over configuration. Every error
// path - an unreadable slot, a rejected queue write, a surprise - falls back to
// sending IMMEDIATELY. A duplicate email is survivable; a fire-safety reminder
// swallowed by the machinery meant to tidy it is not.
// ============================================================================

import { createHash } from 'node:crypto';
import { ops } from './paths';
import { ukDay } from './ukCalendar';
import { EMAIL_KINDS } from './emailKindCatalogue';
import { loadKindConfig, sendKindEmail } from './templatedEmail';
import type { KindConfig, KindSendRequest } from './templatedEmail';
import type { EmailBrand } from './emailHtml';
import type { Logger } from './logging';
import type { EmailKindId, Environment } from '../shared/types';

/**
 * How many items one (recipient, kind) bundle may hold before further sends
 * are counted rather than stored. A digest of 200 rows is already past the
 * point of being read; beyond it the `dropped` counter carries the overflow
 * into the copy ("...and 43 more") and the flush logs it. Nothing is ever
 * silently truncated - the reader is told the list was cut.
 */
export const MAX_BUNDLE_ITEMS = 200;

/** What `deliverKindEmail` did. Informational: every caller is best-effort and
 *  none of them branch on it, but the sweeps log the tally. */
export type DeliveryOutcome = 'sent' | 'queued' | 'skipped';

// ============================================================================
// VARIABLE NAMES ARE NAMESPACED, RTDB KEYS CANNOT BE.
//
// Every template variable in emailKindCatalogue is `namespace.field` -
// 'org.name', 'info.dueDate', 'action.subjectStagePhrase', 'digest.countPhrase'
// - and that dot is the convention, not an accident: it is what separates the
// server-derived namespaces from the rest (sendManualEmail refuses caller keys
// under 'org.' and 'recipient.'). RTDB, meanwhile, rejects '.', '#', '$', '/',
// '[' and ']' in KEYS, and a queued item stores its variable map as a child
// node - so an unescaped name makes the whole bundle write throw and every
// bundled send of that kind falls back to sending immediately, for ever.
//
// So the storage layer escapes the names going in and unescapes them coming
// out, symmetrically and in this one place. It is the value-side twin of the
// recipient hash above, which exists for exactly the same RTDB rule.
//
// The escape character is '~', which RTDB allows in keys and which no variable
// name uses: 'info.dueDate' is stored as 'info~ddueDate' - still legible in the
// console, which base64 or percent-encoding would not be. Escaping '~' itself
// first is what keeps the mapping reversible.
//
// The two branded types below are what stop this being a thing a caller has to
// remember: a StoredVariables map is not assignable to a decoded one or vice
// versa, so the compiler - not a reviewer - catches an item written without
// encoding or rendered without decoding.
// ============================================================================

/** char -> escape. '~' MUST come first when read as an ordered table: it is
 *  the escape itself, and encoding it after the others would double-escape. */
const KEY_ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ['~', '~~'],
  ['.', '~d'],
  ['#', '~h'],
  ['$', '~s'],
  ['/', '~f'],
  ['[', '~l'],
  [']', '~r'],
];

const ESCAPE_BY_CHAR = new Map<string, string>(KEY_ESCAPES);
const CHAR_BY_MARKER = new Map<string, string>(
  KEY_ESCAPES.map(([char, escape]) => [escape[1], char]),
);

/** RTDB rejects the empty key too. No declared variable is nameless, but the
 *  storage layer must not be the thing that throws if one ever is. Unambiguous
 *  because a literal '~z' in a name encodes to '~~z'. */
const EMPTY_KEY = '~z';

/** One variable name, made safe to use as an RTDB key. */
export function encodeVariableKey(name: string): string {
  if (name === '') return EMPTY_KEY;
  let out = '';
  for (const char of name) out += ESCAPE_BY_CHAR.get(char) ?? char;
  return out;
}

/** The exact inverse of encodeVariableKey. An escape marker this table does
 *  not know is left as written rather than guessed at - stored data is data,
 *  and a name that round-trips oddly is better than one silently mangled. */
export function decodeVariableKey(key: string): string {
  if (key === EMPTY_KEY) return '';
  let out = '';
  for (let i = 0; i < key.length; i += 1) {
    const char = key[i];
    if (char !== '~') {
      out += char;
      continue;
    }
    const decoded = CHAR_BY_MARKER.get(key[i + 1] ?? '');
    if (decoded === undefined) {
      out += char;
      continue;
    }
    out += decoded;
    i += 1;
  }
  return out;
}

declare const storedKeysTag: unique symbol;
declare const decodedKeysTag: unique symbol;

/** A variable map whose KEYS are escaped for RTDB. Only ever produced by
 *  encodeVariables and only ever consumed by decodeVariables. */
export type StoredVariables = Record<string, string> & {
  readonly [storedKeysTag]: true;
};

/** A variable map with real, dotted names - what a send site computes and what
 *  the renderer substitutes. Structurally a plain map, so it still satisfies
 *  every Record<string, string> the renderer takes. */
export type DecodedVariables = Record<string, string> & {
  readonly [decodedKeysTag]: true;
};

/** Names -> RTDB-safe keys. Values are untouched: only keys are constrained. */
export function encodeVariables(
  variables: Record<string, string>,
): StoredVariables {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(variables)) {
    out[encodeVariableKey(name)] = value;
  }
  return out as StoredVariables;
}

/** RTDB-safe keys -> names. Tolerant of what it finds: stored state is read
 *  back as untyped JSON, and one malformed entry must not cost a whole bundle
 *  its send (the flush's failure posture, applied at the boundary). */
export function decodeVariables(stored: StoredVariables): DecodedVariables {
  const source: Record<string, unknown> = stored ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') out[decodeVariableKey(key)] = value;
  }
  return out as DecodedVariables;
}

/**
 * One queued send, holding everything the flush needs to render it later
 * WITHOUT re-reading the world: a bundle of one is rendered through the kind's
 * ordinary template with these exact values, so a quiet day looks precisely as
 * it does today. Deliberately server-only operational state, not tenant
 * schema, so it is typed here rather than in the mirrored types contract.
 *
 * This is the DECODED form, as the renderer wants it. What actually sits in
 * RTDB is StoredQueuedEmail; decodeQueuedEmail is the only way across.
 */
export interface QueuedEmail {
  /** Epoch millis at queue time; the flush renders items oldest-first. */
  at: number;
  /** The kind's declared {{variables}}, exactly as the send site computed them. */
  variables: DecodedVariables;
  /** The org's brand at queue time. Stored rather than re-read so a bundle
   *  renders in the colours the event actually happened under. */
  brand: EmailBrand;
  /** The per-recipient CTA; absent means the kind's cta block drops. */
  kindLink?: string;
  /** The send site's detail card. */
  kindRows?: Array<{ label: string; value: string }>;
  /** This item's line in a digest. Absent falls back, at flush time, to the
   *  rendered subject and preheader - so every kind bundles usefully from day
   *  one and send sites can be sharpened one at a time. */
  digestRow?: { label: string; value: string };
}

/** The stored form of a queued send: identical but for the escaped variable
 *  keys. This is what is written to, moved within and restored to RTDB - the
 *  flush handles items in this form throughout, and decodes only at the point
 *  of rendering, so an item that goes back on the queue goes back exactly as
 *  it was stored. */
export interface StoredQueuedEmail extends Omit<QueuedEmail, 'variables'> {
  variables: StoredVariables;
}

/** The one crossing from stored to renderable. */
export function decodeQueuedEmail(stored: StoredQueuedEmail): QueuedEmail {
  return { ...stored, variables: decodeVariables(stored.variables) };
}

/** Everything a send site supplies to have one email delivered. */
export interface DeliverRequest extends KindSendRequest {
  /** This item's line in a digest (see QueuedEmail.digestRow). */
  digestRow?: { label: string; value: string };
  /**
   * Bypass the day slot and the queue entirely. Set ONLY by the four visit and
   * diary change kinds, and only when the visit falls within
   * URGENT_VISIT_WINDOW_MS - a cancellation for tomorrow morning cannot wait
   * for the next flush, because someone would wait in for an assessor who is
   * not coming. It is the single documented exception to the one-per-day rule
   * and is deliberately not a general-purpose flag.
   */
  urgent?: boolean;
}

/**
 * How close a visit must be for a change to it to bypass bundling: 48 hours.
 * Wide enough that a next-day visit is always covered whatever time the change
 * is made, narrow enough that a routine booking three weeks out still bundles.
 */
export const URGENT_VISIT_WINDOW_MS = 48 * 60 * 60 * 1000;

/** True when a visit is close enough that changes to it must not be held.
 *  Shared by the diary and customer-visit senders so both draw the line in the
 *  same place. A visit already in the past is not urgent - nobody is waiting. */
export function isImminentVisit(
  scheduledFor: number,
  now: number = Date.now(),
): boolean {
  return scheduledFor >= now && scheduledFor - now <= URGENT_VISIT_WINDOW_MS;
}

/**
 * The RTDB key for one recipient address. Lower-cased and trimmed first, so the
 * same person written three ways collapses onto one slot and one bundle - the
 * same normalisation the send sites already use to de-duplicate recipients.
 * 32 hex characters of SHA-256: collision-free at any plausible scale, and short
 * enough to keep the paths readable in a console.
 */
export function recipientHash(email: string): string {
  return createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

/**
 * Is bundling switched on? Defaults to ON: the whole point of the seam is that
 * it is the delivery path. Setting EMAIL_BUNDLING_ENABLED='false' degrades
 * every kind to today's immediate behaviour, which is the rollback lever - an
 * environment change, not a redeploy. Read per call, never cached, so the
 * lever takes effect on the next invocation.
 */
export function isBundlingEnabled(): boolean {
  return process.env.EMAIL_BUNDLING_ENABLED !== 'false';
}

/**
 * Claim the day slot for one (recipient, kind).
 *
 * Returns TRUE when this caller now owns today - the slot was free, or held by
 * an earlier day - and FALSE when an email of this kind has already reached
 * this address today. The transaction is what makes the guarantee exact: two
 * concurrent releases racing for the same admin's slot cannot both win.
 *
 * Exported because the flush claims the very same slot before it sends, which
 * is what stops a bundle delivered at 08:15 being joined by an immediate send
 * at 09:00.
 */
export async function claimDaySlot(
  env: Environment,
  orgId: string,
  hash: string,
  kind: EmailKindId,
  day: string,
): Promise<boolean> {
  const { db } = await import('../admin');
  const slot = db.ref(ops.emailDay(env, orgId, hash, kind));
  // Abort (undefined) when today is already stored: aborting is how a RTDB
  // transaction says "someone else got here first" without a second read.
  const claim = await slot.transaction((current: string | null) =>
    current === day ? undefined : day,
  );
  return claim.committed;
}

/**
 * How many sends are already waiting in one (recipient, kind) bundle. Reads the
 * `count` child the append transaction maintains rather than the items
 * themselves, so this stays a single small read on the hot path however large
 * the bundle has grown. A bundle mid-flush has had its count cleared, which is
 * correct: those items are no longer waiting, they are being sent.
 */
async function bundlePendingCount(
  env: Environment,
  orgId: string,
  hash: string,
  kind: EmailKindId,
): Promise<number> {
  const { db } = await import('../admin');
  const snap = await db
    .ref(`${ops.emailBundle(env, orgId, hash, kind)}/count`)
    .get();
  const value = snap.val() as number | null;
  return typeof value === 'number' ? value : 0;
}

/**
 * Append one send to its (recipient, kind) bundle. Returns false when the
 * bundle is full, having counted the overflow instead.
 *
 * The count is advanced by an ABORTING transaction rather than a plain
 * increment, so concurrent sends cannot race past the cap, and the item is
 * written alongside `to` in a single multi-path update - a bundle can never
 * hold items with no address to send them to.
 */
async function appendToBundle(
  env: Environment,
  orgId: string,
  hash: string,
  kind: EmailKindId,
  to: string,
  item: StoredQueuedEmail,
): Promise<boolean> {
  const { db } = await import('../admin');
  const bundlePath = ops.emailBundle(env, orgId, hash, kind);

  const countTx = await db
    .ref(`${bundlePath}/count`)
    .transaction((current: number | null) => {
      const next = (current ?? 0) + 1;
      return next > MAX_BUNDLE_ITEMS ? undefined : next;
    });
  if (!countTx.committed) {
    // Full. Count the overflow so the digest can own up to it in the copy.
    await db
      .ref(`${bundlePath}/dropped`)
      .transaction((current: number | null) => (current ?? 0) + 1);
    return false;
  }

  // ====
  // `push().key` is typed string | null (null only for a detached ref, which
  // the Admin SDK never hands back). Interpolating a null would quietly write
  // to a path literally ending '/null'. THROW rather than returning false:
  // false means "the bundle is full", which legitimately discards the send,
  // and this is not that - it is a surprise, and deliverKindEmail's catch
  // turns a surprise into an immediate send rather than a lost email.
  // ====
  const itemId = db.ref(`${bundlePath}/items`).push().key;
  if (itemId === null) {
    throw new Error('RTDB push() returned no key for an email bundle item');
  }
  try {
    await db.ref().update({
      [`${bundlePath}/to`]: to,
      [`${bundlePath}/items/${itemId}`]: item,
    });
  } catch (error) {
    // ====
    // The cap was claimed BEFORE the item was written, so a failed write has
    // to give it back. Without this, every rejected write creeps the bundle
    // one closer to MAX_BUNDLE_ITEMS with nothing to show for it, and a
    // bundle whose count reaches the cap on phantom items starts discarding
    // real sends - the one outcome this module exists to prevent. The
    // rollback's own failure is swallowed: the caller must see the write
    // error, which is what sends the email immediately.
    // ====
    try {
      await db
        .ref(`${bundlePath}/count`)
        .transaction((current: number | null) => Math.max(0, (current ?? 1) - 1));
    } catch {
      /* The original error is the one that matters. */
    }
    throw error;
  }
  return true;
}

/** The stored form of a request: variable names escaped for RTDB (see the key
 *  escaping above), and - because RTDB rejects `undefined` - every optional
 *  field spread in only when the send site actually supplied it. */
function toQueuedEmail(req: DeliverRequest): StoredQueuedEmail {
  return {
    at: Date.now(),
    variables: encodeVariables(req.variables),
    brand: req.brand,
    ...(req.kindLink !== undefined ? { kindLink: req.kindLink } : {}),
    ...(req.kindRows !== undefined ? { kindRows: req.kindRows } : {}),
    ...(req.digestRow !== undefined ? { digestRow: req.digestRow } : {}),
  };
}

/** Send now, through the one renderer. */
async function sendNow(
  req: DeliverRequest,
  logger: Logger,
): Promise<DeliveryOutcome> {
  const delivered = await sendKindEmail(req, logger);
  return delivered ? 'sent' : 'skipped';
}

/**
 * Deliver one kind email - now, or bundled into the recipient's next daily
 * digest, according to the kind's declared policy.
 *
 * Never throws. Never lets bundling be the reason an email did not arrive:
 * every failure inside falls back to an immediate send.
 */
export async function deliverKindEmail(
  req: DeliverRequest,
  logger: Logger,
): Promise<DeliveryOutcome> {
  try {
    const def = EMAIL_KINDS[req.kind];

    // ====
    // The three ways a send skips the queue entirely: the rollback lever, a
    // kind that may never be held (security, billing, and the two kinds that
    // are already one-per-day by construction), and the imminent-visit
    // exception. A kind with no digest template in the catalogue cannot be
    // bundled either - there would be nothing to render the bundle with.
    // ====
    if (
      !isBundlingEnabled() ||
      def.delivery === 'immediate' ||
      def.digest === undefined ||
      req.urgent === true
    ) {
      return await sendNow(req, logger);
    }

    // The org's own on/off toggle, resolved BEFORE queueing: a kind an admin
    // has switched off must not sit in a bundle for a day and then be dropped
    // by the flush - it should never enter the queue at all. sendKindEmail
    // checks it again at flush time, which is correct; this is the earlier of
    // the two, not a substitute for it.
    const config: KindConfig =
      req.config ?? (await loadKindConfig(req.env, req.orgId, req.kind, logger));
    if (!config.enabled) {
      logger.info('Email kind disabled by organisation; send suppressed', {
        kind: req.kind,
        orgId: req.orgId,
      });
      return 'skipped';
    }

    const hash = recipientHash(req.to);
    const today = ukDay(Date.now());

    // ====
    // 'collapse': the first event of the day is news and sends immediately in
    // the kind's ordinary copy; everything after it is noise and bundles. The
    // slot claim is what tells the two apart, and it is claimed BEFORE the
    // send - a provider failure burns the day rather than reopening the gate,
    // because the alternative is a broken address being retried all day.
    //
    // 'digest': never sends immediately, so it never claims here. The flush
    // claims the slot when it delivers, which is what keeps the whole family
    // to one email per morning.
    // ====
    if (def.delivery === 'collapse') {
      // ====
      // The immediate path is open only when the bundle is EMPTY as well as the
      // slot free. Without the emptiness test a kind that fires every morning
      // before the 08:15 flush would starve its own bundle for ever: the
      // immediate send claims the slot, the flush finds the slot taken and
      // defers, and the pending items grow until the cap starts discarding
      // them - the one failure mode where bundling would lose email outright.
      // With it, a non-empty bundle always wins the next morning's flush,
      // because nothing sent immediately that day to claim the slot ahead of it.
      // ====
      const pending = await bundlePendingCount(req.env, req.orgId, hash, req.kind);
      if (
        pending === 0 &&
        (await claimDaySlot(req.env, req.orgId, hash, req.kind, today))
      ) {
        return await sendNow({ ...req, config }, logger);
      }
    }

    const stored = await appendToBundle(
      req.env,
      req.orgId,
      hash,
      req.kind,
      req.to.trim(),
      toQueuedEmail(req),
    );
    if (!stored) {
      logger.warn('Email bundle full; send counted as overflow, not stored', {
        kind: req.kind,
        orgId: req.orgId,
        cap: MAX_BUNDLE_ITEMS,
      });
      return 'skipped';
    }
    logger.info('Email bundled for the next daily digest', {
      kind: req.kind,
      orgId: req.orgId,
    });
    return 'queued';
  } catch (error) {
    // ====
    // Bundling is an optimisation; delivery is the product. Anything unexpected
    // in the machinery above - an unreadable slot, a rejected write - falls
    // back to the behaviour the platform had before this module existed.
    // ====
    logger.error('Email bundling failed; sending immediately instead', {
      kind: req.kind,
      orgId: req.orgId,
      message: error instanceof Error ? error.message : String(error),
    });
    return await sendNow(req, logger);
  }
}
