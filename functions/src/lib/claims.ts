// ============================================================================
// Custom-claim computation and persistence (brief 4.1 / 4.8, stories 1019/1021).
//
// Claims are the security boundary's view of who a user is: their org, their role
// set, and whether they live in the test or live data root. They are computed
// ONLY here, from the trusted /orgMembers record, and written ONLY by a Function
// (onMembershipChange) - never by the client. computeClaims is a pure function so
// it is unit-testable in isolation (brief 18.2); writeClaims handles the SDK side
// and the token-refresh marker that makes a permission change take effect within
// seconds without the user re-authenticating (story 1019 AC).
// ============================================================================

import { auth, db } from '../admin';
import { paths } from './paths';
import {
  CUSTOMER_ROLES,
  ORG_ROLES,
  type CustomerMember,
  type CustomerRole,
  type CustomerRoleSet,
  type Environment,
  type SafentiaClaims,
  type OrgMember,
  type OrgRole,
  type OrgRoleSet,
} from '../shared/types';

/**
 * Derive the claims a member record should produce. Pure and total: it never
 * throws, it normalises whatever it is given into a safe claim set, because a
 * malformed member record must not crash the claims pipeline (brief 18.3 "never
 * assume a remote record has every field").
 *
 * - roles: only known role flags set to `true` survive; anything else is dropped,
 *   so a corrupted record can never grant a fabricated role.
 * - testMode: copied through ONLY as a literal true (story 4.8). A locked or
 *   archived member keeps their environment binding but loses all roles, so their
 *   next token refresh strips their access while leaving their identity intact for
 *   the audit trail (story 1021 - archiving preserves attribution).
 */
export function computeClaims(
  member: OrgMember | null | undefined,
  orgId: string,
): SafentiaClaims {
  const roles: OrgRoleSet = {};

  // Only an ACTIVE member carries live permissions. Locked or archived members
  // resolve to an empty role set so the very next token refresh revokes access
  // (story 1021 AC: locked session invalidated on refresh) without us having to
  // delete anything - the audit history stays attributed to their uid.
  const isActive = member?.status === 'active';
  if (isActive && member?.roles && typeof member.roles === 'object') {
    for (const role of ORG_ROLES) {
      if ((member.roles as Record<string, unknown>)[role] === true) {
        roles[role as OrgRole] = true;
      }
    }
  }

  const claims: SafentiaClaims = {
    orgId,
    roles,
  };

  // testMode routes the user to the /test root. Set it only from a literal true on
  // the member record so the absence of the marker is unambiguously a live user.
  if (member?.testMode === true) {
    claims.testMode = true;
  }

  return claims;
}

// ----------------------------------------------------------------------------
// Customer-portal claims (FR-E22, stories 2056-2061)
// ----------------------------------------------------------------------------

/**
 * The claim shape a CUSTOMER PORTAL account carries. Deliberately DISJOINT from
 * SafentiaClaims: a portal token has `portalOrgId` and NEVER `orgId`, so every
 * staff rule (all keyed on `auth.token.orgId`) denies portal users by
 * construction, and the portal read grants (keyed on `auth.token.portalOrgId`
 * plus `auth.token.customerId`) never match a staff token. One account is
 * therefore either staff or portal - never both (see onCustomerMembershipChange
 * for the conflict policy).
 */
export interface PortalClaims {
  /** The fire-safety org whose data the portal exposes. NOT `orgId`. */
  portalOrgId: string;
  /** The customer this account belongs to (scopes every portal rule). */
  customerId: string;
  /** Portal permission flags (admin/finance/viewer), allow-listed. */
  customerRoles: CustomerRoleSet;
  /** true binds the token to the /test root; the rules require
   *  `(token.testMode === true) === ($env === 'test')`. */
  testMode?: boolean;
  /** Platform super-admin, re-applied by writeClaims from the durable marker so
   *  a super admin who is also a portal user keeps platform access after a
   *  space switch or membership change. Same field as on SafentiaClaims. */
  superAdmin?: true;
}

/**
 * Derive the portal claims a /customerMembers record should produce, or null
 * when the record grants no session at all. Pure and total, mirroring
 * computeClaims: a malformed record can never crash the pipeline or fabricate a
 * role.
 *
 * Unlike a staff member - whose locked/archived record keeps an orgId claim
 * with an empty role set - a non-active (or deleted) portal member resolves to
 * NULL, meaning "remove the claims entirely". A portal account has no other
 * console identity to preserve: with the claims gone the next token refresh
 * routes them to the holding screen, while their uid keeps attributing history.
 *
 * The environment binding comes from the PATH the record lives under (the
 * trigger's `{env}` wildcard), not from a field on the record: a member written
 * under /test IS a test-portal user, definitionally.
 */
export function computePortalClaims(
  member: CustomerMember | null | undefined,
  orgId: string,
  customerId: string,
  env: Environment,
): PortalClaims | null {
  if (member?.status !== 'active') {
    return null;
  }

  // Allow-list the role flags exactly as computeClaims does for staff: only
  // known customer roles carrying a literal true survive.
  const customerRoles: CustomerRoleSet = {};
  if (member.roles && typeof member.roles === 'object') {
    for (const role of CUSTOMER_ROLES) {
      if ((member.roles as Record<string, unknown>)[role] === true) {
        customerRoles[role as CustomerRole] = true;
      }
    }
  }

  const claims: PortalClaims = {
    portalOrgId: orgId,
    customerId,
    customerRoles,
  };
  if (env === 'test') {
    claims.testMode = true;
  }
  return claims;
}

/**
 * The Firebase Auth metadata path the client watches to know it should refresh
 * its ID token. Writing a fresh timestamp here is the documented signal (brief
 * 4.1 "the client force-refreshes its token") that claims changed, so new
 * permissions apply within seconds without a manual re-login.
 */
function refreshMarkerPath(uid: string): string {
  return paths.platform.tokenRefresh(uid);
}

/**
 * Persist a user's claims and trip the refresh marker atomically-enough for the
 * client to react. setCustomUserClaims replaces the whole claim object (so a
 * removed role disappears), then we stamp the refresh marker so the app's
 * metadata listener forces getIdToken(true).
 *
 * Order matters: claims first, marker second. If the marker write failed after a
 * successful claims write, the worst case is the client refreshes a moment later
 * on its own token-expiry cycle - never a stale-permission security hole.
 */
export async function writeClaims(
  uid: string,
  claims: SafentiaClaims | PortalClaims | null,
): Promise<void> {
  // Re-apply the platform super-admin grant on EVERY write. setCustomUserClaims
  // replaces the whole claim object, so a super admin who also holds an org
  // membership or a portal seat would have `superAdmin` silently stripped the
  // next time their claims are recomputed (a role change, an org switch, a
  // portal accept). The durable source of truth is /platform/superAdmins/{uid},
  // which membership logic never touches; reading it here means the claim heals
  // itself on the next write instead of needing the grant script re-run. A null
  // (membership-cleared) account still keeps platform access, since the grant is
  // a platform concern independent of any org.
  const isSuperAdmin =
    (await db.ref(paths.platform.superAdmin(uid)).get()).val() === true;
  const payload: SafentiaClaims | PortalClaims | { superAdmin: true } | null =
    isSuperAdmin ? { ...(claims ?? {}), superAdmin: true } : claims;
  await auth.setCustomUserClaims(uid, payload);
  await db.ref(refreshMarkerPath(uid)).set(Date.now());
}
