// ============================================================================
// saveOnboardingDetails (callable) - Phase 3 self-serve subscribe, step ZERO.
//
// The first server step of the restructured self-serve journey: a signed-in,
// VERIFIED-email user with NO organisation tells us about the organisation
// they are founding - name (required), and optionally address, phone and
// website in OrgContact's exact vocabulary - BEFORE any plan is chosen. The
// details land on usersOnboarding/{uid} (owner-read, server-write), which
// makes them the resume point: a returning visitor skips straight to the plan
// or payment step, and provisioning copies orgDetails into the new org's
// profile.contact with no translation.
//
// EDITABLE, NEVER DESTRUCTIVE. Re-submitting while the journey is at
// 'details'/'plan'/'payment' updates the details in place; a payment already
// in flight keeps its Stripe fields AND its 'payment' step, so editing the
// address can never strand an incomplete subscription. A journey at 'setup' is
// refused (the org exists - its profile is edited from the console), and a
// finished ('done') node is replaced afresh, exactly as the gating rule that
// sends a claims-less 'done' session back to the start expects.
//
// Like createSubscription, this is a documented exception to the
// assertOrgRole canon (plan section 8): the caller has no org, so the gate is
// verified email + rate limit, and a caller who already holds an org claim is
// turned away.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth } from '../lib/guards';
import { usersOnboarding } from '../lib/paths';
import {
  assertObject,
  optionalString,
  requireString,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { signupEnv } from '../lib/stripe';
import type {
  Environment,
  OnboardingOrgDetails,
  SaveOnboardingDetailsRequest,
  SaveOnboardingDetailsResponse,
  UserOnboarding,
} from '../shared/types';

/** Org names bound exactly as createSubscription always bound them (plan §9). */
const ORG_NAME_MIN = 2;
const ORG_NAME_MAX = 100;

/** The details fields a caller may set. Anything else is rejected rather than
 *  dropped, so a client cannot silently believe it saved a field. The
 *  vocabulary mirrors OrgContact so provisioning maps 1:1. */
const DETAIL_FIELDS = ['name', 'address', 'phone', 'website'] as const;

/**
 * Validate the submitted details into the canonical OnboardingOrgDetails
 * shape: name required (2..100), the rest optional bounded strings, stored
 * only when non-empty. Pure (throws fail.*) and exported for the unit tests.
 */
export function parseOnboardingDetails(raw: unknown): OnboardingOrgDetails {
  const input = assertObject(raw);
  for (const key of Object.keys(input)) {
    if (!(DETAIL_FIELDS as readonly string[]).includes(key)) {
      throw fail.invalidArgument(`Unknown details field: ${key}.`, {
        field: key,
      });
    }
  }
  const name = requireString(input, 'name', ORG_NAME_MAX);
  if (name.length < ORG_NAME_MIN) {
    throw fail.invalidArgument('The name field is too short.', {
      field: 'name',
      min: ORG_NAME_MIN,
    });
  }
  const details: OnboardingOrgDetails = { name };
  const address = optionalString(input, 'address', TEXT_LIMITS.shortText);
  const phone = optionalString(input, 'phone', TEXT_LIMITS.shortText);
  const website = optionalString(input, 'website', TEXT_LIMITS.shortText);
  if (address) details.address = address;
  if (phone) details.phone = phone;
  if (website) details.website = website;
  return details;
}

/**
 * The create-or-update rule for the node (pure, exported for the unit tests):
 * - no node, or a fresh journey ('details'/'plan'): step becomes 'plan' - the
 *   saved details unlock the plan matrix;
 * - a payment in flight ('payment') IN THE CALLER'S CURRENT MODE: the details
 *   update but the step AND every Stripe field (subscriptionId, attemptNonce,
 *   ...) are preserved, so the resume point survives an edit;
 * - a payment in flight from the OTHER Stripe mode (the account's testMode
 *   claim changed between attempts): its Stripe ids are invisible to the
 *   current mode's API, so nothing Stripe-bound is carried - the details
 *   survive and the journey rejoins at 'plan' (createSubscription's step 4b
 *   applies the same rule);
 * - a finished journey ('done'): dead history (§3.1.8) - start afresh rather
 *   than dragging a completed subscription's fields into a new journey.
 * createdAt keeps dating the FIRST attempt of the live journey.
 */
export function nextOnboardingForDetails(
  existing: UserOnboarding | null,
  details: OnboardingOrgDetails,
  env: Environment,
  now: number,
): UserOnboarding {
  const base = existing && existing.step !== 'done' ? existing : null;
  const sameMode = base?.env === env ? base : null;
  return {
    ...(sameMode ?? {}),
    step: sameMode?.step === 'payment' ? 'payment' : 'plan',
    orgName: details.name,
    orgDetails: details,
    createdAt: base?.createdAt ?? now,
  };
}

export const saveOnboardingDetails = onCall<SaveOnboardingDetailsRequest>(
  callableOptions,
  (request) =>
    runCallable<SaveOnboardingDetailsResponse>(
      createLogger({ fn: 'saveOnboardingDetails' }),
      async () => {
        // 1. Attestation + identity: verified email, no org claim (see file
        // header - the createSubscription posture, for the same reasons).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        const token = request.auth?.token;
        if (token?.email_verified !== true) {
          throw fail.failedPrecondition(
            'Please verify your email address before setting up an organisation.',
          );
        }
        if (typeof token.orgId === 'string' && token.orgId.length > 0) {
          throw fail.failedPrecondition(
            'Your account already belongs to an organisation, so it cannot start a new one.',
          );
        }
        await assertRateLimit(uid, 'saveOnboardingDetails');

        // 2. Validate the details.
        const input = assertObject(request.data);
        const details = parseOnboardingDetails(input.details);

        // 3. Create-or-update the caller's node. 'setup' is the one state the
        // details cannot be edited from here: the org exists, and its profile
        // is the console's to edit (updateOrgProfile).
        const ref = db.ref(usersOnboarding(uid));
        const existing = (await ref.get()).val() as UserOnboarding | null;
        if (existing?.step === 'setup') {
          throw fail.failedPrecondition(
            'Your organisation is being set up - its details are edited from the console now.',
          );
        }
        const onboarding = nextOnboardingForDetails(
          existing,
          details,
          signupEnv(token.testMode === true),
          Date.now(),
        );
        await ref.set(onboarding);

        const logger = createLogger({ fn: 'saveOnboardingDetails' });
        logger.info('Onboarding details saved', { uid, step: onboarding.step });
        return { onboarding };
      },
    ),
);
