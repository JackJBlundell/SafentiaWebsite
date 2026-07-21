// ============================================================================
// AccountPage - the signed-in user's own settings: display name, email
// (read-only; email is the sign-in identity and changing it is a support
// operation, not a form field), and password change.
//
// Password change requires the CURRENT password because Firebase demands a
// recent sign-in for credential changes; asking up front turns a confusing
// mid-flow re-authentication error into a plain form field. The AuthProvider's
// changePassword(currentPassword, newPassword) owns that re-auth dance.
// ============================================================================

import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { keys } from '../query/keys';
import { useRtdbQuery } from '../query/useRtdbQuery';
import { useCallable } from './ui/useCallable';
import type {
  OrgMember,
  UpdateMyPreferencesInput,
  UpdateMyPreferencesResult,
} from '../types';
import styles from './AccountPage.module.css';

/** Firebase's own minimum; validating locally gives an instant, plain message
 *  instead of a round-trip error code. */
const MIN_PASSWORD_LENGTH = 6;

export function AccountPage() {
  const { user, claims, signOut } = useAuth();
  // Email preferences live on the caller's OrgMember record, which only staff
  // sessions have - portal users' notification choices await portal settings.
  const isStaff = Boolean(claims && claims.kind !== 'portal');

  return (
    <div className={styles.root}>
      <h1 className={styles.heading}>Account settings</h1>

      <section className={styles.card} aria-labelledby="profile-heading">
        <h2 id="profile-heading" className={styles.cardHeading}>
          Profile
        </h2>
        <DisplayNameForm />
        <div className={styles.field}>
          <label className={styles.label} htmlFor="account-email">
            Email
          </label>
          <input
            id="account-email"
            className={styles.input}
            type="email"
            value={user?.email ?? ''}
            readOnly
            // Read-only, not disabled: a disabled field is skipped by screen
            // readers and cannot be copied from.
            aria-describedby="account-email-note"
          />
          <p id="account-email-note" className={styles.note}>
            Your email is your sign-in identity and cannot be changed here.
          </p>
        </div>
      </section>

      {isStaff && (
        <section className={styles.card} aria-labelledby="email-prefs-heading">
          <h2 id="email-prefs-heading" className={styles.cardHeading}>
            Email preferences
          </h2>
          <EmailPreferencesForm />
        </section>
      )}

      <section className={styles.card} aria-labelledby="password-heading">
        <h2 id="password-heading" className={styles.cardHeading}>
          Change password
        </h2>
        <PasswordForm />
      </section>

      <section className={styles.card} aria-labelledby="session-heading">
        <h2 id="session-heading" className={styles.cardHeading}>
          Session
        </h2>
        <Button variant="secondary" onClick={() => void signOut()}>
          Sign out
        </Button>
      </section>
    </div>
  );
}

function DisplayNameForm() {
  const { user, updateDisplayName } = useAuth();
  const [name, setName] = useState(user?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a display name.');
      setSaved(false);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateDisplayName(trimmed);
      setSaved(true);
    } catch {
      setError('Could not save your display name. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="display-name">
          Display name
        </label>
        <input
          id="display-name"
          className={styles.input}
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className={styles.success}>
          Display name saved.
        </p>
      )}
      <Button type="submit" disabled={saving}>
        {saving ? 'Saving' : 'Save name'}
      </Button>
    </form>
  );
}

/** The four non-transactional email categories a member may quieten (story
 *  2066), each described honestly by who actually receives that category
 *  today. Seeded from the member's own record (self-read; the rules grant a
 *  member their own orgMembers node) and saved through the self-scoped
 *  updateMyPreferences callable. Absent means ON, so only a stored false
 *  unticks a box. */
function EmailPreferencesForm() {
  const { user, claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const uid = user?.uid ?? '';
  const enabled = Boolean(claims && paths && uid);

  const member = useRtdbQuery<OrgMember | null>({
    key: keys.orgMember(orgId, uid),
    path: paths ? paths.db.orgMember(orgId, uid) : '',
    enabled,
  });
  const update = useCallable<
    UpdateMyPreferencesInput,
    UpdateMyPreferencesResult
  >('updateMyPreferences');

  const [seeded, setSeeded] = useState(false);
  const [reviewDue, setReviewDue] = useState(true);
  const [actionAssigned, setActionAssigned] = useState(true);
  const [awaitingValidation, setAwaitingValidation] = useState(true);
  const [released, setReleased] = useState(true);
  const [saved, setSaved] = useState(false);

  // Seed once from the first snapshot: absent preferences mean every category
  // is on (the contract default), so only an explicit false unticks.
  useEffect(() => {
    if (seeded || member.data === undefined) {
      return;
    }
    const stored = member.data?.emailPreferences;
    setReviewDue(stored?.reviewDue !== false);
    setActionAssigned(stored?.actionAssigned !== false);
    setAwaitingValidation(stored?.awaitingValidation !== false);
    setReleased(stored?.released !== false);
    setSeeded(true);
  }, [seeded, member.data]);

  const onSave = async () => {
    setSaved(false);
    const result = await update.call({
      emailPreferences: {
        reviewDue,
        actionAssigned,
        awaitingValidation,
        released,
      },
    });
    if (result) {
      setSaved(true);
    }
  };

  const toggles: Array<{
    id: string;
    label: string;
    note: string;
    checked: boolean;
    set: (value: boolean) => void;
  }> = [
    {
      id: 'pref-review-due',
      label: 'Reviews due',
      note: 'Reminders when a fire risk assessment review is approaching or overdue. Sent to administrators.',
      checked: reviewDue,
      set: setReviewDue,
    },
    {
      id: 'pref-action-assigned',
      label: 'Actions assigned',
      note: 'For future assignment of actions to staff members. Today, assignment email goes to the responsible party at the customer, not to members.',
      checked: actionAssigned,
      set: setActionAssigned,
    },
    {
      id: 'pref-awaiting-validation',
      label: 'Assessments awaiting validation',
      note: 'When an assessor submits an assessment for review. Applies to the auditor role.',
      checked: awaitingValidation,
      set: setAwaitingValidation,
    },
    {
      id: 'pref-released',
      label: 'Released reports',
      note: 'When a validated assessment is released and its report becomes available. Sent to administrators.',
      checked: released,
      set: setReleased,
    },
  ];

  return (
    <div className={styles.form}>
      {toggles.map((toggle) => (
        <div key={toggle.id} className={styles.field}>
          <label className={styles.toggle} htmlFor={toggle.id}>
            <input
              id={toggle.id}
              type="checkbox"
              checked={toggle.checked}
              onChange={(event) => {
                setSaved(false);
                toggle.set(event.target.checked);
              }}
            />
            <span>{toggle.label}</span>
          </label>
          <p className={styles.note}>{toggle.note}</p>
        </div>
      ))}
      <p className={styles.note}>Security and account email always sends.</p>
      {update.error && (
        <p role="alert" className={styles.error}>
          {update.error}
        </p>
      )}
      {saved && (
        <p role="status" className={styles.success}>
          Email preferences saved.
        </p>
      )}
      <Button onClick={() => void onSave()} disabled={update.pending || !seeded}>
        {update.pending ? 'Saving' : 'Save preferences'}
      </Button>
    </div>
  );
}

function PasswordForm() {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    if (!current) {
      setError('Enter your current password.');
      return;
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await changePassword(current, next);
      setSaved(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch {
      // The commonest failure by far is a wrong current password; say so
      // plainly rather than relaying an SDK error code.
      setError(
        'Could not change your password. Check your current password and try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="current-password">
          Current password
        </label>
        <input
          id="current-password"
          className={styles.input}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          className={styles.input}
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          className={styles.input}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className={styles.success}>
          Your password has been changed.
        </p>
      )}
      <Button type="submit" disabled={saving}>
        {saving ? 'Changing password' : 'Change password'}
      </Button>
    </form>
  );
}
