// ============================================================================
// ReviewRemindersPage - the organisation's FRA-review reminder schedule
// (story 2046 AC1).
//
// The reminder sweep warns admins and customers a set number of days before a
// building's fire-risk-assessment review falls due. Those marks used to be
// hardcoded (60/30/7); here an admin tunes them. The schedule is entered as a
// list of day offsets, validated CLIENT-side against the exact same rules the
// callable enforces server-side (descending whole numbers, at most eight, each
// between 1 and 365), so a bad entry is caught before it is sent - the server
// is still the boundary, this is convenience. The overdue ("lapsed") notice is
// always sent and is not configurable, which the copy makes clear.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  OrgSettings,
  UpdateOrgSettingsInput,
  UpdateOrgSettingsResult,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import styles from './ReviewRemindersPage.module.css';

// These MUST match the server rules in functions/src/lib/reviewWindows so the
// client never accepts a schedule the callable would reject.
const DEFAULT_REVIEW_REMINDER_DAYS: readonly number[] = [60, 30, 7];
const MAX_REVIEW_REMINDER_DAYS = 8;
const MAX_REVIEW_REMINDER_DAY = 365;

/** Render a schedule as the editable text the admin sees, e.g. "60, 30, 7". */
function daysToText(days: readonly number[]): string {
  return days.join(', ');
}

/**
 * Parse the comma-separated text into a valid schedule, or null when it does
 * not satisfy every rule. Mirrors the server's isValidReviewReminderDays: a
 * non-empty, capped list of strictly-descending whole numbers within a year.
 * Strictly descending is enforced by comparing each entry with the previous, so
 * duplicates and out-of-order entries are both rejected in one pass.
 */
function parseReminderDays(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > MAX_REVIEW_REMINDER_DAYS) {
    return null;
  }
  const days: number[] = [];
  let previous = Number.POSITIVE_INFINITY;
  for (const part of parts) {
    const value = Number(part);
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_REVIEW_REMINDER_DAY ||
      value >= previous
    ) {
      return null;
    }
    days.push(value);
    previous = value;
  }
  return days;
}

export function ReviewRemindersPage() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(claims && paths);

  const settings = useRtdbQuery<OrgSettings | null>({
    key: keys.orgSettings(orgId),
    path: paths ? paths.db.orgSettings(orgId) : '',
    enabled,
  });

  const update = useCallable<UpdateOrgSettingsInput, UpdateOrgSettingsResult>(
    'updateOrgSettings',
  );

  // The schedule is held as TEXT so a half-typed list is not fought by a
  // formatter; seeded once from the first snapshot (the org's saved schedule or
  // the built-in default when it has none).
  const [seeded, setSeeded] = useState(false);
  const [daysText, setDaysText] = useState(
    daysToText(DEFAULT_REVIEW_REMINDER_DAYS),
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (seeded || settings.data === undefined) {
      return;
    }
    const stored = settings.data?.reviewReminderDays;
    const parsed = Array.isArray(stored) ? parseReminderDays(stored.join(',')) : null;
    setDaysText(daysToText(parsed ?? DEFAULT_REVIEW_REMINDER_DAYS));
    setSeeded(true);
  }, [seeded, settings.data]);

  const parsed = useMemo(() => parseReminderDays(daysText), [daysText]);
  const valid = parsed !== null;

  const onSave = async () => {
    if (!parsed) {
      return;
    }
    setSaved(false);
    const result = await update.call({ reviewReminderDays: parsed });
    if (result) {
      setSaved(true);
    }
  };

  const resetToDefault = async () => {
    setSaved(false);
    // Explicit null clears the stored schedule so the org falls back to the
    // built-in default; reflect that in the field too.
    const result = await update.call({ reviewReminderDays: null });
    if (result) {
      setDaysText(daysToText(DEFAULT_REVIEW_REMINDER_DAYS));
      setSaved(true);
    }
  };

  return (
    <div>
      <PageHeader
        title="Review reminders"
        lede="How far ahead of a building's fire risk assessment review we remind you and the customer."
      />

      <Card>
        <CardHeader title="Reminder schedule" />
        <div className={styles.cardBody}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="review-reminder-days">
              Days before the review is due
            </label>
            <input
              id="review-reminder-days"
              className={styles.input}
              type="text"
              inputMode="numeric"
              value={daysText}
              onChange={(event) => {
                setSaved(false);
                setDaysText(event.target.value);
              }}
              aria-describedby="review-reminder-days-hint"
              aria-invalid={!valid}
            />
            <p id="review-reminder-days-hint" className={styles.note}>
              We will remind you and the customer this many days before a review
              is due. Enter up to {MAX_REVIEW_REMINDER_DAYS} whole numbers of
              days, separated by commas and getting smaller, for example
              &ldquo;60, 30, 7&rdquo;. Each must be between 1 and{' '}
              {MAX_REVIEW_REMINDER_DAY}. The earliest reminder goes to you only;
              the customer hears about the nearer marks.
            </p>
          </div>

          {valid ? (
            <div className={styles.field}>
              <span className={styles.label}>Reminders will be sent</span>
              <ul className={styles.chipList} aria-label="Reminder schedule">
                {parsed.map((day) => (
                  <li key={day} className={styles.chip}>
                    {day} {day === 1 ? 'day' : 'days'} before
                  </li>
                ))}
                <li className={`${styles.chip} ${styles.chipOverdue}`}>
                  Overdue notice, always sent
                </li>
              </ul>
            </div>
          ) : (
            <ErrorNotice message="Enter up to eight whole numbers of days, separated by commas, getting smaller, each between 1 and 365." />
          )}

          {update.error && <ErrorNotice message={update.error} />}
          {saved && (
            <p role="status" className={styles.success}>
              Review reminder schedule saved.
            </p>
          )}

          <div className={styles.actions}>
            <Button
              disabled={!valid || update.pending || !seeded}
              onClick={() => void onSave()}
            >
              {update.pending ? 'Saving' : 'Save schedule'}
            </Button>
            <Button
              variant="ghost"
              disabled={update.pending || !seeded}
              onClick={() => void resetToDefault()}
            >
              Reset to default
            </Button>
          </div>

          <p className={styles.note}>
            The overdue reminder is always sent once, the day after a review
            falls due, and cannot be turned off. Resetting restores the built-in
            schedule of 60, 30 and 7 days.
          </p>
        </div>
      </Card>
    </div>
  );
}
