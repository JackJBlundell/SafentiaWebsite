// ============================================================================
// onCustomerMembershipChange (RTDB trigger) - FR-E22 customer portal, stories
// 2056-2061; the portal twin of onMembershipChange.
//
// Whenever a /customerMembers record is written (created, edited or removed)
// under EITHER environment root, recompute that user's PORTAL claims
// ({portalOrgId, customerId, customerRoles, testMode}) from the trusted record
// and persist them, then trip the token-refresh marker so the change takes
// effect within seconds without a manual re-login. This is the ONLY trust path
// that mints portal claims: the client can never scope itself to a customer.
//
// Portal claims deliberately NEVER include `orgId`: every staff surface's rule
// keys on `auth.token.orgId`, so a portal token is locked out of the staff
// console by construction, and the portal read grants key on
// `auth.token.portalOrgId` + `auth.token.customerId` instead.
//
// Edge cases handled deliberately:
//  - Delete (member removed) or locked/archived status: the claims are REMOVED
//    entirely (setCustomUserClaims(null)), so the next token refresh strips all
//    portal access while the uid's audit history stays attributed. A portal
//    account has no staff identity worth preserving in its claim set.
//  - CONFLICT POLICY: an account cannot be org staff AND a portal user at once.
//    The two claim shapes are mutually exclusive (one token object), and a
//    portal write clobbering staff claims would silently lock a staff member
//    out of their console - or worse, a staff write racing this one could leave
//    a customer holding staff claims. So if the uid holds ANY staff membership
//    (the /userOrgs reverse index, written atomically with every /orgMembers
//    record, checked under BOTH env roots), this trigger logs an error and
//    leaves the staff claims untouched. acceptInvitation's one-portal-per-
//    account guard makes this unreachable in normal operation; the check here
//    is the backstop for seeded or hand-repaired data.
// ============================================================================

import { onValueWritten } from 'firebase-functions/v2/database';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { logTriggerError } from '../lib/errors';
import { computePortalClaims, writeClaims } from '../lib/claims';
import { paths } from '../lib/paths';
import { ENVIRONMENTS } from '../shared/types';
import type { CustomerMember, Environment } from '../shared/types';

/**
 * Path pattern includes the env segment as a wildcard so the single trigger
 * fires for /live/customerMembers/... and /test/customerMembers/... alike -
 * exactly the onMembershipChange pattern. Here the env IS load-bearing: it
 * drives the testMode claim, because the rules bind a portal token to the root
 * its membership record lives under.
 */
export const onCustomerMembershipChange = onValueWritten(
  {
    ref: '/{env}/customerMembers/{orgId}/{customerId}/{uid}',
    region: REGION,
  },
  async (event) => {
    const { env, orgId, customerId, uid } = event.params;
    const logger = createLogger({
      fn: 'onCustomerMembershipChange',
      env,
      orgId,
      uid,
    });

    try {
      // Staff-conflict backstop (see header). Checked FIRST, before any claim
      // computation, so a conflicted write can never touch the token.
      for (const staffEnv of ENVIRONMENTS) {
        const staffSnap = await db
          .ref(paths.forEnv(staffEnv).db.userOrgs(uid))
          .get();
        if (staffSnap.exists()) {
          logger.error(
            'Portal membership written for an org STAFF account; refusing to ' +
              'overwrite staff claims. Remove the orgMembers/userOrgs records ' +
              'or use a separate account for the portal.',
            { customerId, staffEnv },
          );
          return;
        }
      }

      // The post-write value is the source of truth. On a delete it is null,
      // which computePortalClaims resolves to null -> remove the claims.
      const after = event.data.after;
      const member = after.exists() ? (after.val() as CustomerMember) : null;

      const claims = computePortalClaims(
        member,
        orgId,
        customerId,
        env as Environment,
      );
      await writeClaims(uid, claims);

      // Log only non-PII facts, mirroring onMembershipChange.
      logger.info(
        claims ? 'Applied portal claims' : 'Removed portal claims',
        {
          customerId,
          roles: claims ? Object.keys(claims.customerRoles) : [],
          testMode: claims?.testMode === true,
          status: member?.status ?? 'removed',
        },
      );
    } catch (caught) {
      // A claims write failure must be visible (security-relevant) and rethrown
      // so the platform retries per the trigger's policy.
      logTriggerError(logger, caught);
      throw caught;
    }
  },
);
