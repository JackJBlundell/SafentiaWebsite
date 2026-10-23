// ============================================================================
// Request guards (brief 4.5 / 4.6 / 5 / 18.4).
//
// Every callable runs these BEFORE any privileged work, in this order:
//   1. App Check  - the request came from a genuine, attested app build (4.6).
//   2. Auth       - the caller is signed in (4.1).
//   3. Claims     - the caller holds the role(s) the action requires (5).
// Each guard throws a structured SafentiaError, so a rejected call returns the
// {code,message,details} contract, never a raw Firebase error. Permission is the
// UNION of the caller's role set (brief 4.1): assertOrgRole passes if the user
// holds ANY of the accepted roles, so an admin+assessor satisfies an assessor gate
// and an admin gate alike.
// ============================================================================

import type { CallableRequest } from 'firebase-functions/v2/https';
import { fail } from './errors';
import { paths, type EnvPaths } from './paths';
import {
  ORG_ROLES,
  type Environment,
  type SafentiaClaims,
  type OrgRole,
  type OrgRoleSet,
  type OrgMember,
} from '../shared/types';

/**
 * Reject a request that carries no verified App Check token. App Check is
 * ENFORCED, not monitored (brief 4.6): an unattested client (or a curl against
 * the endpoint) has `request.app` undefined and is turned away. This is the first
 * line of defence and runs before we even look at who the caller claims to be.
 */
export function assertAppCheck(request: CallableRequest): void {
  // App Check is enforced by default. It can be disabled for an environment that
  // has not yet registered App Check providers (e.g. a client test project before
  // the store builds exist) by setting FIRERITE_ENFORCE_APPCHECK=false. Production
  // leaves it unset, so enforcement stays ON - the secure default (brief 4.6).
  if (process.env.FIRERITE_ENFORCE_APPCHECK === 'false') {
    return;
  }
  if (!request.app) {
    throw fail.appCheck();
  }
}

/**
 * Reject an unauthenticated request and return the verified auth context. The
 * onCall runtime has already cryptographically verified the ID token; we only
 * confirm it is present, since an unsigned caller cannot have any permissions.
 */
export function assertAuth(request: CallableRequest): { uid: string } {
  if (!request.auth?.uid) {
    throw fail.unauthenticated();
  }
  return { uid: request.auth.uid };
}

/**
 * Assert the caller is the platform operator. The superAdmin claim is minted
 * ONLY by scripts/grantSuperAdmin.ts (never by any callable or trigger), and it
 * is the same flag the database rules' superAdmin read cascade and the /app/admin
 * console gate on - one flag, three layers. Used by the rare platform-level
 * actions (organisation creation until Phase 3 self-serve onboarding).
 */
export function assertSuperAdmin(request: CallableRequest): void {
  if (request.auth?.token?.superAdmin !== true) {
    throw fail.permissionDenied(
      'Organisations are created by the platform operator. Contact Safentia to get set up.',
    );
  }
}

/**
 * Read the Safentia claims off a verified request. The decoded token is the
 * trusted source (it was signed by us via setCustomUserClaims); we normalise it
 * into the typed SafentiaClaims shape and validate the essentials. A signed-in
 * user with no orgId claim has not finished onboarding (claims not yet computed)
 * and is treated as having no permissions rather than crashing.
 */
export function getClaims(request: CallableRequest): SafentiaClaims {
  const token = request.auth?.token;
  if (!token) {
    throw fail.unauthenticated();
  }
  const orgId = token.orgId;
  if (typeof orgId !== 'string' || orgId.length === 0) {
    // No org binding yet: their membership Function has not run, or they are not
    // a member. Either way they cannot act on org data.
    throw fail.permissionDenied(
      'Your account is not yet linked to an organisation. Please try again shortly.',
    );
  }

  // Reconstruct the role set defensively: only known role flags set to true are
  // honoured, so a tampered or stale token cannot assert an unknown role.
  const roles: OrgRoleSet = {};
  const rawRoles = token.roles;
  if (rawRoles && typeof rawRoles === 'object') {
    for (const role of ORG_ROLES) {
      if ((rawRoles as Record<string, unknown>)[role] === true) {
        roles[role as OrgRole] = true;
      }
    }
  }

  const claims: SafentiaClaims = { orgId, roles };
  if (token.customerId && typeof token.customerId === 'string') {
    claims.customerId = token.customerId;
  }
  if (token.testMode === true) {
    claims.testMode = true;
  }
  return claims;
}

/**
 * Resolve a STAFF caller's claims against the LIVE membership record, not just
 * the ID token. Every staff callable uses this rather than getClaims.
 *
 * WHY. An ID token stays valid for up to an hour after it was minted, and a
 * client is free to ignore the refresh marker the membership trigger bumps. A
 * token-only gate therefore lets a member who has just been locked, archived,
 * removed or demoted keep acting with their old roles for that hour - long
 * enough for a locked admin to call updateMember on themselves and undo the
 * lock. The rules layer already re-checks `orgMembers/.../status` on every read
 * and write; this is the same check for the callable layer.
 *
 * The org and environment still come from the token (they choose WHICH record
 * to read); the roles come from the record, so a role revoked a moment ago is
 * gone now and a role granted a moment ago works without waiting for a token
 * refresh. Unknown role flags are ignored exactly as in getClaims.
 */
export async function getLiveClaims(
  request: CallableRequest,
): Promise<SafentiaClaims> {
  const claims = getClaims(request);
  const uid = request.auth?.uid;
  if (!uid) {
    throw fail.unauthenticated();
  }
  const { db } = await import('../admin');
  const member = (
    await db.ref(envFor(claims).paths.db.orgMember(claims.orgId, uid)).get()
  ).val() as OrgMember | null;
  if (!member || member.status !== 'active') {
    throw fail.permissionDenied(
      'Your access to this organisation is not active.',
    );
  }
  const roles: OrgRoleSet = {};
  const liveRoles = member.roles as Record<string, unknown> | undefined;
  if (liveRoles && typeof liveRoles === 'object') {
    for (const role of ORG_ROLES) {
      if (liveRoles[role] === true) {
        roles[role as OrgRole] = true;
      }
    }
  }
  return { ...claims, roles };
}

/**
 * Resolve a CUSTOMER-PORTAL caller's claims. Portal tokens are a different shape
 * to staff tokens by construction (onCustomerMembershipChange mints
 * {portalOrgId, customerId, customerRoles}; a portal token never carries
 * `orgId`), so `getClaims` above - which requires `orgId` - would turn every
 * portal caller away. This is the portal twin, kept separate rather than folded
 * into getClaims so a portal token can never satisfy a staff callable's gate by
 * accident.
 *
 * The returned shape reuses SafentiaClaims with `orgId` carrying portalOrgId
 * (identical to how the web resolver presents a portal session), so `envFor`
 * and the path builders work unchanged. `roles` is always EMPTY: portal users
 * hold no staff roles, so any assertOrgRole check on this value denies.
 */
export function getPortalClaims(
  request: CallableRequest,
): SafentiaClaims & { customerId: string } {
  const token = request.auth?.token;
  if (!token) {
    throw fail.unauthenticated();
  }
  const orgId = token.portalOrgId;
  const customerId = token.customerId;
  if (
    typeof orgId !== 'string' ||
    orgId.length === 0 ||
    typeof customerId !== 'string' ||
    customerId.length === 0
  ) {
    throw fail.permissionDenied(
      'Your account does not have access to this customer portal.',
    );
  }
  const claims: SafentiaClaims & { customerId: string } = {
    orgId,
    roles: {},
    customerId,
  };
  if (token.testMode === true) {
    claims.testMode = true;
  }
  return claims;
}

/**
 * Assert the caller holds AT LEAST ONE of the accepted roles (the union model).
 * Passing several roles models "any of these may perform this action"; an
 * admin+assessor user passes an `['admin']` gate and an `['assessor']` gate both.
 */
export function assertOrgRole(
  claims: SafentiaClaims,
  accepted: OrgRole | readonly OrgRole[],
): void {
  const acceptedList: readonly OrgRole[] = Array.isArray(accepted)
    ? accepted
    : [accepted];
  const holdsOne = acceptedList.some((role) => claims.roles[role] === true);
  if (!holdsOne) {
    throw fail.permissionDenied(
      'You do not have the role required for this action.',
      { requiredAnyOf: acceptedList },
    );
  }
}

/**
 * Assert the caller is the assessor assigned to a specific job/assessment. This is
 * the row-level check the assessor Functions need (startAssessment, submit
 * Assessment): holding the assessor role is not enough, it must be THIS person's
 * job. Comparing the caller's uid to the stored assessorUid is the whole gate.
 */
export function assertAssessorOnJob(
  claims: SafentiaClaims,
  callerUid: string,
  assessorUid: string,
): void {
  // They must hold the assessor capability at all...
  assertOrgRole(claims, 'assessor');
  // ...and be the specific assessor this work was assigned to.
  if (callerUid !== assessorUid) {
    throw fail.permissionDenied(
      'This job is assigned to a different assessor.',
    );
  }
}

/**
 * Resolve the environment (and its path builders) from the caller's claim. This
 * is THE place the test/live boundary is applied server-side: a testMode user can
 * only ever be handed the /test builders, a live user the /live builders, so a
 * Function physically cannot address the wrong root (brief 4.8). The rules layer
 * enforces the same boundary independently.
 */
export function envFor(claims: SafentiaClaims): { env: Environment; paths: EnvPaths } {
  const env = paths.envFromTestMode(claims.testMode);
  return { env, paths: paths.forEnv(env) };
}
