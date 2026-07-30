// ============================================================================
// NotificationSettingsPage - every reminder the platform sends on a schedule,
// configured in one place (stories 2046 AC1 / 2071).
//
// Three sweeps chase three dated commitments, and each ran its own hardcoded
// ladder of day offsets: FRA reviews (reviewReminders), open information
// requests and open actions (deadlineReminders). All three are now org-tunable
// here, one section each: a master switch and the marks the sweep fires on.
//
// The marks are PICKED, not typed. The previous control was a comma-separated
// text field, which asked an admin to know the server's rules (descending, whole
// numbers, capped, in range) and got them wrong silently until save. Toggle
// chips make every rule structural instead: the offered offsets are already in
// range, the selection is held descending, and the cap is enforced by disabling
// what cannot be chosen - so the only reachable invalid state is "none chosen",
// which the page names plainly. The selection is still checked with the SHARED
// validator (isValidReminderDays over the same rule set the callable and the
// sweeps use) before it is sent: the server remains the boundary, and the two
// cannot drift because there is one definition, mirrored byte-for-byte into
// functions/src/lib/reminderSchedules.ts.
//
// The overdue ("lapsed") notice is deliberately absent from every schedule: it
// is sent once, the day after a deadline passes, and only the master switch
// stops it. The copy says so rather than leaving an admin hunting for it.
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
import {
  isValidReminderDays,
  reminderDayOptions,
  resolveReminderDays,
  ACTION_REMINDER_RULES,
  INFO_REQUEST_REMINDER_RULES,
  REVIEW_REMINDER_RULES,
  type ReminderScheduleRules,
} from './reminderSchedules';
import styles from './NotificationSettingsPage.module.css';

/** "7 days" / "1 day" - the offsets read as English wherever they appear. */
function dayLabel(day: number): string {
  return `${day} ${day === 1 ? 'day' : 'days'}`;
}

interface ReminderSectionProps {
  /** Distinguishes this section's control ids from its siblings' on one page. */
  idBase: string;
  title: string;
  hint: string;
  rules: ReminderScheduleRules;
  /** The org's stored values, and whether the settings snapshot has attached.
   *  Seeding waits for `ready` so an admin never edits placeholder defaults that
   *  are then overwritten by the record arriving a moment later. */
  ready: boolean;
  storedDays: number[] | undefined;
  storedEnabled: boolean | undefined;
  switchLabel: string;
  switchNote: string;
  scheduleLabel: string;
  scheduleNote: string;
  /** What the always-sent overdue chip says for this concern. */
  overdueLabel: string;
  /** What the preview says instead when the category is switched off. */
  offLabel: string;
  footnote: string;
  /** Built explicitly per section so only defined fields are sent: the callable
   *  transport encodes `undefined` as null, and a null where a boolean belongs
   *  would be rejected as invalid rather than ignored. */
  buildSave: (days: number[], enabled: boolean) => UpdateOrgSettingsInput;
  buildReset: () => UpdateOrgSettingsInput;
}

function ReminderSection({
  idBase,
  title,
  hint,
  rules,
  ready,
  storedDays,
  storedEnabled,
  switchLabel,
  switchNote,
  scheduleLabel,
  scheduleNote,
  overdueLabel,
  offLabel,
  footnote,
  buildSave,
  buildReset,
}: ReminderSectionProps) {
  const update = useCallable<UpdateOrgSettingsInput, UpdateOrgSettingsResult>(
    'updateOrgSettings',
  );

  const [seeded, setSeeded] = useState(false);
  const [days, setDays] = useState<number[]>(() => [...rules.defaults]);
  // Absent in the record means ON - an org that has never opened this page still
  // gets its reminders - so only an explicit false is off, exactly as the sweep
  // reads it.
  const [enabled, setEnabled] = useState(true);
  const [saved, setSaved] = useState(false);
  // The offsets on offer are fixed at seed time rather than recomputed from the
  // live selection: a schedule saved through the old free-text field may hold a
  // mark the standard list does not offer, and that chip has to stay on screen
  // after it is deselected so the admin can put it back within the session.
  const [options, setOptions] = useState<number[]>(() =>
    reminderDayOptions(rules, rules.defaults),
  );

  useEffect(() => {
    if (seeded || !ready) {
      return;
    }
    const resolved = resolveReminderDays(storedDays, rules);
    setDays([...resolved]);
    setOptions(reminderDayOptions(rules, resolved));
    setEnabled(storedEnabled !== false);
    setSeeded(true);
  }, [seeded, ready, storedDays, storedEnabled, rules]);

  // The control cannot produce an out-of-range or out-of-order schedule, but the
  // shared validator still decides: it is the same function the callable runs,
  // so what the page calls valid and what the server accepts are one rule.
  const valid = useMemo(() => isValidReminderDays(days, rules), [days, rules]);
  const atCap = days.length >= rules.maxMarks;

  const toggleDay = (day: number) => {
    setSaved(false);
    setDays((current) =>
      current.includes(day)
        ? current.filter((entry) => entry !== day)
        : // Re-sorted descending on every add, which is the stored contract and
          // what the validator checks.
          [...current, day].sort((a, b) => b - a),
    );
  };

  const onSave = async () => {
    if (!valid) {
      return;
    }
    setSaved(false);
    // The switch and the schedule save together: they are one decision on one
    // screen, and saving half of it would leave the section disagreeing with the
    // record it just wrote.
    const result = await update.call(buildSave(days, enabled));
    if (result) {
      setSaved(true);
    }
  };

  const onReset = async () => {
    setSaved(false);
    // Explicit null clears the stored schedule so the org falls back to the
    // built-in default; reflect that in the control too. The master switch is
    // left as it is: resetting a schedule is not the same decision as turning a
    // whole category back on.
    const result = await update.call(buildReset());
    if (result) {
      setDays([...rules.defaults]);
      setSaved(true);
    }
  };

  return (
    <Card>
      <CardHeader title={title} hint={hint} />
      <div className={styles.cardBody}>
        <div className={styles.field}>
          <label className={styles.toggle} htmlFor={`${idBase}-enabled`}>
            <input
              id={`${idBase}-enabled`}
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                setSaved(false);
                setEnabled(event.target.checked);
              }}
            />
            <span>{switchLabel}</span>
          </label>
          <p className={styles.note}>{switchNote}</p>
        </div>

        <div
          className={enabled ? styles.field : `${styles.field} ${styles.disabled}`}
        >
          <span className={styles.label} id={`${idBase}-days-label`}>
            {scheduleLabel}
          </span>
          <div
            className={styles.choices}
            role="group"
            aria-labelledby={`${idBase}-days-label`}
            aria-describedby={`${idBase}-days-hint`}
          >
            {options.map((day) => {
              const active = days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={[styles.choice, active ? styles.choiceActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={active}
                  // At the cap, only removing a mark is available; the disabled
                  // chip says that better than a click that does nothing.
                  disabled={!active && atCap}
                  onClick={() => toggleDay(day)}
                >
                  {dayLabel(day)}
                </button>
              );
            })}
          </div>
          <p id={`${idBase}-days-hint`} className={styles.note}>
            {scheduleNote} Choose up to {rules.maxMarks} marks.
          </p>
          {atCap && (
            <p role="status" className={styles.note}>
              That is the most marks this reminder can have. Clear one to choose
              another.
            </p>
          )}
        </div>

        {valid ? (
          <div className={styles.field}>
            <span className={styles.label}>Reminders will be sent</span>
            <ul className={styles.chipList} aria-label={`${title} schedule`}>
              {days.map((day) => (
                <li key={day} className={styles.chip}>
                  {dayLabel(day)} before
                </li>
              ))}
              <li className={`${styles.chip} ${styles.chipOverdue}`}>
                {enabled ? overdueLabel : offLabel}
              </li>
            </ul>
          </div>
        ) : (
          // A schedule is always stored, whether or not the category is on, so
          // an empty one is refused either way - but the way out of the state
          // differs, and the copy says which one the reader is in.
          <ErrorNotice
            message={
              enabled
                ? 'Choose at least one reminder, or turn this category off above.'
                : 'Choose at least one reminder. The schedule is kept while the category is off, ready for when you turn it back on.'
            }
          />
        )}

        {update.error && <ErrorNotice message={update.error} />}
        {saved && (
          <p role="status" className={styles.success}>
            Reminder schedule saved.
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
            onClick={() => void onReset()}
          >
            Reset to default
          </Button>
        </div>

        <p className={styles.note}>{footnote}</p>
      </div>
    </Card>
  );
}

export function NotificationSettingsPage() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(claims && paths);

  const settings = useRtdbQuery<OrgSettings | null>({
    key: keys.orgSettings(orgId),
    path: paths ? paths.db.orgSettings(orgId) : '',
    enabled,
  });
  // `undefined` is "the listener has not delivered yet"; `null` is a real answer
  // meaning the org has no settings node, which seeds the built-in defaults.
  const ready = settings.data !== undefined;

  return (
    <div>
      <PageHeader
        title="Reminders"
        lede="When Safentia chases the dates your organisation is accountable for: fire risk assessment reviews, outstanding information requests and open remedial actions."
      />

      <div className={styles.sections}>
        <ReminderSection
          idBase="review-reminders"
          title="Fire risk assessment reviews"
          hint="Sent to your administrators, and to the customer at the nearer marks."
          rules={REVIEW_REMINDER_RULES}
          ready={ready}
          storedDays={settings.data?.reviewReminderDays}
          storedEnabled={settings.data?.reviewRemindersEnabled}
          switchLabel="Send review reminders"
          switchNote="Turning this off stops every fire risk assessment review reminder for your whole organisation - the marks below, the overdue notice, and the emails to your customers. Review dates are still tracked and shown on each building; nobody is emailed about them. To stop them for one customer only, archive that customer: an active customer is always told when their assessment is due."
          scheduleLabel="Days before the review is due"
          scheduleNote="We will remind you and the customer this many days before a review is due. The earliest mark goes to you only; the customer hears about the nearer ones."
          overdueLabel="Overdue notice, always sent"
          offLabel="Review reminders are currently switched off"
          footnote="The overdue reminder is sent once, the day after a review falls due, and cannot be removed from the schedule - only the switch above stops it. Resetting restores the built-in marks of 60, 30 and 7 days. Archived customers are never sent review reminders."
          buildSave={(days, on) => ({
            reviewReminderDays: days,
            reviewRemindersEnabled: on,
          })}
          buildReset={() => ({ reviewReminderDays: null })}
        />

        <ReminderSection
          idBase="info-request-reminders"
          title="Information requests"
          hint="Sent to the assessor an auditor is waiting on."
          rules={INFO_REQUEST_REMINDER_RULES}
          ready={ready}
          storedDays={settings.data?.infoRequestReminderDays}
          storedEnabled={settings.data?.infoRequestRemindersEnabled}
          switchLabel="Chase outstanding information requests"
          switchNote="When an auditor asks an assessor for more information, the assessment waits until they answer. Turning this off stops those chases for your whole organisation, overdue notices included; the request itself stays open and visible on the job."
          scheduleLabel="Days before the response is due"
          scheduleNote="The assessor is reminded this many days before their response is due. A request runs for a week by default, so short marks are the ones that fire."
          overdueLabel="Overdue notice, always sent"
          offLabel="Information request chases are currently switched off"
          footnote="One reminder per assessment, not per question: a batch of flagged questions shares one deadline and one conversation. Resetting restores the built-in marks of 3 and 1 days."
          buildSave={(days, on) => ({
            infoRequestReminderDays: days,
            infoRequestRemindersEnabled: on,
          })}
          buildReset={() => ({ infoRequestReminderDays: null })}
        />

        <ReminderSection
          idBase="action-reminders"
          title="Remedial actions"
          hint="Sent to the responsible party, with a daily digest to your administrators."
          rules={ACTION_REMINDER_RULES}
          ready={ready}
          storedDays={settings.data?.actionReminderDays}
          storedEnabled={settings.data?.actionRemindersEnabled}
          switchLabel="Chase open actions"
          switchNote="Turning this off stops the emails to the people named as responsible for each action, and the daily summary to your administrators, for your whole organisation. Actions stay open on the action plan and still count towards a building's risk rating."
          scheduleLabel="Days before the action is due"
          scheduleNote="The responsible party is emailed this many days before the work is due. An action's window runs from a week to three months depending on severity, so a longer ladder is worth having here."
          overdueLabel="Overdue notice, always sent"
          offLabel="Action chases are currently switched off"
          footnote="Your administrators receive one summary each morning covering every action that matched, however many there are; the responsible parties are emailed individually about their own buildings. Resetting restores the built-in marks of 30, 7 and 1 days."
          buildSave={(days, on) => ({
            actionReminderDays: days,
            actionRemindersEnabled: on,
          })}
          buildReset={() => ({ actionReminderDays: null })}
        />
      </div>
    </div>
  );
}
