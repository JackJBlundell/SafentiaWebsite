// ============================================================================
// Notification quota resolution (brief 4.5 #9, the "enforce later" of the ledger).
//
// Mirrors lib/inviteLimits: read the org's plan from /platform/plans (via its
// subscription's planId) and return the monthly notification ceiling IF the plan
// defines one, otherwise undefined = UNLIMITED. Keeping the resolution in one tiny
// function means sendNotification stays readable and the limit source is stated
// exactly once. The actual count + atomic enforcement lives next to the send (a
// per-month counter under ops/notificationCounts), so this module only answers
// "what is the cap?".
// ============================================================================

import type { EnvPaths } from './paths';
import { resolvePlanContext } from './planContext';

/**
 * The org's monthly notification cap, or undefined when there is no enforced
 * limit (no plan, or a plan with no notificationsPerMonth). Resolved through
 * the shared plan context so this gate judges from the SAME entitlements the
 * mirrored module shows the console (Phase 3 §6.3): the grandfather chain
 * still resolves every missing link to unlimited, a plan cap passes through
 * as-is, and a SUSPENDED subscription (unpaid/canceled/incomplete, or an
 * expired dunning grace window) resolves to the zero-create floor - so a
 * suspended org's notifications stop exactly as the entitlements it renders
 * (SUSPENDED_LIMITS.notificationsPerMonth = 0) say they do. The skip is
 * best-effort by sendNotification's own contract: the calling business op
 * still succeeds, and nothing stored is touched.
 */
export async function resolveNotificationLimit(
  env: EnvPaths,
  orgId: string,
): Promise<number | undefined> {
  const { entitlements } = await resolvePlanContext(env, orgId);
  const limit = entitlements.limits.notificationsPerMonth;
  return limit === -1 ? undefined : limit;
}
