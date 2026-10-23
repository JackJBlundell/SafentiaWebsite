// ============================================================================
// onAssessmentCreate (RTDB trigger) - offline-first start reconciliation,
// brief 12 / 18.4, story 1039.
//
// WHY THIS EXISTS: "start assessment" is now offline-first. The startAssessment
// callable required the network; on a no-signal site the assessor could not
// begin work. So the CLIENT now creates the assessment node itself (see
// Safentia/src/features/sync/startAssessment.ts) and syncs it via a plain
// outbox update() when signal returns. The security rules permit the assigned
// assessor to create exactly that one node, but a client write cannot be the
// integrity authority - it cannot trust its own template snapshot, and it
// cannot flip the job/assessorJob status (those are .write:false to clients).
//
// This trigger is the SERVER RECONCILER that restores the guarantees the
// callable used to enforce, doing with admin privilege (db bypasses rules) what
// the client could not:
//   1. Re-read the originating job's PINNED published template and OVERWRITE the
//      assessment's templateSnapshot with that canonical copy, so a tampered or
//      stale client snapshot can never be the shape the assessment is validated
//      against (brief 18.4).
//   2. STAMP the responsible party the assessment inherits from its building,
//      when the client did not send one. The defaulting used to happen only at
//      render time in the app, so nothing was ever persisted and every consumer
//      of the stored record (report, action plan, portal) saw a blank party.
//      Resolving it here - once, server-side, at the same seam that already
//      reconciles the snapshot - is what makes "chosen once, applied
//      everywhere" true of the DATA rather than of one screen.
//   3. Atomically flip the job AND the assessor reverse-index to inProgress -
//      but ONLY from 'scheduled', so a later lifecycle state (e.g. the auditor
//      has already moved it on) is never stomped.
//
// IDEMPOTENCE: re-running on the same node is harmless - the snapshot overwrite
// is deterministic, the party stamp re-reads the CURRENT value and writes only
// into an empty field, and the status flip is conditional on 'scheduled', so a
// second fire is a no-op. This mirrors the deterministic `job-${jobId}` id the
// client and the old callable both derive, so a job can never spawn two
// assessments.
// ============================================================================

import { onValueCreated } from 'firebase-functions/v2/database';
import { db } from '../admin';
import { REGION } from '../lib/region';
import { createLogger } from '../lib/logging';
import { logTriggerError } from '../lib/errors';
import { appendActivity } from '../lib/events';
import { paths } from '../lib/paths';
import { resolveResponsibleParty } from '../lib/responsibleParty';
import {
  type Assessment,
  type Building,
  type Job,
  type Template,
  type Environment,
} from '../shared/types';

/** The job's pinned published template: the immutable archived version first,
 *  then the live template if (and only if) it is still at the pinned version.
 *  Null when neither exists. A half-written archive entry (a publish claim
 *  marker) is not a template and is skipped. */
async function loadPinnedTemplate(
  envPaths: ReturnType<typeof paths.forEnv>,
  orgId: string,
  job: Job,
): Promise<Template | null> {
  const archived = (
    await db
      .ref(envPaths.db.templateVersion(orgId, job.templateId, job.templateVersion))
      .get()
  ).val() as Template | null;
  if (archived && archived.version === job.templateVersion) {
    return archived;
  }
  const live = (
    await db.ref(envPaths.db.template(orgId, job.templateId)).get()
  ).val() as Template | null;
  return live && live.version === job.templateVersion ? live : null;
}

export const onAssessmentCreate = onValueCreated(
  {
    ref: '/{env}/assessments/{orgId}/{assessmentId}',
    region: REGION,
  },
  async (event) => {
    const env = event.params.env as Environment;
    const { orgId, assessmentId } = event.params;
    const logger = createLogger({
      fn: 'onAssessmentCreate',
      env,
      orgId,
      assessmentId,
    });

    try {
      const assessment = event.data.val() as Assessment;
      const { jobId } = assessment;
      const envPaths = paths.forEnv(env);

      // Record the assessment START in the audit trail. The create is client-
      // driven (offline-first), so this trigger is where 'started' is first seen
      // server-side. This is assessment WORKFLOW: it goes to /activity (and the
      // in-assessment activity timeline), never the building Fire Safety Log Book.
      await appendActivity(envPaths, orgId, {
        actorUid: assessment.conductedBy,
        action: 'assessment.started',
        target: assessmentId,
      });

      // 1. Load the originating job. Defensive: if it has gone, there is nothing
      // to reconcile against - log and stop rather than throw (brief 18.3).
      const jobSnap = await db.ref(envPaths.db.job(orgId, jobId)).get();
      if (!jobSnap.exists()) {
        logger.warn('Assessment created but originating job is absent', { jobId });
        return;
      }
      const job = jobSnap.val() as Job;

      // 2. Overwrite the client-supplied snapshot with the job's PINNED
      // published template. The immutable archive copy (templateVersions) is
      // read first, so a template republished or edited since the job was
      // created still reconciles to exactly the version the job pinned; the
      // live template is the fallback for one published before the archive
      // existed. The client snapshot is NEVER kept: it is client-written, and
      // the report generator trusts its certificate reference.
      const assessmentPath = envPaths.db.assessment(orgId, assessmentId);
      const canonical = await loadPinnedTemplate(envPaths, orgId, job);
      if (canonical) {
        await db.ref(`${assessmentPath}/templateSnapshot`).set(canonical);
        logger.info('Reconciled templateSnapshot from pinned template', {
          jobId,
          templateId: job.templateId,
        });
      } else {
        // No canonical copy exists to restore (template and archive both gone).
        // Keep the questions so the assessor's work is not lost, but strip the
        // certificate - the one field that makes the generator read a Storage
        // object - and flag it for an operator.
        await db.ref(`${assessmentPath}/templateSnapshot/certificate`).remove();
        logger.error('Pinned template unavailable; client snapshot unverified', {
          jobId,
          templateId: job.templateId,
          pinned: job.templateVersion,
        });
      }

      // 2b. The assessment's building and customer are the JOB's. The create
      // rule already insists on this; stamping them here as well means no
      // record can ever carry a client's choice of where its report is filed.
      if (
        assessment.buildingId !== job.buildingId ||
        assessment.customerId !== job.customerId
      ) {
        await db.ref(assessmentPath).update({
          buildingId: job.buildingId,
          customerId: job.customerId,
        });
        logger.warn('Assessment building/customer corrected from its job', {
          jobId,
        });
      }

      // 3. Stamp the inherited responsible party, when the assessment does not
      // already carry one. The job knows where the building lives (the
      // assessment only carries a buildingId, and buildings are addressed
      // site-first), so this is one targeted read rather than an estate scan.
      //
      // NEVER STOMP AN OVERRIDE: the trigger snapshot is the value at CREATE
      // time, but an assessor can have set their own party in the seconds since
      // (or a retry can re-fire this trigger long after). So the absence is
      // re-confirmed against the CURRENT node immediately before writing, and
      // only the single `responsibleParty` child is written - never the record.
      if (!assessment.responsibleParty) {
        const buildingSnap = await db
          .ref(envPaths.db.building(orgId, job.siteId, job.buildingId))
          .get();
        const building = buildingSnap.val() as Building | null;
        const party = resolveResponsibleParty(assessment, building);
        if (!party) {
          logger.info('No responsible party to inherit', {
            buildingId: job.buildingId,
          });
        } else {
          const partyRef = db.ref(
            `${envPaths.db.assessment(orgId, assessmentId)}/responsibleParty`,
          );
          const currentSnap = await partyRef.get();
          if (currentSnap.exists()) {
            logger.info('Responsible party already set; stamp skipped');
          } else {
            await partyRef.set(party);
            logger.info('Stamped responsible party from building default', {
              buildingId: job.buildingId,
            });
          }
        }
      }

      // 4. Atomically move the job AND the assessor reverse-index to inProgress -
      // but only if the job is still 'scheduled', so we never stomp a later
      // lifecycle state. A single multi-location update() keeps the two in step
      // (brief 18.3); the conditional makes a re-fire a no-op.
      if (job.status === 'scheduled') {
        const update: Record<string, unknown> = {
          [`${envPaths.db.job(orgId, jobId)}/status`]: 'inProgress',
          [envPaths.db.assessorJob(orgId, job.assessorUid, jobId)]: 'inProgress',
        };
        await db.ref().update(update);
        logger.info('Moved job to inProgress', { jobId });
      } else {
        logger.info('Job not scheduled; status flip skipped', {
          jobId,
          status: job.status,
        });
      }
    } catch (caught) {
      logTriggerError(logger, caught);
      throw caught;
    }
  },
);
