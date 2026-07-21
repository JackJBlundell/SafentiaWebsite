// ============================================================================
// Shared pieces for the Jobs area: the canonical job-status labels and badge,
// route URLs, the deterministic job -> assessment id mapping, and the British
// date/time formatters every jobs screen uses. One definition each, so the
// board, wizard and detail cannot drift apart.
//
// Generic scope/record helpers (useOrgScope, toEntries, LoadingNote,
// NoAccessPanel) are reused from the customers area rather than re-implemented.
// ============================================================================

import {
  ASSESSMENT_STAGE_LABELS,
  type JobStatus,
  type ReportStandard,
} from '../../types';
import styles from './JobsBoard.module.css';

// ----------------------------------------------------------------------------
// Router URLs for the Jobs area, plus the validation handoff.
// ----------------------------------------------------------------------------

export const jobUrls = {
  jobs: '/app/jobs',
  jobNew: '/app/jobs/new',
  job: (jobId: string) => `/app/jobs/${jobId}`,
  validation: (assessmentId: string) => `/app/validation/${assessmentId}`,
} as const;

/** Deterministic assessment id for a job - the client-side twin of the server's
 *  assessmentIdForJob (startAssessment / security rules). The job detail uses it
 *  to read the job's one possible assessment without an index lookup. */
export function assessmentIdForJob(jobId: string): string {
  return `job-${jobId}`;
}

// ----------------------------------------------------------------------------
// Canonical labels. A job's in-flight statuses mirror the assessment stages, so
// those words come straight from ASSESSMENT_STAGE_LABELS (the client-facing
// stage names, brief 6.1); only the two job-native states add their own copy.
// ----------------------------------------------------------------------------

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  scheduled: 'Scheduled',
  inProgress: ASSESSMENT_STAGE_LABELS.inProgress,
  readyForValidation: ASSESSMENT_STAGE_LABELS.readyForValidation,
  infoRequired: ASSESSMENT_STAGE_LABELS.infoRequired,
  readyForRelease: ASSESSMENT_STAGE_LABELS.readyForRelease,
  released: ASSESSMENT_STAGE_LABELS.released,
  cancelled: 'Cancelled',
};

export const STANDARD_LABELS: Record<ReportStandard, string> = {
  pas79: 'PAS 79',
  bs9792: 'BS 9792',
  custom: 'Custom',
};

/** Tone groups so colour supports (never carries) the status meaning. */
const STATUS_TONE: Record<JobStatus, 'open' | 'attention' | 'done' | 'muted'> = {
  scheduled: 'open',
  inProgress: 'open',
  readyForValidation: 'attention',
  infoRequired: 'attention',
  readyForRelease: 'attention',
  released: 'done',
  cancelled: 'muted',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`${styles.statusBadge} ${styles[`status-${STATUS_TONE[status]}`]}`}>
      {JOB_STATUS_LABELS[status]}
    </span>
  );
}

// ----------------------------------------------------------------------------
// Formatting - British dates, 24-hour times (Intl en-GB throughout).
// ----------------------------------------------------------------------------

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "Mon 20 Jul 2026" from epoch millis. */
export function formatJobDate(millis: number): string {
  return dateFormat.format(millis);
}

/** "09:00" from epoch millis. */
export function formatTime(millis: number): string {
  return timeFormat.format(millis);
}

/** The visit's slot: "09:00 to 11:00", or just the start when the job predates
 *  slot scheduling and carries no end time. */
export function formatSlot(scheduledFor: number, scheduledUntil?: number): string {
  const start = formatTime(scheduledFor);
  return scheduledUntil ? `${start} to ${formatTime(scheduledUntil)}` : start;
}

// ----------------------------------------------------------------------------
// Slot arithmetic. Slots live on a 15-minute grid; the inputs and the timeline
// SNAP to it rather than ever erroring about it (product decision: a typed
// 09:07 becomes a scheduled 09:00, never a telling-off).
// ----------------------------------------------------------------------------

/** The slot grid, in minutes. */
export const SLOT_MINUTES = 15;

/** "HH:mm" -> minutes since local midnight, or null when not a parseable time. */
export function timeToMinutes(time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) {
    return null;
  }
  return h * 60 + m;
}

/** Minutes since midnight -> "HH:mm" (clamped to the day). */
export function minutesToTime(minutes: number): string {
  const clamped = Math.min(Math.max(minutes, 0), 24 * 60 - SLOT_MINUTES);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

/** Snap an "HH:mm" value to the NEAREST slot boundary. ROUND, not floor: a
 *  typed 09:08 means "about quarter past" far more often than "nine sharp",
 *  so the nearest boundary honours intent; flooring would silently pull every
 *  entry earlier. 09:07 -> 09:00, 09:08 -> 09:15. */
export function snapTimeToSlot(time: string): string {
  const minutes = timeToMinutes(time);
  if (minutes === null) {
    return time;
  }
  return minutesToTime(Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES);
}

/** Whole-slot duration between two "HH:mm" values, or null when either is
 *  unparseable or the pair is inverted. */
export function slotDurationMinutes(start: string, end: string): number | null {
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  if (startMin === null || endMin === null || endMin <= startMin) {
    return null;
  }
  return endMin - startMin;
}

/** "2 h visit" / "1 h 30 min visit" / "45 min visit" for the duration hint. */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [
    ...(hours > 0 ? [`${hours} h`] : []),
    ...(rest > 0 ? [`${rest} min`] : []),
  ];
  return `${parts.join(' ')} visit`;
}

/** yyyy-mm-dd + HH:mm (both from the native inputs) -> local epoch millis. */
export function localDateTimeMillis(date: string, time: string): number {
  return new Date(`${date}T${time}:00`).getTime();
}

/** Epoch millis -> the yyyy-mm-dd / HH:mm pair the native inputs expect, in the
 *  viewer's local timezone (the same convention localDateTimeMillis writes). */
export function toLocalInputValues(millis: number): { date: string; time: string } {
  const value = new Date(millis);
  const pad = (part: number) => String(part).padStart(2, '0');
  return {
    date: `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    time: `${pad(value.getHours())}:${pad(value.getMinutes())}`,
  };
}
