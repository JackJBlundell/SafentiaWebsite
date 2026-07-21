// ============================================================================
// Jobs (brief 10), all assigned to the seeded assessor so the Jobs screen is
// populated on first launch. Statuses span the lifecycle: a still-scheduled job,
// in-progress jobs, one mid-validation, one in the info-required loop and the
// released ones - so every job-card state is demonstrable.
//
// Each job PINS { templateId, templateVersion } (story 1031) so the assessment
// can never shift shape if a newer template is published mid-flight. The seed
// also writes the /assessorJobs reverse index per job (the value is the status).
// ============================================================================

import type { Job, JobStatus } from '../../shared/types';
import {
  JOB,
  BUILDING,
  SITE,
  CUSTOMER,
  UID,
  PAS79_TEMPLATE_ID,
  PAS79_TEMPLATE_VERSION,
  days,
} from '../ids';

export interface SeedJob {
  id: string;
  job: Job;
}

function job(
  id: string,
  customerId: string,
  siteId: string,
  buildingId: string,
  status: JobStatus,
  scheduledFor: number,
): SeedJob {
  return {
    id,
    job: {
      templateId: PAS79_TEMPLATE_ID,
      templateVersion: PAS79_TEMPLATE_VERSION,
      customerId,
      siteId,
      buildingId,
      assessorUid: UID.assessor,
      scheduledFor,
      status,
    },
  };
}

export const SEED_JOBS: SeedJob[] = [
  // Released work - history, report and actions hang off this job.
  job(
    JOB.towerA,
    CUSTOMER.meridian,
    SITE.meridianCentral,
    BUILDING.meridianTowerA,
    'released',
    days(-21),
  ),
  // Released, the mostly-green building.
  job(
    JOB.towerB,
    CUSTOMER.meridian,
    SITE.meridianCentral,
    BUILDING.meridianTowerB,
    'released',
    days(-34),
  ),
  // Mid-lifecycle: submitted, awaiting auditor validation.
  job(
    JOB.riversideMill,
    CUSTOMER.meridian,
    SITE.meridianRiverside,
    BUILDING.riversideMill,
    'readyForValidation',
    days(-4),
  ),
  // In the info-required loop: the auditor has asked a question back.
  job(
    JOB.lodgeHouse,
    CUSTOMER.northgate,
    SITE.northgateLodge,
    BUILDING.northgateLodgeHouse,
    'infoRequired',
    days(-9),
  ),
  // Scheduled, not yet started - the upcoming-work state.
  job(
    JOB.harboursideUnit,
    CUSTOMER.harbourside,
    SITE.harboursideQuay,
    BUILDING.harboursideUnit,
    'scheduled',
    days(3),
  ),
];
