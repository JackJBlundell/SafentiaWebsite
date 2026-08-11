// ============================================================================
// createJob (callable, admin-only) - brief 4.5 #4, stories 1040 / 1034.
//
// The ONLY path that creates a job; direct client writes to /jobs are denied by
// rules, so a job can never be malformed or created by an unauthorised user (1040).
// We:
//   1. Enforce App Check, auth and the admin role.
//   2. Validate the input shape and timestamp.
//   3. Verify the referenced template EXISTS and is PUBLISHED at the requested
//      version (a job pins {templateId, templateVersion} - story 1031), the
//      building EXISTS, and the named assessor actually HOLDS the assessor role
//      (the union model: their member record carries assessor:true). Each failure
//      is a distinct structured error so the UI can point at the cause (1040 AC).
//   4. Write /jobs and the /assessorJobs index atomically (one update) so the
//      index can never drift from the job.
//   5. Notify the assessor (in-app + best-effort push) so assignment lands within
//      seconds and tapping it deep-links to the job (1034). The notification names
//      the scheduled day - and calls out a SAME-DAY booking specifically, since the
//      07:00 "jobs due today" digest has already run by the time most of them land.
//      A branded email goes alongside (lib/jobEmails), because an assessor who has
//      not opened the app has no other way to learn their diary changed; their own
//      `jobScheduled` preference silences that email and nothing else.
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
import { assertObject, requireString, requireTimestamp, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { assertNotSuspended, resolvePlanContext } from '../lib/planContext';
import { assertValidSlot, assertNoSlotClash } from '../lib/jobSlots';
import { sendNotification } from '../lib/notifications';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { sendJobChangeEmail, sendVisitCustomerEmails } from '../lib/jobEmails';
import { isUkToday, ukWhenPhrase } from '../lib/ukCalendar';
import type {
  CreateJobInput,
  CreateJobResult,
  Job,
  Template,
  Building,
  OrgMember,
} from '../shared/types';

export const createJob = onCall<CreateJobInput>(
  // The assignment email needs the provider secret mounted; without it the
  // send degrades to a logged intent (lib/email), never an error.
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
  runCallable<CreateJobResult>(
    createLogger({ fn: 'createJob' }),
    async () => {
      // 1. Attestation, identity, authorisation.
      assertAppCheck(request);
      const { uid } = assertAuth(request);
      await assertRateLimit(uid, 'createJob');
      const claims = getClaims(request);
      assertOrgRole(claims, 'admin');
      const { paths } = envFor(claims);
      const orgId = claims.orgId;

      // 2. Validate input. Ids are short identifiers; scheduledFor is a timestamp.
      const input = assertObject(request.data);
      const templateId = requireString(input, 'templateId', TEXT_LIMITS.shortText);
      const templateVersion = requireTimestamp(
        // templateVersion is a positive integer like a timestamp - reuse the same
        // positive-integer guard so a non-integer or zero version is rejected.
        { templateVersion: input.templateVersion },
        'templateVersion',
      );
      const customerId = requireString(input, 'customerId', TEXT_LIMITS.shortText);
      const siteId = requireString(input, 'siteId', TEXT_LIMITS.shortText);
      const buildingId = requireString(input, 'buildingId', TEXT_LIMITS.shortText);
      const assessorUid = requireString(input, 'assessorUid', TEXT_LIMITS.shortText);
      const scheduledFor = requireTimestamp(input, 'scheduledFor');
      // Optional time slot (FR-E17). When present it must be well-formed (end
      // after start, same UTC day). Date-only jobs never clash (lib/jobSlots).
      const scheduledUntil =
        input.scheduledUntil !== undefined
          ? requireTimestamp(input, 'scheduledUntil')
          : undefined;
      if (scheduledUntil !== undefined) {
        assertValidSlot(scheduledFor, scheduledUntil);
      }

      // Suspension gate (Phase 3 §6.3 degrade policy): a dead subscription
      // blocks CREATES only - existing jobs, in-flight assessments and every
      // read stay untouched. Checked after validation so a malformed payload
      // still gets its precise validation error (the manageCustomer idiom),
      // and the caller here is always an admin, so the copy can point at
      // Billing directly.
      const { entitlements } = await resolvePlanContext(paths, orgId);
      assertNotSuspended(
        entitlements,
        'Your organisation’s subscription has ended, so new jobs cannot be created. Restart it from the Billing page to continue.',
      );

      // 3a. Template must exist and be PUBLISHED at the requested version (1031).
      const templateSnap = await db
        .ref(paths.db.template(orgId, templateId))
        .get();
      if (!templateSnap.exists()) {
        throw fail.notFound('The chosen template could not be found.', {
          field: 'templateId',
        });
      }
      const template = templateSnap.val() as Template;
      if (template.status !== 'published') {
        throw fail.failedPrecondition(
          'A job can only use a published template.',
          { field: 'templateId', status: template.status },
        );
      }
      if (template.version !== templateVersion) {
        // The version must match exactly: jobs pin the version they were created
        // with, and an assessment must never shift shape mid-flight (1031).
        throw fail.invalidArgument(
          'The selected template version is not available.',
          { field: 'templateVersion', available: template.version },
        );
      }

      // 3b. Building must exist (it sits under the site in the tenant tree).
      const buildingSnap = await db
        .ref(paths.db.building(orgId, siteId, buildingId))
        .get();
      if (!buildingSnap.exists()) {
        throw fail.notFound('The chosen building could not be found.', {
          field: 'buildingId',
        });
      }
      const building = buildingSnap.val() as Building;
      // The building's own customerId must match the job's, so a job cannot pin a
      // building to the wrong customer (data-integrity, brief 18.3).
      if (building.customerId !== customerId) {
        throw fail.invalidArgument(
          'The building does not belong to the chosen customer.',
          { field: 'buildingId' },
        );
      }

      // 3c. Assessor must be an active member holding the assessor role (1040 AC).
      const memberSnap = await db
        .ref(paths.db.orgMember(orgId, assessorUid))
        .get();
      if (!memberSnap.exists()) {
        throw fail.notFound('The chosen assessor is not a member of this organisation.', {
          field: 'assessorUid',
        });
      }
      const member = memberSnap.val() as OrgMember;
      if (member.status !== 'active' || member.roles?.assessor !== true) {
        throw fail.failedPrecondition(
          'The chosen person is not an active assessor.',
          { field: 'assessorUid' },
        );
      }

      // 3d. Slotted jobs must not overlap another slotted, non-cancelled visit
      // in the assessor's diary (FR-E17). The error names the conflicting
      // building and time so the admin can resolve it immediately.
      if (scheduledUntil !== undefined) {
        await assertNoSlotClash(
          paths,
          orgId,
          assessorUid,
          scheduledFor,
          scheduledUntil,
        );
      }

      // 4. Atomic write: the job and its assessor index together. push() on /jobs
      // yields the job id, which the index entry then references.
      const jobRef = db.ref(paths.db.jobs(orgId)).push();
      const jobId = jobRef.key as string;
      const job: Job = {
        templateId,
        templateVersion,
        customerId,
        siteId,
        buildingId,
        assessorUid,
        scheduledFor,
        // RTDB rejects undefined values, so the optional slot end is spread in
        // only when present.
        ...(scheduledUntil !== undefined ? { scheduledUntil } : {}),
        status: 'scheduled',
      };
      const update: Record<string, unknown> = {
        [paths.db.job(orgId, jobId)]: job,
        // The index value is the status, matching the schema (/assessorJobs index).
        [paths.db.assessorJob(orgId, assessorUid, jobId)]: 'scheduled',
      };
      await db.ref().update(update);

      // 5. Notify the assessor. Deep link opens the job detail cold (brief 9.3).
      //
      // The copy NAMES THE DAY. The morning "jobs due today" digest
      // (dailyJobReminders) runs at 07:00 and can only cover the diary as it stood
      // then, so a job booked into today at 11:00 has no other route to the
      // assessor - a bare "you have been assigned an assessment" reads identically
      // whether the visit is this afternoon or next month. Same-day assignments get
      // their own title too, so the push is recognisable as urgent on the lock
      // screen without being opened.
      const logger = createLogger({ fn: 'createJob', orgId });
      const today = isUkToday(scheduledFor);
      const when = ukWhenPhrase(scheduledFor, scheduledUntil);
      await sendNotification(
        paths,
        orgId,
        assessorUid,
        {
          type: today ? 'jobAssignedToday' : 'jobAssigned',
          title: today ? 'New job today' : 'New job assigned',
          body: `You have been assigned an assessment at ${building.name}, scheduled for ${when}.`,
          link: `safentia://job/${jobId}`,
        },
        logger,
      );
      // ...and the same news by email, for the assessor who has not opened the
      // app today. Best-effort and silent on the member's own opt-out; the
      // notification above is unconditional either way.
      await sendJobChangeEmail(
        paths,
        orgId,
        assessorUid,
        {
          kind: 'job-assigned',
          jobId,
          buildingName: building.name,
          customerId,
          scheduledFor,
          scheduledUntil,
          // The email's template names the DATE where the notification says
          // 'today': it is read hours or days after it lands, by which time a
          // relative phrase would be a lie. Only the same-day subject/heading
          // variance travels from here.
          subjectPhrase: today ? 'New job today' : 'New job assigned',
          headingPhrase: today
            ? 'A new job in your diary today'
            : 'A new job in your diary',
        },
        logger,
      );
      // ...and the CUSTOMER's contacts hear that someone is coming to their
      // building. Best-effort in exactly the same way: the job is written, and
      // a duty-holder who cannot be emailed must not undo that.
      await sendVisitCustomerEmails(
        paths,
        orgId,
        {
          jobId,
          customerId,
          siteId,
          buildingId,
          buildingName: building.name,
          assessorUid,
          scheduledFor,
          scheduledUntil,
          kind: 'scheduled',
        },
        logger,
      );

      logger.info('Job created', { jobId, assessorUid, today });
      return { jobId };
    },
  ),
);
