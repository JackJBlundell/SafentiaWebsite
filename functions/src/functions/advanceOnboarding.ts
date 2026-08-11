// ============================================================================
// advanceOnboarding (callable) - Phase 3 setup wizard skip/finish (plan 5.4).
//
// The setup wizard's steps are marked done by the callables that actually
// PERFORM them (updateOrgProfile, createInvitation, manageCustomer,
// manageBuilding each stamp their step when an onboarding node is live); this
// callable exists ONLY for the two movements that perform no other action:
//   - SKIP: jump setupStep to another step without completing the current one;
//   - FINISH: stamp completedAt and set step 'done', releasing the SetupGate.
//
// Strictly owner-scoped: it mutates usersOnboarding/{uid} for the CALLER's uid
// off the verified token - there is no way to address anyone else's node.
// Rules deny all client writes to the node, so this is the only skip/finish
// path. Finishing is idempotent (a repeat returns the finished node unchanged)
// because the wizard's final tap may race a reload.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth } from '../lib/guards';
import { usersOnboarding } from '../lib/paths';
import { assertObject, requireEnum } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import type {
  AdvanceOnboardingRequest,
  AdvanceOnboardingResponse,
  UserOnboarding,
} from '../shared/types';

/** The wizard's steps, in display order (shared type §5.4). */
const SETUP_STEPS = ['profile', 'team', 'customer', 'building'] as const;

export const advanceOnboarding = onCall<AdvanceOnboardingRequest>(
  callableOptions,
  (request) =>
    runCallable<AdvanceOnboardingResponse>(
      createLogger({ fn: 'advanceOnboarding' }),
      async () => {
        // Owner-only by construction: guards yield the caller's uid and the
        // node addressed is theirs - no orgId, no role, nothing else to check.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'advanceOnboarding');

        const input = assertObject(request.data ?? {});
        const skipTo =
          input.skipTo === undefined
            ? undefined
            : requireEnum(input, 'skipTo', SETUP_STEPS);
        const finish = input.finish === true;
        if (input.finish !== undefined && typeof input.finish !== 'boolean') {
          throw fail.invalidArgument('The finish field must be a boolean.', {
            field: 'finish',
          });
        }
        if (!skipTo && !finish) {
          throw fail.invalidArgument(
            'Provide skipTo or finish - the request asks for nothing.',
          );
        }

        const ref = db.ref(usersOnboarding(uid));
        const onboarding = (await ref.get()).val() as UserOnboarding | null;
        if (!onboarding) {
          throw fail.failedPrecondition(
            'You have no onboarding in progress.',
          );
        }

        // Idempotent finish: a wizard already finished stays finished.
        if (finish && onboarding.step === 'done') {
          return { onboarding };
        }
        // Both movements only make sense once the org exists and the wizard is
        // live - never during plan choice or payment (those steps advance via
        // createSubscription and the provisioning webhook).
        if (onboarding.step !== 'setup') {
          throw fail.failedPrecondition(
            'Onboarding is not at the setup stage.',
          );
        }

        const changes: Partial<UserOnboarding> = {};
        if (skipTo) {
          changes.setupStep = skipTo;
        }
        if (finish) {
          changes.step = 'done';
          changes.completedAt = Date.now();
        }
        await ref.update(changes);

        const logger = createLogger({ fn: 'advanceOnboarding' });
        logger.info('Onboarding advanced', { uid, skipTo, finish });
        return { onboarding: { ...onboarding, ...changes } };
      },
    ),
);
