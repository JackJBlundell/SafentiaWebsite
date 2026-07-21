// ============================================================================
// ScheduleTimeline - one assessor's day as a vertical timeline, so an operator
// picks a slot by SEEING the diary rather than guessing times into inputs.
//
// Data: an indexed one-day window over /jobs (orderByChild('scheduledFor')
// bounded to the local day, `.indexOn: scheduledFor`), filtered client-side to
// the assessor. No name-resolution fan-out: blocks are labelled by the optional
// `labelForJob` callback from data the parent already holds, else "Booked".
//
// Conflicts: the proposal tints with --status-error and a line names the clash.
// This MIRRORS the server rule (half-open [scheduledFor, scheduledUntil)
// overlap per assessor; date-only jobs without scheduledUntil never clash -
// see functions/src/lib/jobSlots.ts). It is advisory only: the server stays
// authoritative and its rejection is still surfaced verbatim by the parent.
//
// Accessibility: the paired time inputs in the parent remain the primary
// accessible path. The day itself is a role="img" with a summary label; the
// proposal block is additionally focusable with arrow-key nudging (Up/Down
// move by 15 minutes, Shift+Up/Down resize) - honest, without exposing 48
// fifteen-minute tab stops.
// ============================================================================

import { useMemo, useRef } from 'react';
import { orderByChild, query, startAt, endAt } from 'firebase/database';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type { Job } from '../../types';
import { useOrgScope } from '../customers/shared';
import { formatSlot, formatTime, SLOT_MINUTES } from './shared';
import styles from './ScheduleTimeline.module.css';

// Visible working window. Jobs outside it are clamped to its edges so nothing
// scheduled is ever invisible; widen here if operators book outside these hours.
const DAY_START_HOUR = 7;
const DAY_END_HOUR = 19;
const WINDOW_START_MIN = DAY_START_HOUR * 60;
const WINDOW_END_MIN = DAY_END_HOUR * 60;
const WINDOW_MINUTES = WINDOW_END_MIN - WINDOW_START_MIN;

/** Default proposal length when the operator clicks with no times chosen. */
const DEFAULT_DURATION_MIN = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

interface DayJob extends Job {
  id: string;
}

/** The day's jobs in ascending `scheduledFor` order (earliest first), derived
 *  from the field rather than snapshot iteration since the selector runs off the
 *  cached raw value. */
function selectDayJobs(value: unknown): DayJob[] {
  const node = (value as Record<string, Job> | null) ?? {};
  return Object.entries(node)
    .map(([id, job]) => ({ id, ...job }))
    .sort((a, b) => a.scheduledFor - b.scheduledFor);
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const snapMinutes = (minutes: number) =>
  Math.round(minutes / SLOT_MINUTES) * SLOT_MINUTES;

/** Vertical position of a minute-of-day inside the window, as a percentage. */
const topPercent = (minutes: number) =>
  ((clamp(minutes, WINDOW_START_MIN, WINDOW_END_MIN) - WINDOW_START_MIN) /
    WINDOW_MINUTES) *
  100;

export interface ScheduleTimelineProps {
  assessorUid: string;
  assessorName?: string;
  /** yyyy-mm-dd, local (the same convention as the paired date input). */
  date: string;
  /** The proposed slot, or null when no valid proposal exists yet. */
  startMs: number | null;
  endMs: number | null;
  onSlotChange: (startMs: number, endMs: number) => void;
  /** Reschedule case: the job being moved must not conflict with itself. */
  excludeJobId?: string;
  /** Cheap label lookup from data the parent already loaded; no fan-out. */
  labelForJob?: (job: Job) => string | undefined;
}

export function ScheduleTimeline({
  assessorUid,
  assessorName,
  date,
  startMs,
  endMs,
  onSlotChange,
  excludeJobId,
  labelForJob,
}: ScheduleTimelineProps) {
  const { ready, orgId, db } = useOrgScope();

  const dayStartMs = useMemo(() => new Date(`${date}T00:00:00`).getTime(), [date]);
  const enabled = ready && Boolean(date) && Number.isFinite(dayStartMs);

  // One local day of jobs, via the scheduledFor index; never the whole subtree.
  const buildDay = useMemo<RtdbQueryBuilder>(
    () => (node) =>
      query(
        node,
        orderByChild('scheduledFor'),
        startAt(dayStartMs),
        endAt(dayStartMs + DAY_MS - 1),
      ),
    [dayStartMs],
  );
  const dayQuery = useRtdbQuery<DayJob[]>({
    key: keys.jobsForDay(orgId, dayStartMs),
    path: db ? db.jobs(orgId) : '',
    select: selectDayJobs,
    enabled,
    build: buildDay,
  });

  // This assessor's live bookings; cancelled visits and (when rescheduling)
  // the job being moved do not occupy the day.
  const dayJobs = useMemo(
    () =>
      (dayQuery.data ?? []).filter(
        (job) =>
          job.assessorUid === assessorUid &&
          job.status !== 'cancelled' &&
          job.id !== excludeJobId,
      ),
    [dayQuery.data, assessorUid, excludeJobId],
  );

  // Proposal in minutes-of-day, derived from the epoch props.
  const proposal = useMemo(() => {
    if (startMs === null || endMs === null || !(endMs > startMs)) {
      return null;
    }
    return {
      start: Math.round((startMs - dayStartMs) / 60000),
      end: Math.round((endMs - dayStartMs) / 60000),
    };
  }, [startMs, endMs, dayStartMs]);

  // Client-side mirror of the server clash rule: half-open interval overlap;
  // date-only jobs (no scheduledUntil) never clash. Advisory only - the server
  // remains the authority and its rejection is surfaced by the parent.
  const conflicts = useMemo(() => {
    if (!proposal) {
      return [];
    }
    const proposalStart = dayStartMs + proposal.start * 60000;
    const proposalEnd = dayStartMs + proposal.end * 60000;
    return dayJobs.filter(
      (job) =>
        job.scheduledUntil !== undefined &&
        job.scheduledFor < proposalEnd &&
        job.scheduledUntil > proposalStart,
    );
  }, [dayJobs, proposal, dayStartMs]);

  const emitMinutes = (startMin: number, endMin: number) => {
    onSlotChange(dayStartMs + startMin * 60000, dayStartMs + endMin * 60000);
  };

  /** Place (or move) the proposal so it starts at the snapped minute, keeping
   *  the current duration, and stays inside the visible window. */
  const placeAt = (rawMinute: number) => {
    const duration = proposal ? proposal.end - proposal.start : DEFAULT_DURATION_MIN;
    const start = clamp(
      snapMinutes(rawMinute),
      WINDOW_START_MIN,
      WINDOW_END_MIN - duration,
    );
    emitMinutes(start, start + duration);
  };

  // --- Pointer interaction ----------------------------------------------------

  const dayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    mode: 'move' | 'resize';
    pointerId: number;
    originY: number;
    origStart: number;
    origEnd: number;
  } | null>(null);

  const minuteAtClientY = (clientY: number): number => {
    const rect = dayRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) {
      return WINDOW_START_MIN;
    }
    const ratio = clamp((clientY - rect.top) / rect.height, 0, 1);
    return WINDOW_START_MIN + ratio * WINDOW_MINUTES;
  };

  const handleDayPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Clicking a free position places the start there (snapped); dragging the
    // proposal itself is handled below and stops propagation.
    placeAt(minuteAtClientY(event.clientY));
  };

  const beginDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    mode: 'move' | 'resize',
  ) => {
    if (!proposal) {
      return;
    }
    event.stopPropagation();
    dragRef.current = {
      mode,
      pointerId: event.pointerId,
      originY: event.clientY,
      origStart: proposal.start,
      origEnd: proposal.end,
    };
    // Pointer capture keeps the drag alive when the cursor leaves the block.
    // Guarded: jsdom (tests) does not implement it.
    const target = event.currentTarget;
    if (typeof target.setPointerCapture === 'function') {
      target.setPointerCapture(event.pointerId);
    }
  };

  const handleDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const rect = dayRef.current?.getBoundingClientRect();
    if (!drag || drag.pointerId !== event.pointerId || !rect || rect.height <= 0) {
      return;
    }
    const deltaMin = snapMinutes(
      ((event.clientY - drag.originY) / rect.height) * WINDOW_MINUTES,
    );
    if (drag.mode === 'move') {
      const duration = drag.origEnd - drag.origStart;
      const start = clamp(
        drag.origStart + deltaMin,
        WINDOW_START_MIN,
        WINDOW_END_MIN - duration,
      );
      emitMinutes(start, start + duration);
    } else {
      const end = clamp(
        drag.origEnd + deltaMin,
        drag.origStart + SLOT_MINUTES,
        WINDOW_END_MIN,
      );
      emitMinutes(drag.origStart, end);
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  // --- Keyboard interaction (the proposal block) -------------------------------

  const handleProposalKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!proposal || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return;
    }
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? SLOT_MINUTES : -SLOT_MINUTES;
    if (event.shiftKey) {
      // Shift resizes: the end nudges, never below one slot.
      const end = clamp(
        proposal.end + step,
        proposal.start + SLOT_MINUTES,
        WINDOW_END_MIN,
      );
      emitMinutes(proposal.start, end);
    } else {
      const duration = proposal.end - proposal.start;
      const start = clamp(
        proposal.start + step,
        WINDOW_START_MIN,
        WINDOW_END_MIN - duration,
      );
      emitMinutes(start, start + duration);
    }
  };

  // --- Render -------------------------------------------------------------------

  const hours = useMemo(() => {
    const list: number[] = [];
    for (let hour = DAY_START_HOUR; hour <= DAY_END_HOUR; hour += 1) {
      list.push(hour);
    }
    return list;
  }, []);

  const whose = assessorName ? `${assessorName}'s day` : "The assessor's day";
  const daySummary =
    dayJobs.length === 0
      ? `${whose}: no existing visits. Click a free time to place the visit.`
      : `${whose}: ${dayJobs.length} existing ${
          dayJobs.length === 1 ? 'visit' : 'visits'
        } between ${formatTime(Math.min(...dayJobs.map((job) => job.scheduledFor)))} and ${formatTime(
          Math.max(...dayJobs.map((job) => job.scheduledUntil ?? job.scheduledFor)),
        )}.`;

  const proposalLabel = proposal
    ? `Proposed slot, ${formatSlot(
        dayStartMs + proposal.start * 60000,
        dayStartMs + proposal.end * 60000,
      )}.${conflicts.length > 0 ? ' Clashes with an existing visit.' : ''} Arrow keys move by 15 minutes; hold Shift to resize.`
    : '';

  return (
    <div className={styles.root}>
      <div className={styles.frame}>
        {/* The day itself: a summarising image for assistive tech (the paired
            time inputs are the accessible editing path). */}
        <div
          ref={dayRef}
          className={styles.day}
          role="img"
          aria-label={daySummary}
          onPointerDown={handleDayPointerDown}
        >
          {hours.map((hour) => (
            <div
              key={hour}
              className={styles.hourLine}
              style={{ top: `${topPercent(hour * 60)}%` }}
            >
              <span className={styles.hourLabel} aria-hidden="true">
                {String(hour).padStart(2, '0')}:00
              </span>
            </div>
          ))}

          {dayJobs.map((job) => {
            // Date-only jobs (no scheduledUntil) render as a one-slot sliver;
            // per the server rule they never clash, but they should be seen.
            const startMin = (job.scheduledFor - dayStartMs) / 60000;
            const endMin =
              job.scheduledUntil !== undefined
                ? (job.scheduledUntil - dayStartMs) / 60000
                : startMin + SLOT_MINUTES;
            const top = topPercent(startMin);
            const bottom = topPercent(endMin);
            return (
              <div
                key={job.id}
                className={styles.booked}
                style={{ top: `${top}%`, height: `${Math.max(bottom - top, 1)}%` }}
              >
                <span className={styles.blockName}>
                  {labelForJob?.(job) ?? 'Booked'}
                </span>
                <span className={styles.blockTimes}>
                  {formatSlot(job.scheduledFor, job.scheduledUntil)}
                </span>
              </div>
            );
          })}
        </div>

        {proposal && (
          <div
            className={
              conflicts.length > 0
                ? `${styles.proposal} ${styles.proposalConflict}`
                : styles.proposal
            }
            style={{
              top: `${topPercent(proposal.start)}%`,
              height: `${topPercent(proposal.end) - topPercent(proposal.start)}%`,
            }}
            tabIndex={0}
            aria-label={proposalLabel}
            onKeyDown={handleProposalKeyDown}
            onPointerDown={(event) => beginDrag(event, 'move')}
            onPointerMove={handleDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span className={styles.blockName}>Proposed visit</span>
            <span className={styles.blockTimes}>
              {formatSlot(
                dayStartMs + proposal.start * 60000,
                dayStartMs + proposal.end * 60000,
              )}
            </span>
            <div
              className={styles.resizeHandle}
              aria-hidden="true"
              onPointerDown={(event) => beginDrag(event, 'resize')}
              onPointerMove={handleDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <span className={styles.resizeGrip} />
            </div>
          </div>
        )}
      </div>

      {/* Advisory clash line, mirroring the server rule; the server's own
          rejection remains the final authority and keeps its role=alert in the
          parent. This is guidance, not an error state, hence no alert role. */}
      {conflicts.map((job) => (
        <p key={job.id} className={styles.conflictLine}>
          Clashes with {labelForJob?.(job) ?? 'an existing visit'},{' '}
          {formatSlot(job.scheduledFor, job.scheduledUntil)}. Pick a free gap, or
          the server will refuse the slot.
        </p>
      ))}

      {!proposal && (
        <p className={styles.placeLine}>
          Click a free time to place the visit, or type the times above.
        </p>
      )}
    </div>
  );
}
