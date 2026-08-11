// ============================================================================
// Per-user rate limiting (brief 4.5 / 4.6 abuse control).
//
// App Check stops UNATTESTED callers; this stops an ATTESTED, signed-in caller
// (or a buggy client stuck in a retry loop) from hammering an endpoint. Each
// (uid, action) pair gets a fixed-window counter in RTDB under the server-only
// `ops/rateLimits` tree (Admin-SDK-only; rules default-deny it). A single atomic
// transaction both reads and advances the window, so concurrent calls cannot race
// past the limit, and an over-limit call ABORTS the transaction (no write) and is
// rejected with the structured `resource-exhausted` error the client already maps.
//
// The limits below are deliberately generous - enough that no legitimate on-site
// workflow is ever throttled, low enough that automated abuse is capped. Tune per
// action as real usage data arrives; the shape (limit per window) stays the same.
// ============================================================================

import { db } from '../admin';
import { paths } from './paths';
import { fail } from './errors';

/** A fixed-window allowance: at most `limit` calls per `windowMs`. */
export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Per-action allowances. Keyed by a stable action name (also the RTDB child key),
 * so a limit change is a one-line edit and adding a new guarded action is adding
 * one entry. Expensive actions (report generation) are tighter than cheap ones.
 */
export const RATE_LIMITS = {
  createJob: { limit: 60, windowMs: MINUTE },
  createInvitation: { limit: 10, windowMs: MINUTE },
  startAssessment: { limit: 60, windowMs: MINUTE },
  submitAssessment: { limit: 30, windowMs: MINUTE },
  generateReport: { limit: 10, windowMs: MINUTE },
  // AI drafting calls a paid model, so it is held tighter than the everyday
  // assessment actions - a handful of drafts per minute is ample on site.
  generateAssessmentDraft: { limit: 6, windowMs: MINUTE },
  // Changing the template DELETES every recorded answer, so the bucket is tight:
  // a couple of corrections at the start of a visit is the honest use, and a
  // loop hammering this would be destroying an assessor's work each time.
  changeAssessmentTemplate: { limit: 5, windowMs: MINUTE },
  // The public register-interest form has no signed-in caller, so its bucket is
  // keyed by client IP rather than uid (see registerInterest.ts). One genuine
  // enquiry is one call; five a minute absorbs a retry or a corrected resubmit
  // while capping a scripted flood from a single address.
  registerInterest: { limit: 5, windowMs: MINUTE },
  // Accepting an invitation is likewise a PRE-AUTH endpoint (possession of the
  // token is the credential), so its bucket is keyed by client IP too - see
  // rateLimitKeyFor in registerInterest.ts. Ten a minute absorbs a retry loop
  // or a shared-office NAT while capping token-guessing from one address.
  acceptInvitation: { limit: 10, windowMs: MINUTE },
  // The read-only companion /invite calls on load. Also IP-keyed, and a touch
  // more generous than accepting because a reload, a back-navigation or a
  // second device all repeat it while none of them consumes the token.
  previewInvitation: { limit: 20, windowMs: MINUTE },
  // Organisation administration (Phase 2). Creating an org is a rare, deliberate
  // act; settings and membership edits are occasional; the entity CRUD actions
  // are generous enough for an admin bulk-entering a portfolio in one sitting.
  createOrganisation: { limit: 3, windowMs: MINUTE },
  updateOrgProfile: { limit: 20, windowMs: MINUTE },
  updateOrgSettings: { limit: 20, windowMs: MINUTE },
  updateMember: { limit: 30, windowMs: MINUTE },
  revokeInvitation: { limit: 20, windowMs: MINUTE },
  // Resending dispatches an email, so it is held tighter than the other admin
  // actions - the same anti-abuse posture as createInvitation.
  resendInvitation: { limit: 5, windowMs: MINUTE },
  manageCustomer: { limit: 60, windowMs: MINUTE },
  manageCustomerContact: { limit: 60, windowMs: MINUTE },
  manageSite: { limit: 60, windowMs: MINUTE },
  manageBuilding: { limit: 60, windowMs: MINUTE },
  manageFloorPlan: { limit: 60, windowMs: MINUTE },
  manageBuildingDocument: { limit: 60, windowMs: MINUTE },
  manageAction: { limit: 60, windowMs: MINUTE },
  // A whole-file estate import is one deliberate act that writes hundreds of
  // records at once, so it sits with the one-shot admin actions rather than the
  // per-record CRUD allowances: enough for a corrected re-run, not for a loop.
  importRecords: { limit: 6, windowMs: MINUTE },
  // A portal contact signs one report off once. The allowance is generous enough
  // to absorb a retry after a dropped connection and nothing more.
  acceptReport: { limit: 10, windowMs: MINUTE },
  // Every report download now mints a fresh signed URL, so this fires once per
  // click rather than once per report - a reader opening several buildings'
  // reports in a sitting, or re-clicking after a URL expired, is normal. Held
  // well below the CRUD allowances because each call signs through the IAM API.
  getReportDownloadUrl: { limit: 30, windowMs: MINUTE },
  // A customer admin inviting a colleague dispatches an email, so it is held as
  // tight as the staff-side createInvitation - deliberate, one at a time, not
  // bulk entry.
  portalInviteTeammate: { limit: 5, windowMs: MINUTE },
  // Changing a portal account's role sends no email and writes one small record,
  // so it sits with the staff-side updateMember allowance rather than the tight
  // invite one: a staff admin correcting a customer's whole team after a
  // reorganisation is a legitimate run of calls in one sitting.
  updateCustomerMember: { limit: 30, windowMs: MINUTE },
  // A duty-holder working down their action plan after a contractor's visit may
  // legitimately respond to a run of actions in one sitting, so this sits with
  // the everyday CRUD allowances rather than the one-shot ones - it writes one
  // small record and one trail entry per call.
  respondToAction: { limit: 60, windowMs: MINUTE },
  // Publishing a template (FR-E21) is a deliberate authoring milestone, not bulk
  // entry - each publish deep-validates the draft and mints an archive version,
  // so it sits with the other one-shot admin actions.
  publishTemplate: { limit: 10, windowMs: MINUTE },
  // Jobs administration (FR-E17). Rescheduling and cancelling are deliberate
  // diary edits, not bulk entry, so they sit below the create allowance.
  rescheduleJob: { limit: 30, windowMs: MINUTE },
  cancelJob: { limit: 30, windowMs: MINUTE },
  // Auditor lifecycle (FR-E18). Reviewing is human-paced; release is held
  // tightest because each release fans out into action-plan writes, the
  // building roll-up and a PDF render via the stage trigger.
  requestInfo: { limit: 30, windowMs: MINUTE },
  acceptAssessment: { limit: 30, windowMs: MINUTE },
  releaseAssessment: { limit: 10, windowMs: MINUTE },
  // Switching organisations re-mints the caller's claims (an Auth write plus
  // the refresh marker); a human switches a handful of times a day, so twenty
  // a minute absorbs any UI retry loop while capping claim-churn abuse.
  setActiveOrganisation: { limit: 20, windowMs: MINUTE },
  // A member's own email preference toggles (story 2066): a settings form a
  // human saves a few times at most; twenty a minute absorbs indecisive
  // toggling while capping a scripted write loop.
  updateMyPreferences: { limit: 20, windowMs: MINUTE },
  // Best-effort client-error telemetry (reportClientError). A single page crash
  // can fire a small burst (the error boundary plus the global window handlers),
  // and the client already caps its own reports per session, so this is only a
  // backstop against a stuck client - generous enough never to drop a genuine
  // crash report, tight enough to cap a runaway loop.
  reportClientError: { limit: 20, windowMs: MINUTE },
  // A manual send can address fifty EXTERNAL recipients per call from the
  // platform's verified sending domain, so the scarce resource here is domain
  // reputation, not compute: at the old 10/minute a single admin account was a
  // ~720k-emails/day relay. Five an HOUR still covers every honest use (an
  // admin composes deliberately, batch by batch, with a corrected re-send to
  // spare) while making the endpoint worthless as a spam pipe. The per-org
  // daily recipient cap (lib/manualEmailLimits) backstops this per-user rate.
  sendManualEmail: { limit: 5, windowMs: HOUR },
  // A super admin opening a tenant drill-down (recordPlatformAccess). A single
  // navigation through an org, a customer and a building fires it three times,
  // and the pages guard against StrictMode double-fire, so sixty a minute is
  // ample for genuine oversight browsing while capping a stuck client.
  recordPlatformAccess: { limit: 60, windowMs: MINUTE },
  // Billing (Phase 3). Starting a subscription creates real Stripe objects
  // (customer + incomplete subscription), so the window is hourly and small: a
  // genuine subscriber does this once - but the payment page calls it on
  // EVERY mount (the resume path returns the same secret), so a buyer
  // deliberating between tiers legitimately burns several calls in minutes.
  // Twelve an hour absorbs that comparison shopping; the persisted attempt
  // nonce means every extra call resumes rather than duplicates, so the
  // marginal cost of a higher ceiling is one idempotent Stripe read.
  createSubscription: { limit: 12, windowMs: HOUR },
  // The pre-plan details form: a human fills it once and maybe edits it a few
  // times on the way to payment; thirty a minute absorbs a fiddly address
  // correction without allowing a write loop against the onboarding node.
  saveOnboardingDetails: { limit: 30, windowMs: MINUTE },
  // Reading billing state fires on gate mounts and payment-confirmation polls,
  // so it is generous like the other read paths, while still capping a client
  // stuck in a refresh loop against the Stripe API behind it.
  getBillingState: { limit: 30, windowMs: MINUTE },
  // Skip/finish taps in the setup wizard: a human clicks through a handful of
  // steps once; thirty a minute absorbs indecision without allowing a loop.
  advanceOnboarding: { limit: 30, windowMs: MINUTE },
  // Plan changes and cancellations are deliberate, rare acts - six an hour
  // absorbs a change of heart while stopping a scripted loop against Stripe.
  changeSubscription: { limit: 6, windowMs: HOUR },
  cancelSubscription: { limit: 6, windowMs: HOUR },
  // Restarting a dead subscription creates a real Stripe subscription, so it
  // matches createSubscription's posture: a genuine restart happens once, and
  // the dead-subscription-derived idempotency key makes retries resume rather
  // than duplicate.
  resubscribe: { limit: 5, windowMs: HOUR },
  // A card update mints a SetupIntent against Stripe; ten an hour covers a
  // fumbled card number several times over.
  createCardUpdateIntent: { limit: 10, windowMs: HOUR },
  // Invoice history is a read, paged by the Billing tab.
  listInvoices: { limit: 30, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitedAction = keyof typeof RATE_LIMITS;

interface WindowState {
  windowStart: number;
  count: number;
}

/**
 * Consume one unit of a user's allowance for `action`, or reject. Runs an atomic
 * RTDB transaction:
 *   - no/expired window  -> open a fresh window at count 1 (allow);
 *   - within window, under limit -> increment (allow);
 *   - within window, at limit    -> abort the transaction (deny, no write).
 * `nowMs` is injectable so the decision is deterministically testable without a
 * clock; production passes Date.now().
 */
export async function assertRateLimit(
  uid: string,
  action: RateLimitedAction,
  nowMs: number = Date.now(),
): Promise<void> {
  const { limit, windowMs } = RATE_LIMITS[action];
  const ref = db.ref(paths.ops.rateLimit(uid, action));

  const result = await ref.transaction((current: WindowState | null) => {
    if (
      !current ||
      typeof current.windowStart !== 'number' ||
      nowMs - current.windowStart >= windowMs
    ) {
      // First call, or the previous window has elapsed: start a new one.
      return { windowStart: nowMs, count: 1 };
    }
    if (current.count >= limit) {
      // At the ceiling for this window: abort (undefined) so nothing is written
      // and `committed` comes back false.
      return undefined;
    }
    return { windowStart: current.windowStart, count: current.count + 1 };
  });

  if (!result.committed) {
    throw fail.resourceExhausted(
      'You are doing that too quickly. Please wait a moment and try again.',
      { action, limit, windowMs },
    );
  }
}
