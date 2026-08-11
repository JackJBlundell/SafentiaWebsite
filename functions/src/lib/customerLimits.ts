// ============================================================================
// Customer limit check - Phase 3 billing §6.
//
// The inviteLimits pattern, cloned for the customers ceiling: ONE pure decision
// (assertWithinCustomerLimit) with both modes - limited and unlimited -
// deterministically testable without a database, fed by a resolver that reads
// the org's usage counter and its plan context. The degrade policy (§6.3) is
// block-new-creates only, so this gate guards manageCustomer's CREATE branch
// alone: archive, restore and edit never consult it.
//
// The contract:
//   - If the org's resolved entitlements carry a customers ceiling, enforce it.
//   - Missing plan / subscription resolves to UNLIMITED (the grandfather rule,
//     lib/entitlements invariant 1), so operator-created orgs are never blocked.
//   - A suspended subscription resolves to the zero-create floor upstream, so
//     the same arithmetic refuses every create there too.
// ============================================================================

import { db } from '../admin';
import type { EnvPaths } from './paths';
import { fail } from './errors';
import { resolvePlanContext } from './planContext';

/** What the org currently consumes and what its plan permits, if anything. */
export interface CustomerLimitContext {
  /** Current active customer count, as accounted in org usage (usageCounters). */
  currentCustomerCount: number;
  /** The plan's customer ceiling, or undefined when the org has no enforced limit. */
  customerLimit: number | undefined;
  /** The plan's display name, so the refusal can say which plan is full. */
  planName?: string;
}

/**
 * Pure decision: is creating one more customer within the org's plan? Unlimited
 * when customerLimit is undefined. Throws the structured 'resource-exhausted'
 * error - which the console renders as a calm upsell notice, never a scary
 * failure - when the limit would be exceeded.
 */
export function assertWithinCustomerLimit(ctx: CustomerLimitContext): void {
  if (ctx.customerLimit === undefined) {
    // No plan limit configured: grandfather behaviour, unlimited.
    return;
  }
  // A creation is a prospective customer, so the check is "current + 1 <= limit".
  if (ctx.currentCustomerCount + 1 > ctx.customerLimit) {
    throw fail.resourceExhausted(
      ctx.planName
        ? `The ${ctx.planName} plan includes up to ${ctx.customerLimit} customers. To add more, please upgrade your plan.`
        : 'Your plan has reached its customer limit. To add more, please upgrade your plan.',
      { limit: ctx.customerLimit, current: ctx.currentCustomerCount },
    );
  }
}

/**
 * Resolve the limit context for an org: its current customer count from usage
 * (maintained by lib/usageCounters on every create/archive/restore) and its
 * customers ceiling from the shared plan context. The entitlements module's
 * -1 sentinel means unlimited and maps to the undefined this module's pure
 * check treats the same way; 0 (the suspended floor) passes through and can
 * never admit a create.
 */
export async function resolveCustomerLimitContext(
  env: EnvPaths,
  orgId: string,
): Promise<CustomerLimitContext> {
  const usageSnap = await db.ref(env.db.orgUsage(orgId)).get();
  const usage = usageSnap.val() as { customerCount?: number } | null;
  const currentCustomerCount =
    typeof usage?.customerCount === 'number' ? usage.customerCount : 0;

  const { plan, entitlements } = await resolvePlanContext(env, orgId);
  const limit = entitlements.limits.customers;
  return {
    currentCustomerCount,
    customerLimit: limit === -1 ? undefined : limit,
    ...(plan?.name ? { planName: plan.name } : {}),
  };
}
