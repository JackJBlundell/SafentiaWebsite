// ============================================================================
// planContext - the ONE server-side plan-context resolver every entitlement
// enforcement point shares (Phase 3 billing §1.2 / §6).
//
// Each gate needs the same three facts: the org's subscription, the plan that
// subscription names, and the entitlements the mirrored pure module resolves
// from the pair. Resolving them here - one RTDB read each, both tolerant of
// absent nodes - means every gate (invites, customers, templates, branding,
// email templates) enforces from IDENTICAL inputs and inherits the grandfather
// rule for free: any missing link (no subscription, no planId, unseeded plan)
// flows into effectiveEntitlements, which resolves it to unlimited/all-features
// exactly as lib/inviteLimits established (story 1023).
//
// Server-only, deliberately NOT mirrored: the pure resolution lives in
// lib/entitlements (mirrored ×2); this module is just its impure feet.
// ============================================================================

import { db } from '../admin';
import type { EnvPaths } from './paths';
import { platform } from './paths';
import { fail } from './errors';
import {
  effectiveEntitlements,
  type Entitlements,
  type PlanFeature,
} from './entitlements';
import { DEFAULT_BRAND } from './provisionOrganisation';
import type { OrgProfile, OrgSubscription, Plan } from '../shared/types';

/** Everything an enforcement point needs to decide, resolved in one call. */
export interface PlanContext {
  /** The org's subscription block, or undefined when billing has never touched it. */
  subscription: OrgSubscription | undefined;
  /** The subscribed plan from /platform/plans/{env}, or undefined when the org
   *  has no planId or the catalogue is not (yet) seeded for it. */
  plan: Plan | undefined;
  /** The resolved entitlements the pure module derives from the pair. */
  entitlements: Entitlements;
}

/**
 * Resolve an org's plan context: one read of its subscription, one read of the
 * named plan (env-NESTED - Phase 3 §5.3: stripePriceId differs between Stripe
 * test/live modes, so the plan comes from the caller's env branch). Absent
 * nodes at either step are the documented grandfather path, never an error.
 */
export async function resolvePlanContext(
  env: EnvPaths,
  orgId: string,
): Promise<PlanContext> {
  const subSnap = await db.ref(env.db.orgSubscription(orgId)).get();
  const subscription = (subSnap.val() as OrgSubscription | null) ?? undefined;

  let plan: Plan | undefined;
  if (subscription?.planId) {
    const planSnap = await db.ref(platform.plan(env.env, subscription.planId)).get();
    plan = (planSnap.val() as Plan | null) ?? undefined;
  }

  return {
    subscription,
    plan,
    // Server call time anchors the grace-expiry arithmetic (the pure module
    // takes `now` rather than reading a clock - see lib/entitlements).
    entitlements: effectiveEntitlements(subscription, plan, Date.now()),
  };
}

/**
 * Require a feature flag, or refuse with the structured failed-precondition the
 * console renders as a calm upsell notice (§6.3 - never a hard redirect or a
 * scary error). Pure over the resolved entitlements so both outcomes unit-test
 * without a database, matching the assertWithinInviteLimit idiom.
 */
export function assertFeature(
  entitlements: Entitlements,
  feature: PlanFeature,
  message: string,
): void {
  if (!entitlements.features[feature]) {
    throw fail.failedPrecondition(message, { feature });
  }
}

/**
 * Refuse a CREATE for a suspended organisation (§6.3 degrade policy: the
 * zero-create floor blocks new jobs/assessments/customers/invites while reads
 * and in-flight work continue). The structured 'resource-exhausted' error is
 * the same vocabulary the countable limits throw, so the console renders it as
 * the same calm notice rather than a scary failure. Pure over the resolved
 * entitlements, matching assertFeature above, so both outcomes unit-test
 * without a database.
 */
export function assertNotSuspended(
  entitlements: Entitlements,
  message: string,
): void {
  if (entitlements.suspended) {
    throw fail.resourceExhausted(message, { suspended: true });
  }
}

/**
 * Apply the branding entitlement to a stored org profile (§6.3): when the
 * feature is off - a bronze plan, or a suspended subscription - the stored
 * logo, colours, cover image and font are RETAINED in RTDB but NOT applied, so
 * downstream renderers (report cover, themed emails) fall back to the Safentia
 * defaults they already carry for a profile that never set them. Identity and
 * contact details are not branding and always pass through. Pure, so both the
 * stripped and pass-through modes test without I/O.
 */
export function applyBrandingEntitlement(
  profile: OrgProfile,
  entitlements: Entitlements,
): OrgProfile {
  if (entitlements.features.branding) {
    return profile;
  }
  // Rebuilt without the branded fields rather than deleted from a copy, so a
  // future OrgProfile addition defaults to "passes through" and must opt in
  // to being gated here. `brand` is required on OrgProfile, so it is replaced
  // with the platform default (the same colours provisionOrganisation stamps
  // on a fresh org) rather than removed.
  const { logoUrl: _logo, coverImageUrl: _cover, fontFamily: _font, ...rest } = profile;
  return { ...rest, brand: { ...DEFAULT_BRAND } };
}
