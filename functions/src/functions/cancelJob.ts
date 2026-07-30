// ============================================================================
// cancelJob (callable, admin-only) - FR-E17 jobs administration.
//
// An admin withdraws a scheduled visit. The job is CANCELLED, never deleted:
// the record (and any assessment already started against it) is history that
// the audit trail, the log book and the customer's timeline may reference. Any
// started assessment is deliberately left untouched - the work done to date is
// preserved exactly as it stood, and the rules already stop a cancelled job's
// assessment progressing (startAssessment refuses a cancelled job). The status,
// the /assessorJobs index value and the /activity entry land in ONE
// multi-location update; the assessor is then told, with the admin's reason
// when one was given - in-app AND by branded email (lib/jobEmails), because a
// cancellation the assessor never sees is the one that sends them across the
// county to a visit that is not happening; their own `jobScheduled` preference
// silences the email only.
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
  getClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireString, optionalString, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { sendNotification } from '../lib/notifications';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { sendJobChangeEmail, sendVisitCustomerEmails } from '../lib/jobEmails';
import type {
  CancelJobInput,
  CancelJobResult,
  Building,
  Job,
} from '../shared/types';

export const cancelJob = onCall<CancelJobInput>(
  // The cancellation email needs the provider secret mounted; without it the
  // send degrades to a logged intent (lib/email), never an error.
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
  runCallable<CancelJobResult>(
    createLogger({ fn: 'cancelJob' }),
    async () => {
      // 1. Attestation, identity, authorisation.
      assertAppCheck(request);
      const { uid } = assertAuth(request);
      await assertRateLimit(uid, 'cancelJob');
      const claims = getClaims(request);
      assertOrgRole(claims, 'admin');
      const { paths } = envFor(claims);
      const orgId = claims.orgId;

      // 2. Validate input. The reason is optional free text for the assessor.
      const input = assertObject(request.data);
      const jobId = requireString(input, 'jobId', TEXT_LIMITS.shortText);
      const reason = optionalString(input, 'reason', TEXT_LIMITS.freeText);

      // 3. The job must exist (env-scoped path = tenancy) and still be
      // cancellable: cancelling twice is a client bug, and a released job is a
      // completed piece of statutory history that cannot be withdrawn.
      const jobSnap = await db.ref(paths.db.job(orgId, jobId)).get();
      if (!jobSnap.exists()) {
        throw fail.notFound('This job could not be found.', { field: 'jobId' });
      }
      const job = jobSnap.val() as Job;
      if (job.status === 'cancelled' || job.status === 'released') {
        throw fail.failedPrecondition(
          job.status === 'cancelled'
            ? 'This job is already cancelled.'
            : 'A released job cannot be cancelled.',
          { status: job.status },
        );
      }

      // 4. Cancel atomically: status, index mirror and audit entry in one
      // update. Any started assessment is NOT touched (see header) - its record
      // and answers stay exactly as the assessor left them.
      const update: Record<string, unknown> = {
        [`${paths.db.job(orgId, jobId)}/status`]: 'cancelled',
        [paths.db.assessorJob(orgId, job.assessorUid, jobId)]: 'cancelled',
        ...activityUpdate(paths, orgId, {
          actorUid: uid,
          action: 'job.cancelled',
          target: jobId,
        }),
      };
      await db.ref().update(update);

      // 5. Tell the assessor, naming the building and passing on the reason -
      // the same in-app + best-effort push path as assignment (createJob).
      const logger = createLogger({ fn: 'cancelJob', orgId });
      const buildingSnap = await db
        .ref(paths.db.building(orgId, job.siteId, job.buildingId))
        .get();
      const building = buildingSnap.val() as Building | null;
      const where = building?.name ?? 'a building';

      await sendNotification(
        paths,
        orgId,
        job.assessorUid,
        {
          type: 'jobCancelled',
          title: 'Job cancelled',
          body: reason
            ? `Your assessment at ${where} has been cancelled: ${reason}`
            : `Your assessment at ${where} has been cancelled.`,
          link: `safentia://job/${jobId}`,
        },
        logger,
      );
      // And by email: a cancellation the assessor does not see is the one that
      // sends them across the county to a visit that is not happening. The
      // reason travels as its own paragraph so it reads as the admin's words.
      await sendJobChangeEmail(
        paths,
        orgId,
        job.assessorUid,
        {
          jobId,
          buildingName: where,
          customerId: job.customerId,
          scheduledFor: job.scheduledFor,
          scheduledUntil: job.scheduledUntil,
          subject: `Job cancelled: ${where}`,
          heading: 'A job has been cancelled',
          body: `Your assessment at ${where} has been cancelled, so there is nothing to attend.`,
          extraParagraphs: reason ? [`Reason given: ${reason}`] : undefined,
          dateLabel: 'Was scheduled for',
        },
        logger,
      );
      // The customer is told too, with the admin's reason where there is one: a
      // duty-holder who has arranged access, or warned their tenants, is owed
      // the news that nobody is coming after all.
      await sendVisitCustomerEmails(
        paths,
        orgId,
        {
          jobId,
          customerId: job.customerId,
          siteId: job.siteId,
          buildingId: job.buildingId,
          buildingName: where,
          assessorUid: job.assessorUid,
          scheduledFor: job.scheduledFor,
          scheduledUntil: job.scheduledUntil,
          kind: 'cancelled',
          reason,
        },
        logger,
      );

      logger.info('Job cancelled', { jobId });
      return { cancelled: true };
    },
  ),
);
