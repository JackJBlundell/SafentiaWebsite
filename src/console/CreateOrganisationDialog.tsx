// ============================================================================
// CreateOrganisationDialog - one field, one callable (story 2010).
//
// Opened from the super-admin Platform area only: until Phase 3 self-serve
// onboarding, organisations are founded by the platform operator (the callable
// enforces the superAdmin claim). The createOrganisation callable creates the
// org, makes the caller its first admin member and re-points their active-org
// claim, so after it succeeds we refresh the session token and land on /app -
// by then the claims name the new workspace, where the operator invites the
// client's real administrators.
//
// Accessibility: focus moves into the name field on open, Tab is trapped
// within the dialog, Escape closes, and focus returns to whatever opened it.
// ============================================================================

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import type { CreateOrganisationInput, CreateOrganisationResult } from '../types';
import { ErrorNotice } from './ui/Page';
import { useCallable } from './ui/useCallable';
import styles from './CreateOrganisationDialog.module.css';

const FOCUSABLE = 'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])';

export function CreateOrganisationDialog({ onClose }: { onClose: () => void }) {
  const { refreshSession } = useAuth();
  const navigate = useNavigate();
  const create = useCallable<CreateOrganisationInput, CreateOrganisationResult>(
    'createOrganisation',
  );
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  // True from a successful callable until navigation: the session refresh may
  // remount ancestors, and the dialog must not offer a second submit meanwhile.
  const [finishing, setFinishing] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<Element | null>(null);

  const busy = create.pending || finishing;

  // Never abandon the flow mid-callable: closing then succeeding would leave
  // the user in an org they never saw created.
  const close = useCallback(() => {
    if (busy) {
      return;
    }
    onClose();
  }, [busy, onClose]);

  // Focus in on open; on unmount, focus the opener if it is still in the
  // document. When it is not (success navigated to the new workspace, so the
  // opener unmounted), land on the page's first heading instead - made
  // focusable for the one programmatic move - so keyboard and screen-reader
  // context is not dropped at document.body.
  useEffect(() => {
    openerRef.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
        return;
      }
      const heading = document.querySelector<HTMLElement>('h1, h2');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
      }
    };
  }, []);

  // Escape closes; Tab wraps within the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) {
        return;
      }
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) {
        // Every control is disabled while busy: park focus on the dialog
        // itself (tabIndex={-1}) so Tab cannot escape the modal to the page
        // behind it.
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFieldError('Enter a name for your organisation.');
      return;
    }
    setFieldError(null);
    const result = await create.call({ name: trimmed });
    if (!result) {
      return;
    }
    setFinishing(true);
    // The callable re-pointed the caller's active org; pick up the new claims
    // before touching any data. Then close DETERMINISTICALLY before navigating
    // (bypassing close(), which refuses while busy): relying on the session
    // refresh to remount an ancestor left the dialog's fate to chance. React
    // batches the two updates, so the unmount cleanup above runs after the new
    // route renders and restores focus somewhere sensible.
    await refreshSession();
    onClose();
    navigate('/app');
  };

  return (
    <div className={styles.overlay}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-org-title"
        className={styles.dialog}
        tabIndex={-1}
      >
        <h2 id="create-org-title" className={styles.title}>
          Create an organisation
        </h2>
        <p className={styles.copy}>
          You will become its administrator, and can invite staff from the
          console.
        </p>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="create-org-name">
              Organisation name
            </label>
            <input
              id="create-org-name"
              ref={inputRef}
              className={styles.input}
              type="text"
              autoComplete="organization"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
          </div>
          {fieldError && <ErrorNotice message={fieldError} />}
          {create.error && <ErrorNotice message={create.error} />}
          <div className={styles.actions}>
            <Button type="submit" disabled={busy}>
              {finishing
                ? 'Opening your workspace'
                : create.pending
                  ? 'Creating'
                  : 'Create organisation'}
            </Button>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
