// ============================================================================
// inviteSeats - the client twin of the server's pending-seat arithmetic
// (functions/src/lib/inviteLimits.countPendingStaffInvites).
//
// A pending, unexpired STAFF invitation is a seat already promised:
// acceptInvitation admits without re-checking the plan limit, so
// createInvitation reserves the seat at issue time - occupied members PLUS
// pending invites must fit the ceiling. The console's gates count the same way
// here so the invite button and the invite form never look open when the
// server would refuse (presentation only - the server remains the boundary).
// Portal invites (customerId set) never consume a staff seat, and accepted /
// revoked / expired records have released theirs.
// ============================================================================

import type { InvitationSummary } from '../../types';

/** Live staff invitations that currently reserve a plan seat. */
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
