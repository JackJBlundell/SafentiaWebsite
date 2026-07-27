// ============================================================================
// Job time-slot validation and per-assessor clash checking (FR-E17).
//
// A job may carry an optional [scheduledFor, scheduledUntil) time slot. When it
// does, the slot must be well-formed (end after start, no longer than a 12-hour
// working day) and must not overlap any OTHER slotted, non-cancelled job already
// assigned to the same assessor. Date-only jobs (no scheduledUntil) NEVER clash -
// they carry no interval to test, and Phase 1 jobs predate slots entirely, so
// they must stay valid and schedulable alongside anything.
//
// Shared by createJob and rescheduleJob so the two admin paths cannot drift in
// what they accept - the reason this lives in lib rather than in either Function.
// ============================================================================

import { db } from '../admin';
import { fail } from './errors';
import type { EnvPaths } from './paths';
import type { Building, Job, Keyed } from '../shared/types';

/** The longest a single site visit may run. Doubles as the clash query's window
 *  bound below: no conforming slot can reach further than this from its start. */
const MAX_SLOT_MS = 12 * 60 * 60 * 1000;

// Error-copy formatters. Safentia is a UK product, so Europe/London is the one
// wall clock every admin reading a clash message shares - never raw UTC, which
// reads an hour off for half the year.
const LONDON_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
});
const LONDON_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * Validate a slot's shape: the end must be strictly after the start, and the
 * slot may run at most 12 hours. There is deliberately NO calendar-day rule:
 * clients submit local wall-clock epochs and the server has no timezone
 * authority, so "same day" is undecidable here - a legitimate local-evening
 * slot under BST crosses UTC midnight. The duration cap bounds a visit instead.
 * Throws the structured invalid-argument error; returns nothing (the values are
 * already validated timestamps).
 */
export function assertValidSlot(scheduledFor: number, scheduledUntil: number): void {
  if (scheduledUntil <= scheduledFor) {
    throw fail.invalidArgument(
      'The end of the time slot must be after its start.',
      { field: 'scheduledUntil' },
    );
  }
  if (scheduledUntil - scheduledFor > MAX_SLOT_MS) {
    throw fail.invalidArgument(
      'A time slot cannot be longer than 12 hours.',
      { field: 'scheduledUntil' },
    );
  }
}

/**
 * Assert the slot [scheduledFor, scheduledUntil) does not overlap any other
 * slotted, non-cancelled job assigned to `assessorUid`. `excludeJobId` lets
 * rescheduleJob test a job's NEW slot without colliding with its own old one.
 *
 * Candidates come from ONE indexed query over the org's job book rather than a
 * read per indexed job: every slot is capped at MAX_SLOT_MS, so any job whose
 * interval could touch the proposed one must have its scheduledFor inside
 * [proposedStart - 12h, proposedEnd + 12h] - the window provably contains every
 * possible clash. The narrow result is filtered to the assessor in memory. A
 * conflicting job is named by its building and time so the admin can resolve
 * the clash without hunting (FR-E17 AC).
 *
 * Read-then-write race: a concurrent createJob/rescheduleJob could book the
 * same window between this check and the caller's write. Accepted house posture
 * (admin-driven, rate-limited); FUTURE_WORK.md #7 covers per-assessor
 * serialisation should real contention appear.
 */
export async function assertNoSlotClash(
  paths: EnvPaths,
  orgId: string,
  assessorUid: string,
  scheduledFor: number,
  scheduledUntil: number,
  excludeJobId?: string,
): Promise<void> {
  const candidatesSnap = await db
    .ref(paths.db.jobs(orgId))
    .orderByChild('scheduledFor')
    .startAt(scheduledFor - MAX_SLOT_MS)
    .endAt(scheduledUntil + MAX_SLOT_MS)
    .get();
  const candidates = (candidatesSnap.val() as Keyed<Job> | null) ?? {};

  for (const [jobId, job] of Object.entries(candidates)) {
    if (
      jobId === excludeJobId ||
      !job ||
      job.assessorUid !== assessorUid ||
      job.status === 'cancelled'
    ) {
      continue;
    }
    // Date-only jobs (no scheduledUntil) never clash - documented above.
    if (typeof job.scheduledUntil !== 'number') {
      continue;
    }
    // Half-open interval overlap: [aStart, aEnd) intersects [bStart, bEnd)
    // exactly when each starts before the other ends, so back-to-back slots
    // (one ending as the next begins) are allowed.
    const overlaps =
      scheduledFor < job.scheduledUntil && job.scheduledFor < scheduledUntil;
    if (!overlaps) {
      continue;
    }
    // Name the conflicting visit by building and time so the admin can fix the
    // diary without hunting. A missing building record degrades to the job id.
    const buildingSnap = await db
      .ref(paths.db.building(orgId, job.siteId, job.buildingId))
      .get();
    const building = buildingSnap.val() as Building | null;
    const where = building?.name ?? `job ${jobId}`;
    throw fail.failedPrecondition(
      `This assessor already has ${where} booked from ${LONDON_TIME.format(job.scheduledFor)} to ${LONDON_TIME.format(job.scheduledUntil)} on ${LONDON_DATE.format(job.scheduledFor)}.`,
      {
        field: 'scheduledFor',
        conflictingJobId: jobId,
        conflictingStart: job.scheduledFor,
        conflictingEnd: job.scheduledUntil,
      },
    );
  }
}
