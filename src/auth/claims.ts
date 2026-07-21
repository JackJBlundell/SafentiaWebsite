// ============================================================================
// Claim resolution (brief 4.1 / 4.8, story 1022; FR-E22 portal) - the web twin
// of FireRite/src/auth/claims.ts.
//
// Custom claims are the ONLY source of a user's org, roles and environment - the
// client never decides these. `onMembershipChange` writes STAFF claims
// ({orgId, roles, testMode}); `onCustomerMembershipChange` writes PORTAL claims
// ({portalOrgId, customerId, customerRoles, testMode}). The two shapes are
// mutually exclusive by construction - a portal token never carries `orgId` -
// and here they resolve into a DISCRIMINATED session (`kind`) that the console
// gate routes on: staff to ConsoleShell, portal to PortalShell (story 2005's
// third landing). A user with neither claim set has no membership yet (holding
// screen, story 1022).
//
// The one platform difference from the app: the Web SDK types the raw claims as
// `ParsedToken` on `IdTokenResult.claims`, where the native SDK used its own
// result type. The parsing below is byte-for-byte the same logic.
// ============================================================================

import type { IdTokenResult } from 'firebase/auth';
import { CUSTOMER_ROLES, ORG_ROLES } from '../types';
import type {
  CustomerRole,
  CustomerRoleSet,
  Environment,
  OrgRole,
  OrgRoleSet,
} from '../types';
import { envFromTestMode } from '../paths';

/**
 * A staff session - the shape every existing console screen was built against.
 * `kind` is optional with 'staff' the only value, so the pre-portal literal
 * `{orgId, roles, environment}` (used throughout the tests) still IS a staff
 * session; narrowing works either way (`claims.kind === 'portal'` vs not).
 */
export interface StaffSessionClaims {
  kind?: 'staff';
  orgId: string;
  roles: OrgRoleSet;
  environment: Environment;
  /** Never set on a staff session; declared so `claims.customerId` stays legal
   *  (string | undefined) on the union without narrowing first. */
  customerId?: undefined;
  customerRoles?: undefined;
}

/** A customer-portal session (FR-E22). Compatibility surface: `orgId` carries
 *  the portalOrgId claim (path builders and caches key on it identically), and
 *  `roles` is always the EMPTY staff role set so every `claims.roles.admin`
 *  style check in shared code reads false for portal users. */
export interface PortalSessionClaims {
  kind: 'portal';
  /** The fire-safety org whose data the portal exposes (= token.portalOrgId). */
  orgId: string;
  /** The customer this account belongs to; scopes every portal read. */
  customerId: string;
  /** Portal permissions (admin/finance/viewer), allow-listed. */
  customerRoles: CustomerRoleSet;
  /** Always empty - portal users hold NO staff roles, by construction. */
  roles: OrgRoleSet;
  environment: Environment;
}

/** The resolved session identity every screen and path build derives from. */
export type SessionClaims = StaffSessionClaims | PortalSessionClaims;

/**
 * Parse the raw custom claims off an ID token result into a typed session, or
 * null when the user has no membership yet. Staff wins the check order only
 * because it is checked first; the server never mints both shapes onto one
 * token (onCustomerMembershipChange refuses to overwrite staff claims). Role
 * keys are allow-listed against their canonical lists so an unexpected claim
 * value can never widen permissions (defence in depth - rules are still the
 * real boundary, brief 18.4).
 */
export function resolveClaims(result: IdTokenResult): SessionClaims | null {
  const raw = result.claims;
  const environment = envFromTestMode(raw.testMode === true);

  const orgId = typeof raw.orgId === 'string' ? raw.orgId : undefined;
  if (orgId) {
    const roles: OrgRoleSet = {};
    const rawRoles = raw.roles;
    if (rawRoles && typeof rawRoles === 'object') {
      for (const role of ORG_ROLES) {
        if ((rawRoles as Record<string, unknown>)[role] === true) {
          roles[role as OrgRole] = true;
        }
      }
    }
    return { kind: 'staff', orgId, roles, environment };
  }

  const portalOrgId =
    typeof raw.portalOrgId === 'string' ? raw.portalOrgId : undefined;
  const customerId =
    typeof raw.customerId === 'string' ? raw.customerId : undefined;
  if (portalOrgId && customerId) {
    const customerRoles: CustomerRoleSet = {};
    const rawRoles = raw.customerRoles;
    if (rawRoles && typeof rawRoles === 'object') {
      for (const role of CUSTOMER_ROLES) {
        if ((rawRoles as Record<string, unknown>)[role] === true) {
          customerRoles[role as CustomerRole] = true;
        }
      }
    }
    return {
      kind: 'portal',
      orgId: portalOrgId,
      customerId,
      customerRoles,
      roles: {},
      environment,
    };
  }

  return null;
}

/** True for a customer-portal session. The single narrowing helper the gate and
 *  portal screens use, so the discriminant is read in exactly one way. */
export function isPortalSession(
  claims: SessionClaims,
): claims is PortalSessionClaims {
  return claims.kind === 'portal';
}

/** A short, non-PII summary of the role set for error context/logging. */
export function rolesSummary(roles: OrgRoleSet): string {
  return ORG_ROLES.filter((r) => roles[r]).join('+') || 'none';
}
