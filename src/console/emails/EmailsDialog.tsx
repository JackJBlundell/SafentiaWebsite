// ============================================================================
// EmailsDialog - the one dialog shell the Emails area's surfaces share (the
// per-kind preview and the compose confirm). Hand-rolled to the SignOffDialog
// posture exactly: overlay click and Escape close, focus moves to the heading
// on open, Tab wraps within the dialog, and focus returns to the opener on
// unmount. Content and footer are the caller's; this owns only the frame and
// the accessibility contract, so the two dialogs cannot drift apart on it.
// ============================================================================

import { useEffect, useRef, type ReactNode } from 'react';
import styles from './EmailsDialog.module.css';

const FOCUSABLE =
  'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])';

export function EmailsDialog({
  title,
  titleId,
  wide = false,
  onClose,
  children,
}: {
  title: string;
  /** Distinct per dialog so two never share an id in the document. */
  titleId: string;
  /** The preview dialog needs room for a rendered email; the confirm does not. */
  wide?: boolean;
  /** Called on Escape, overlay click, or a caller-rendered close control. The
   *  caller decides whether closing is currently allowed (e.g. mid-send). */
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);

  // Focus in on open; back to the opener on close.
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
        onClose();
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
  }, [onClose]);

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className={wide ? `${styles.dialog} ${styles.wide}` : styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className={styles.title} ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
