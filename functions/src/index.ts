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
export { onAssessmentCreate } from './functions/onAssessmentCreate';
export { onAssessmentStageChange } from './functions/onAssessmentStageChange';
// Mirrors an assessor's confirmed service next-due dates (a `serviceConfirmed`
// log book entry) onto building.serviceSchedule, the field the report and the
// submission completeness check read (story 1047).
export { onLogBookEntryCreated } from './functions/onLogBookEntryCreated';

// --- Reports -----------------------------------------------------------------
// generateReport renders the three-section industry-standard PDF server-side,
// writes it to tenant-scoped Storage with a /reports record and logs to /activity
// (brief 4.5 #8 / section 11, stories 1071-1076). The Storage rules already scope
// report PDFs to the owning org and customer (story 1076).
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

// --- Customer portal ----------------------------------------------------------
// The contact's manual sign-off of a released report: records the typed name
// against the report, with the uid and timestamp taken from the session.
export { acceptReport } from './functions/acceptReport';

// --- Public site --------------------------------------------------------------
// Book-a-demonstration form: stores the lead at /platform/leads and notifies sales.
export { registerInterest } from './functions/registerInterest';

// --- Telemetry ---------------------------------------------------------------
// Best-effort client-error sink: logs a caught console crash to Cloud Logging (no
// RTDB write, no node). Alerting is configured on the logging side.
export { reportClientError } from './functions/reportClientError';

// --- Scheduled ---------------------------------------------------------------
// A daily 07:00 UK reminder to each assessor with jobs scheduled that day
// ("You have 4 jobs scheduled today."), in-app plus best-effort push.
export { dailyJobReminders } from './functions/dailyJobReminders';
// A daily 07:30 UK FRA-review reminder (60/30/7 days ahead, plus a one-off
// lapsed notice) to each org's admins: in-app, best-effort push and email.
export { reviewReminders } from './functions/reviewReminders';
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
