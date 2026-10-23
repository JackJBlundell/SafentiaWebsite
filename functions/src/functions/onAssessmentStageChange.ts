// ============================================================================
// onAssessmentStageChange (RTDB trigger) - brief 4.5 #7 / 6.1, stories 1066/1051.
//
// THE documented stage event bus: it fires on every change to an assessment's
// `status` field (under either env root via the {env} wildcard) and, for each
// lifecycle transition, writes an /activity entry and an append-only /logBook
// entry, and emits the notification events for that stage. Centralising this means
// EVERY transition - whoever drove it (assessor Function now, auditor web later) -
// produces the same gap-free trail (story 1066 AC), and it is the future hook
// point for integrations such as SimPRO (which we do NOT build, brief 4.5 #7).
//
// We react to the status field specifically (not the whole assessment) so an
// answer edit does not spuriously fire a stage event. The previous and new status
// come from the change, so we only act on a genuine transition.
// ============================================================================

import { onValueWritten } from 'firebase-functions/v2/database';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { logTriggerError } from '../lib/errors';
import { paths } from '../lib/paths';
import { appendActivity, activityUpdate, logBookUpdate } from '../lib/events';
import { sendNotification } from '../lib/notifications';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { orgEmailBrand } from '../lib/emailTemplates';
import { loadKindConfig } from '../lib/templatedEmail';
import { deliverKindEmail } from '../lib/emailDigest';
import { WEB_ORIGIN } from '../lib/webOrigin';
import type { EnvPaths } from '../lib/paths';
import {
  ASSESSMENT_STAGE_LABELS,
  type AssessmentStatus,
  type Assessment,
  type Building,
  type Customer,
  type CustomerContact,
  type Job,
  type OrgMember,
  type OrgProfile,
  type Environment,
  type Keyed,
} from '../shared/types';

/** Which org roles to notify on each stage, so the right people are told. */
const STAGE_AUDIENCE: Record<AssessmentStatus, ReadonlyArray<'assessor' | 'auditor'>> = {
  // Submitted by the assessor: auditors pick it up.
  readyForValidation: ['auditor'],
  // Auditor asked for more info: the assessor must respond.
  infoRequired: ['assessor'],
  // Auditor accepted: the assessor sees it is cleared for release.
  readyForRelease: ['assessor'],
  // Released: assessor learns it is done. (Customer notification is Phase 2.)
  released: ['assessor'],
  // Back in progress (e.g. resumed): no notification, it is the assessor's own act.
  inProgress: [],
};

/**
 * Server-internal once-only marker for the released side effects (log book
 * entry, report, notification). Lives under the Admin-SDK-only /ops tree
 * (rules default-deny it, like ops/rateLimits), NOT in the mirrored shared
 * path contract - it is operational state, never tenant data. Written in the
 * SAME update() as the statutory log-book entry, so "the record exists" and
 * "the record was emitted" can never disagree.
 */
function releaseSideEffectsMarker(
  env: Environment,
  orgId: string,
  assessmentId: string,
): string {
  return `ops/releaseSideEffects/${env}/${orgId}/${assessmentId}`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A timestamp rendered for email copy, UK-local so it names the moment the
 *  recipient's working day actually saw. */
function formatWhen(millis: number): string {
  return new Date(millis).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });
}

/** Locate a building record by id. The estate lives under
 *  /{env}/buildings/{orgId}/{siteId}/{buildingId} and the assessment does not
 *  carry the siteId, so one bounded org-estate read and an in-memory walk is
 *  the honest lookup (the manageAction assignment email set this precedent). */
async function findBuilding(
  envPaths: EnvPaths,
  orgId: string,
  buildingId: string,
): Promise<{ building: Building; siteId: string } | undefined> {
  const estateSnap = await db.ref(envPaths.db.buildingsRoot(orgId)).get();
  const estate =
    (estateSnap.val() as Record<string, Record<string, Building>> | null) ?? {};
  // The siteId travels back with the record: the portal and console routes to a
  // building both carry it, and this walk is the only place that knows it.
  for (const [siteId, site] of Object.entries(estate)) {
    if (site && typeof site === 'object' && buildingId in site) {
      return { building: site[buildingId], siteId };
    }
  }
  return undefined;
}

/** Every customer contact who should be sent the released report, de-duplicated
 *  by address. Story 2060 tells the whole customer, not just the primary, so a
 *  released report reaches everyone the customer has nominated - but a customer
 *  with a dozen contacts was sending a dozen copies of a fire risk assessment,
 *  including to people who only ever needed a door-check reminder, so
 *  `receivesReports` is the per-contact opt-out.
 *
 *  ABSENT MEANS YES: the test is `!== false`, never truthiness, because every
 *  record that predates the field is a recipient today and must stay one (see
 *  the field's own declaration in shared/types). Duplicates (the same person
 *  entered twice, or a shared inbox) are collapsed on a case- and space-
 *  normalised key so no one is emailed twice; the first spelling seen is the
 *  one used to send. A duplicate address is a recipient if ANY contact holding
 *  it still receives reports - one person's opt-out cannot silence a shared
 *  inbox somebody else is still listening on. */
async function customerContactEmails(
  envPaths: EnvPaths,
  orgId: string,
  customerId: string,
): Promise<{ emails: string[]; optedOut: number }> {
  const contactsSnap = await db
    .ref(envPaths.db.customerContacts(orgId, customerId))
    .get();
  const contacts =
    (contactsSnap.val() as Keyed<CustomerContact> | null) ?? {};
  const seen = new Set<string>();
  const emails: string[] = [];
  // Counted, not just skipped: "the report reached nobody" has two very
  // different causes - nobody has an address, or everybody was opted out - and
  // the log has to say which, or a silent non-delivery is undiagnosable.
  let optedOut = 0;
  for (const contact of Object.values(contacts)) {
    const email = contact?.email?.trim();
    if (!email) {
      continue;
    }
    if (contact?.receivesReports === false) {
      optedOut += 1;
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    emails.push(email);
  }
  return { emails, optedOut };
}

export const onAssessmentStageChange = onValueWritten(
  {
    ref: '/{env}/assessments/{orgId}/{assessmentId}/status',
    region: REGION,
    // The stage emails below go out through the shared provider seam, so the
    // provider key must be mounted into this trigger's runtime.
    secrets: EMAIL_PROVIDER_SECRETS,
  },
  async (event) => {
    const env = event.params.env as Environment;
    const { orgId, assessmentId } = event.params;
    const logger = createLogger({
      fn: 'onAssessmentStageChange',
      env,
      orgId,
      assessmentId,
    });

    try {
      const before = event.data.before.exists()
        ? (event.data.before.val() as AssessmentStatus)
        : undefined;
      const after = event.data.after.exists()
        ? (event.data.after.val() as AssessmentStatus)
        : undefined;

      // Only act on a genuine transition to a new, present status. A delete (no
      // after) or an unchanged value is a no-op, so the bus never double-fires.
      if (!after || after === before) {
        return;
      }

      const envPaths = paths.forEnv(env);

      // Load the assessment for context (building, who conducted it). Defensive:
      // if it has gone, log and stop rather than throw, since there is nothing to
      // trail (brief 18.3).
      const assessmentSnap = await db
        .ref(envPaths.db.assessment(orgId, assessmentId))
        .get();
      if (!assessmentSnap.exists()) {
        logger.warn('Status changed but assessment record is absent', { after });
        return;
      }
      const assessment = assessmentSnap.val() as Assessment;

      const stageLabel = ASSESSMENT_STAGE_LABELS[after];

      // 1. Activity entry (append-only). Attribution: the released stage
      // belongs to the RELEASER (workflow.releasedBy, stamped by the
      // releaseAssessment callable) in preference to the validator - accepting
      // and releasing may be different auditors; other stages fall back to the
      // validator, then the conductor. This stage row intentionally coexists
      // with the driving callable's own /activity row: the callable records
      // the invoked ACT, this bus records the STAGE transition, so the trail
      // stays gap-free even for transitions no callable drove.
      const actorUid =
        (after === 'released' ? assessment.workflow?.releasedBy : undefined) ??
        assessment.workflow?.validatedBy ??
        assessment.conductedBy;

      // Every stage EXCEPT released takes the simple path: one activity entry,
      // then the audience notifications below. The released stage carries the
      // statutory side effects (log book, report, notification) and gets the
      // hardened path that follows.
      if (after !== 'released') {
        await appendActivity(envPaths, orgId, {
          actorUid,
          action: `assessment.stage.${after}`,
          target: assessmentId,
        });
      }

      // 2. Released side effects: the Building Fire Safety Log Book entry (the
      // one GENUINE fire-safety record a stage change produces - the FRA was
      // completed and released for this building), the released report PDF and
      // the assessor notification. Two hardening concerns shape this block:
      //
      // ORDERING (releaseAssessment): the callable CLAIMS the status via a
      // transaction on the status child FIRST, then writes the release payload
      // (action plan, building roll-up, workflow.releasedAt/releasedBy) in a
      // separate update - and on payload failure it reverts the status to
      // readyForRelease. This trigger fires on the STATUS write, i.e. usually
      // BEFORE the payload has landed, and the payload update never touches
      // the status child, so it does NOT re-fire the trigger. We therefore
      // confirm the payload (workflow.releasedAt on a fresh read) with a short
      // bounded wait: in the normal case it lands milliseconds behind the
      // claim; if it never arrives the release FAILED and was reverted, and a
      // reverted release must leave no statutory residue - no log-book entry,
      // no report, no notification - so we log and skip everything. The revert
      // itself is a status write, so the NEXT successful release re-fires this
      // trigger and the side effects run then.
      //
      // IDEMPOTENCY (trigger retries): the statutory records must be
      // once-only. The log-book entry uses the deterministic id
      // `fra-{assessmentId}` (set(), never push()), and an /ops marker is
      // written in the SAME atomic update as the entry and the activity row -
      // a re-delivery (or a second status write to 'released') sees the marker
      // and does nothing. The report and notification run AFTER the marker:
      // a crash between marker and dispatch loses at most a courtesy
      // notification, never duplicates a statutory record.
      // The report minted below, remembered for the customer email in section 4.
      // Undefined when generation failed or was skipped, in which case the email
      // falls back to the portal home rather than linking at nothing.
      let releasedReportId: string | undefined;
      // Who actually released it, as CONFIRMED below (the outer actorUid is read
      // from a snapshot that usually predates the release payload). Carried into
      // the assessor's released email in section 4 so it can name them.
      let releasedByUid: string | undefined;

      if (after === 'released') {
        // (a) Confirm the release payload actually landed. Re-read the
        // workflow child a few times (the payload normally trails the status
        // claim by milliseconds); if the status has meanwhile been reverted,
        // or the payload never arrives, this release did not complete.
        let releasedAt = assessment.workflow?.releasedAt;
        let releasedBy = assessment.workflow?.releasedBy;
        for (let attempt = 0; releasedAt === undefined && attempt < 3; attempt += 1) {
          await sleep(1500);
          const statusSnap = await db
            .ref(envPaths.db.assessmentStatus(orgId, assessmentId))
            .get();
          if (statusSnap.val() !== 'released') {
            // The callable reverted the claim: the release failed. Skip.
            logger.warn(
              'Release status was reverted before its payload landed; skipping released side effects',
            );
            return;
          }
          const workflowSnap = await db
            .ref(`${envPaths.db.assessment(orgId, assessmentId)}/workflow`)
            .get();
          const workflow = workflowSnap.val() as Assessment['workflow'] | null;
          releasedAt = workflow?.releasedAt;
          releasedBy = workflow?.releasedBy ?? releasedBy;
        }
        if (releasedAt === undefined) {
          // Payload never arrived: either the release failed (revert racing
          // us) or something is badly wrong. Either way, emitting statutory
          // records for an incomplete release would be dishonest - log loudly
          // and leave no residue. A retried release re-fires this trigger.
          logger.error(
            'Assessment is released but its release payload (workflow.releasedAt) is absent; skipping released side effects',
          );
          return;
        }

        // (b) Once-only guard: if the marker exists a previous delivery
        // already emitted everything - a retry must be a total no-op.
        const markerPath = releaseSideEffectsMarker(env, orgId, assessmentId);
        const markerSnap = await db.ref(markerPath).get();
        if (markerSnap.exists()) {
          logger.info('Released side effects already emitted; skipping retry');
          return;
        }

        const emittedBy = releasedBy ?? actorUid;
        releasedByUid = emittedBy;

        // (c) ONE atomic update: the statutory log-book entry (deterministic
        // id), the stage activity row (its push key is minted locally, and the
        // marker in the same update is what makes a retry skip it), and the
        // marker itself. All three land or none do.
        await db.ref().update({
          ...logBookUpdate(
            envPaths,
            orgId,
            assessment.buildingId,
            `fra-${assessmentId}`,
            'fraCompleted',
            emittedBy,
            {
              assessmentId,
              completedAt: Date.now(),
              summary: 'Fire risk assessment completed and released.',
            },
          ),
          ...activityUpdate(envPaths, orgId, {
            actorUid: emittedBy,
            action: 'assessment.stage.released',
            target: assessmentId,
          }),
          [markerPath]: { at: Date.now(), by: emittedBy },
        });

        // Generate the released report PDF. This is THE moment the report is
        // minted (a released assessment is the final validated artefact). We
        // isolate its failure: a render/upload hiccup must not lose the audit
        // trail written above nor force a whole-trigger retry, which would
        // duplicate the append-only entries. A failed report can always be
        // regenerated on demand via the generateReport callable.
        try {
          // Lazy-load the report core (and its pdfkit dependency) at first use:
          // every deployed function loads the whole barrel graph at cold start,
          // so a static import here would make EVERY function pay for pdfkit.
          const { generateAndStoreReport } = await import('../report/generateAndStore');
          const generated = await generateAndStoreReport({
            paths: envPaths,
            orgId,
            assessmentId,
            actorUid: emittedBy,
            logger,
          });
          // Carried into the customer email below so its CTA can deep-link at
          // the report the contact has to sign off, not the portal home.
          releasedReportId = generated.reportId;
        } catch (reportError) {
          logger.error('Automatic report generation on release failed', {
            reason:
              reportError instanceof Error
                ? reportError.message
                : String(reportError),
          });
        }
      }

      // 3. Notifications for the stage's audience. We resolve recipients from the
      // org's active members holding the audience role(s). The member list is
      // loaded once here and reused by the stage emails in section 4.
      const audience = STAGE_AUDIENCE[after];
      let members: Keyed<OrgMember> = {};
      if (audience.length > 0 || after === 'readyForValidation' || after === 'released') {
        const membersSnap = await db.ref(envPaths.db.orgMembers(orgId)).get();
        members = (membersSnap.val() as Keyed<OrgMember> | null) ?? {};
      }
      // The one assessor this stage concerns, resolved once from the job below
      // and reused by their stage email in section 4 - the two must address the
      // same person, and one job read is enough to be sure of it.
      let assignedAssessorUid: string | undefined;
      if (audience.length > 0) {

        // For assessor-targeted stages, prefer the specific assigned assessor so we
        // do not spam every assessor in the org; fall back to role match otherwise.
        let recipients: string[] = [];
        if (audience.includes('assessor')) {
          const jobSnap = await db
            .ref(envPaths.db.job(orgId, assessment.jobId))
            .get();
          const job = jobSnap.val() as Job | null;
          if (job?.assessorUid) {
            assignedAssessorUid = job.assessorUid;
            recipients.push(job.assessorUid);
          }
        }
        if (audience.includes('auditor')) {
          recipients = recipients.concat(
            Object.entries(members)
              .filter(([, m]) => m.status === 'active' && m.roles?.auditor === true)
              .map(([uid]) => uid),
          );
        }

        // Deduplicate (a multi-role user could match twice) before dispatch.
        for (const uid of Array.from(new Set(recipients))) {
          await sendNotification(
            envPaths,
            orgId,
            uid,
            {
              type: `assessmentStage.${after}`,
              title: stageLabel,
              body: `An assessment is now: ${stageLabel}.`,
              link: `safentia://assessment/${assessmentId}`,
            },
            logger,
          );
        }
      }

      // 4. Stage emails (stories 2065 + 2060). Best-effort throughout: the
      // statutory records above have landed and nothing here may throw. A
      // member's emailPreferences quietens these courtesy categories; ABSENT
      // means ON (the contract's default), so only an explicit false skips.
      // Idempotency posture: the released emails sit behind the /ops marker's
      // early return (a retry never reaches here for released), and a retried
      // readyForValidation/readyForRelease email is an acceptable courtesy
      // duplicate - the same stance the in-app notifications above already take.
      if (
        after === 'readyForValidation' ||
        after === 'readyForRelease' ||
        after === 'released'
      ) {
        // Best-effort IN FULL, not just at the dispatch: the statutory records
        // above have already landed, and the section-1 activity row is
        // append-only, so a failed READ here (estate, profile, customer) must
        // cost at most a courtesy email - never a thrown trigger, whose retry
        // would write that row a second time.
        try {
          const located = await findBuilding(
            envPaths,
            orgId,
            assessment.buildingId,
          );
          const building = located?.building;
          const siteId = located?.siteId;
          const buildingName = building?.name ?? 'a building';

          // Every stage email below carries the sending organisation's own brand
          // (name + accent), falling back to the Safentia brand when the org has
          // not set a valid one. Read once here and shared by all recipients.
          const profileSnap = await db.ref(envPaths.db.orgProfile(orgId)).get();
          const brand = orgEmailBrand(profileSnap.val() as OrgProfile | null);

          // Addresses the released ADMIN notice below has already gone to,
          // normalised for comparison. An admin who is also the assigned assessor
          // would otherwise be told twice about one release; whichever email
          // reaches them first is the one they get, and each side keeps its own
          // preference (silencing one never silences the other).
          const emailedAdmins = new Set<string>();

          if (after === 'readyForValidation') {
            // (a) Story 2065: every active auditor who has not quietened the
            // awaiting-validation category learns a submission needs review.
            const assessorName =
              members[assessment.conductedBy]?.name ?? 'An assessor';
            const submittedAt = assessment.workflow?.submittedAt;
            // The seam owns the rendering now; the message is identical for
            // every auditor, so the org's kind config is loaded once and the
            // variables and rows are computed once for the whole fan-out.
            const awaitingConfig = await loadKindConfig(
              envPaths.env,
              orgId,
              'awaiting-validation',
              logger,
            );
            const awaitingVariables = {
              'building.name': buildingName,
              'assessor.name': assessorName,
            };
            const awaitingRows = [
              { label: 'Building', value: buildingName },
              { label: 'Assessor', value: assessorName },
              ...(submittedAt !== undefined
                ? [{ label: 'Submitted', value: formatWhen(submittedAt) }]
                : []),
            ];
            // One line for this submission in an auditor's queue digest: which
            // building, and whose work it is - the two facts that decide the
            // order a reviewer picks a morning's submissions up in.
            const awaitingDigestRow = {
              label: buildingName,
              value: `Submitted by ${assessorName}`,
            };
            for (const member of Object.values(members)) {
              if (
                member?.status === 'active' &&
                member.roles?.auditor === true &&
                member.email &&
                member.emailPreferences?.awaitingValidation !== false
              ) {
                await deliverKindEmail(
                  {
                    kind: 'awaiting-validation',
                    env: envPaths.env,
                    orgId,
                    to: member.email,
                    variables: awaitingVariables,
                    brand,
                    // Straight into THIS assessment's review screen, the exact place
                    // the auditor accepts it or requests more information.
                    kindLink: `${WEB_ORIGIN}/app/validation/${assessmentId}`,
                    kindRows: awaitingRows,
                    config: awaitingConfig,
                    digestRow: awaitingDigestRow,
                  },
                  logger,
                );
              }
            }
          }

          if (after === 'released') {
            // (b) Story 2065: active admins who have not quietened the released
            // category hear the report is out...
            // The seam owns the rendering now; the message is identical for
            // every admin, so the org's kind config and the variables are
            // resolved once for the whole fan-out.
            const adminConfig = await loadKindConfig(
              envPaths.env,
              orgId,
              'released-admin',
              logger,
            );
            const adminVariables = {
              'building.name': buildingName,
              'assessment.releasedAt': formatWhen(Date.now()),
            };
            for (const member of Object.values(members)) {
              if (
                member?.status === 'active' &&
                member.roles?.admin === true &&
                member.email &&
                member.emailPreferences?.released !== false
              ) {
                emailedAdmins.add(member.email.trim().toLowerCase());
                await deliverKindEmail(
                  {
                    kind: 'released-admin',
                    env: envPaths.env,
                    orgId,
                    to: member.email,
                    variables: adminVariables,
                    brand,
                    // The released assessment's own screen, which carries the report
                    // download - closer to the point than the reports index.
                    kindLink: `${WEB_ORIGIN}/app/validation/${assessmentId}`,
                    config: adminConfig,
                    // A bulk release is exactly the day this digest exists for:
                    // one line per building, all saying the same thing, which is
                    // the whole news an admin needs from thirty of them.
                    digestRow: {
                      label: buildingName,
                      value: 'Report released',
                    },
                  },
                  logger,
                );
              }
            }

            // ...and (story 2060) the building's customer hears too. Every
            // customer contact with an email is told, not just the primary, so a
            // released report reaches everyone the customer has nominated to
            // receive it - EXCEPT the contacts an admin has taken off the
            // distribution with `receivesReports: false`, which is the only
            // choice a customer contact can express (emailPreferences lives on
            // OrgMember only). The message is identical for every recipient, so
            // it is rendered once and sent to each de-duplicated address.
            if (building) {
              const { emails: contactEmails, optedOut } =
                await customerContactEmails(
                  envPaths,
                  orgId,
                  building.customerId,
                );
              if (contactEmails.length > 0) {
                // The seam owns the rendering now; the org's kind config, the
                // variables and the link are resolved once for the fan-out.
                const contactConfig = await loadKindConfig(
                  envPaths.env,
                  orgId,
                  'released-contact',
                  logger,
                );
                const contactVariables = {
                  'building.name': buildingName,
                  // The portal instruction sentences, exactly as computed for
                  // the accept-flow and no-report cases (the catalogue's
                  // report.accessInstruction contract). The accept-flow copy
                  // names WHO signs rather than telling the reader they will:
                  // one message goes to every contact, and acceptReport refuses
                  // a portal viewer, so "you will be asked to sign" would be a
                  // promise the portal breaks for some recipients.
                  'report.accessInstruction':
                    releasedReportId && siteId
                      ? 'Sign in to your Safentia portal to read and accept the report. A portal administrator or finance contact for your organisation signs it off by typing their name, and the report is available to download straight afterwards.'
                      : 'You can view the assessment and download the report from your Safentia portal. The report is a secure, authenticated download - sign in to open it.',
                };
                // A secure CTA into the portal, never the PDF as an attachment:
                // the report is sensitive and email attachments leak. The link
                // deep-links at THIS report's acceptance screen behind the
                // contact's own authenticated session - there is no bearer token
                // in the URL, so a forwarded email grants nobody access. It
                // carries the RTDB push key the /reports record is stored under,
                // NOT the Storage object uuid (generateAndStore mints the two
                // separately); the push key is what the portal route and the
                // acceptReport callable address. In the no-report fallback the
                // building's own portal page still beats the portal home, which
                // the recipient would only have to navigate away from; it is
                // known here whenever the building was located, which this
                // branch requires. The catalogue models the one accept-flow CTA
                // label ('Accept & Sign Off') for both cases - see its comment.
                const contactLink =
                  releasedReportId && siteId
                    ? `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${assessment.buildingId}/reports/${releasedReportId}`
                    : `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${assessment.buildingId}`;
                // Best-effort per recipient: deliverKindEmail never throws, so
                // one contact's provider failure cannot stop the rest being told.
                for (const contactEmail of contactEmails) {
                  await deliverKindEmail(
                    {
                      kind: 'released-contact',
                      env: envPaths.env,
                      orgId,
                      to: contactEmail,
                      variables: contactVariables,
                      brand,
                      kindLink: contactLink,
                      config: contactConfig,
                      // A contact covering an estate hears about several
                      // releases in a day; the building is the only thing that
                      // distinguishes one line of that digest from the next.
                      digestRow: {
                        label: buildingName,
                        value: 'Report released',
                      },
                    },
                    logger,
                  );
                }
              } else if (optedOut > 0) {
                // A released report that reached nobody is a silent failure, and
                // this is the version of it an operator can actually act on:
                // there were addresses, every one of them was opted out. WARN,
                // not info - the console warns an admin about the same state on
                // the customer's contacts panel, and this is its server trail.
                logger.warn(
                  'Released customer email reached nobody: every contact with an email address is opted out of report copies',
                  { customerId: building.customerId, optedOut },
                );
              } else {
                logger.info(
                  'Released customer email skipped: no contact email recorded',
                );
              }
            } else {
              logger.warn(
                'Released customer email skipped: building record not found',
              );
            }
          }

          // (c) The ASSIGNED ASSESSOR hears the verdict on their own work, for
          // every stage where STAGE_AUDIENCE names them. Assessors work in the
          // field, not in the console, so the in-app notification above is the
          // record and this is the message that actually reaches them.
          //
          // The `infoRequired` stage is deliberately NOT emailed from here:
          // requestInfo sends that one itself, where the flagged count and the
          // response deadline are known (see its header), and a second send would
          // double up. That leaves the two OUTCOME stages, which the stage bus
          // knows everything about.
          if (
            (after === 'readyForRelease' || after === 'released') &&
            assignedAssessorUid !== undefined
          ) {
            const assessor = members[assignedAssessorUid];
            const assessorEmail = assessor?.email?.trim();
            if (
              assessor?.status !== 'active' ||
              !assessorEmail ||
              // ABSENT means on: only an explicit false quietens the category, and
              // it quietens the EMAIL alone - the in-app notification always sent.
              assessor.emailPreferences?.assessmentOutcome === false ||
              emailedAdmins.has(assessorEmail.toLowerCase())
            ) {
              logger.info('Assessor stage email skipped', { stage: after });
            } else {
              // Who acted. acceptAssessment CLAIMS the status first and stamps
              // workflow.validatedBy in a following update, so the snapshot this
              // trigger fired on can predate it - one fresh read is the honest way
              // to name the auditor. The released stage already confirmed its own
              // payload above, so its actor is in hand. Either may still be
              // unknown, and the copy simply omits the name when it is.
              let actedByUid = releasedByUid;
              if (after === 'readyForRelease') {
                const workflowSnap = await db
                  .ref(`${envPaths.db.assessment(orgId, assessmentId)}/workflow`)
                  .get();
                actedByUid = (
                  workflowSnap.val() as Assessment['workflow'] | null
                )?.validatedBy;
              }
              const actedByName =
                actedByUid !== undefined ? members[actedByUid]?.name : undefined;

              // The customer names WHOSE building this was, which is how an
              // assessor with a full week tells one assessment from another.
              const customerSnap = await db
                .ref(envPaths.db.customer(orgId, assessment.customerId))
                .get();
              const customerName = (customerSnap.val() as Customer | null)?.name;

              const accepted = after === 'readyForRelease';
              const by = actedByName ? ` by ${actedByName}` : '';
              const body = accepted
                ? `Your fire risk assessment of ${buildingName} has been reviewed and accepted${by}. It is cleared for release.`
                : `Your fire risk assessment of ${buildingName} has been released${by}, and its report has gone to the customer.`;
              // One kind covers both verdicts, with the sentences supplied
              // exactly as computed here (the catalogue's outcome variables).
              // The log entry now carries the catalogue's unified 'released'
              // category for BOTH verdicts, where this site used to log
              // 'assessment-accepted' / 'assessment-released' - intended: the
              // kindId is the precise identifier now, and the log UI tolerates
              // any category string.
              await deliverKindEmail(
                {
                  kind: 'released-assessor',
                  env: envPaths.env,
                  orgId,
                  to: assessorEmail,
                  variables: {
                    'building.name': buildingName,
                    'assessment.outcomePhrase': accepted
                      ? 'accepted'
                      : 'released',
                    'assessment.outcomeSummary': body,
                    'assessment.outcomeDetail': accepted
                      ? 'Nothing further is needed from you. You will hear again when it is released.'
                      : 'This assessment is now complete. Its report stays on the job record if you need to refer back to it.',
                  },
                  brand,
                  // The job is the assessor's own view of this work (/app/validation
                  // is the auditors' queue, which an assessor has no business landing
                  // in) - the requestInfo precedent.
                  kindLink: `${WEB_ORIGIN}/app/jobs/${assessment.jobId}`,
                  kindRows: [
                    { label: 'Building', value: buildingName },
                    ...(customerName
                      ? [{ label: 'Customer', value: customerName }]
                      : []),
                    { label: 'Stage', value: stageLabel },
                    ...(actedByName
                      ? [
                          {
                            label: accepted ? 'Accepted by' : 'Released by',
                            value: actedByName,
                          },
                        ]
                      : []),
                    { label: 'When', value: formatWhen(Date.now()) },
                  ],
                  // An assessor who submitted a week's work hears both verdicts
                  // across a day, so the digest line has to say WHICH this was -
                  // 'accepted, nothing more to do' and 'released, it is finished'
                  // are different news about the same building.
                  digestRow: {
                    label: buildingName,
                    value: accepted ? 'Accepted' : 'Released',
                  },
                },
                logger,
              );
            }
          }
        } catch (emailError) {
          logger.error('Stage emails failed', {
            stage: after,
            reason:
              emailError instanceof Error
                ? emailError.message
                : String(emailError),
          });
        }
      }

      logger.info('Stage event emitted', { from: before ?? null, to: after });
    } catch (caught) {
      logTriggerError(logger, caught);
      throw caught;
    }
  },
);
