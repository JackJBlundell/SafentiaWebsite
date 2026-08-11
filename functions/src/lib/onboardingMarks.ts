// ============================================================================
// Onboarding setup-step marks - Phase 3 setup wizard (plan §5.4).
//
// The setup wizard's steps are ticked off by the callables that actually
// PERFORM them (updateOrgProfile, createInvitation, manageCustomer,
// manageBuilding) rather than by client writes: rules deny all client writes
// to usersOnboarding/{uid}, so a real business write landing through the real
// callable is the only thing that can mark a step done. This module is the
// single piggyback seam those callables share.
//
// Best-effort BY CONTRACT: the business write has already committed by the
// time this runs, so a mark failure must never fail (or even slow the retry
// path of) the call that carried it. Every failure is swallowed and logged.
// The admin module is imported lazily so pure unit tests of callables can
// stub this module without touching admin initialisation order.
// ============================================================================

import type { Logger } from './logging';
import { usersOnboarding } from './paths';

/** The wizard steps a business callable can mark done (shared type §5.4). */
export type OnboardingSetupStep = 'profile' | 'team' | 'customer' | 'building';

/**
 * Mark a setup-wizard step done for the caller, iff their onboarding node is
 * live, at the setup stage, and belongs to the SAME organisation the business
 * write just touched (a caller acting in another org - e.g. an operator - must
 * never tick their own wizard). Never throws.
 */
export async function markOnboardingStep(
  uid: string,
  orgId: string,
  step: OnboardingSetupStep,
  logger: Logger,
): Promise<void> {
  try {
    const { db } = await import('../admin');
    const ref = db.ref(usersOnboarding(uid));
    const onboarding = (await ref.get()).val() as {
      step?: string;
      orgId?: string;
    } | null;
    // Silent no-ops: most calls arrive from long-established users with no
    // onboarding node at all, or outside the setup stage - nothing to mark.
    if (!onboarding) return;
    if (onboarding.step !== 'setup') return;
    if (onboarding.orgId !== orgId) return;

    await ref.child('setupDone').update({ [step]: true });
    logger.info('Onboarding setup step marked done', { uid, step });
  } catch (error) {
    logger.warn('Onboarding step mark failed (ignored - best effort)', {
      uid,
      step,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
