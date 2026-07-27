// ============================================================================
// startAssessment (callable, assessor-on-this-job only) - brief 4.5 #5, 1039.
//
// One tap starts (or resumes) the assessment for a job. The hard requirement is
// IDEMPOTENCE: re-opening a job must resume the SAME assessment, never create a
// duplicate (1039 AC). We achieve this by deriving the assessment id from the job
// id, so "the assessment for this job" has exactly one address.
//
// Flow:
//   1. App Check + auth + assessor-on-THIS-job (holding the assessor role is not
//      enough; the caller must be the assigned assessor - row-level check).
//   2. Load the job; reject if cancelled/released (cannot start work on it).
//   3. If the assessment already exists, return it with resumed:true.
//   4. Otherwise create it from the job's PINNED template version as the
//      templateSnapshot, stamp the responsible party inherited from the
//      building, and move the job to inProgress - atomically, so the job status
//      and the assessment are never out of step (brief 18.3).
//
// The party stamp mirrors onAssessmentCreate (the offline-first path's server
// reconciler): both routes into existence must persist the SAME inherited
// default, or which route an assessment took would decide whether its
// responsible party was ever recorded.
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
import { resolveResponsibleParty } from '../lib/responsibleParty';
import type {
  StartAssessmentInput,
  StartAssessmentResult,
  Building,
  Job,
  Template,
  Assessment,
} from '../shared/types';

/**
 * Deterministic assessment id for a job. Deriving the id from the job id is what
 * makes start idempotent: two concurrent taps both target the same node, and a
 * resume re-finds it, so a job can never spawn two assessments (1039 AC).
 */
function assessmentIdForJob(jobId: string): string {
  return `job-${jobId}`;
}

export const startAssessment = onCall<StartAssessmentInput>(
  callableOptions,
  (request) =>
    runCallable<StartAssessmentResult>(
      createLogger({ fn: 'startAssessment' }),
      async () => {
        // 1. Attestation + identity.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'startAssessment');
        const claims = getClaims(request);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        const input = assertObject(request.data);
        const jobId = requireString(input, 'jobId', TEXT_LIMITS.shortText);

        // 2. Load the job and confirm the caller is its assigned assessor.
        const jobSnap = await db.ref(paths.db.job(orgId, jobId)).get();
        if (!jobSnap.exists()) {
          throw fail.notFound('This job could not be found.');
        }
        const job = jobSnap.val() as Job;
        assertAssessorOnJob(claims, uid, job.assessorUid);

        if (job.status === 'cancelled' || job.status === 'released') {
          throw fail.failedPrecondition(
            'This job is closed and cannot be started.',
            { status: job.status },
          );
        }

        const assessmentId = assessmentIdForJob(jobId);
        const assessmentRef = db.ref(paths.db.assessment(orgId, assessmentId));

        // 3. Resume if it already exists - never duplicate (the core guarantee).
        const existingSnap = await assessmentRef.get();
        if (existingSnap.exists()) {
          const logger = createLogger({ fn: 'startAssessment', orgId });
          logger.info('Resumed existing assessment', { jobId, assessmentId });
          return { assessmentId, resumed: true };
        }

        // 4a. Load the PINNED template version as the snapshot. We re-read the
        // template and confirm the pinned version still matches, so the assessment
        // captures the exact shape the job was created with (1031 / 1039).
        const templateSnap = await db
          .ref(paths.db.template(orgId, job.templateId))
          .get();
        if (!templateSnap.exists()) {
          throw fail.failedPrecondition(
            'The job template is no longer available.',
          );
        }
        const template = templateSnap.val() as Template;
        if (template.version !== job.templateVersion) {
          // Defensive: a published template version is immutable, so this should
          // never happen; if it does, refuse rather than snapshot the wrong shape.
          throw fail.failedPrecondition(
            'The pinned template version could not be loaded.',
            { pinned: job.templateVersion, current: template.version },
          );
        }

        // 4b. Resolve the responsible party the assessment inherits from its
        // building, so the default is PERSISTED at birth rather than re-derived
        // by each reader (the report, the action plan and the portal all read
        // the stored record). The job knows the site, so this is one targeted
        // read. Best-effort by design: a building record that has gone missing
        // must not stop an assessor starting work, so an absent building simply
        // leaves the field unset and the read-time fallbacks still apply.
        const buildingSnap = await db
          .ref(paths.db.building(orgId, job.siteId, job.buildingId))
          .get();
        const party = resolveResponsibleParty(
          undefined,
          buildingSnap.val() as Building | null,
        );

        // 4c. Atomic create: the assessment AND the job status move together.
        const now = Date.now();
        const assessment: Assessment = {
          jobId,
          buildingId: job.buildingId,
          customerId: job.customerId,
          templateSnapshot: template,
          conductedBy: uid,
          conductedAt: now,
          // RTDB rejects undefined, so the party is spread in only when the
          // building actually names one.
          ...(party !== undefined ? { responsibleParty: party } : {}),
          status: 'inProgress',
        };
        const update: Record<string, unknown> = {
          [paths.db.assessment(orgId, assessmentId)]: assessment,
          [`${paths.db.job(orgId, jobId)}/status`]: 'inProgress',
          [paths.db.assessorJob(orgId, uid, jobId)]: 'inProgress',
        };
        await db.ref().update(update);

        const logger = createLogger({ fn: 'startAssessment', orgId });
        logger.info('Created assessment from pinned template', {
          jobId,
          assessmentId,
        });
        return { assessmentId, resumed: false };
      },
    ),
);
