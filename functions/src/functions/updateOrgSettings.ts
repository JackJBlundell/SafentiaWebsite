// ============================================================================
// updateOrgSettings (callable, admin-only) - Phase 2 admin, story 2012.
//
// An admin tunes the org's configurable RAG derivation (Schedule 1 group 5:
// "configurable RAG thresholds and roll-up calculation"). The config drives how
// every building's risk level is derived, so it is validated strictly here -
// shares must be real fractions, flags real booleans - and written together with
// its /activity entry in ONE multi-location update, which is why this is a
// callable rather than a rules-governed client write: the audit trail cannot be
// skipped when the same Function writes both.
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
import { assertObject } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import type {
  RagConfig,
  UpdateOrgSettingsInput,
  UpdateOrgSettingsResult,
} from '../shared/types';

/** A share is a fraction of the finding distribution: finite and within [0,1].
 *  Anything else (NaN, negatives, >1, strings) would corrupt the derivation. */
function requireShare(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw fail.invalidArgument(
      `The ${field} field must be a number between 0 and 1.`,
      { field },
    );
  }
  return value;
}

/** Flags are literal booleans; reject, never coerce (brief 18.4). */
function requireBoolean(input: Record<string, unknown>, field: string): boolean {
  const value = input[field];
  if (typeof value !== 'boolean') {
    throw fail.invalidArgument(`The ${field} field must be true or false.`, {
      field,
    });
  }
  return value;
}

export const updateOrgSettings = onCall<UpdateOrgSettingsInput>(
  callableOptions,
  (request) =>
    runCallable<UpdateOrgSettingsResult>(
      createLogger({ fn: 'updateOrgSettings' }),
      async () => {
        // 1. Attestation, identity, authorisation.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'updateOrgSettings');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate the full RagConfig; it is replaced whole so the stored
        // config is always a complete, internally-consistent set.
        const input = assertObject(request.data);
        const configInput = assertObject(input.ragConfig);
        const ragConfig: RagConfig = {
          redShareForHigh: requireShare(configInput, 'redShareForHigh'),
          amberRedShareForMedium: requireShare(configInput, 'amberRedShareForMedium'),
          openHighActionForcesHigh: requireBoolean(
            configInput,
            'openHighActionForcesHigh',
          ),
          overdueActionEscalates: requireBoolean(configInput, 'overdueActionEscalates'),
        };

        // 3. Atomic write: the settings change and the audit entry together.
        const update: Record<string, unknown> = {
          [`${paths.db.orgSettings(orgId)}/ragConfig`]: ragConfig,
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'orgSettings.ragConfig.updated',
            target: orgId,
          }),
        };
        await db.ref().update(update);

        const logger = createLogger({ fn: 'updateOrgSettings', orgId });
        logger.info('RAG configuration updated');
        return { updated: true };
      },
    ),
);
