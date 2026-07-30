// ============================================================================
// SignOffDialog - closing one action, on its own surface.
//
// Sign-off used to expand inside the action's row: a textarea and two buttons
// squeezed into a table cell, inches from Reopen. It changes the legal reading
// of the plan, so it gets a modal with room instead - the observation restated
// so the admin can see WHAT they are closing, the optional completion note, and
// the optional supporting document that proves the work happened.
//
// The evidence upload follows the DocumentsPanel contract exactly: the client
// puts the file in ITS OWN tenant Storage prefix (paths.storage.actionEvidence)
// and hands the callable the object PATH, never a URL. manageAction re-validates
// that path against the caller's tenant prefix and stamps the file's owning
// customer before it records anything, so a pointer the customer's portal could
// not open can never reach the record. A successful upload is remembered, so
// retrying after a failed callable reuses the object rather than orphaning a
// fresh one per attempt.
//
// Accessibility: focus moves into the dialog on open, Tab is trapped within it,
// Escape closes, and focus returns to the control that opened it - the same
// posture as ContactCreateDialog.
// ============================================================================

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import type { ManageActionInput, ManageActionResult } from '../../types';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { fileIsDocument, newObjectId, uploadFile } from '../lib/upload';
import styles from './SignOffDialog.module.css';

const FOCUSABLE =
  'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])';

export function SignOffDialog({
  buildingId,
  actionId,
  observation,
  onClose,
}: {
  buildingId: string;
  actionId: string;
  /** Restated in the dialog: the admin must be able to confirm they are closing
   *  the action they meant to, without reading the row behind the overlay. */
  observation: string;
  /** Called with `true` once the sign-off has landed, so the opener can clear
   *  its own state; `false` when the admin backed out. */
  onClose: (signedOff: boolean) => void;
}) {
  const { claims, paths } = useAuth();
  const manage = useCallable<ManageActionInput, ManageActionResult>(
    'manageAction',
  );

  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  // The object path of an already-uploaded file, kept so a retry after a FAILED
  // CALLABLE reuses it instead of leaving an orphan per attempt.
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);

  const busy = progress !== null || manage.pending;

  // Never abandon mid-flight: the file may already be in Storage and the
  // callable may already have closed the action.
  const close = useCallback(() => {
    if (busy) {
      return;
    }
    onClose(false);
  }, [busy, onClose]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    headingRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
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
      ).filter((element) => !element.hasAttribute('disabled'));
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    setFileError(null);
    // A different file needs a different object: the remembered path belongs to
    // the previous choice.
    setUploadedPath(null);
    if (chosen) {
      const check = fileIsDocument(chosen);
      if (!check.ok) {
        setFileError(check.reason);
        setFile(null);
        return;
      }
    }
    setFile(chosen);
  };

  const confirm = async () => {
    setFileError(null);
    let storagePath = uploadedPath;
    if (file && storagePath === null) {
      if (!claims || !paths) {
        return;
      }
      storagePath = paths.storage.actionEvidence(
        claims.orgId,
        buildingId,
        newObjectId(),
      );
      setProgress(0);
      try {
        await uploadFile({ storagePath, file, onProgress: setProgress });
      } catch {
        setProgress(null);
        setFileError(
          'The document could not be uploaded. Check your connection and try again.',
        );
        return;
      }
      setProgress(null);
      setUploadedPath(storagePath);
    }

    const trimmed = note.trim();
    const result = await manage.call({
      action: 'signOff',
      buildingId,
      actionId,
      // Both extras ride along only when the admin actually supplied them, so
      // an unadorned sign-off sends the same payload it always did.
      ...(trimmed ? { completionNote: trimmed } : {}),
      ...(file && storagePath
        ? { completionEvidence: { fileName: file.name, storagePath } }
        : {}),
    });
    if (result) {
      onClose(true);
    }
  };

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={close}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-off-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <h2
            id="sign-off-dialog-title"
            className={styles.title}
            ref={headingRef}
            tabIndex={-1}
          >
            Sign off this action
          </h2>
          <p className={styles.copy}>
            Signing off records the work as complete against this building, with
            your name and the time. It can be reopened if anything is unfinished.
          </p>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>The action</h3>
            <blockquote className={styles.observation}>{observation}</blockquote>
          </section>

          <section className={styles.section}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="sign-off-note">
                Completion note (optional)
              </label>
              <p className={styles.hint}>
                How the action was resolved - what was done, and by whom. This
                stays on the record after sign-off.
              </p>
              <textarea
                id="sign-off-note"
                className={styles.textarea}
                rows={4}
                value={note}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="sign-off-evidence">
                Supporting document (optional)
              </label>
              <p className={styles.hint}>
                A photo of the completed work, or a contractor&rsquo;s
                certificate. Up to 25 MB. Whoever can see this building&rsquo;s
                action plan can open it.
              </p>
              <input
                id="sign-off-evidence"
                className={styles.fileInput}
                type="file"
                accept="image/*,application/pdf"
                disabled={busy}
                onChange={onFileChange}
              />
              {file && !fileError && (
                <p className={styles.chosen}>
                  {uploadedPath
                    ? `${file.name} is uploaded and ready.`
                    : `${file.name} will be attached as evidence.`}
                </p>
              )}
            </div>

            {progress !== null && (
              <div className={styles.progressWrap}>
                <progress
                  className={styles.progress}
                  value={progress}
                  max={1}
                  aria-label="Upload progress"
                />
                <span className={styles.progressLabel}>
                  {Math.round(progress * 100)}%
                </span>
              </div>
            )}
          </section>

          {fileError && <ErrorNotice message={fileError} />}
          {manage.error && <ErrorNotice message={manage.error} />}
        </div>

        <footer className={styles.footer}>
          <Button disabled={busy} onClick={() => void confirm()}>
            {progress !== null
              ? 'Uploading'
              : manage.pending
                ? 'Signing off'
                : 'Confirm sign off'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
        </footer>
      </div>
    </div>
  );
}
