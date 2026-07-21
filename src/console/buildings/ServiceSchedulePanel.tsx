// ============================================================================
// ServiceSchedulePanel - the building's statutory service calendar (story
// 1047): next-due dates for the fire alarm service, drills, training, PAT,
// extinguisher maintenance and the FRA review.
//
// Dates are stored as epoch millis (the platform convention: they sort and
// compare without timezone ambiguity) and entered here through plain date
// inputs, converted at midnight UTC. Assessors confirm these dates during
// every assessment; the admin edit exists to keep the calendar accurate
// between visits, so saving sends the WHOLE serviceSchedule object through
// manageBuilding update - one write, one truth.
// ============================================================================

import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  SERVICE_SCHEDULE_KEYS,
  type Building,
  type ManageBuildingInput,
  type ManageBuildingResult,
  type ServiceSchedule,
  type ServiceScheduleKey,
} from '../../types';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import styles from './ServiceSchedulePanel.module.css';

/** Human titles for every statutory service key. Exhaustive by construction. */
const SERVICE_LABELS: Record<ServiceScheduleKey, string> = {
  fireAlarmService: 'Fire alarm service',
  fireMarshalTraining: 'Fire marshal training',
  fireSafetyTraining: 'Fire safety training',
  fireDrill: 'Fire drill',
  pat: 'Portable appliance testing (PAT)',
  extinguisherMaintenance: 'Extinguisher maintenance',
  fraReview: 'Fire risk assessment review',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_WINDOW_MS = 30 * DAY_MS;

type DueStatus = 'overdue' | 'dueSoon' | 'ok' | 'unset';

function dueStatus(nextDue: number | undefined, now: number): DueStatus {
  if (nextDue === undefined) {
    return 'unset';
  }
  // nextDue is midnight UTC on the due day, so the service is overdue only
  // once that whole UTC day has passed: a service due today sits in the
  // due-soon band all day rather than reading "Overdue" from midnight.
  if (now >= nextDue + DAY_MS) {
    return 'overdue';
  }
  if (nextDue - now <= DUE_SOON_WINDOW_MS) {
    return 'dueSoon';
  }
  return 'ok';
}

function formatDate(epochMillis: number): string {
  return new Date(epochMillis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Epoch millis -> the yyyy-mm-dd a date input wants, in UTC. */
function toDateInputValue(epochMillis: number | undefined): string {
  if (epochMillis === undefined) {
    return '';
  }
  return new Date(epochMillis).toISOString().slice(0, 10);
}

/** yyyy-mm-dd -> epoch millis at midnight UTC (the platform convention). */
function fromDateInputValue(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

type DraftDates = Record<ServiceScheduleKey, string>;

function draftFromSchedule(schedule: ServiceSchedule | undefined): DraftDates {
  const draft = {} as DraftDates;
  for (const key of SERVICE_SCHEDULE_KEYS) {
    draft[key] = toDateInputValue(schedule?.[key]?.nextDue);
  }
  return draft;
}

/** Canonical fingerprint of a schedule: the draft record in fixed key order,
 *  so a live snapshot and a submitted payload compare equal regardless of the
 *  key ordering RTDB happens to return. */
function scheduleFingerprint(schedule: ServiceSchedule | undefined): string {
  return JSON.stringify(draftFromSchedule(schedule));
}

export function ServiceSchedulePanel({
  siteId,
  buildingId,
}: {
  siteId: string;
  buildingId: string;
}) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const isAdmin = claims?.roles.admin === true;

  const buildingQuery = useRtdbQuery<Building | null>({
    key: keys.building(orgId, siteId, buildingId),
    path: paths ? paths.db.building(orgId, siteId, buildingId) : '',
    enabled: Boolean(orgId && paths),
  });
  const schedule = buildingQuery.data?.serviceSchedule;

  const manage = useCallable<ManageBuildingInput, ManageBuildingResult>(
    'manageBuilding',
  );
  const [draft, setDraft] = useState<DraftDates>(() => draftFromSchedule(undefined));
  // The keys the admin has actually edited: only these come from the draft at
  // save time, so a concurrent edit to another service key is not clobbered.
  const [editedKeys, setEditedKeys] = useState<ReadonlySet<ServiceScheduleKey>>(
    new Set(),
  );
  // Set on a successful save to the PRE-save snapshot's fingerprint: while the
  // live node still reads as that stale state, re-seeding would visually
  // revert the save, so the submitted draft is held until the node moves on.
  const [staleFingerprint, setStaleFingerprint] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = editedKeys.size > 0;

  // Seed (and live-refresh) the draft from the record, but never while the
  // admin is mid-edit: a snapshot landing between keystrokes must not clobber
  // unsaved dates. After a save, the listener may still be echoing the
  // pre-save snapshot; the submitted draft stays until the node moves off that
  // state (our own echo, or a later concurrent write - either is fresher).
  const liveFingerprint = scheduleFingerprint(schedule);
  useEffect(() => {
    if (dirty) {
      return;
    }
    if (staleFingerprint !== null) {
      if (liveFingerprint === staleFingerprint) {
        return;
      }
      setStaleFingerprint(null);
    }
    setDraft(draftFromSchedule(schedule));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint stands in for the object
  }, [liveFingerprint, dirty, staleFingerprint]);

  const now = Date.now();
  const hasAnyDate = SERVICE_SCHEDULE_KEYS.some(
    (key) => schedule?.[key]?.nextDue !== undefined,
  );

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    // manageBuilding REPLACES the serviceSchedule node with whatever it is
    // given, so the payload must carry every key. Only the keys the admin
    // actually edited come from the draft; the rest are taken from the LATEST
    // live snapshot, so this save does not clobber a concurrent edit to a key
    // the admin never touched. Keys cleared in the form are omitted entirely
    // (absent means "not set").
    const nextSchedule: ServiceSchedule = {};
    for (const key of SERVICE_SCHEDULE_KEYS) {
      if (editedKeys.has(key)) {
        const millis = fromDateInputValue(draft[key]);
        if (millis !== undefined) {
          nextSchedule[key] = { nextDue: millis };
        }
      } else {
        const nextDue = schedule?.[key]?.nextDue;
        if (nextDue !== undefined) {
          nextSchedule[key] = { nextDue };
        }
      }
    }
    const result = await manage.call({
      action: 'update',
      siteId,
      buildingId,
      building: { serviceSchedule: nextSchedule },
    });
    if (result) {
      // Show exactly what was submitted, and record the pre-save fingerprint
      // so the seeding effect does not revert the draft from a stale snapshot.
      setStaleFingerprint(scheduleFingerprint(schedule));
      setDraft(draftFromSchedule(nextSchedule));
      setEditedKeys(new Set());
      setSaved(true);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="service-schedule-heading">
      <h2 id="service-schedule-heading" className={styles.heading}>
        Service schedule
      </h2>

      {buildingQuery.isError && (
        <ErrorNotice message="Could not load the service schedule. Please try again." />
      )}

      {!hasAnyDate && !buildingQuery.isLoading && !buildingQuery.isError && (
        <p className={styles.emptyNote}>
          {isAdmin
            ? 'No service dates are recorded yet. They appear after the first assessment, or you can set them now.'
            : 'No service dates are recorded yet. They appear after the first assessment.'}
        </p>
      )}

      <form className={styles.form} onSubmit={(event) => void onSave(event)}>
        <ul className={styles.list}>
          {SERVICE_SCHEDULE_KEYS.map((key) => {
            const nextDue = schedule?.[key]?.nextDue;
            const status = dueStatus(nextDue, now);
            return (
              <li key={key} className={styles.row}>
                <div className={styles.rowInfo}>
                  <span className={styles.serviceLabel} id={`service-${key}-label`}>
                    {SERVICE_LABELS[key]}
                  </span>
                  <span
                    className={[
                      styles.dueDate,
                      status === 'overdue' ? styles.overdueText : '',
                      status === 'dueSoon' ? styles.dueSoonText : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {nextDue !== undefined ? formatDate(nextDue) : 'Not set'}
                  </span>
                  {status === 'overdue' && (
                    <span className={styles.overdueBadge}>Overdue</span>
                  )}
                  {status === 'dueSoon' && (
                    <span className={styles.dueSoonBadge}>Due soon</span>
                  )}
                </div>
                {isAdmin && (
                  <div className={styles.rowEdit}>
                    <label
                      className={styles.dateLabel}
                      htmlFor={`service-date-${key}`}
                    >
                      Next due
                    </label>
                    <input
                      id={`service-date-${key}`}
                      className={styles.dateInput}
                      type="date"
                      value={draft[key]}
                      aria-describedby={`service-${key}-label`}
                      onChange={(event) => {
                        const next = event.target.value;
                        setDraft((current) => ({ ...current, [key]: next }));
                        setEditedKeys((current) => new Set(current).add(key));
                        setSaved(false);
                      }}
                      disabled={manage.pending}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {manage.error && (
          <p role="alert" className={styles.inlineError}>
            {manage.error}
          </p>
        )}
        {saved && (
          <p role="status" className={styles.success}>
            Service schedule saved.
          </p>
        )}

        {isAdmin && (
          <div className={styles.actions}>
            <Button type="submit" disabled={manage.pending || !dirty}>
              {manage.pending ? 'Saving' : 'Save changes'}
            </Button>
          </div>
        )}
      </form>

      <p className={styles.footnote}>
        Assessors confirm these dates during every assessment; edits here keep
        the calendar accurate between visits.
      </p>
    </section>
  );
}
