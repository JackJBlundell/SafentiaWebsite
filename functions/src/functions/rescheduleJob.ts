// ============================================================================
// rescheduleJob (callable, admin-only) - FR-E17 jobs administration.
//
// An admin moves a scheduled visit: a new date/slot, optionally a new assessor,
// or both. Being a callable buys what rules cannot express:
//   - the slot shape + per-assessor CLASH check (lib/jobSlots), excluding the
//     job's own current slot;
//   - an assessor move rewrites BOTH /assessorJobs index entries in the SAME
//     multi-location update as the job change, so the index can never drift;
//   - the /activity audit entry lands atomically with the change.
// A cancelled or released job cannot be rescheduled - the first is dead, the
// second is history. The (new) assessor is notified with what changed, and a
// replaced assessor is told the visit has left their diary (mirroring the
// createJob assignment notification path).
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
import { assertValidSlot, assertNoSlotClash } from '../lib/jobSlots';
import { activityUpdate } from '../lib/events';
import { sendNotification } from '../lib/notifications';
import { isUkToday, ukWhenPhrase } from '../lib/ukCalendar';
import type {
  RescheduleJobInput,
  RescheduleJobResult,
  Building,
  Job,
  OrgMember,
} from '../shared/types';

export const rescheduleJob = onCall<RescheduleJobInput>(callableOptions, (request) =>
  runCallable<RescheduleJobResult>(
    createLogger({ fn: 'rescheduleJob' }),
    async () => {
      // 1. Attestation, identity, authorisation.
      assertAppCheck(request);
      const { uid } = assertAuth(request);
      await assertRateLimit(uid, 'rescheduleJob');
      const claims = getClaims(request);
      assertOrgRole(claims, 'admin');
      const { paths } = envFor(claims);
      const orgId = claims.orgId;

      // 2. Validate input. The slot rules are the same as createJob's, shared
      // via lib/jobSlots so the two admin paths cannot drift.
      const input = assertObject(request.data);
      const jobId = requireString(input, 'jobId', TEXT_LIMITS.shortText);
      const scheduledFor = requireTimestamp(input, 'scheduledFor');
      const scheduledUntil =
        input.scheduledUntil !== undefined
          ? requireTimestamp(input, 'scheduledUntil')
          : undefined;
      if (scheduledUntil !== undefined) {
        assertValidSlot(scheduledFor, scheduledUntil);
      }
      const newAssessorUid =
        input.assessorUid !== undefined
          ? requireString(input, 'assessorUid', TEXT_LIMITS.shortText)
          : undefined;

      // 3. The job must exist in the caller's org (the env-scoped path IS the
      // tenancy check) and still be live: a cancelled job is dead, a released
      // one is history - neither may move.
      const jobSnap = await db.ref(paths.db.job(orgId, jobId)).get();
      if (!jobSnap.exists()) {
        throw fail.notFound('This job could not be found.', { field: 'jobId' });
      }
      const job = jobSnap.val() as Job;
      if (job.status === 'cancelled' || job.status === 'released') {
        throw fail.failedPrecondition(
          'A cancelled or released job cannot be rescheduled.',
          { status: job.status },
        );
      }

      // 3b. When moving the visit, the target must be an active member holding
      // the assessor role - the same gate createJob applies (1040 AC).
      const assessorUid = newAssessorUid ?? job.assessorUid;
      const assessorChanged = assessorUid !== job.assessorUid;
      if (assessorChanged) {
        // An in-flight assessment is owned by its conductor: once the visit has
        // started, handing the JOB to someone else would strand the conducting
        // assessor's work behind a job that no longer names them. Only a
        // not-yet-started job may change hands; time-only reschedules stay
        // allowed on in-flight statuses as before.
        if (job.status !== 'scheduled') {
          throw fail.failedPrecondition(
            "This job's assessment is already in progress; cancel and reschedule instead.",
            { status: job.status },
          );
        }
        const memberSnap = await db
          .ref(paths.db.orgMember(orgId, assessorUid))
          .get();
        const member = memberSnap.exists()
          ? (memberSnap.val() as OrgMember)
          : null;
        if (!member) {
          throw fail.notFound(
            'The chosen assessor is not a member of this organisation.',
            { field: 'assessorUid' },
          );
        }
        if (member.status !== 'active' || member.roles?.assessor !== true) {
          throw fail.failedPrecondition(
            'The chosen person is not an active assessor.',
            { field: 'assessorUid' },
          );
        }
      }

      // 3c. Clash check against the TARGET assessor's diary, excluding this
      // job's own current slot. Date-only reschedules never clash (jobSlots).
      if (scheduledUntil !== undefined) {
        await assertNoSlotClash(
          paths,
          orgId,
          assessorUid,
          scheduledFor,
          scheduledUntil,
          jobId,
        );
      }

      // 4. Apply everything atomically: the job fields, both index entries when
      // the assessor moves, and the audit entry. Writing null removes a slot end
      // when a slotted job is rescheduled to date-only.
      const changed: string[] = [];
      if (scheduledFor !== job.scheduledFor) changed.push('scheduledFor');
      if (scheduledUntil !== job.scheduledUntil) changed.push('scheduledUntil');
      if (assessorChanged) changed.push('assessor');

      const jobPath = paths.db.job(orgId, jobId);
      const update: Record<string, unknown> = {
        [`${jobPath}/scheduledFor`]: scheduledFor,
        [`${jobPath}/scheduledUntil`]: scheduledUntil ?? null,
        ...(assessorChanged
          ? {
              [`${jobPath}/assessorUid`]: assessorUid,
              // Rewrite BOTH index entries so the index can never drift: the old
              // assessor loses the entry, the new one gains it at the current
              // status (the index value is the status, matching createJob).
              [paths.db.assessorJob(orgId, job.assessorUid, jobId)]: null,
              [paths.db.assessorJob(orgId, assessorUid, jobId)]: job.status,
            }
          : {}),
        ...activityUpdate(paths, orgId, {
          actorUid: uid,
          action: `job.rescheduled (${changed.length > 0 ? changed.join(', ') : 'unchanged'})`,
          target: jobId,
        }),
      };
      await db.ref().update(update);

      // 5. Notify the assessor(s), naming the building and what changed - the
      // same in-app + best-effort push path createJob uses for assignment.
      const logger = createLogger({ fn: 'rescheduleJob', orgId });
      const buildingSnap = await db
        .ref(paths.db.building(orgId, job.siteId, job.buildingId))
        .get();
      const building = buildingSnap.val() as Building | null;
      const where = building?.name ?? 'a building';
      // UK product: name the date on the Europe/London wall clock the assessor
      // lives by, not a raw UTC slice that reads a day off around midnight BST.
      // 'today'/'tomorrow' rather than a bare date when it is one of those: a visit
      // moved INTO today missed the 07:00 digest, so this notification is the only
      // thing that tells the assessor their afternoon just changed - and the title
      // says so too, so it is legible without opening the app.
      const today = isUkToday(scheduledFor);
      const when = ukWhenPhrase(scheduledFor, scheduledUntil);

      await sendNotification(
        paths,
        orgId,
        assessorUid,
        {
          type: today ? 'jobRescheduledToday' : 'jobRescheduled',
          title: today
            ? assessorChanged
              ? 'Job assigned to you today'
              : 'Job moved to today'
            : assessorChanged
              ? 'Job assigned to you'
              : 'Job rescheduled',
          body: assessorChanged
            ? `The assessment at ${where} has been reassigned to you, scheduled for ${when}.`
            : `Your assessment at ${where} has been rescheduled to ${when}.`,
          link: `safentia://job/${jobId}`,
        },
        logger,
      );
      if (assessorChanged) {
        // The replaced assessor's diary changed too; a silent removal would
        // leave them travelling to a visit that is no longer theirs.
        await sendNotification(
          paths,
          orgId,
          job.assessorUid,
          {
            type: 'jobRescheduled',
            title: 'Job reassigned',
            body: `The assessment at ${where} has been reassigned to another assessor.`,
            link: `safentia://job/${jobId}`,
          },
          logger,
        );
      }

      logger.info('Job rescheduled', { jobId, changed, today });
      return { updated: true };
    },
  ),
);
