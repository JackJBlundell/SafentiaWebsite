// ============================================================================
// Functions-side path facade.
//
// The canonical, mirrored path builders live in shared/paths and MUST NOT be
// edited here (they are kept byte-for-byte identical with the mobile app's copy
// by the CI diff gate - see SCHEMA_CHANGES.md). This module re-exports them and
// adds ONLY server-internal locations that the mobile app never addresses, so the
// shared contract stays clean while the Functions still have one import for every
// path they need.
//
// The token-refresh marker is the one such location: it is a global (non-env)
// signal the client watches to know it should refresh its ID token after a claim
// change (brief 4.1). It is not tenant data, it never appears in the section 6
// schema, and the app only ever READS it, so it correctly lives outside the
// mirrored builders.
// ============================================================================

import {
  forEnv,
  platform as sharedPlatform,
  envFromTestMode,
  portalSpaceKey,
  usersOnboarding,
  type EnvPaths,
  type RtdbPath,
} from '../shared/paths';
import type { Environment } from '../shared/types';

/** Re-exported as-is so callers import everything paths-related from one place. */
export { forEnv, envFromTestMode, portalSpaceKey, usersOnboarding };
export type { EnvPaths, RtdbPath };

/**
 * Platform (global, non-env) paths: the shared ones plus the server-only token
 * refresh marker. Spreading the shared object keeps every existing builder while
 * adding the marker, so there is still exactly one `platform` surface.
 */
export const platform = {
  ...sharedPlatform,
  /** Per-user metadata the client listens to; bumping it forces a token refresh. */
  metadata: (): RtdbPath => 'metadata',
  tokenRefresh: (uid: string): RtdbPath => `metadata/${uid}/refreshAt`,
} as const;

/**
 * Server-internal operational state the mobile app never addresses: abuse-control
 * counters that the Admin SDK alone reads and writes. These are deliberately NOT
 * in the mirrored shared/paths contract (they are not tenant data and never appear
 * in the section 6 schema), and rules default-deny them so no client can read or
 * tamper with them. The path segments are all server-controlled (uid from a
 * verified token, action a literal, env a fixed enum), so the template form is
 * injection-safe.
 */
export const ops = {
  /** Sliding-window rate-limit bucket for one user + action (lib/rateLimit). */
  rateLimit: (uid: string, action: string): RtdbPath =>
    `ops/rateLimits/${uid}/${action}`,
  /** Per-env, per-org monthly notification counter, for plan-quota enforcement. */
  notificationCount: (
    env: Environment,
    orgId: string,
    yyyyMm: string,
  ): RtdbPath => `ops/notificationCounts/${env}/${orgId}/${yyyyMm}`,
  /** One org's whole notification-counter subtree (all months), for offboarding
   *  deletion to reap without hand-typing the parent path. */
  notificationCountsForOrg: (env: Environment, orgId: string): RtdbPath =>
    `ops/notificationCounts/${env}/${orgId}`,
  /** Per-env, per-org DAILY manual-email recipient counter (UTC date key), for
   *  the spam-relay cap in lib/manualEmailLimits. */
  manualEmailCount: (
    env: Environment,
    orgId: string,
    yyyyMmDd: string,
  ): RtdbPath => `ops/manualEmailCounts/${env}/${orgId}/${yyyyMmDd}`,
  /** One org's whole manual-email-counter subtree (all days), for offboarding
   *  deletion. */
  manualEmailCountsForOrg: (env: Environment, orgId: string): RtdbPath =>
    `ops/manualEmailCounts/${env}/${orgId}`,

  // ====
  // Email bundling (EMAIL_BUNDLING_PLAN.md). Both trees are keyed by a HASH of
  // the recipient address, never the address itself: RTDB keys may not contain
  // '.', and hashing also keeps addresses out of path strings and therefore out
  // of the logs that quote them (brief 18.4 data minimisation). The address
  // itself lives in the bundle's `to` child, transiently, and is deleted when
  // the bundle is flushed. Server-only by definition - rules default-deny the
  // whole `ops` tree - and reaped on offboarding by the ...ForOrg builders.
  // ====
  /** One recipient's pending bundle for one kind: `to`, a `dropped` overflow
   *  counter, `items/{pushId}` and, mid-flush, `inflight/{flushId}`. */
  emailBundle: (
    env: Environment,
    orgId: string,
    recipientHash: string,
    kindId: string,
  ): RtdbPath => `ops/emailBundles/${env}/${orgId}/${recipientHash}/${kindId}`,
  /** One env's whole bundle collection - the flush sweep's read root. */
  emailBundles: (env: Environment): RtdbPath => `ops/emailBundles/${env}`,
  /** One org's whole bundle subtree, for offboarding deletion. */
  emailBundlesForOrg: (env: Environment, orgId: string): RtdbPath =>
    `ops/emailBundles/${env}/${orgId}`,
  /** The last UK day an email of this kind reached this recipient ('YYYY-MM-DD').
   *  ONE node per (recipient, kind) holding a date string, not a child per day,
   *  so the slot record never grows and needs no cleanup sweep of its own. */
  emailDay: (
    env: Environment,
    orgId: string,
    recipientHash: string,
    kindId: string,
  ): RtdbPath => `ops/emailDays/${env}/${orgId}/${recipientHash}/${kindId}`,
  /** One org's whole day-slot subtree, for offboarding deletion. */
  emailDaysForOrg: (env: Environment, orgId: string): RtdbPath =>
    `ops/emailDays/${env}/${orgId}`,
  // ====
  // Stripe billing plumbing (Phase 3, plan section 4.3). Both are server-only by
  // definition: they exist to make the webhook idempotent and to resolve which
  // org a Stripe customer belongs to, and neither is tenant data. Stripe IDs
  // (cus_..., evt_...) are alphanumeric-plus-underscore, so they are safe RTDB
  // path segments; env is the fixed enum.
  // ====
  /** Reverse index: Stripe customer id -> owning orgId, written at customer
   *  creation so customer-level webhook events without org metadata resolve. */
  stripeCustomer: (env: Environment, customerId: string): RtdbPath =>
    `ops/stripeCustomers/${env}/${customerId}`,
  /** Claim-before-act marker for one received Stripe webhook event. */
  stripeEvent: (env: Environment, eventId: string): RtdbPath =>
    `ops/stripeEvents/${env}/${eventId}`,
  /** One env's whole claim-marker collection (the retention sweep's read root). */
  stripeEvents: (env: Environment): RtdbPath => `ops/stripeEvents/${env}`,
  /** Idempotency marker for self-serve org provisioning: one organisation per
   *  Stripe subscription, stored as {orgId, at} so a webhook retry hands back
   *  the org the first delivery created (lib/provisionOrganisation). Stripe
   *  subscription ids (sub_...) are alphanumeric-plus-underscore, so they are
   *  safe RTDB path segments. */
  provisionedSub: (env: Environment, subscriptionId: string): RtdbPath =>
    `ops/provisionedSubs/${env}/${subscriptionId}`,
} as const;

/** Grouped facade so a caller writes `paths.platform.plan(...)` or `paths.forEnv(env)`. */
export const paths = {
  forEnv,
  envFromTestMode,
  platform,
  ops,
} as const;
