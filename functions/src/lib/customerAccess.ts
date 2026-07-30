// ============================================================================
// customerAccess - what archiving a CUSTOMER does to that customer's PEOPLE.
//
// A customer's status and their portal sessions are stored in different places:
// `/customers/{orgId}/{customerId}/status` says whether the organisation is
// still a customer, while a portal session is minted from the individual
// `/customerMembers/{orgId}/{customerId}/{uid}` record (computePortalClaims
// grants claims only while THAT record is active). Archiving the customer alone
// therefore ended nothing: every one of their people stayed signed in and kept
// reading the estate.
//
// This is the cascade that makes archive mean what an admin thinks it means.
// It returns a multi-location-update FRAGMENT rather than writing, so the caller
// folds it into the same atomic update as the status flip and its audit entry -
// access can never be left half-withdrawn by a failure between two writes.
//
// PRECISION ON RESTORE: locking sets `lockedByCustomerArchive` on each account
// it touches, and unlocking reactivates only accounts carrying that mark. An
// account an admin locked individually before the archive (someone who left the
// customer, say) stays locked when the customer comes back, because this cascade
// never touched it.
//
// The /customerMembers write trips onCustomerMembershipChange, which recomputes
// the portal claims and trips the token-refresh marker, so access falls away
// within seconds rather than at the next sign-in.
// ============================================================================

import { db } from '../admin';
import type { EnvPaths } from '../shared/paths';
import type { CustomerMember } from '../shared/types';

export type PortalAccessMode = 'lock' | 'unlock';

/**
 * Build the update fragment that withdraws (or returns) portal access for every
 * account belonging to a customer. Empty when the customer has no portal
 * accounts, which is the common case for a customer whose contacts were never
 * invited - the caller spreads an empty object and nothing changes.
 */
export async function portalAccessCascade(
  paths: EnvPaths,
  orgId: string,
  customerId: string,
  mode: PortalAccessMode,
): Promise<Record<string, unknown>> {
  const snap = await db.ref(paths.db.customerMembers(orgId, customerId)).get();
  const members = (snap.val() as Record<string, CustomerMember> | null) ?? {};
  const update: Record<string, unknown> = {};

  for (const [uid, member] of Object.entries(members)) {
    const memberPath = paths.db.customerMember(orgId, customerId, uid);
    if (mode === 'lock') {
      // Only ACTIVE accounts are locked: an already-locked or archived account
      // is not this cascade's to touch, and marking it would make the restore
      // reactivate someone the admin had deliberately shut out.
      if (member?.status !== 'active') {
        continue;
      }
      update[`${memberPath}/status`] = 'locked';
      update[`${memberPath}/lockedByCustomerArchive`] = true;
      continue;
    }
    // Unlock: exactly the accounts this cascade locked, and no others.
    if (member?.lockedByCustomerArchive !== true) {
      continue;
    }
    update[`${memberPath}/status`] = 'active';
    update[`${memberPath}/lockedByCustomerArchive`] = null;
  }

  return update;
}
