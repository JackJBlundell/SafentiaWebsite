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
import { fail } from './errors';
import { resolvePlanContext } from './planContext';
import type { InvitationSummary } from '../shared/types';

/** What the org currently consumes and what its plan permits, if anything. */
export interface InviteLimitContext {
  /** Current org staff count (non-archived members), as accounted in org usage. */
  currentStaffCount: number;
  /** Live (pending, unexpired) STAFF invitations - each one is a seat already
   *  promised: acceptInvitation admits without re-checking the limit (refusing
   *  a legitimately invited person at the door would be hostile and racy), so
   *  the seat must be reserved HERE, at issue time. Excluding pending invites
   *  would let an org at limit-1 issue any number of invites and land every
   *  acceptance over the ceiling. */
  pendingInviteCount: number;
  /** The plan's staff ceiling, or undefined when the org has no enforced limit. */
  staffLimit: number | undefined;
}

/**
 * Pure decision: is claiming one more staff seat (an invitation, or an archived
 * member's reinstatement) within the org's staff limit? Seats already spoken
 * for = non-archived members + pending unexpired invites. Unlimited when
 * staffLimit is undefined. Throws a structured 'resource-exhausted' error when
 * the limit would be exceeded. Pure so both modes test without I/O.
 */
export function assertWithinInviteLimit(ctx: InviteLimitContext): void {
  if (ctx.staffLimit === undefined) {
    // No plan limit configured: Phase 1 unlimited behaviour.
    return;
  }
  // The claim is a prospective seat, so the check is "occupied + reserved + 1
  // <= limit" - a suspended org's zero floor can never pass it.
  if (ctx.currentStaffCount + ctx.pendingInviteCount + 1 > ctx.staffLimit) {
    throw fail.resourceExhausted(
      'Your plan has reached its staff limit. To add more people, upgrade your plan, or archive a member or revoke a pending invitation first.',
      {
        limit: ctx.staffLimit,
        current: ctx.currentStaffCount,
        pending: ctx.pendingInviteCount,
      },
    );
  }
}

/**
 * Count the STAFF invitations that currently reserve a seat: status 'pending'
 * and not yet past their expiry. Portal invites (customerId set) never consume
 * a staff seat (createInvitation's documented policy), and accepted / revoked /
 * expired records release theirs. Read defensively: the summaries are written
 * only by the platform, but a malformed child must not crash an invite.
 */
export function countPendingStaffInvites(
  summaries: Record<string, InvitationSummary> | null | undefined,
  now: number,
): number {
  if (!summaries) {
    return 0;
  }
  return Object.values(summaries).filter(
    (summary) =>
      summary !== null &&
      typeof summary === 'object' &&
      summary.status === 'pending' &&
      summary.customerId === undefined &&
      typeof summary.expiresAt === 'number' &&
      summary.expiresAt > now,
  ).length;
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

  // Seats already reserved by in-flight invitations (see the context's field
  // note): the admin-facing summaries carry status + expiry without the bearer
  // token, so they are the correct - and cheap - source for the count.
  const invitesSnap = await db.ref(env.db.orgInvitations(orgId)).get();
  const pendingInviteCount = countPendingStaffInvites(
    invitesSnap.val() as Record<string, InvitationSummary> | null,
    Date.now(),
  );

  // The shared Phase 3 resolver (lib/planContext): subscription + env-nested
  // plan + the pure entitlements resolution. Every missing link in that chain
  // still resolves to unlimited (the documented Phase 1 default), now via the
  // same module the customer/template/branding gates enforce from, and a
  // terminally dead subscription resolves to the zero-create floor (§6.3) so
  // a suspended org cannot add seats either.
  const { entitlements } = await resolvePlanContext(env, orgId);
  const limit = entitlements.limits.orgStaff;
  return {
    currentStaffCount,
    pendingInviteCount,
    staffLimit: limit === -1 ? undefined : limit,
  };
}
