// ============================================================================
// submitAssessment (callable, assessor-only) - brief 4.5 #6, story 1049.
//
// The assessor submits a completed assessment for validation. The server is the
// authority: it RE-VALIDATES required answers, mandatory photos and the
// service-schedule step (the same checks the app shows), so an incomplete
// assessment can never reach an auditor even from a tampered or offline-synced
// client (brief 18.4). On success it sets status readyForValidation, writes the
// activity + log-book trail, and notifies the org's auditors. Direct client status
// writes are denied by rules, forcing this path (1049 AC).
//
// onAssessmentStageChange (the trigger) fires off the status change and produces
// the cross-cutting stage events; this Function owns the assessor-side gate and
// the submit-specific notification.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertAssessorOnJob,
  getClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireString, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { findMissingForSubmission } from '../lib/assessmentChecks';
import { appendActivity } from '../lib/events';
import { sendNotification } from '../lib/notifications';
import type {
  SubmitAssessmentInput,
  SubmitAssessmentResult,
  Assessment,
  AssessmentAnswer,
  Building,
  Job,
  OrgMember,
  Keyed,
} from '../shared/types';

export const submitAssessment = onCall<SubmitAssessmentInput>(
  callableOptions,
  (request) =>
    runCallable<SubmitAssessmentResult>(
      createLogger({ fn: 'submitAssessment' }),
      async () => {
        // 1. Attestation + identity.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'submitAssessment');
        const claims = getClaims(request);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        const input = assertObject(request.data);
        const assessmentId = requireString(
          input,
          'assessmentId',
          TEXT_LIMITS.shortText,
        );

        // 2. Load the assessment and confirm the caller conducted it (the assessor
        // -on-this-work check via the originating job's assessor).
        const assessmentSnap = await db
          .ref(paths.db.assessment(orgId, assessmentId))
          .get();
        if (!assessmentSnap.exists()) {
          throw fail.notFound('This assessment could not be found.');
        }
        const assessment = assessmentSnap.val() as Assessment;

        // The job pins the assigned assessor; we authorise against it so submission
        // is locked to the assigned assessor, not merely anyone holding the role.
        const jobSnap = await db
          .ref(paths.db.job(orgId, assessment.jobId))
          .get();
        if (!jobSnap.exists()) {
          throw fail.failedPrecondition('The originating job is missing.');
        }
        const job = jobSnap.val() as Job;
        assertAssessorOnJob(claims, uid, job.assessorUid);
        // PRODUCT DECISION (2026-07): a submission against a CANCELLED job is
        // deliberately ALLOWED. The assessor may have completed the survey on
        // site (possibly offline) before the office cancelled the job, and that
        // fieldwork is real evidence that must not be discarded at the door.
        // The validation queue surfaces the mismatch instead: the assessment
        // record carries `jobId`, so the console joins to the job's status and
        // badges the entry as "job cancelled" for the auditor to judge. No
        // server-side gate here is intentional, not an omission. (Note that a
        // brand-new assessment on a cancelled job is still blocked at creation
        // by the assessments rules; this covers work already in flight.)

        // Only an in-progress (or info-required, on resubmit) assessment may be
        // submitted, so a double-submit or a submit after release is refused.
        if (
          assessment.status !== 'inProgress' &&
          assessment.status !== 'infoRequired'
        ) {
          throw fail.failedPrecondition(
            'This assessment is not in a submittable state.',
            { status: assessment.status },
          );
        }

        // 3. Re-validate completeness server-side. We need the answers and the
        // building (for the service-schedule check).
        const answersSnap = await db
          .ref(paths.db.assessmentAnswers(orgId, assessmentId))
          .get();
        const answers = answersSnap.val() as Keyed<AssessmentAnswer> | null;

        // The building sits under its site; the job carries the site id.
        const buildingSnap = await db
          .ref(paths.db.building(orgId, job.siteId, assessment.buildingId))
          .get();
        const building = buildingSnap.val() as Building | null;

        const missing = findMissingForSubmission(
          assessment.templateSnapshot,
          answers,
          building,
        );
        if (missing.length > 0) {
          // Structured so the UI can list exactly what is outstanding (1049 AC).
          throw fail.failedPrecondition(
            'This assessment cannot be submitted while items are outstanding.',
            { missing },
          );
        }

        // 4. Transition to readyForValidation atomically, stamping the workflow.
        // The trigger reacts to the status field for the cross-cutting stage events;
        // here we own the precise submission write and its workflow timestamp.
        const now = Date.now();
        const update: Record<string, unknown> = {
          [paths.db.assessmentStatus(orgId, assessmentId)]: 'readyForValidation',
          [`${paths.db.assessment(orgId, assessmentId)}/workflow/submittedAt`]: now,
          [`${paths.db.job(orgId, assessment.jobId)}/status`]: 'readyForValidation',
          [paths.db.assessorJob(orgId, job.assessorUid, assessment.jobId)]:
            'readyForValidation',
        };
        await db.ref().update(update);

        const logger = createLogger({ fn: 'submitAssessment', orgId });

        // Activity trail (append-only). target is the assessment for traceability.
        await appendActivity(paths, orgId, {
          actorUid: uid,
          action: 'assessment.submitted',
          target: assessmentId,
        });

        // 5. Notify auditors. We notify every active auditor in the org so the
        // validation queue is picked up promptly; auditor and assessor may be the
        // same person (multi-role), which is fine - they simply see their own item.
        const membersSnap = await db.ref(paths.db.orgMembers(orgId)).get();
        const members = (membersSnap.val() as Keyed<OrgMember> | null) ?? {};
        const auditorUids = Object.entries(members)
          .filter(
            ([, m]) => m.status === 'active' && m.roles?.auditor === true,
          )
          .map(([memberUid]) => memberUid);

        for (const auditorUid of auditorUids) {
          await sendNotification(
            paths,
            orgId,
            auditorUid,
            {
              type: 'assessmentReadyForValidation',
              title: 'Assessment ready for validation',
              body: 'An assessment has been submitted and is ready for validation.',
              link: `safentia://assessment/${assessmentId}`,
            },
            logger,
          );
        }

        logger.info('Assessment submitted for validation', {
          assessmentId,
          auditorsNotified: auditorUids.length,
        });

        return { status: 'readyForValidation' };
      },
    ),
);
