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

import { db } from '../admin';
import type { EnvPaths } from './paths';
import { platform } from './paths';
import type { PlanLimits } from '../shared/types';

/**
 * The org's monthly notification cap, or undefined when there is no enforced
 * limit (no plan, or a plan with no notificationsPerMonth). Any missing link in
 * the chain resolves to unlimited - the documented default before a plan is set.
 */
export async function resolveNotificationLimit(
  env: EnvPaths,
  orgId: string,
): Promise<number | undefined> {
  const subSnap = await db.ref(env.db.orgSubscription(orgId)).get();
  const planId = (subSnap.val() as { planId?: string } | null)?.planId;
  if (!planId) {
    return undefined;
  }

  // /platform/plans is global (not env-scoped). A plan may carry no limits block.
  const planSnap = await db.ref(platform.plan(planId)).get();
  const limits = (planSnap.val() as { limits?: PlanLimits } | null)?.limits;
  return typeof limits?.notificationsPerMonth === 'number'
    ? limits.notificationsPerMonth
    : undefined;
}
