// ============================================================================
// Cloud Functions entry point (brief 4.5).
//
// Every deployable Function is re-exported here under the name Firebase deploys it
// as. The implementations live in src/functions/* and src/lib/* one concern per
// file; this barrel is the deployment manifest, kept thin on purpose so the
// Function catalogue is readable at a glance (brief 18.9).
//
// Region and App Check: every callable carries the shared callableOptions (one
// region, App Check enforced) and every trigger is pinned to the same region, so
// the whole codebase deploys to europe-west1 with attestation on (brief 4.6 / 4.7).
// ============================================================================

// --- Identity and membership -------------------------------------------------
export { onMembershipChange } from './functions/onMembershipChange';
// The portal twin: mints/clears {portalOrgId, customerId, customerRoles}
// claims from /customerMembers records (FR-E22).
export { onCustomerMembershipChange } from './functions/onCustomerMembershipChange';
export { createInvitation } from './functions/createInvitation';
// Read-only lookup /invite runs on load, so the page knows which address the
// invitation names and whether that account already exists.
export { previewInvitation } from './functions/previewInvitation';
export { acceptInvitation } from './functions/acceptInvitation';
// Switch which organisation a multi-org user is acting in (re-mints their claims).
export { setActiveOrganisation } from './functions/setActiveOrganisation';
// A member's own email preference toggles (self-scoped; story 2066).
export { updateMyPreferences } from './functions/updateMyPreferences';

// --- Jobs and assessment lifecycle ------------------------------------------
export { createJob } from './functions/createJob';
export { startAssessment } from './functions/startAssessment';
export { submitAssessment } from './functions/submitAssessment';
// AI-assisted drafting: reads the answers and drafts the narrative + an
// issues-to-address list grounded in UK fire-safety regulation. Needs the
// OPENAI_API_KEY secret (see the function header).
export { generateAssessmentDraft } from './functions/generateAssessmentDraft';
export { changeAssessmentTemplate } from './functions/changeAssessmentTemplate';
export { onAssessmentCreate } from './functions/onAssessmentCreate';
export { onAssessmentStageChange } from './functions/onAssessmentStageChange';
// Mirrors an assessor's confirmed service next-due dates (a `serviceConfirmed`
// log book entry) onto building.serviceSchedule, the field the report and the
// submission completeness check read (story 1047).
export { onLogBookEntryCreated } from './functions/onLogBookEntryCreated';

// --- Reports -----------------------------------------------------------------
// generateReport renders the three-section industry-standard PDF server-side,
// writes it to tenant-scoped Storage with a /reports record and logs to /activity
// (brief 4.5 #8 / section 11, stories 1071-1076). The Storage rules scope report
// PDFs to the owning ORG (story 1076); a customer reads theirs only through
// getReportDownloadUrl, which authorises live per request.
export { generateReport } from './functions/generateReport';

// --- Organisation administration (Phase 2) -----------------------------------
// Every action below writes its /activity audit entry in the same atomic update
// as the data change - the reason these are callables, not client writes.
// Found a new organisation; the caller becomes its first admin.
export { createOrganisation } from './functions/createOrganisation';
// Whitelabel profile edits (name, brand colours, contact, typography, logo).
export { updateOrgProfile } from './functions/updateOrgProfile';
// Configurable RAG derivation thresholds (story 2012).
export { updateOrgSettings } from './functions/updateOrgSettings';
// Member role/status changes, with the last-active-admin guard.
export { updateMember } from './functions/updateMember';
// Invitation lifecycle: withdraw a pending invite / rotate and re-send one.
export { revokeInvitation } from './functions/revokeInvitation';
export { resendInvitation } from './functions/resendInvitation';
// Customer / site / building CRUD (archive-not-delete; derived fields guarded).
export { manageCustomer } from './functions/manageCustomer';
export { manageCustomerContact } from './functions/manageCustomerContact';
export { manageSite } from './functions/manageSite';
export { manageBuilding } from './functions/manageBuilding';
// Floor-plan records (past assessments' flag composites survive removal).
export { manageFloorPlan } from './functions/manageFloorPlan';
// Building document records, per category (file itself lives in Storage).
export { manageBuildingDocument } from './functions/manageBuildingDocument';
// Action-plan management between assessments (create/update/signOff/reopen;
// status moves only through the sign-off verbs, story 2043/2044).
export { manageAction } from './functions/manageAction';
// Bulk CSV import of an estate (sites and their buildings, or buildings onto
// one site) - the whole file validated and written in ONE atomic update.
export { importRecords } from './functions/importRecords';
// Template builder (FR-E21): validate a draft and promote it to the live,
// client-immutable /templates node, with a frozen /templateVersions archive copy.
export { publishTemplate } from './functions/publishTemplate';

// --- Jobs administration (Phase 2) --------------------------------------------
// Diary edits with the slot clash check and atomic /assessorJobs index rewrites.
// Move a visit's date/slot and/or assessor; both index entries rewritten together.
export { rescheduleJob } from './functions/rescheduleJob';
// Withdraw a visit (cancelled, never deleted); any started assessment survives.
export { cancelJob } from './functions/cancelJob';

// --- Auditor lifecycle (Phase 2) -----------------------------------------------
// The server-side validation transitions (FUTURE_WORK 3, now built). Stage
// notifications, the log book and the released PDF all fire from
// onAssessmentStageChange - these callables own the gates and the writes.
// Flag questions needing more information (readyForValidation -> infoRequired).
export { requestInfo } from './functions/requestInfo';
// Sign off validation (readyForValidation -> readyForRelease; unresolved
// information requests block acceptance).
export { acceptAssessment } from './functions/acceptAssessment';
// THE release pipeline: mint the action plan, compute the finding distribution,
// derive the building's RAG (shared lib/ragDerivation) and release - atomically.
export { releaseAssessment } from './functions/releaseAssessment';

// --- Emails -------------------------------------------------------------------
// Explicit one-off send of an org template (admin; up to fifty recipients,
// resolved server-side and returned redacted). The automated kinds send from
// their own triggers/crons - this is the only hand-composed dispatch.
export { sendManualEmail } from './functions/sendManualEmail';

// --- Customer portal ----------------------------------------------------------
// The contact's manual sign-off of a released report: records the typed name
// against the report, with the uid and timestamp taken from the session.
export { acceptReport } from './functions/acceptReport';
// THE way a report PDF is opened. Authorisation is re-derived from live database
// state on every request (owning customer, portal seat, acceptance) and answered
// with a short-lived signed URL, because Storage rules cannot read RTDB and the
// object metadata they can read goes stale the moment ownership or access moves.
export { getReportDownloadUrl } from './functions/getReportDownloadUrl';
// A customer admin invites a colleague into the portal with a role: the first
// portal-side write beyond acceptReport, and the first customer-role gate. Org
// and customer are taken from the verified portal token, never the payload.
export { portalInviteTeammate } from './functions/portalInviteTeammate';
// Changes the roles (and optionally the standing) of a portal account that
// already exists, so a wrong role is corrected rather than revoked and re-issued.
// TWO callers: an org STAFF admin from the contacts panel, and a PORTAL admin
// managing their own team. Keeps the contact's portalRoles in step in the same
// atomic write, and protects the customer's last active portal administrator.
export { updateCustomerMember } from './functions/updateCustomerMember';
// The duty-holder reports progress on remedial work they are responsible for
// arranging: a claim plus an optional dated note, never a sign-off. Closing an
// action stays with the organisation (manageAction's signOff verb).
export { respondToAction } from './functions/respondToAction';

// --- Platform oversight (super admin) ----------------------------------------
// Records a super admin's read-only drill-down into a tenant as a
// `platform.access` entry in that tenant's own /activity trail (story 2069 AC2),
// so an organisation can see when the platform operator looked. Actor and org
// come from the verified token and validated input, never spoofable client data.
export { recordPlatformAccess } from './functions/recordPlatformAccess';

// --- Public site --------------------------------------------------------------
// Book-a-demonstration form: stores the lead at /platform/leads and notifies sales.
export { registerInterest } from './functions/registerInterest';

// --- Telemetry ---------------------------------------------------------------
// Best-effort client-error sink: logs a caught console crash to Cloud Logging (no
// RTDB write, no node). Alerting is configured on the logging side.
export { reportClientError } from './functions/reportClientError';

// --- Billing (Phase 3) --------------------------------------------------------
// The Stripe event receiver: the codebase's FIRST v2 onRequest (signature-
// verified over req.rawBody - deliberately outside App Check/callableOptions).
// One URL serves both Stripe modes via ?mode=test|live; writes subscription
// snapshots, dunning state, the finance feed and drives first-subscribe
// organisation provisioning.
export { stripeWebhook } from './functions/stripeWebhook';
// Self-serve subscribe (verified-email user, no org yet): creates the Stripe
// Customer + incomplete subscription and returns the Payment Element secret;
// the org itself is provisioned by the webhook when payment lands.
export { createSubscription } from './functions/createSubscription';
// Step ZERO of self-serve: the organisation's details (name, address, phone,
// website), collected BEFORE plan choice and saved to the caller's own
// usersOnboarding node - the journey's resume point.
export { saveOnboardingDetails } from './functions/saveOnboardingDetails';
// Billing read model: onboarding resume state (no orgId) or the org admin's
// subscription snapshot (orgId), each with a pending-payment client secret
// when a payment still needs finishing.
export { getBillingState } from './functions/getBillingState';
// Setup-wizard skip/finish on the caller's own usersOnboarding node; the
// substantive wizard steps are marked done by the callables that perform them.
export { advanceOnboarding } from './functions/advanceOnboarding';
// Plan management by the org admin. Upgrades invoice the proration immediately;
// downgrades land at period end via a subscription schedule. The webhook stays
// the single writer of Stripe-derived state - these return what changed.
export { changeSubscription } from './functions/changeSubscription';
// Period-end cancel with one-click resume until the date passes; immediate
// cancellation is deliberately not offered (refunds go through support).
export { cancelSubscription } from './functions/cancelSubscription';
// The way back from a dead (canceled/expired) subscription: a NEW subscription
// on the org's existing Stripe customer, returning the Payment Element secret;
// the webhook lands the snapshot when payment confirms.
export { resubscribe } from './functions/resubscribe';
// Mints the SetupIntent for the Billing tab's card-update Payment Element; the
// webhook's setup_intent.succeeded handler performs the default-card swap.
export { createCardUpdateIntent } from './functions/createCardUpdateIntent';
// Invoice history for the Billing tab, read straight from Stripe (paged).
export { listInvoices } from './functions/listInvoices';

// --- Scheduled ---------------------------------------------------------------
// A daily 07:00 UK reminder to each assessor with jobs scheduled that day
// ("You have 4 jobs scheduled today."), in-app plus best-effort push.
export { dailyJobReminders } from './functions/dailyJobReminders';
// A daily 07:30 UK FRA-review reminder (60/30/7 days ahead, plus a one-off
// lapsed notice) to each org's admins: in-app, best-effort push and email.
export { reviewReminders } from './functions/reviewReminders';
export { customerContracts } from './functions/customerContracts';
// A daily 07:45 UK sweep of the two dated commitments nothing else chases: an
// assessor's outstanding information request and an open action's due date.
// In-app plus best-effort push, and email to the people who own each.
export { deadlineReminders } from './functions/deadlineReminders';
// Nightly 03:15 UK lead-retention sweep: deletes /platform/leads entries older
// than the privacy policy's promised 24 months.
export { cleanupLeads } from './functions/cleanupLeads';
// Nightly 02:30 UK whole-database JSON export (live/test/platform roots) to the
// client-inaccessible backups/** prefix in the default bucket.
export { exportBackups } from './functions/exportBackups';
// Nightly 03:45 UK billing-retention sweep, both envs: Stripe webhook
// idempotency done-markers older than 30 days and finance-feed entries older
// than 12 months.
export { cleanupBilling } from './functions/cleanupBilling';
