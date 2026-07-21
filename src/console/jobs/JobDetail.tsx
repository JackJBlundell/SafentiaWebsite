// ============================================================================
// JobDetail (story 2027) - one visit, live: what stage its assessment is at,
// where it happens, and (for admins) the levers - reschedule and cancel.
//
// The job's assessment is addressed DIRECTLY by the deterministic id the server
// derives (`job-<jobId>`, see startAssessment/assessmentIdForJob), so no index
// lookup is needed: the detail subscribes to the one node the assessment can
// ever live at, and its absence simply means the visit has not started.
//
// Reschedule and cancel go through rescheduleJob/cancelJob; the server enforces
// per-assessor slot clash-freedom and a clash rejection (which names the
// conflicting job) is surfaced verbatim in a role=alert.
// ============================================================================

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Assessment,
  Building,
  CancelJobInput,
  CancelJobResult,
  Customer,
  Job,
  OrgMember,
  RescheduleJobInput,
  RescheduleJobResult,
  Site,
  Template,
} from '../../types';
import { ASSESSMENT_STAGE_LABELS } from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DescriptionList, PageGrid } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { LoadingNote, sortByName, toEntries, urls } from '../customers/shared';
import shared from '../customers/shared.module.css';
import {
  assessmentIdForJob,
  durationLabel,
  formatJobDate,
  formatSlot,
  JobStatusBadge,
  jobUrls,
  localDateTimeMillis,
  minutesToTime,
  slotDurationMinutes,
  snapTimeToSlot,
  STANDARD_LABELS,
  timeToMinutes,
  toLocalInputValues,
} from './shared';
import { ScheduleTimeline } from './ScheduleTimeline';
import { actorName } from '../lib/actorName';
import styles from './JobDetail.module.css';

/** Native time inputs step in seconds; the slot granularity is 15 minutes. */
const SLOT_STEP_SECONDS = 15 * 60;

/** A visit defaults to two hours until the operator says otherwise. */
const DEFAULT_DURATION_MIN = 120;

export function JobDetail() {
  const { jobId = '' } = useParams();
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(orgId && paths && jobId);
  const isAdmin = claims?.roles.admin === true;

  const jobQuery = useRtdbQuery<Job | null>({
    key: keys.job(orgId, jobId),
    path: paths ? paths.db.job(orgId, jobId) : '',
    enabled,
  });
  const job = jobQuery.data;

  // The job's one possible assessment, addressed by its deterministic id.
  const assessmentId = assessmentIdForJob(jobId);
  const assessmentQuery = useRtdbQuery<Assessment | null>({
    key: keys.assessment(orgId, assessmentId),
    path: paths ? paths.db.assessment(orgId, assessmentId) : '',
    enabled,
  });
  const assessment = assessmentQuery.data;

  // Context records, enabled once the job's ids are known.
  const customerQuery = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId, job?.customerId ?? ''),
    path: paths && job ? paths.db.customer(orgId, job.customerId) : '',
    enabled: enabled && Boolean(job),
  });
  const siteQuery = useRtdbQuery<Site | null>({
    key: keys.site(orgId, job?.customerId ?? '', job?.siteId ?? ''),
    path: paths && job ? paths.db.site(orgId, job.customerId, job.siteId) : '',
    enabled: enabled && Boolean(job),
  });
  const buildingQuery = useRtdbQuery<Building | null>({
    key: keys.building(orgId, job?.siteId ?? '', job?.buildingId ?? ''),
    path:
      paths && job ? paths.db.building(orgId, job.siteId, job.buildingId) : '',
    enabled: enabled && Boolean(job),
  });
  const templateQuery = useRtdbQuery<Template | null>({
    key: keys.template(orgId, job?.templateId ?? ''),
    path: paths && job ? paths.db.template(orgId, job.templateId) : '',
    enabled: enabled && Boolean(job),
  });

  // Staff names: /orgMembers is granted only to admin, assessor and auditor, so
  // the read is gated by role and the assessor line degrades to the raw uid.
  const canReadMembers =
    claims?.roles.admin === true ||
    claims?.roles.assessor === true ||
    claims?.roles.auditor === true;
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: enabled && canReadMembers,
  });

  if (!enabled || jobQuery.isLoading) {
    return <LoadingNote>Loading job</LoadingNote>;
  }
  if (job === null || job === undefined) {
    return (
      <EmptyState
        title="Job not found"
        body="This job does not exist, or it belongs to a different organisation."
        action={<Button to={jobUrls.jobs}>Back to jobs</Button>}
      />
    );
  }

  const buildingName = buildingQuery.data?.name ?? job.buildingId;
  const customerName = customerQuery.data?.name ?? job.customerId;
  const siteName = siteQuery.data?.name ?? job.siteId;
  const assessorName = (uid: string) =>
    actorName(membersQuery.data, uid, membersQuery.data !== undefined);
  const template = templateQuery.data;
  const actionable = job.status !== 'cancelled' && job.status !== 'released';

  return (
    <div>
      <PageHeader
        title={buildingName}
        lede={`Assessment visit for ${customerName}.`}
        crumbs={[{ label: 'Jobs', to: jobUrls.jobs }, { label: buildingName }]}
        action={<JobStatusBadge status={job.status} />}
      />

      <PageGrid
        aside={
          <ScheduleCard
            jobId={jobId}
            job={job}
            isAdmin={isAdmin}
            actionable={actionable}
            assessorName={assessorName}
            assessorOptions={
              canReadMembers
                ? sortByName(
                    toEntries(membersQuery.data).filter(
                      ([, member]) =>
                        member.roles.assessor === true && member.status === 'active',
                    ),
                  )
                : []
            }
          />
        }
      >
        <Card>
          <CardHeader
            title="Assessment"
            hint="The visit's assessment, live from the assessor's device."
          />
          {assessment ? (
            <>
              <p className={styles.stage}>{ASSESSMENT_STAGE_LABELS[assessment.status]}</p>
              <DescriptionList
                items={[
                  { label: 'Conducted by', value: assessorName(assessment.conductedBy) },
                  {
                    label: 'Started',
                    value: assessment.conductedAt
                      ? formatJobDate(assessment.conductedAt)
                      : undefined,
                  },
                  {
                    label: 'Submitted',
                    value: assessment.workflow?.submittedAt
                      ? formatJobDate(assessment.workflow.submittedAt)
                      : undefined,
                  },
                ]}
              />
              {(assessment.status === 'readyForValidation' ||
                assessment.status === 'infoRequired' ||
                assessment.status === 'readyForRelease') && (
                <div className={styles.assessmentAction}>
                  <Button to={jobUrls.validation(assessmentId)}>Open in validation</Button>
                </div>
              )}
            </>
          ) : (
            <p className={shared.cardCopy}>
              {job.status === 'cancelled'
                ? 'This job was cancelled before an assessment began.'
                : 'Not started yet. The assessment appears here the moment the assessor begins the visit.'}
            </p>
          )}
        </Card>

        <Card>
          <CardHeader title="Where and what" hint="The building under assessment and the template the visit follows." />
          <DescriptionList
            items={[
              {
                label: 'Customer',
                value: (
                  <Link className={styles.factLink} to={urls.customer(job.customerId)}>
                    {customerName}
                  </Link>
                ),
              },
              {
                label: 'Site',
                value: (
                  <Link
                    className={styles.factLink}
                    to={urls.site(job.customerId, job.siteId)}
                  >
                    {siteName}
                  </Link>
                ),
              },
              {
                label: 'Building',
                value: (
                  <Link
                    className={styles.factLink}
                    to={urls.building(job.customerId, job.siteId, job.buildingId)}
                  >
                    {buildingName}
                  </Link>
                ),
              },
              {
                label: 'Template',
                value: template
                  ? `${template.name} (v${job.templateVersion}, ${STANDARD_LABELS[template.standard ?? 'custom']})`
                  : `Version ${job.templateVersion}`,
              },
            ]}
          />
        </Card>
      </PageGrid>
    </div>
  );
}

// ----------------------------------------------------------------------------
// The sticky aside: the visit's slot, and the admin levers. Reschedule opens an
// inline panel (date, times, optional assessor move); cancel asks for a
// confirmation with an optional reason the assessor sees in their notification.
// ----------------------------------------------------------------------------

function ScheduleCard({
  jobId,
  job,
  isAdmin,
  actionable,
  assessorName,
  assessorOptions,
}: {
  jobId: string;
  job: Job;
  isAdmin: boolean;
  actionable: boolean;
  assessorName: (uid: string) => string;
  assessorOptions: [string, OrgMember][];
}) {
  const rescheduleJob = useCallable<RescheduleJobInput, RescheduleJobResult>(
    'rescheduleJob',
  );
  const cancelJob = useCallable<CancelJobInput, CancelJobResult>('cancelJob');

  const [panel, setPanel] = useState<'none' | 'reschedule' | 'cancel'>('none');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Reschedule fields, seeded from the current slot each time the panel opens.
  const seeded = useMemo(() => {
    const start = toLocalInputValues(job.scheduledFor);
    const end =
      job.scheduledUntil !== undefined
        ? toLocalInputValues(job.scheduledUntil).time
        : '';
    return { date: start.date, start: start.time, end };
  }, [job.scheduledFor, job.scheduledUntil]);
  const [date, setDate] = useState(seeded.date);
  const [startTime, setStartTime] = useState(seeded.start);
  const [endTime, setEndTime] = useState(seeded.end);
  const [moveTo, setMoveTo] = useState('');
  const [reason, setReason] = useState('');

  // A legacy visit scheduled before slots existed has no end time; rescheduling
  // it must not force one on it, so its end stays optional throughout.
  const hadSlot = job.scheduledUntil !== undefined;

  // Typed times SNAP to the 15-minute grid instead of erroring; the end
  // follows a start change so the pair cannot invert by moving the start
  // (same behaviour as the wizard - a visit keeps its duration when it moves).
  // A slot-less legacy visit with its end left empty keeps it empty.
  const applyStartTime = (raw: string) => {
    const snapped = snapTimeToSlot(raw);
    setStartTime(snapped);
    if (!hadSlot && endTime === '') {
      return;
    }
    const duration =
      slotDurationMinutes(startTime, endTime) ?? DEFAULT_DURATION_MIN;
    const startMin = timeToMinutes(snapped);
    if (startMin !== null) {
      setEndTime(minutesToTime(startMin + duration));
    }
  };

  const applyEndTime = (raw: string) => {
    setEndTime(snapTimeToSlot(raw));
  };

  const startMs =
    date && startTime ? localDateTimeMillis(date, startTime) : null;
  const endMs = date && endTime ? localDateTimeMillis(date, endTime) : null;
  const durationMin = slotDurationMinutes(startTime, endTime);

  /** Timeline -> inputs: a picked/dragged slot writes both times back. */
  const handleSlotChange = (nextStartMs: number, nextEndMs: number) => {
    setStartTime(toLocalInputValues(nextStartMs).time);
    setEndTime(toLocalInputValues(nextEndMs).time);
  };

  // The timeline shows the day of whoever will HOLD the slot after the move.
  const targetAssessorUid = moveTo || job.assessorUid;

  const openReschedule = () => {
    setDate(seeded.date);
    setStartTime(seeded.start);
    setEndTime(seeded.end);
    setMoveTo('');
    setFieldError(null);
    rescheduleJob.clearError();
    setPanel('reschedule');
  };

  const submitReschedule = async () => {
    if (!date || !startTime || (hadSlot && !endTime)) {
      setFieldError(
        hadSlot
          ? 'Choose the date and both slot times.'
          : 'Choose the date and start time.',
      );
      return;
    }
    const scheduledFor = localDateTimeMillis(date, startTime);
    const input: RescheduleJobInput = { jobId, scheduledFor };
    // A slot-less legacy visit may move by start alone; an end, when given
    // (always, for a visit that had a slot), must follow the start.
    if (endTime) {
      const scheduledUntil = localDateTimeMillis(date, endTime);
      if (!(scheduledUntil > scheduledFor)) {
        setFieldError('The end time must be after the start time.');
        return;
      }
      input.scheduledUntil = scheduledUntil;
    }
    setFieldError(null);
    if (moveTo) {
      input.assessorUid = moveTo;
    }
    const result = await rescheduleJob.call(input);
    if (result) {
      setPanel('none'); // The live job listener repaints the slot.
    }
  };

  const submitCancel = async () => {
    const input: CancelJobInput = { jobId };
    if (reason.trim()) {
      input.reason = reason.trim();
    }
    const result = await cancelJob.call(input);
    if (result) {
      setPanel('none');
    }
  };

  return (
    <Card>
      <CardHeader title="Schedule" as="h2" />
      <DescriptionList
        items={[
          { label: 'Date', value: formatJobDate(job.scheduledFor) },
          { label: 'Slot', value: formatSlot(job.scheduledFor, job.scheduledUntil) },
          { label: 'Assessor', value: assessorName(job.assessorUid) },
        ]}
      />

      {isAdmin && actionable && panel === 'none' && (
        <div className={styles.asideActions}>
          <Button variant="secondary" onClick={openReschedule}>
            Reschedule
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setReason('');
              cancelJob.clearError();
              setPanel('cancel');
            }}
          >
            Cancel job
          </Button>
        </div>
      )}

      {panel === 'reschedule' && (
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Reschedule this visit</h3>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="reschedule-date">
              Date
            </label>
            <input
              id="reschedule-date"
              className={shared.input}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
          <div className={shared.fieldRow}>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="reschedule-start">
                Start time
              </label>
              <input
                id="reschedule-start"
                className={shared.input}
                type="time"
                step={SLOT_STEP_SECONDS}
                value={startTime}
                onChange={(event) => applyStartTime(event.target.value)}
              />
            </div>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="reschedule-end">
                End time
              </label>
              <input
                id="reschedule-end"
                className={shared.input}
                type="time"
                step={SLOT_STEP_SECONDS}
                value={endTime}
                onChange={(event) => applyEndTime(event.target.value)}
              />
              {durationMin !== null && (
                <p className={shared.hint}>{durationLabel(durationMin)}</p>
              )}
              {!hadSlot && endTime === '' && (
                <p className={shared.hint}>
                  Optional: this visit was scheduled without an end time.
                </p>
              )}
            </div>
          </div>
          {assessorOptions.length > 0 && (
            <div className={shared.field}>
              <label className={shared.label} htmlFor="reschedule-assessor">
                Assessor
              </label>
              <select
                id="reschedule-assessor"
                className={shared.select}
                value={moveTo}
                onChange={(event) => setMoveTo(event.target.value)}
              >
                <option value="">Keep {assessorName(job.assessorUid)}</option>
                {assessorOptions
                  .filter(([uid]) => uid !== job.assessorUid)
                  .map(([uid, member]) => (
                    <option key={uid} value={uid}>
                      Move to {member.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {date && (
            <ScheduleTimeline
              assessorUid={targetAssessorUid}
              assessorName={assessorName(targetAssessorUid)}
              date={date}
              startMs={startMs}
              endMs={
                endMs !== null && startMs !== null && endMs > startMs
                  ? endMs
                  : null
              }
              onSlotChange={handleSlotChange}
              excludeJobId={jobId}
            />
          )}
          {fieldError && <ErrorNotice message={fieldError} />}
          {rescheduleJob.error && <ErrorNotice message={rescheduleJob.error} />}
          <div className={styles.panelActions}>
            <Button
              variant="ghost"
              onClick={() => setPanel('none')}
              disabled={rescheduleJob.pending}
            >
              Keep current slot
            </Button>
            <Button
              onClick={() => void submitReschedule()}
              disabled={rescheduleJob.pending}
            >
              {rescheduleJob.pending ? 'Rescheduling' : 'Reschedule'}
            </Button>
          </div>
        </div>
      )}

      {panel === 'cancel' && (
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Cancel this job?</h3>
          <p className={shared.cardCopy}>
            The visit is removed from the assessor's list and they are notified.
            This cannot be undone.
          </p>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="cancel-reason">
              Reason (optional)
            </label>
            <textarea
              id="cancel-reason"
              className={styles.reason}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {cancelJob.error && <ErrorNotice message={cancelJob.error} />}
          <div className={styles.panelActions}>
            <Button
              variant="ghost"
              onClick={() => setPanel('none')}
              disabled={cancelJob.pending}
            >
              Keep the job
            </Button>
            <Button onClick={() => void submitCancel()} disabled={cancelJob.pending}>
              {cancelJob.pending ? 'Cancelling' : 'Cancel job'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
