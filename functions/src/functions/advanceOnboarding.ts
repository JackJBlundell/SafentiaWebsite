// ============================================================================
// advanceOnboarding (callable) - Phase 3 setup wizard skip/finish (plan 5.4).
//
// The setup wizard's steps are marked done by the callables that actually
// PERFORM them (updateOrgProfile, createInvitation, manageCustomer each stamp
// their step when an onboarding node is live); this callable exists ONLY for
// the two movements that perform no other action:
//   - SKIP: jump setupStep to another step without completing the current one;
//   - FINISH: retire the journey, releasing the SetupGate.
//
// FINISH DELETES the node rather than stamping step 'done'. A finished journey
// is never read again: the gate routes a claims-carrying admin to the shell via
// their membership (orgId is on the token), and gating.ts IGNORES a would-be
// 'done' node for a claims-less session too. Leaving completed nodes behind
// would let usersOnboarding grow without bound (assessment 3024 AC3), so the
// finishing call removes its own node - eager, bounded, no sweep to schedule.
//
// Strictly owner-scoped: it mutates usersOnboarding/{uid} for the CALLER's uid
// off the verified token - there is no way to address anyone else's node.
// Rules deny all client writes to the node, so this is the only skip/finish
// path. Finishing is idempotent (a repeat - the wizard's final tap racing a
// reload - finds the node already gone and reports success anyway).
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
const SETUP_STEPS = ['profile', 'team', 'customer'] as const;

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
        const logger = createLogger({ fn: 'advanceOnboarding' });

        // Idempotent finish: the finishing call DELETES the node (below), so a
        // repeat finds nothing - which for a finish is success, not an error.
        // The synthesised terminal marker is never read (the wizard fires
        // finish and forgets the response), so an unknown createdAt reads 0.
        if (finish && (!onboarding || onboarding.step === 'done')) {
          return { onboarding: onboarding ?? { step: 'done', createdAt: 0 } };
        }
        if (!onboarding) {
          throw fail.failedPrecondition(
            'You have no onboarding in progress.',
          );
        }
        // Both movements only make sense once the org exists and the wizard is
        // live - never during plan choice or payment (those steps advance via
        // createSubscription and the provisioning webhook).
        if (onboarding.step !== 'setup') {
          throw fail.failedPrecondition(
            'Onboarding is not at the setup stage.',
          );
        }

        if (finish) {
          // Retire the node: it has served its only purpose (holding the
          // SetupGate open). Deleting on finish keeps usersOnboarding free of
          // completed nodes that would otherwise accumulate forever - see the
          // file header. The response mirrors the pre-deletion shape a caller
          // would have seen, so nothing downstream needs to know it is gone.
          const finished: UserOnboarding = {
            ...onboarding,
            step: 'done',
            completedAt: Date.now(),
          };
          await ref.remove();
          logger.info('Onboarding finished; node retired', { uid });
          return { onboarding: finished };
        }

        // Skip only: record the furthest step so a reload resumes there. The
        // node survives, so resume is never lost.
        await ref.update({ setupStep: skipTo });
        logger.info('Onboarding advanced', { uid, skipTo });
        return { onboarding: { ...onboarding, setupStep: skipTo } };
      },
    ),
);
