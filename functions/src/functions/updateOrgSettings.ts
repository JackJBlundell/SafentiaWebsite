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
import { assertObject, clearableString } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import {
  isValidReminderDays,
  ACTION_REMINDER_RULES,
  INFO_REQUEST_REMINDER_RULES,
  REVIEW_REMINDER_RULES,
  type ReminderScheduleRules,
} from '../lib/reminderSchedules';
import type {
  RagConfig,
  UpdateOrgSettingsInput,
  UpdateOrgSettingsResult,
} from '../shared/types';

/**
 * How much house AI guidance an organisation may store. Deliberately far below
 * TEXT_LIMITS.freeText (5000): this text is appended to the summary writer's
 * system prompt, AFTER the regulatory grounding and the strict rules, and a
 * guidance block long enough to dwarf them would effectively become the prompt.
 * ~1500 characters is a couple of hundred words - room for a house style, the
 * regulations a firm always cites and the features it always calls out, and no
 * room for a rewritten brief.
 *
 * MIRRORED in the console's AiGuidanceSettingsPage so the page can count down to
 * the same ceiling the server enforces; the server remains the boundary.
 */
const AI_GUIDANCE_MAX_LENGTH = 1500;

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

/** Validate a supplied reminder schedule against the SAME rules the sweeps use
 *  (isValidReminderDays over the concern's own rule set), so the callable can
 *  never store a ladder a sweep would then reject and silently ignore. A
 *  trusted, in-range value is returned; anything else is refused, never coerced
 *  (brief 18.4). */
function requireReminderDays(
  value: unknown,
  rules: ReminderScheduleRules,
  field: string,
): number[] {
  if (!isValidReminderDays(value, rules)) {
    throw fail.invalidArgument(
      `The ${field} field must be a descending list of up to ${rules.maxMarks} whole numbers of days, each between 1 and ${rules.maxDay}.`,
      { field },
    );
  }
  return value;
}

/** The three configurable reminder ladders, each with the rules it is validated
 *  against and the audit code its change records. Table-driven because the three
 *  differ only in name and horizon: a fourth concern is one row, not another
 *  copy of the same twenty lines. */
const REMINDER_SCHEDULES: ReadonlyArray<{
  field: 'reviewReminderDays' | 'infoRequestReminderDays' | 'actionReminderDays';
  rules: ReminderScheduleRules;
}> = [
  { field: 'reviewReminderDays', rules: REVIEW_REMINDER_RULES },
  { field: 'infoRequestReminderDays', rules: INFO_REQUEST_REMINDER_RULES },
  { field: 'actionReminderDays', rules: ACTION_REMINDER_RULES },
];

/** The master switches, with the audit code each state records. */
const REMINDER_SWITCHES: ReadonlyArray<{
  field:
    | 'reviewRemindersEnabled'
    | 'infoRequestRemindersEnabled'
    | 'actionRemindersEnabled';
  onAction: string;
  offAction: string;
}> = [
  {
    field: 'reviewRemindersEnabled',
    onAction: 'orgSettings.reviewReminders.enabled',
    offAction: 'orgSettings.reviewReminders.disabled',
  },
  {
    field: 'infoRequestRemindersEnabled',
    onAction: 'orgSettings.infoRequestReminders.enabled',
    offAction: 'orgSettings.infoRequestReminders.disabled',
  },
  {
    field: 'actionRemindersEnabled',
    onAction: 'orgSettings.actionReminders.enabled',
    offAction: 'orgSettings.actionReminders.disabled',
  },
];

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

        // 2. Validate whichever settings the caller supplied. Every field is
        // optional and independent: the risk-scoring page saves ragConfig on its
        // own, and each section of the reminders page saves only its own ladder
        // and switch, so a field is written only when present and the rest are
        // left untouched.
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

        // The organisation's own steer for the AI summary writer. It is GUIDANCE
        // FOR THE MODEL - house style, the regulations this firm always cites,
        // the features it always wants called out - and never report wording: a
        // standard paragraph is printed verbatim and is not this. It supplements
        // the platform's /platform/aiContext grounding rather than replacing it,
        // which the prompt builder enforces by appending it after the strict
        // rules (lib/fireSafetyContext).
        //
        // Clearable, like the reminder ladders: an explicit null removes the key
        // so the prompt falls back to the platform framework alone. `?? null`
        // folds in the blank-string case too - clearableString reads '' as
        // "leave alone", which is emphatically not what emptying the box means -
        // so the page cannot accidentally leave stale guidance in the prompt by
        // sending a blank rather than a null.
        if (input.aiGuidance !== undefined) {
          const guidance =
            clearableString(input, 'aiGuidance', AI_GUIDANCE_MAX_LENGTH) ?? null;
          writes[`${orgSettingsPath}/aiGuidance`] = guidance;
          actions.push(
            guidance === null
              ? 'orgSettings.aiGuidance.cleared'
              : 'orgSettings.aiGuidance.updated',
          );
        }

        // Story 2046 AC1: an explicit null clears a reminder schedule back to
        // the built-in default (writing null removes the RTDB node); a supplied
        // array is validated against that sweep's own rules and stored; an
        // absent field leaves the stored value alone. Each of the three ladders
        // is independent, so a page section saves only its own concern.
        for (const { field, rules } of REMINDER_SCHEDULES) {
          const supplied = input[field];
          if (supplied === undefined) {
            continue;
          }
          writes[`${orgSettingsPath}/${field}`] =
            supplied === null ? null : requireReminderDays(supplied, rules, field);
          actions.push(`orgSettings.${field}.updated`);
        }

        // The master switches. Stored as plain booleans rather than cleared when
        // true: "on" is the default, but an admin who deliberately turned a
        // category back on should see that decision in the record rather than an
        // absent key that merely happens to mean the same thing.
        for (const { field, onAction, offAction } of REMINDER_SWITCHES) {
          if (input[field] === undefined) {
            continue;
          }
          const enabled = requireBoolean(input, field);
          writes[`${orgSettingsPath}/${field}`] = enabled;
          actions.push(enabled ? onAction : offAction);
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
