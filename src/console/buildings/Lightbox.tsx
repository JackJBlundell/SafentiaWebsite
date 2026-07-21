// ============================================================================
// Lightbox - a minimal full-size image overlay for the building panels (floor
// plans and image documents), so a thumbnail or filename is inspectable
// without leaving the page. Images only: PDFs and other documents keep their
// direct download links.
//
// Accessibility skeleton mirrors ImageCropDialog: a focus-trapped
// role="dialog" with aria-modal, focus moves in on open, Escape (or the
// overlay, or Close) dismisses, and focus returns to the opener on unmount.
// The Download link reuses the storage download URL the row already resolved.
// ============================================================================

import { useCallback, useEffect, useRef } from 'react';
import { Button } from '../../components/Button';
import styles from './Lightbox.module.css';

const FOCUSABLE =
  'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])';

export interface LightboxProps {
  /** The full-size image source - the already-resolved download URL. */
  src: string;
  /** The image's name, used as the dialog title and the alt text. */
  title: string;
  /** The download link's target; defaults to `src`. */
  downloadUrl?: string;
  onClose: () => void;
}

export function Lightbox({ src, title, downloadUrl, onClose }: LightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  // Focus in on open; on unmount, return focus to the opener if it is still
  // in the document, otherwise land on the page's first heading.
  useEffect(() => {
    openerRef.current = document.activeElement;
    dialogRef.current?.focus();
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
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
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
      ).filter((el) => !el.hasAttribute('disabled'));
      if (focusable.length === 0) {
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
      } else if (
        event.shiftKey &&
        (active === first || active === dialogRef.current)
      ) {
        event.preventDefault();
        last.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onKeyDown]);

  return (
    <div
      className={styles.overlay}
      onClick={(event) => {
        // Clicking the dimmed surround dismisses; clicks inside the dialog
        // bubble here too, so only a direct overlay hit closes.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={styles.dialog}
        tabIndex={-1}
      >
        <div className={styles.bar}>
          <span className={styles.title}>{title}</span>
          <div className={styles.barActions}>
            <a
              className={styles.downloadLink}
              href={downloadUrl ?? src}
              target="_blank"
              rel="noopener noreferrer"
            >
              Download
            </a>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        <div className={styles.stage}>
          <img className={styles.image} src={src} alt={title} />
        </div>
      </div>
    </div>
  );
}
