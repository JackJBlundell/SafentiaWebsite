// ============================================================================
// onMembershipChange (RTDB trigger) - stories 1019, 1021, brief 4.8.
//
// Whenever an /orgMembers record is written (created, edited or removed) under
// EITHER environment root, recompute that user's custom claims (roles, testMode,
// orgId) from the trusted record and persist them, then trip the token-refresh
// marker so the change takes effect within seconds without a manual re-login
// (story 1019 AC). This is the ONLY trust path that sets claims: the client can
// never set its own roles or test mode (brief 4.8). The `{env}` wildcard means one
// trigger covers both /live and /test - the environment is captured from the path,
// matching the testMode marker on the record itself.
//
// Edge cases handled deliberately:
//  - Delete (member removed): claims are cleared (empty role set) so access is
//    revoked on next refresh while the uid's history stays attributed (1021).
//  - Locked / archived status: computeClaims yields an empty role set, so the next
//    refresh strips access (1021 AC: locked session invalidated on refresh).
//  - A user belonging to several orgs: claims reflect the org whose record changed;
//    multi-org switching is a client concern that re-reads claims per active org.
// ============================================================================

import { onValueWritten } from 'firebase-functions/v2/database';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { logTriggerError } from '../lib/errors';
import { computeClaims, writeClaims } from '../lib/claims';
import type { OrgMember } from '../shared/types';

/**
 * Path pattern includes the env segment as a wildcard so the single trigger fires
 * for /live/orgMembers/... and /test/orgMembers/... alike. The env itself is not
 * needed to compute claims (the record's own testMode marker drives that), but
 * capturing it lets us log which root changed without inferring it.
 */
export const onMembershipChange = onValueWritten(
  {
    ref: '/{env}/orgMembers/{orgId}/{uid}',
    region: REGION,
  },
  async (event) => {
    const { env, orgId, uid } = event.params;
    const logger = createLogger({ fn: 'onMembershipChange', env, orgId, uid });

    try {
      // The post-write value is the source of truth. On a delete it is null, which
      // computeClaims treats as "no active membership" -> empty role set.
      const after = event.data.after;
      const member = after.exists()
        ? (after.val() as OrgMember)
        : null;

      const claims = computeClaims(member, orgId);
      await writeClaims(uid, claims);

      // Log only non-PII facts: which roles resulted and whether test mode is set.
      // Never log the member's name or email.
      logger.info('Recomputed and applied custom claims', {
        roleCount: Object.keys(claims.roles).length,
        roles: Object.keys(claims.roles),
        testMode: claims.testMode === true,
        status: member?.status ?? 'removed',
      });
    } catch (caught) {
      // A claims write failure must be visible (it is a security-relevant event)
      // and rethrown so the platform retries per the trigger's policy.
      logTriggerError(logger, caught);
      throw caught;
    }
  },
);
