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
import {
  isValidReviewReminderDays,
  MAX_REVIEW_REMINDER_DAY,
  MAX_REVIEW_REMINDER_DAYS,
} from '../lib/reviewWindows';
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

/** Validate a supplied reminder schedule against the SAME rules the sweep uses
 *  (isValidReviewReminderDays), so the callable can never store a config the
 *  sweep would then reject and silently ignore. A trusted, in-range value is
 *  returned; anything else is refused, never coerced (brief 18.4). */
function requireReviewReminderDays(value: unknown): number[] {
  if (!isValidReviewReminderDays(value)) {
    throw fail.invalidArgument(
      `The reviewReminderDays field must be a descending list of up to ${MAX_REVIEW_REMINDER_DAYS} whole numbers of days, each between 1 and ${MAX_REVIEW_REMINDER_DAY}.`,
      { field: 'reviewReminderDays' },
    );
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

        // 2. Validate whichever settings the caller supplied. Both fields are
        // optional and independent: the risk-scoring page saves ragConfig on its
        // own, the reminders page saves reviewReminderDays on its own, so each is
        // written only when present and the other is left untouched.
        const input = assertObject(request.data);
        const orgSettingsPath = paths.db.orgSettings(orgId);
        const writes: Record<string, unknown> = {};
        const actions: string[] = [];

        if (input.ragConfig !== undefined) {
          // The RAG config is replaced whole so the stored config is always a
          // complete, internally-consistent set.
          const configInput = assertObject(input.ragConfig);
          const ragConfig: RagConfig = {
            redShareForHigh: requireShare(configInput, 'redShareForHigh'),
            amberRedShareForMedium: requireShare(
              configInput,
              'amberRedShareForMedium',
            ),
            openHighActionForcesHigh: requireBoolean(
              configInput,
              'openHighActionForcesHigh',
            ),
            overdueActionEscalates: requireBoolean(
              configInput,
              'overdueActionEscalates',
            ),
          };
          writes[`${orgSettingsPath}/ragConfig`] = ragConfig;
          actions.push('orgSettings.ragConfig.updated');
        }

        // Story 2046 AC1: an explicit null clears the reminder schedule back to
        // the built-in default (writing null removes the RTDB node); a supplied
        // array is validated against the sweep's own rules and stored; an absent
        // field leaves the stored value alone.
        if (input.reviewReminderDays !== undefined) {
          writes[`${orgSettingsPath}/reviewReminderDays`] =
            input.reviewReminderDays === null
              ? null
              : requireReviewReminderDays(input.reviewReminderDays);
          actions.push('orgSettings.reviewReminderDays.updated');
        }

        // Reject an empty call rather than writing a lone audit entry for a
        // change that touches nothing.
        if (actions.length === 0) {
          throw fail.invalidArgument('Provide at least one setting to update.');
        }

        // 3. Atomic write: every settings change and one audit entry per changed
        // setting land in ONE update, so the trail can never show a change
        // without its entry or vice versa (the reason this is a callable).
        const update: Record<string, unknown> = { ...writes };
        for (const action of actions) {
          Object.assign(
            update,
            activityUpdate(paths, orgId, {
              actorUid: uid,
              action,
              target: orgId,
            }),
          );
        }
        await db.ref().update(update);

        const logger = createLogger({ fn: 'updateOrgSettings', orgId });
        logger.info('Organisation settings updated', { changed: actions });
        return { updated: true };
      },
    ),
);
