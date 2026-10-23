// ============================================================================
// changeAssessmentTemplate (callable, the assessor on the job).
//
// An assessor who has opened the wrong assessment type - a PAS 79 job that
// should have been BS 9792, say - can switch the template rather than abandoning
// the visit and asking the office to raise a new job.
//
// IT DELETES EVERY ANSWER. Question ids are template-specific: answers recorded
// against the old set cannot be mapped onto the new one, and keeping them would
// silently attach the previous template's evidence (photos, findings, flags) to
// questions that never asked for it. Wiping is the only honest outcome, which is
// why the app warns first and this returns the count it removed.
//
// WHY A CALLABLE: `templateSnapshot` is deliberately not client-writable after
// creation (the rules let an assessor write only narrative, responsibleParty and
// manualRiskLevel), because the snapshot is what the report and the validation
// screens render. Going through here means the swap, the answer wipe, the job's
// pinned template and the audit entry all land in ONE update - the assessment can
// never be left describing one template while its answers belong to another.
//
// SCOPE: only while the assessment is still `inProgress`. Once it has been
// submitted it belongs to an auditor, and changing the question set underneath a
// review - or after release, under a published report - is not a thing an
// assessor may do.
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
  getLiveClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import type {
  Assessment,
  AssessmentAnswer,
  ChangeAssessmentTemplateInput,
  ChangeAssessmentTemplateResult,
  Job,
  Keyed,
  Template,
} from '../shared/types';

export const changeAssessmentTemplate = onCall<ChangeAssessmentTemplateInput>(
  callableOptions,
  (request) =>
    runCallable<ChangeAssessmentTemplateResult>(
      createLogger({ fn: 'changeAssessmentTemplate' }),
      async () => {
        // 1. Attestation, identity, rate limit.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'changeAssessmentTemplate');
        const claims = await getLiveClaims(request);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;
        const logger = createLogger({ fn: 'changeAssessmentTemplate', orgId });

        // 2. Validate input. Both ids are interpolated into database paths, so
        // they are validated as KEYS: a value carrying '/' would address a node
        // one level deeper than intended.
        const input = assertObject(request.data);
        const assessmentId = requireDbKey(
          input,
          'assessmentId',
          TEXT_LIMITS.shortText,
        );
        const templateId = requireDbKey(
          input,
          'templateId',
          TEXT_LIMITS.shortText,
        );

        // 3. Load the assessment and authorise against the originating job's
        // assessor - holding the assessor role is not enough, it must be their
        // work.
        const assessmentPath = paths.db.assessment(orgId, assessmentId);
        const assessmentSnap = await db.ref(assessmentPath).get();
        if (!assessmentSnap.exists()) {
          throw fail.notFound('This assessment could not be found.');
        }
        const assessment = assessmentSnap.val() as Assessment;

        const jobSnap = await db
          .ref(paths.db.job(orgId, assessment.jobId))
          .get();
        if (!jobSnap.exists()) {
          throw fail.failedPrecondition('The originating job is missing.');
        }
        const job = jobSnap.val() as Job;
        assertAssessorOnJob(claims, uid, job.assessorUid);

        if (assessment.status !== 'inProgress') {
          throw fail.failedPrecondition(
            'The template can only be changed while the assessment is still in progress.',
            { status: assessment.status },
          );
        }
        if (job.status === 'cancelled' || job.status === 'released') {
          throw fail.failedPrecondition(
            'This job is closed, so its assessment cannot be changed.',
            { status: job.status },
          );
        }

        // 4. The target template must exist and be PUBLISHED - an assessment may
        // never be conducted against a draft or archived question set.
        const templateSnap = await db
          .ref(paths.db.template(orgId, templateId))
          .get();
        if (!templateSnap.exists()) {
          throw fail.notFound('That template could not be found.', {
            field: 'templateId',
          });
        }
        const template = templateSnap.val() as Template;
        if (template.status !== 'published') {
          throw fail.failedPrecondition(
            'That template is not published, so an assessment cannot be conducted against it.',
            { field: 'templateId', status: template.status },
          );
        }
        if (templateId === job.templateId) {
          throw fail.invalidArgument(
            'This assessment already uses that template.',
            { field: 'templateId' },
          );
        }

        // 5. Count what is about to be destroyed, so the app can tell the
        // assessor exactly what happened rather than "some answers".
        const answersPath = paths.db.assessmentAnswers(orgId, assessmentId);
        const answersSnap = await db.ref(answersPath).get();
        const answers =
          (answersSnap.val() as Keyed<AssessmentAnswer> | null) ?? {};
        const answersRemoved = Object.keys(answers).length;

        // 6. ONE multi-location update. The snapshot, the wipe, the job's pin and
        // the audit entry are one fact about this assessment; committing them
        // separately could leave answers from a template the assessment no longer
        // claims to be using.
        await db.ref().update({
          [`${assessmentPath}/templateSnapshot`]: template,
          [answersPath]: null,
          [`${paths.db.job(orgId, assessment.jobId)}/templateId`]: templateId,
          [`${paths.db.job(orgId, assessment.jobId)}/templateVersion`]:
            template.version,
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            // The detail suffix is the established shape for a qualified action
            // (see humaniseActivity): the trail names WHICH template it became.
            action: `assessment.templateChanged (${template.name})`,
            target: assessmentId,
          }),
        });

        logger.info('Assessment template changed', {
          assessmentId,
          templateId,
          answersRemoved,
        });

        return {
          templateName: template.name,
          templateVersion: template.version,
          answersRemoved,
        };
      },
    ),
);
