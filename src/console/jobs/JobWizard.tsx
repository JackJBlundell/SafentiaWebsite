// ============================================================================
// JobWizard (stories 2024 + 3001) - the guided scheduling flow: WHERE the visit
// happens (customer -> site -> building, cascading live reads), WHAT is being
// assessed (a published template, pinned at its current version), and WHO goes
// WHEN (an active assessor plus the visit's time slot).
//
// Slot scheduling (3001): the visit carries a START and END time in 15-minute
// steps, submitted as scheduledFor/scheduledUntil epoch millis. Typed times
// SNAP to the grid (never an error), the assessor's day renders as a visual
// timeline (ScheduleTimeline) wired bidirectionally to the inputs, and
// clash-freedom per assessor is enforced SERVER-SIDE by createJob; a rejection
// names the conflicting job and is surfaced verbatim in a role=alert so the
// operator can re-slot without hunting.
// ============================================================================

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Building,
  CreateJobInput,
  CreateJobResult,
  Customer,
  OrgMember,
  Site,
  Template,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { Stepper } from '../ui/Stepper';
import { useCallable } from '../ui/useCallable';
import { sortByName, toEntries, useOrgScope } from '../customers/shared';
import { useUnsavedGuard } from '../customers/useUnsavedGuard';
import shared from '../customers/shared.module.css';
import {
  durationLabel,
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
import styles from './JobWizard.module.css';

const STEPS = ['Where', 'What', 'Who and when'] as const;

/** Native time inputs step in seconds; the slot granularity is 15 minutes. */
const SLOT_STEP_SECONDS = 15 * 60;

/** A visit defaults to two hours until the operator says otherwise. */
const DEFAULT_DURATION_MIN = 120;

export function JobWizard() {
  const navigate = useNavigate();
  const { ready, orgId, db } = useOrgScope();

  const [step, setStep] = useState(0);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Step 1 - where.
  const [customerId, setCustomerId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [buildingId, setBuildingId] = useState('');

  // Step 2 - what.
  const [templateId, setTemplateId] = useState('');

  // Step 3 - who and when.
  const [assessorUid, setAssessorUid] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  const createJob = useCallable<CreateJobInput, CreateJobResult>('createJob');

  // Anything picked or typed exists only here until createJob lands; success
  // navigates to the job page, which unmounts the guard.
  useUnsavedGuard(
    Boolean(
      customerId ||
        siteId ||
        buildingId ||
        templateId ||
        assessorUid ||
        date ||
        startTime ||
        endTime,
    ),
  );

  // Cascading live reads: sites follow the chosen customer, buildings follow
  // the chosen site. Each read stays disabled until its parent is picked.
  const customers = useRtdbQuery<Record<string, Customer> | null>({
    key: keys.customers(orgId),
    path: db ? db.customers(orgId) : '',
    enabled: ready,
  });
  const sites = useRtdbQuery<Record<string, Site> | null>({
    key: keys.sites(orgId, customerId),
    path: db && customerId ? db.sites(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });
  const buildings = useRtdbQuery<Record<string, Building> | null>({
    key: keys.buildings(orgId, siteId),
    path: db && siteId ? db.buildings(orgId, siteId) : '',
    enabled: ready && Boolean(siteId),
  });
  const templates = useRtdbQuery<Record<string, Template> | null>({
    key: keys.templates(orgId),
    path: db ? db.templates(orgId) : '',
    enabled: ready,
  });
  const members = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: db ? db.orgMembers(orgId) : '',
    enabled: ready,
  });

  const customerOptions = useMemo(
    () =>
      sortByName(
        toEntries(customers.data).filter(([, customer]) => customer.status === 'active'),
      ),
    [customers.data],
  );
  const siteOptions = useMemo(() => sortByName(toEntries(sites.data)), [sites.data]);
  const buildingOptions = useMemo(
    () => sortByName(toEntries(buildings.data)),
    [buildings.data],
  );
  // Published templates only: /templates holds one node per template whose
  // `version` is its latest PUBLISHED version (published versions are
  // immutable), so listing published templates is a status filter.
  const templateOptions = useMemo(
    () =>
      sortByName(
        toEntries(templates.data).filter(([, template]) => template.status === 'published'),
      ),
    [templates.data],
  );
  const assessorOptions = useMemo(
    () =>
      sortByName(
        toEntries(members.data).filter(
          ([, member]) => member.roles.assessor === true && member.status === 'active',
        ),
      ),
    [members.data],
  );

  // --- Slot editing -------------------------------------------------------------
  // Typed times SNAP to the 15-minute grid instead of erroring; the end follows
  // a start change so the pair can never invert by moving the start (the
  // calendar convention: a visit keeps its duration when it moves).

  const applyStartTime = (raw: string) => {
    const snapped = snapTimeToSlot(raw);
    setStartTime(snapped);
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

  // The proposal the timeline paints, as epochs; null until the pair is valid.
  const startMs =
    date && startTime ? localDateTimeMillis(date, startTime) : null;
  const endMs = date && endTime ? localDateTimeMillis(date, endTime) : null;
  const durationMin = slotDurationMinutes(startTime, endTime);

  /** Timeline -> inputs: a picked/dragged slot writes both times back. */
  const handleSlotChange = (nextStartMs: number, nextEndMs: number) => {
    setStartTime(toLocalInputValues(nextStartMs).time);
    setEndTime(toLocalInputValues(nextEndMs).time);
  };

  // --- Step transitions -------------------------------------------------------

  const nextFromWhere = () => {
    if (!customerId || !siteId || !buildingId) {
      setFieldError('Choose the customer, site and building for this visit.');
      return;
    }
    setFieldError(null);
    setStep(1);
  };

  const nextFromWhat = () => {
    if (!templateId) {
      setFieldError('Choose the template this assessment will follow.');
      return;
    }
    setFieldError(null);
    setStep(2);
  };

  const schedule = async () => {
    const template = templates.data?.[templateId];
    if (!template) {
      setFieldError('Choose the template this assessment will follow.');
      setStep(1);
      return;
    }
    if (!assessorUid || !date || !startTime || !endTime) {
      setFieldError('Choose the assessor, the date, and the start and end times.');
      return;
    }
    const scheduledFor = localDateTimeMillis(date, startTime);
    const scheduledUntil = localDateTimeMillis(date, endTime);
    if (!(scheduledUntil > scheduledFor)) {
      setFieldError('The end time must be after the start time.');
      return;
    }
    setFieldError(null);
    const result = await createJob.call({
      templateId,
      templateVersion: template.version,
      customerId,
      siteId,
      buildingId,
      assessorUid,
      scheduledFor,
      scheduledUntil,
    });
    if (result) {
      navigate(jobUrls.job(result.jobId));
    }
    // On failure createJob.error renders below - verbatim, so a clash rejection
    // names the conflicting job.
  };

  // --- Render -----------------------------------------------------------------

  return (
    <div className={styles.root}>
      <PageHeader
        title="Schedule a job"
        lede="Book an assessment visit: where it happens, what is being assessed, and who goes when."
        crumbs={[{ label: 'Jobs', to: jobUrls.jobs }, { label: 'Schedule a job' }]}
      />

      <Stepper steps={STEPS} current={step} />

      {step === 0 ? (
        <Card>
          <CardHeader
            title="Where"
            hint="The building this visit assesses. Pick the customer first; sites and buildings follow."
          />
          <div className={styles.stepBody}>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="job-customer">
                Customer
              </label>
              <select
                id="job-customer"
                className={shared.select}
                value={customerId}
                onChange={(event) => {
                  setCustomerId(event.target.value);
                  setSiteId('');
                  setBuildingId('');
                }}
              >
                <option value="">Choose a customer</option>
                {customerOptions.map(([id, customer]) => (
                  <option key={id} value={id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={shared.fieldRow}>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="job-site">
                  Site
                </label>
                <select
                  id="job-site"
                  className={shared.select}
                  value={siteId}
                  disabled={!customerId}
                  onChange={(event) => {
                    setSiteId(event.target.value);
                    setBuildingId('');
                  }}
                >
                  <option value="">
                    {customerId ? 'Choose a site' : 'Choose a customer first'}
                  </option>
                  {siteOptions.map(([id, site]) => (
                    <option key={id} value={id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="job-building">
                  Building
                </label>
                <select
                  id="job-building"
                  className={shared.select}
                  value={buildingId}
                  disabled={!siteId}
                  onChange={(event) => setBuildingId(event.target.value)}
                >
                  <option value="">
                    {siteId ? 'Choose a building' : 'Choose a site first'}
                  </option>
                  {buildingOptions.map(([id, building]) => (
                    <option key={id} value={id}>
                      {building.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          {fieldError && <ErrorNotice message={fieldError} />}
          <div className={styles.controls}>
            <Button variant="ghost" to={jobUrls.jobs}>
              Cancel
            </Button>
            <Button onClick={nextFromWhere}>Next: what</Button>
          </div>
        </Card>
      ) : step === 1 ? (
        <Card>
          <CardHeader
            title="What"
            hint="The published template this assessment follows. The job pins the version you pick, so the visit never shifts shape mid-flight."
          />
          <div className={styles.stepBody}>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="job-template">
                Template
              </label>
              <select
                id="job-template"
                className={shared.select}
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">Choose a template</option>
                {templateOptions.map(([id, template]) => (
                  <option key={id} value={id}>
                    {template.name} (v{template.version},{' '}
                    {STANDARD_LABELS[template.standard ?? 'custom']})
                  </option>
                ))}
              </select>
              {templateOptions.length === 0 ? (
                <p className={shared.hint}>
                  No published templates yet. Publish one under{' '}
                  <Link to="/app/templates">Templates</Link> before scheduling a
                  job.
                </p>
              ) : (
                <p className={shared.hint}>
                  Templates are created and published under{' '}
                  <Link to="/app/templates">Templates</Link>.
                </p>
              )}
            </div>
            {templateId && templates.data?.[templateId] && (
              <>
                <p className={styles.standardLine}>
                  Standard:{' '}
                  <span className={styles.standardTag}>
                    {STANDARD_LABELS[templates.data[templateId].standard ?? 'custom']}
                  </span>
                </p>
                <p className={shared.hint}>
                  The assessment identifies the responsible person and anyone
                  else with duties under the Regulatory Reform (Fire Safety)
                  Order 2005, Article 5(3).
                </p>
              </>
            )}
          </div>
          {fieldError && <ErrorNotice message={fieldError} />}
          <div className={styles.controls}>
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button onClick={nextFromWhat}>Next: who and when</Button>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader
            title="Who and when"
            hint="The assessor and the visit's time slot. Times snap to 15-minute steps; the server refuses a slot that clashes with the assessor's other bookings."
          />
          <div className={styles.stepBody}>
            <div className={shared.fieldRow}>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="job-assessor">
                  Assessor
                </label>
                <select
                  id="job-assessor"
                  className={shared.select}
                  value={assessorUid}
                  onChange={(event) => setAssessorUid(event.target.value)}
                >
                  <option value="">Choose an assessor</option>
                  {assessorOptions.map(([uid, member]) => (
                    <option key={uid} value={uid}>
                      {member.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="job-date">
                  Date
                </label>
                <input
                  id="job-date"
                  className={shared.input}
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </div>
            </div>
            <div className={shared.fieldRow}>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="job-start">
                  Start time
                </label>
                <input
                  id="job-start"
                  className={shared.input}
                  type="time"
                  step={SLOT_STEP_SECONDS}
                  value={startTime}
                  onChange={(event) => applyStartTime(event.target.value)}
                />
              </div>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="job-end">
                  End time
                </label>
                <input
                  id="job-end"
                  className={shared.input}
                  type="time"
                  step={SLOT_STEP_SECONDS}
                  value={endTime}
                  onChange={(event) => applyEndTime(event.target.value)}
                />
                <p className={shared.hint}>
                  {durationMin !== null
                    ? durationLabel(durationMin)
                    : 'The end time must be after the start, on the same day.'}
                </p>
              </div>
            </div>
            {assessorUid && date ? (
              <ScheduleTimeline
                assessorUid={assessorUid}
                assessorName={members.data?.[assessorUid]?.name}
                date={date}
                startMs={startMs}
                endMs={endMs !== null && startMs !== null && endMs > startMs ? endMs : null}
                onSlotChange={handleSlotChange}
                // Cheap labels only: buildings for the chosen site are already
                // loaded; a booking elsewhere simply reads "Booked".
                labelForJob={(booked) => buildings.data?.[booked.buildingId]?.name}
              />
            ) : (
              <p className={shared.hint}>
                Choose an assessor and a date to see their day and pick a free
                slot.
              </p>
            )}
          </div>
          {fieldError && <ErrorNotice message={fieldError} />}
          {createJob.error && <ErrorNotice message={createJob.error} />}
          <div className={styles.controls}>
            <Button variant="ghost" onClick={() => setStep(1)} disabled={createJob.pending}>
              Back
            </Button>
            <Button onClick={() => void schedule()} disabled={createJob.pending}>
              {createJob.pending ? 'Scheduling' : 'Schedule job'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
