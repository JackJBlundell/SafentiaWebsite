// ============================================================================
// Invitation limit check - story 1023.
//
// Isolated behind ONE function with both modes unit-tested, exactly as the story
// requires, so Phase 3 entitlement enforcement switches on without reworking the
// invite path. The contract:
//   - If /platform/plans carries a staff limit for the org's plan, enforce it.
//   - If no plan / no limit is present, treat the org as UNLIMITED (Phase 1
//     behaviour) and allow.
// Keeping the decision pure (assertWithinInviteLimit) makes both modes - limited
// and unlimited - deterministically testable without a database (brief 18.2).
// ============================================================================

import { db } from '../admin';
import type { EnvPaths } from './paths';
import { platform } from './paths';
import { fail } from './errors';
import type { PlanLimits } from '../shared/types';

/** What the org currently consumes and what its plan permits, if anything. */
export interface InviteLimitContext {
  /** Current org staff count (active members), as accounted in org usage. */
  currentStaffCount: number;
  /** The plan's staff ceiling, or undefined when the org has no enforced limit. */
  staffLimit: number | undefined;
}

/**
 * Pure decision: is creating one more invitation within the org's staff limit?
 * Unlimited when staffLimit is undefined. Throws a structured 'resource-exhausted'
 * error when the limit would be exceeded. Pure so both modes test without I/O.
 */
export function assertWithinInviteLimit(ctx: InviteLimitContext): void {
  if (ctx.staffLimit === undefined) {
    // No plan limit configured: Phase 1 unlimited behaviour.
    return;
  }
  // An invitation is a prospective seat, so the check is "current + 1 <= limit".
  if (ctx.currentStaffCount + 1 > ctx.staffLimit) {
    throw fail.resourceExhausted(
      'Your plan has reached its staff limit. Please contact your administrator.',
      { limit: ctx.staffLimit, current: ctx.currentStaffCount },
    );
  }
}

/**
 * Resolve the limit context for an org from the database: read its current staff
 * count from usage, and its plan's staff limit from /platform/plans IF the org has
 * a plan and that plan defines a limit. Any missing link in that chain resolves to
 * "unlimited", which is the documented Phase 1 default (story 1023).
 */
export async function resolveInviteLimitContext(
  env: EnvPaths,
  orgId: string,
): Promise<InviteLimitContext> {
  const usageSnap = await db.ref(env.db.orgUsage(orgId)).get();
  const usage = usageSnap.val() as { staffCount?: number } | null;
  const currentStaffCount =
    typeof usage?.staffCount === 'number' ? usage.staffCount : 0;

  // The org's plan id lives on its subscription block (Phase 3 populates it; absent
  // in Phase 1). Without a plan id there is no limit to enforce.
  const subSnap = await db.ref(env.db.orgSubscription(orgId)).get();
  const planId = (subSnap.val() as { planId?: string } | null)?.planId;
  if (!planId) {
    return { currentStaffCount, staffLimit: undefined };
  }

  // /platform/plans is global (not env-scoped). A plan may exist without a limits
  // block; only an explicit numeric orgStaff limit is enforced.
  const planSnap = await db.ref(platform.plan(planId)).get();
  const limits = (planSnap.val() as { limits?: PlanLimits } | null)?.limits;
  const staffLimit =
    typeof limits?.orgStaff === 'number' ? limits.orgStaff : undefined;

  return { currentStaffCount, staffLimit };
}
