// ============================================================================
// recordPlatformAccess (callable, PLATFORM super admin only) - story 2069 AC2.
//
// The platform oversight console lets a super admin drill into any tenant's
// organisation, customer and building records read-only. That looking is itself
// an audited event: this callable appends a `platform.access` entry into THAT
// tenant's own /activity trail, so an organisation can see plainly that the
// platform operator viewed it. It closes FUTURE_WORK #11 (the drill-down pages
// previously stated in copy that platform access was not recorded).
//
// Trust boundary: the entry's actorUid is taken from the VERIFIED token and the
// orgId from validated input, never from anything that could name another user,
// so the trail cannot be used to frame someone else's account. A super admin is
// the only caller who gets past the gate, and that is proven two ways, not one:
// the `superAdmin` custom claim on the token AND the durable
// /platform/superAdmins/{uid} marker re-read server-side. A claim alone is a
// cached assertion (it survives on an old token until refresh); requiring the
// marker too means a revoked operator cannot write into a tenant's audit log
// with a still-warm token (defence in depth, brief 18.4).
//
// Environment: a super admin can view either the live or the test root (the
// rules give them a read cascade over both), and which one they are viewing is
// a CLIENT-side console choice (platformEnv), not a security-scoped claim. So
// the env travels in the request and is validated against ENVIRONMENTS - never
// derived from the caller's own testMode, which would pin the write to the
// wrong root. It only selects which tenant tree the operator's own access note
// lands in; it grants nothing, so accepting it from the client is safe here.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth, assertSuperAdmin } from '../lib/guards';
import { paths, forEnv } from '../lib/paths';
import {
  assertObject,
  requireDbKey,
  requireEnum,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { appendActivity } from '../lib/events';
import { ENVIRONMENTS } from '../shared/types';
import type {
  RecordPlatformAccessInput,
  RecordPlatformAccessResult,
} from '../shared/types';

/** What a drill-down can open, and the whole vocabulary the `scope` field may
 *  carry. An allow-list rather than free text so the tenant-facing phrasing
 *  ("viewed the organisation / a customer / a building") is bounded and a
 *  client cannot push arbitrary strings into another org's audit trail. */
const ACCESS_SCOPES = ['organisation', 'customer', 'building'] as const;

// The env is a console-view choice the client passes; it is not part of the
// stored RecordPlatformAccessInput contract, so it is read off the raw request
// and validated here. Typing it locally keeps the call site honest without
// widening the shared input shape.
type RecordPlatformAccessRequest = RecordPlatformAccessInput & {
  env: (typeof ENVIRONMENTS)[number];
};

export const recordPlatformAccess = onCall<RecordPlatformAccessRequest>(
  callableOptions,
  (request) =>
    runCallable<RecordPlatformAccessResult>(
      createLogger({ fn: 'recordPlatformAccess' }),
      async () => {
        // 1. Attestation, identity, rate limit - the standard callable chain.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'recordPlatformAccess');

        // 2. Platform authorisation, proven twice. The claim gate is the fast
        // path; the durable marker re-read is what a revoked operator's stale
        // token cannot satisfy, so this platform-privileged write into a tenant
        // tree needs a CURRENTLY valid super admin, not just a token that once
        // held the claim.
        assertSuperAdmin(request);
        const markerSnap = await db.ref(paths.platform.superAdmin(uid)).get();
        if (!markerSnap.exists()) {
          throw fail.permissionDenied(
            'This action is restricted to the platform operator.',
          );
        }

        // 3. Validate the input. orgId and targetId are interpolated nowhere
        // dangerous here, but they identify tenant records, so they are held to
        // the same key discipline as every other id (no `/` or control chars).
        const input = assertObject(request.data);
        const orgId = requireDbKey(input, 'orgId', TEXT_LIMITS.shortText);
        const scope = requireEnum(input, 'scope', ACCESS_SCOPES);
        // The env is validated against the two-value allow-list, never coerced.
        // It selects the tenant tree the note lands in and nothing more.
        const env = requireEnum(input, 'env', ENVIRONMENTS);
        // targetId is optional (the organisation scope names no child record);
        // when present it is validated as a key, same as orgId.
        const targetId =
          input.targetId === undefined || input.targetId === null
            ? undefined
            : requireDbKey(input, 'targetId', TEXT_LIMITS.shortText);

        // 4. Append the access note into the viewed org's own trail. actorUid is
        // the verified super admin uid and `at` is server-stamped by
        // appendActivity, so the entry cannot be attributed to another account
        // or back-dated. `target` carries the scope and, where there is one, the
        // specific record id, so the tenant sees what was opened.
        const envPaths = forEnv(env);
        await appendActivity(envPaths, orgId, {
          actorUid: uid,
          action: 'platform.access',
          target: targetId ? `${scope}:${targetId}` : scope,
        });

        return { recorded: true };
      },
    ),
);
