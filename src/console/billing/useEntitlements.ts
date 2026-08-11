// ============================================================================
// useEntitlements - the console's single answer to "what may this org do?".
//
// Reads the org's subscription block, the plan document it names and the
// server-maintained usage counters, and resolves them through the pure
// entitlements module (the same module the server enforcement points run).
// Every UI gate (invite/customer/template creates, branding, email templates,
// the dunning banner) calls this one hook, so no screen re-derives billing
// state its own way.
//
// PRESENTATION ONLY: these gates exist so an at-limit admin meets a calm
// upsell instead of a server rejection. The server-side limit checks are the
// boundary; nothing here grants or denies anything.
//
// Read permissions (database.rules.json):
//   - /subscription is ADMIN-read. A non-admin member's listener would be
//     DENIED, and useRtdbQuery answers a denial with an error state plus a
//     5-second re-attach loop - permanent noise for an expected condition. So
//     the subscription (and usage) reads are gated on the admin claim instead
//     of attaching-and-failing. A non-admin therefore resolves to the
//     grandfather posture (no subscription visible => unlimited, features on),
//     which is honest for presentation: non-admins hold no create controls the
//     gates guard, and the server remains the boundary regardless.
//   - Plan documents are authed-read (platform catalogue data), so that read
//     needs no role gate - it simply waits for a planId to exist.
// ============================================================================

import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { platform } from '../../paths';
import type { OrgSubscription, OrgUsage, Plan } from '../../types';
import { effectiveEntitlements, type Entitlements } from './entitlements';

export interface EntitlementsState {
  /** The resolved limits/features/suspended flag - never undefined; while the
   *  reads attach it holds the grandfather posture (see `loading`). */
  entitlements: Entitlements;
  plan: Plan | undefined;
  subscription: OrgSubscription | undefined;
  usage: OrgUsage | undefined;
  /** True while any backing read is still attaching. During this window the
   *  entitlements resolve UNLIMITED, so gates show their normal controls
   *  rather than flashing an upsell that data may immediately retract. */
  loading: boolean;
  /** The admin claim, resolved once here because every gate pairs its notice
   *  wording ("View plans" vs "ask your administrator") with it. */
  isAdmin: boolean;
}

export function useEntitlements(): EntitlementsState {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  // STAFF admin only: a portal session's roles.admin is a CUSTOMER role, and
  // attaching the admin-read subscription/usage listeners for one would meet a
  // permanent rules denial (the exact re-attach noise the header note exists
  // to avoid). Portal sessions resolve the grandfather posture instead.
  const isAdmin = claims?.kind !== 'portal' && claims?.roles.admin === true;
  const ready = Boolean(orgId && paths);

  // Admin-read nodes: attach only for admins (header note). The keys still use
  // the real orgId so an org switch mints fresh cache entries.
  const subscription = useRtdbQuery<OrgSubscription | null>({
    key: keys.orgSubscription(orgId),
    path: paths ? paths.db.orgSubscription(orgId) : '',
    enabled: ready && isAdmin,
  });
  const usage = useRtdbQuery<OrgUsage | null>({
    key: keys.orgUsage(orgId),
    path: paths ? paths.db.orgUsage(orgId) : '',
    enabled: ready && isAdmin,
  });

  // The plan the subscription names, from the env-nested catalogue. The env
  // comes from the session's resolved paths (the testMode claim), the same
  // derivation every console read uses. No planId (grandfathered org, or a
  // non-admin who cannot see one) leaves the read detached and the plan
  // undefined - exactly what the grandfather rule expects.
  const planId = subscription.data?.planId;
  const plan = useRtdbQuery<Plan | null>({
    key: keys.platformPlan(paths?.env ?? 'live', planId ?? 'none'),
    path: paths && planId ? platform.plan(paths.env, planId) : '',
    enabled: Boolean(paths && planId),
  });

  // A denied or errored read is treated as absent rather than surfaced: for
  // entitlements, "cannot see a subscription" and "has no subscription" both
  // resolve to the safe posture (unlimited - never lock a safety tool over a
  // read hiccup), and the server enforces the real limits either way.
  const subscriptionValue = subscription.isError
    ? undefined
    : (subscription.data ?? undefined);
  const planValue = plan.isError ? undefined : (plan.data ?? undefined);
  const usageValue = usage.isError ? undefined : (usage.data ?? undefined);

  const loading =
    (isAdmin && (subscription.isLoading || usage.isLoading)) ||
    (Boolean(planId) && plan.isLoading);

  return {
    // Render time anchors the grace-expiry arithmetic (the pure module takes
    // `now` rather than reading a clock). Good enough for presentation: a
    // stale render shows the pre-expiry gate briefly, and the server-side
    // check - which passes its own call time - remains the boundary.
    entitlements: effectiveEntitlements(subscriptionValue, planValue, Date.now()),
    plan: planValue,
    subscription: subscriptionValue,
    usage: usageValue,
    loading,
    isAdmin,
  };
}
