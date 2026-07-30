// ============================================================================
// calendarEvent - put a scheduled visit into whatever calendar the person uses.
//
// TWO ROUTES, because the web has no single answer:
//   - a downloaded .ics file, which Apple Calendar, Outlook (desktop and web)
//     and Thunderbird all import on open. This is the honest default: it works
//     offline, needs no account, and carries the full event;
//   - a Google Calendar "template" URL, which opens a pre-filled new-event page
//     in the browser. Google's web app does not import .ics from a local file
//     without a round trip through Gmail, so the link is what makes it one click
//     for a Google user.
//
// The event carries a STABLE uid derived from the job, so a person who adds the
// same visit twice - or adds it again after a reschedule - gets an update to the
// event they already have rather than a duplicate in their week.
//
// Times are emitted in UTC (the trailing Z form). The visit is stored as epoch
// millis, so UTC is the only reading that cannot drift; every calendar renders
// it back in the viewer's own timezone.
//
// This mirrors the mobile app's features/jobs/calendar.ts deliberately: same
// PRODID, same uid convention, same two-hour default, so a job added from the
// app and from the console is ONE event, not two.
// ============================================================================

/** Visit length assumed when a job has no explicit end, in minutes. */
export const DEFAULT_DURATION_MINUTES = 120;

export interface CalendarEvent {
  /** Stable per-job identity, so re-adding updates rather than duplicates. */
  uid: string;
  startMs: number;
  endMs: number;
  title: string;
  location?: string;
  description?: string;
}

/** Epoch millis -> the iCalendar UTC stamp: YYYYMMDDTHHMMSSZ. */
function toIcsUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** Escape a text value for an iCalendar property (RFC 5545 section 3.3.11). */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** The visit's end: its booked slot end, or the default block after the start. */
export function resolveEnd(startMs: number, until: number | undefined): number {
  return until && until > startMs
    ? until
    : startMs + DEFAULT_DURATION_MINUTES * 60 * 1000;
}

/** The .ics document for one event. Pure, so it is unit-testable; CRLF-joined
 *  per the spec, which Outlook in particular is strict about. */
export function buildIcs(event: CalendarEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Safentia//Fire Risk Assessment//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${toIcsUtc(Date.now())}`,
    `DTSTART:${toIcsUtc(event.startMs)}`,
    `DTEND:${toIcsUtc(event.endMs)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

/** A pre-filled Google Calendar new-event page for this visit. */
export function googleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${toIcsUtc(event.startMs)}/${toIcsUtc(event.endMs)}`,
  });
  // The optional parts are set only when present: an undefined value passed to
  // URLSearchParams would arrive in someone's calendar as the word "undefined".
  if (event.description) {
    params.set('details', event.description);
  }
  if (event.location) {
    params.set('location', event.location);
  }
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Hand the .ics to the browser as a download. The object URL is revoked on the
 * next tick rather than immediately: several browsers cancel an in-flight
 * download when the URL is revoked in the same frame as the click.
 */
export function downloadIcs(event: CalendarEvent, fileName: string): void {
  const blob = new Blob([buildIcs(event)], {
    type: 'text/calendar;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName.endsWith('.ics') ? fileName : `${fileName}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
