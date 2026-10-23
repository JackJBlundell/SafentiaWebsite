// ============================================================================
// updateMyPreferences (callable, any active org member) - story 2066.
//
// A member quietens (or re-enables) their own non-transactional email
// categories. Strictly SELF-SCOPED BY CONSTRUCTION: the write path is built
// from the verified auth uid, never from input, so no caller can address
// another member's preferences - which is also why this needs no admin gate.
// Security and account email (invitations, password reset) is never optional
// and is not represented here.
//
// NO /activity entry, deliberately: the audit trail records acts on the
// ORGANISATION and its tenants; which courtesy emails one member chooses to
// receive is a personal setting with no compliance significance, and logging
// it would only add noise to the trail admins actually review.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth, getLiveClaims, envFor } from '../lib/guards';
import { assertObject } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import type {
  EmailPreferences,
  OrgMember,
  UpdateMyPreferencesInput,
  UpdateMyPreferencesResult,
} from '../shared/types';

/** The complete category list, stated once so validation and the contract can
 *  never drift: exactly these keys are legal, each a strict boolean.
 *
 *  This list is load-bearing beyond validation: step 4 REPLACES the whole
 *  emailPreferences node with the keys named here, so a category read by a
 *  sender but missing from this list is not merely unreachable from the account
 *  page - it is wiped the next time the member saves any other preference. Every
 *  key in EmailPreferences must therefore appear here and have a toggle in
 *  AccountPage. */
const PREFERENCE_KEYS = [
  'reviewDue',
  'actionAssigned',
  'awaitingValidation',
  'released',
  // requestInfo's "more information needed" email to the assessor.
  'infoRequested',
  // The deadlineReminders sweep's information-request and action nudges.
  'deadlineReminder',
  // Diary email: createJob / rescheduleJob / cancelJob and the morning
  // dailyJobReminders digest.
  'jobScheduled',
  // The assessor's own verdict emails from the stage bus: accepted, and
  // released. Separate from 'released', which is the administrators' notice.
  'assessmentOutcome',
] as const;

export const updateMyPreferences = onCall<UpdateMyPreferencesInput>(
  callableOptions,
  (request) =>
    runCallable<UpdateMyPreferencesResult>(
      createLogger({ fn: 'updateMyPreferences' }),
      async () => {
        // 1. Attestation and identity. getClaims is the whole authorisation
        // story here: it requires an org binding (only computed for members),
        // and the caller may hold ANY role - every member owns their own
        // preferences, so there is no assertOrgRole gate.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'updateMyPreferences');
        const claims = await getLiveClaims(request);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate: exactly the known categories above, each a strict
        // boolean when present. Unknown keys are rejected rather than silently
        // dropped so a drifted client fails loudly (CONVENTIONS: no silent
        // acceptance of malformed input).
        const input = assertObject(request.data);
        const raw = assertObject(input.emailPreferences);
        const preferences: EmailPreferences = {};
        for (const key of Object.keys(raw)) {
          if (!(PREFERENCE_KEYS as readonly string[]).includes(key)) {
            throw fail.invalidArgument(
              'Unknown email preference category.',
              { field: key },
            );
          }
        }
        for (const key of PREFERENCE_KEYS) {
          const value = raw[key];
          if (value === undefined) {
            continue;
          }
          if (typeof value !== 'boolean') {
            throw fail.invalidArgument(
              'Email preferences must be true or false.',
              { field: key },
            );
          }
          preferences[key] = value;
        }

        // 3. The caller must be an ACTIVE member of their claimed org. Claims
        // are recomputed on membership change, but a token can outlive a lock
        // by up to an hour - the fresh record read closes that window.
        const memberSnap = await db.ref(paths.db.orgMember(orgId, uid)).get();
        const member = memberSnap.val() as OrgMember | null;
        if (!member || member.status !== 'active') {
          throw fail.permissionDenied(
            'Your membership is not active, so preferences cannot be changed.',
          );
        }

        // 4. Replace the caller's own emailPreferences node whole. set() (not
        // update) so switching a category back ON removes the stored false and
        // the record returns to the compact absent-equals-on default.
        await db
          .ref(`${paths.db.orgMember(orgId, uid)}/emailPreferences`)
          .set(preferences);

        const logger = createLogger({ fn: 'updateMyPreferences', orgId });
        logger.info('Email preferences updated', { uid });
        return { updated: true };
      },
    ),
);
