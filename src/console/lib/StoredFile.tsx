// ============================================================================
// StoredImage / StoredFileLink - the two ways the console shows a file from
// Firebase Storage. Both fetch through the SDK so the App Check token is sent
// (see useStoredFileUrl.ts for why plain <img src>/<a href> cannot be used).
// ============================================================================

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { openStoredFile, useStoredFileUrl } from './useStoredFileUrl';

/**
 * An <img> for a stored-file reference (object path, own-bucket download URL,
 * or a local blob:/data: preview). Renders nothing while loading so no broken
 * glyph flashes; `onError` fires when the file cannot be loaded, exactly as an
 * <img> load error would, so existing fallbacks keep working.
 */
export function StoredImage({
  reference,
  className,
  alt,
  onError,
}: {
  reference: string | null | undefined;
  className?: string;
  alt: string;
  onError?: () => void;
}) {
  const { url, failed } = useStoredFileUrl(reference);
  // Latest handler without re-firing on every render (callers pass closures).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (failed) {
      onErrorRef.current?.();
    }
  }, [failed]);

  if (!url) {
    return null;
  }
  return <img className={className} src={url} alt={alt} onError={onError} />;
}

/**
 * A link that opens (PDFs, images) or downloads (anything else) a stored file
 * when clicked. The bytes are only fetched on click, so a list of files costs
 * nothing until one is used. A file that cannot be read says so beside the link.
 */
export function StoredFileLink({
  reference,
  fileName,
  className,
  errorClassName,
  children,
  ...aria
}: {
  reference: string;
  fileName?: string;
  className?: string;
  /** Style for the "could not open" note shown beside the link. */
  errorClassName?: string;
  children: ReactNode;
  'aria-label'?: string;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusy(true);
    setFailed(false);
    openStoredFile(reference, fileName)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <a
        className={className}
        href="#"
        role="link"
        aria-busy={busy || undefined}
        onClick={onClick}
        {...aria}
      >
        {children}
      </a>
      {failed && (
        <span role="alert" className={errorClassName}>
          {' '}
          The file could not be reached. Please try again.
        </span>
      )}
    </>
  );
}
