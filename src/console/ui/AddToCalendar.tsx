// ============================================================================
// AddToCalendar - the two ways a person gets a scheduled visit into their own
// calendar, offered plainly side by side rather than hidden behind a menu.
//
// "Add to calendar" downloads the .ics (Apple Calendar, Outlook, Thunderbird -
// the file IS the event, so it works offline and carries everything). "Google
// Calendar" opens a pre-filled event in a new tab, because Google's web app
// will not take a local .ics without a detour through Gmail.
//
// Two visible controls beat one menu here: the choice is between two named
// products a person already knows they use, and a menu would add a click, a
// focus trap and an aria-expanded state to a decision nobody has to think about.
// ============================================================================

import { Button } from '../../components/Button';
import {
  downloadIcs,
  googleCalendarUrl,
  type CalendarEvent,
} from '../lib/calendarEvent';
import styles from './AddToCalendar.module.css';

export interface AddToCalendarProps {
  event: CalendarEvent;
  /** Download name, without the extension; the helper adds .ics. */
  fileName: string;
}

export function AddToCalendar({ event, fileName }: AddToCalendarProps) {
  return (
    <div className={styles.row}>
      <Button variant="secondary" onClick={() => downloadIcs(event, fileName)}>
        Add to calendar
      </Button>
      <Button
        variant="ghost"
        href={googleCalendarUrl(event)}
        target="_blank"
        rel="noreferrer"
      >
        Google Calendar
      </Button>
    </div>
  );
}
