// ============================================================================
// onLogBookEntryCreated (RTDB trigger) - story 1047, the service-schedule mirror.
//
// The assessor confirms each statutory service's next-due date during capture.
// The CLIENT only ever appends a `serviceConfirmed` log book entry (it must not be
// able to mutate the building's compliance calendar directly - see serviceWrites.ts);
// this trigger is the SERVER-SIDE half that mirrors those confirmed dates onto
// `building.serviceSchedule`, which is the field the report's service section and
// the submission completeness check (assessmentChecks.ts) read.
//
// We react to log book ENTRY creation (append-only, so entries are only ever
// created, never updated) and act solely on `serviceConfirmed` entries; every
// other log type (fireIncident, fireDoorRecord, ...) is a no-op. The mirror is a
// deterministic overwrite of the named `nextDue` values, so a re-fire is harmless
// (idempotent), matching how the rest of the trigger layer behaves.
// ============================================================================

import { onValueCreated } from 'firebase-functions/v2/database';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { logTriggerError } from '../lib/errors';
import { paths } from '../lib/paths';
import {
  SERVICE_SCHEDULE_KEYS,
  type LogBookEntry,
  type Assessment,
  type Job,
  type Environment,
} from '../shared/types';

/** The payload shape a `serviceConfirmed` entry carries (serviceWrites.ts). */
interface ServiceConfirmedPayload {
  assessmentId?: string;
  dates?: Record<string, unknown>;
}

export const onLogBookEntryCreated = onValueCreated(
  {
    ref: '/{env}/logBook/{orgId}/{buildingId}/{entryId}',
    region: REGION,
  },
  async (event) => {
    const env = event.params.env as Environment;
    const { orgId, buildingId, entryId } = event.params;
    const logger = createLogger({
      fn: 'onLogBookEntryCreated',
      env,
      orgId,
      buildingId,
      entryId,
    });

    try {
      const entry = event.data.val() as LogBookEntry | null;
      // Only the service-confirmation entry drives the calendar mirror; all other
      // log types are genuine records that need no projection.
      if (!entry || entry.type !== 'serviceConfirmed') {
        return;
      }

      const payload = (entry.payload ?? {}) as ServiceConfirmedPayload;
      const assessmentId = payload.assessmentId;
      const dates = payload.dates ?? {};

      // Keep only known statutory keys carrying a real epoch-millis value, so a
      // malformed or partial payload can never write junk onto the building.
      const updates: Record<string, number> = {};
      for (const key of SERVICE_SCHEDULE_KEYS) {
        const value = dates[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          updates[`serviceSchedule/${key}/nextDue`] = value;
        }
      }
      if (Object.keys(updates).length === 0) {
        logger.info('serviceConfirmed entry carried no usable dates', { assessmentId });
        return;
      }

      const envPaths = paths.forEnv(env);

      // Resolve the building's siteId via the assessment -> job chain (the log book
      // is keyed by building, but the building record is keyed by site too). Each
      // hop is defensive: if a record has gone, log and stop rather than throw, so
      // a missing parent never wedges the trigger (brief 18.3).
      if (!assessmentId) {
        logger.warn('serviceConfirmed entry has no assessmentId; cannot mirror');
        return;
      }

      const assessmentSnap = await db
        .ref(envPaths.db.assessment(orgId, assessmentId))
        .get();
      if (!assessmentSnap.exists()) {
        logger.warn('Assessment for serviceConfirmed entry is absent', { assessmentId });
        return;
      }
      const assessment = assessmentSnap.val() as Assessment;

      const jobSnap = await db.ref(envPaths.db.job(orgId, assessment.jobId)).get();
      if (!jobSnap.exists()) {
        logger.warn('Job for serviceConfirmed entry is absent', {
          assessmentId,
          jobId: assessment.jobId,
        });
        return;
      }
      const job = jobSnap.val() as Job;

      // The building must GENUINELY exist at /buildings/{org}/{job.siteId}/
      // {buildingId} before we write to it. The log book is keyed by building
      // id alone, and update() on a non-existent path would CREATE a phantom
      // building node holding nothing but a serviceSchedule (the backend sweep
      // found exactly this from mismatched entry/job paths - e.g. an entry
      // whose assessmentId points at a job on a different site). Verify, and
      // reject with a log rather than mint partial data.
      const buildingRef = db.ref(
        envPaths.db.building(orgId, job.siteId, buildingId),
      );
      const buildingSnap = await buildingRef.get();
      if (!buildingSnap.exists()) {
        logger.warn(
          'Log book buildingId does not reside under the job\'s site; refusing to mirror',
          { assessmentId, jobId: assessment.jobId, siteId: job.siteId },
        );
        return;
      }

      // Single atomic merge so the confirmed dates land together; relative keys
      // overwrite only the named services and leave the rest of the schedule intact.
      await buildingRef.update(updates);

      logger.info('Mirrored confirmed service dates onto building', {
        assessmentId,
        keys: Object.keys(updates),
      });
    } catch (caught) {
      logTriggerError(logger, caught);
      throw caught;
    }
  },
);
