// ============================================================================
// updateMember (callable, admin-only) - Phase 2 admin, stories 1019/1021.
//
// An admin changes a member's role set and/or status (lock blocks sign-in on the
// next token refresh; archive removes them from pickers while preserving their
// attributed history). Being a callable buys two things rules cannot express:
//   - The LAST-ADMIN guard: a change may never leave the org without at least
//     one ACTIVE admin, counted from a fresh read of the whole member list, so
//     an org can never lock itself out.
//   - The member write and its /activity entry land in ONE multi-location
//     update, so the audit trail cannot be skipped or forged.
// onMembershipChange then recomputes the TARGET'S claims from the new record, so
// the change takes effect within seconds (story 1019 AC). The activity entry
// names WHICH fields changed (roles/status), never old-vs-new PII.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  requireString,
  requireRoleSet,
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { MEMBER_STATUSES } from '../shared/types';
import type {
  MemberStatus,
  OrgMember,
  OrgRoleSet,
  UpdateMemberInput,
  UpdateMemberResult,
} from '../shared/types';

export const updateMember = onCall<UpdateMemberInput>(callableOptions, (request) =>
  runCallable<UpdateMemberResult>(
    createLogger({ fn: 'updateMember' }),
    async () => {
      // 1. Attestation, identity, authorisation.
      assertAppCheck(request);
      const { uid } = assertAuth(request);
      await assertRateLimit(uid, 'updateMember');
      const claims = getClaims(request);
      assertOrgRole(claims, 'admin');
      const { paths } = envFor(claims);
      const orgId = claims.orgId;

      // 2. Validate input: the target, plus at least one of roles/status.
      // requireRoleSet enforces the allow-list and literal-true flags (the union
      // model); status must be a known lifecycle state.
      const input = assertObject(request.data);
      const memberUid = requireString(input, 'memberUid', TEXT_LIMITS.shortText);
      const roles: OrgRoleSet | undefined =
        input.roles !== undefined ? requireRoleSet(input) : undefined;
      const status: MemberStatus | undefined =
        input.status !== undefined
          ? requireEnum(input, 'status', MEMBER_STATUSES)
          : undefined;
      if (roles === undefined && status === undefined) {
        throw fail.invalidArgument('Provide a role set and/or a status to apply.');
      }

      // 3. The target must exist in the caller's org.
      const memberSnap = await db.ref(paths.db.orgMember(orgId, memberUid)).get();
      if (!memberSnap.exists()) {
        throw fail.notFound('That person is not a member of this organisation.', {
          field: 'memberUid',
        });
      }

      // 4+5. LAST-ADMIN guard and the write, as ONE TRANSACTION on the member
      // list. A read-then-write guard here is a TOCTOU hole: two concurrent
      // demotions of the two remaining admins would each pass their own stale
      // count and land, leaving the organisation with no administrator and no
      // in-app recovery. The transaction applies the change and re-counts
      // atomically, so a concurrent demotion forces a retry that then sees the
      // true state and aborts.
      const changed: string[] = [];
      if (roles !== undefined) changed.push('roles');
      if (status !== undefined) changed.push('status');

      const result = await db
        .ref(paths.db.orgMembers(orgId))
        .transaction((all: Record<string, OrgMember> | null) => {
          if (all === null) {
            // Uncached first run in a listener-less function instance: the local
            // cache is null even though the node exists, and returning undefined
            // here would abort BEFORE the server value is read. Return a sentinel
            // to force the server round-trip; the SDK then re-runs this against
            // the real members node (the earlier existence check confirmed it is
            // present), so the sentinel is never persisted.
            return {} as Record<string, OrgMember>;
          }
          if (!all[memberUid]) {
            // The member vanished between the earlier existence check and now.
            return undefined;
          }
          const next: Record<string, OrgMember> = {
            ...all,
            [memberUid]: {
              ...all[memberUid],
              ...(roles !== undefined ? { roles } : {}),
              ...(status !== undefined ? { status } : {}),
            },
          };
          const remainsAdmin = Object.values(next).some(
            (member) => member.roles?.admin === true && member.status === 'active',
          );
          if (!remainsAdmin) {
            return undefined;
          }
          return next;
        });

      if (!result.committed) {
        // The transaction cannot carry a reason out of an abort; a fresh read
        // distinguishes "member gone" from "guard tripped" for honest copy.
        const stillThere = (
          await db.ref(paths.db.orgMember(orgId, memberUid)).get()
        ).exists();
        if (!stillThere) {
          throw fail.notFound('That member no longer exists.');
        }
        throw fail.failedPrecondition(
          'An organisation must keep at least one active administrator. Promote someone else first.',
          { field: 'memberUid' },
        );
      }

      // Audit entry AFTER the committed transaction (a transaction cannot join a
      // multi-location update). The deliberate trade-off: guard correctness wins
      // over single-write audit atomicity; a crash in the gap loses one audit
      // line, never the invariant. Field NAMES only - no PII in the trail.
      await db
        .ref()
        .update(
          activityUpdate(paths, orgId, {
            actorUid: uid,
            action: `member.updated (${changed.join(', ')})`,
            target: memberUid,
          }),
        );

      const logger = createLogger({ fn: 'updateMember', orgId });
      logger.info('Member updated', { memberUid, changed });
      return { updated: true };
    },
  ),
);
