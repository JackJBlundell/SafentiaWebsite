// ============================================================================
// acceptAssessment (callable, auditor) - FR-E18 auditor lifecycle, story 1051.
//
// The auditor signs the assessment off as validated: readyForValidation ->
// readyForRelease, stamping workflow.checkedBy / validatedBy / acceptedAt. An
// assessment carrying an UNRESOLVED InfoRequest cannot be accepted: once info
// has been requested the work must come back through the assessor's response
// and resubmission (submitAssessment allows infoRequired -> readyForValidation),
// so the audit trail always shows the query answered before sign-off. Status,
// workflow, job + index mirrors and the /activity entry land in ONE update; the
// assessor's "cleared for release" notification fires from
// onAssessmentStageChange, so nothing is sent here.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getLiveClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import type {
  AcceptAssessmentInput,
  AcceptAssessmentResult,
  Assessment,
  AssessmentAnswer,
  AssessmentStatus,
  Job,
  Keyed,
} from '../shared/types';

export const acceptAssessment = onCall<AcceptAssessmentInput>(
  callableOptions,
  (request) =>
    runCallable<AcceptAssessmentResult>(
      createLogger({ fn: 'acceptAssessment' }),
      async () => {
        // 1. Attestation, identity, authorisation. Validation may be performed
        // by an auditor OR an admin, consistent with requestInfo and
        // releaseAssessment (an admin holds oversight of the whole workflow).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'acceptAssessment');
        const claims = await getLiveClaims(request);
        assertOrgRole(claims, ['admin', 'auditor']);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        const input = assertObject(request.data);
        const assessmentId = requireDbKey(
          input,
          'assessmentId',
          TEXT_LIMITS.shortText,
        );

        // 2. The assessment must exist in the caller's org and be awaiting
        // validation. An infoRequired assessment is with the ASSESSOR - it must
        // come back through resubmission before it can be accepted.
        const assessmentSnap = await db
          .ref(paths.db.assessment(orgId, assessmentId))
          .get();
        if (!assessmentSnap.exists()) {
          throw fail.notFound('This assessment could not be found.');
        }
        const assessment = assessmentSnap.val() as Assessment;
        if (assessment.status !== 'readyForValidation') {
          throw fail.failedPrecondition(
            'Only an assessment awaiting validation can be accepted.',
            { status: assessment.status },
          );
        }

        // 2b. No unanswered InfoRequest may remain: a query the assessor has
        // not answered means the validation conversation is still open, however
        // the status got back here. "Open" means the request has NO response -
        // resolvedAt is deliberately not the test, because the client stamps it
        // advisorily alongside the reply and a client-supplied timestamp is
        // never trusted as the resolution of record; acceptance below stamps
        // the authoritative one. The offending questions are named so the
        // auditor can see exactly what is outstanding.
        const answersSnap = await db
          .ref(paths.db.assessmentAnswers(orgId, assessmentId))
          .get();
        const answers =
          (answersSnap.val() as Keyed<AssessmentAnswer> | null) ?? {};
        const unresolved = Object.entries(answers)
          .filter(
            ([, answer]) => answer?.infoRequest && !answer.infoRequest.response,
          )
          .map(([questionId]) => questionId);
        if (unresolved.length > 0) {
          throw fail.failedPrecondition(
            'This assessment still has unanswered information requests.',
            { unresolved },
          );
        }

        // The job carries the assessor whose index entry mirrors the status.
        const jobSnap = await db
          .ref(paths.db.job(orgId, assessment.jobId))
          .get();
        if (!jobSnap.exists()) {
          throw fail.failedPrecondition('The originating job is missing.');
        }
        const job = jobSnap.val() as Job;

        // 3. CLAIM the acceptance transactionally: readyForValidation ->
        // readyForRelease, aborting on anything else. The step-2 status check
        // is a fast-path courtesy - between it and this write a concurrent
        // accept or requestInfo may have moved the status, and a plain update
        // would stamp over it (the updateMember/acceptInvitation posture).
        const statusRef = db.ref(paths.db.assessmentStatus(orgId, assessmentId));
        const claim = await statusRef.transaction(
          // The Admin SDK runs this FIRST against the locally cached value, which
          // is null in a fresh (deployed) function instance with no listener on
          // this path. Returning undefined on that initial null aborts the whole
          // transaction BEFORE the server value is ever consulted (proven: even a
          // server value of readyForValidation aborted). Treating the uncached
          // null as "proceed" forces the server round-trip; the SDK then re-runs
          // against the REAL server value, which step 2 already confirmed is
          // readyForValidation, so a genuine concurrent move to any other status
          // still aborts here.
          (current: AssessmentStatus | null) =>
            current === null || current === 'readyForValidation'
              ? ('readyForRelease' as const)
              : undefined,
        );
        if (!claim.committed) {
          throw fail.failedPrecondition(
            'Only an assessment awaiting validation can be accepted.',
            { status: (claim.snapshot?.val() as string | null) ?? 'unknown' },
          );
        }

        // 3b. The payload update (the status is already claimed above, so it
        // is NOT repeated here): workflow attribution + timestamp, the
        // job/index mirrors and the audit entry. checkedBy is (re)stamped
        // alongside validatedBy: the accepting auditor checked the final
        // content, whoever raised an earlier query round.
        const now = Date.now();
        const assessmentPath = paths.db.assessment(orgId, assessmentId);
        const update: Record<string, unknown> = {
          [`${assessmentPath}/workflow/checkedBy`]: uid,
          [`${assessmentPath}/workflow/validatedBy`]: uid,
          [`${assessmentPath}/workflow/acceptedAt`]: now,
          [`${paths.db.job(orgId, assessment.jobId)}/status`]: 'readyForRelease',
          [paths.db.assessorJob(orgId, job.assessorUid, assessment.jobId)]:
            'readyForRelease',
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: 'assessment.accepted',
            target: assessmentId,
          }),
        };
        // Server-authoritative InfoRequest resolution: acceptance IS the moment
        // every answered query is settled (the auditor signing off has read the
        // replies), so each responded request gets resolvedAt stamped HERE -
        // whatever advisory timestamp the client wrote when the assessor
        // replied. Lifecycle: requestInfo mints the request (server), the
        // assessor writes response/respondedAt (client), acceptance resolves
        // it (server).
        for (const [questionId, answer] of Object.entries(answers)) {
          if (answer?.infoRequest?.response) {
            update[
              `${paths.db.assessmentAnswer(orgId, assessmentId, questionId)}/infoRequest/resolvedAt`
            ] = now;
          }
        }
        try {
          await db.ref().update(update);
        } catch (error) {
          // The claim landed but the payload did not: put the status back so
          // the acceptance can be retried rather than stranding a half-accepted
          // assessment. Best-effort (acceptInvitation posture).
          await statusRef.set('readyForValidation').catch(() => undefined);
          throw error;
        }

        // The assessor's notification fires from onAssessmentStageChange on
        // this transition (see header).
        const logger = createLogger({ fn: 'acceptAssessment', orgId });
        logger.info('Assessment accepted', { assessmentId });
        return { accepted: true };
      },
    ),
);
