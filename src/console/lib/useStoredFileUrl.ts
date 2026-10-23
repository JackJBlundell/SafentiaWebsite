// ============================================================================
// Stored files - every console surface that shows or opens a file from
// Firebase Storage goes through this module.
//
// WHY BLOBS, NOT DOWNLOAD URLS. A browser fetching a download URL directly
// (<img src>, <a href>) cannot attach the App Check token, so Firebase counts it
// as "unknown origin" and rejects it once Storage enforcement is on. Instead the
// bytes are fetched with the SDK's getBlob (which sends the token) and shown
// through a same-origin `blob:` object URL. getBlob needs a CORS config on the
// bucket (storage.cors.json at the repo root).
//
// Two reference shapes exist in the data: a Storage OBJECT PATH (what the app
// and most callables write) and a full download URL (older records, and values
// the console uploaded itself). Both resolve to a Storage ref. A URL is accepted
// ONLY when it points at this project's own bucket: some references are written
// by clients, so an arbitrary https value would let one member plant a link or
// image that pings a host of their choosing. Anything else resolves to `failed`,
// which every caller renders as honest "unavailable" copy.
//
// Images resolve eagerly (useStoredFileUrl). Files that are opened or downloaded
// (PDFs, documents, drawings) resolve only when clicked (openStoredFile), so a
// list of reports does not download every PDF just to render its links. PDFs
// and other files download; only raster images open in a new tab.
// ============================================================================

import { useEffect, useState } from 'react';
import {
  getBlob,
  getMetadata,
  ref as storageRef,
  type StorageReference,
} from 'firebase/storage';
import { firebase } from '../../firebase';
import { firebaseConfig } from '../../config/env';

/** Whether `value` is a Firebase Storage download URL for our own bucket. */
export function isOwnStorageUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'firebasestorage.googleapis.com' &&
    parsed.pathname.startsWith(`/v0/b/${firebaseConfig.storageBucket}/o/`)
  );
}

/** Types a browser would execute if opened as a page: never shown same-origin. */
function isActiveContent(type: string): boolean {
  return /svg|html|xml|javascript/i.test(type);
}

/** A browser-local image (a fresh crop preview), shown as is. */
function isLocalUrl(value: string): boolean {
  return value.startsWith('blob:') || value.startsWith('data:');
}

/** The Storage ref behind a reference, or null when it is not one of ours. */
function storedFileRef(reference: string): StorageReference | null {
  const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(reference);
  if (isUrl && !isOwnStorageUrl(reference)) {
    return null;
  }
  try {
    // ref() accepts both an object path and a download URL for the bucket.
    return storageRef(firebase.storage(), reference);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Object-URL cache. One fetch per object however many components show it, and
// the object URL is revoked once nothing has used it for a while (a short grace
// so navigating back and forth does not refetch).
// ----------------------------------------------------------------------------

const REVOKE_AFTER_MS = 30_000;

interface StoredBlob {
  url: string;
  /** MIME type the bucket served, e.g. application/pdf. */
  type: string;
}

interface CacheEntry {
  key: string;
  promise: Promise<StoredBlob>;
  url: string | null;
  users: number;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

const cache = new Map<string, CacheEntry>();

/** Start (or join) the fetch for one object. Pair every call with release()
 *  on the entry it returns. */
function acquire(fileRef: StorageReference): CacheEntry {
  const key = fileRef.fullPath;
  let entry = cache.get(key);
  if (!entry) {
    const created: CacheEntry = {
      key,
      promise: Promise.resolve({ url: '', type: '' }),
      url: null,
      users: 0,
      revokeTimer: null,
    };
    created.promise = getBlob(fileRef).then(
      (fetched) => {
        // An object URL is SAME-ORIGIN with the console, so a stored SVG (which
        // can carry script, and the Storage rules accept any image/*) must never
        // render as a document here. Served as opaque bytes it only downloads.
        const blob = isActiveContent(fetched.type)
          ? new Blob([fetched], { type: 'application/octet-stream' })
          : fetched;
        created.url = URL.createObjectURL(blob);
        return { url: created.url, type: blob.type };
      },
      (error: unknown) => {
        // Never cache a failure: a later mount (or a fixed object) retries.
        if (cache.get(key) === created) {
          cache.delete(key);
        }
        throw error;
      },
    );
    cache.set(key, created);
    entry = created;
  }
  if (entry.revokeTimer) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  entry.users += 1;
  return entry;
}

function release(entry: CacheEntry): void {
  entry.users = Math.max(0, entry.users - 1);
  if (entry.users > 0) {
    return;
  }
  if (entry.revokeTimer) {
    clearTimeout(entry.revokeTimer);
  }
  entry.revokeTimer = setTimeout(() => {
    if (entry.users > 0) {
      return;
    }
    if (cache.get(entry.key) === entry) {
      cache.delete(entry.key);
    }
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
    }
  }, REVOKE_AFTER_MS);
}

/**
 * Resolve a stored-file reference to a same-origin object URL for an <img> or
 * an in-page link. `url` is null while loading; `failed` is true when the
 * reference is not ours or the object cannot be read (missing, or refused by
 * the rules). Browser-local `blob:`/`data:` previews pass straight through.
 */
export function useStoredFileUrl(reference: string | null | undefined): {
  url: string | null;
  failed: boolean;
} {
  const local = reference && isLocalUrl(reference) ? reference : null;
  const [resolved, setResolved] = useState<{ ref: string; url: string } | null>(
    null,
  );
  const [failedRef, setFailedRef] = useState<string | null>(null);

  useEffect(() => {
    if (!reference || isLocalUrl(reference)) {
      return;
    }
    const fileRef = storedFileRef(reference);
    if (!fileRef) {
      setFailedRef(reference);
      return;
    }
    let cancelled = false;
    const entry = acquire(fileRef);
    entry.promise
      .then(({ url }) => {
        if (!cancelled) {
          setResolved({ ref: reference, url });
        }
      })
      .catch((error: unknown) => {
        // A missing object must not silently blank the file: log loudly
        // (CONVENTIONS section 4) and let the caller say so on screen.
        console.error('[Safentia] stored file', error);
        if (!cancelled) {
          setFailedRef(reference);
        }
      });
    return () => {
      cancelled = true;
      release(entry);
    };
  }, [reference]);

  if (!reference) {
    return { url: null, failed: false };
  }
  if (local) {
    return { url: local, failed: false };
  }
  return {
    url: resolved?.ref === reference ? resolved.url : null,
    failed: failedRef === reference,
  };
}

export type StoredFileStatus = 'checking' | 'ready' | 'unavailable';

/**
 * Whether a stored file can be opened by the signed-in member, WITHOUT
 * downloading it (a metadata read through the SDK, so App Check is sent and the
 * same Storage rule applies). Lets a row offer a link only when it can honour
 * it, and say "unavailable" otherwise.
 */
export function useStoredFileStatus(
  reference: string | null | undefined,
): StoredFileStatus {
  const [result, setResult] = useState<{
    ref: string;
    status: StoredFileStatus;
  } | null>(null);

  useEffect(() => {
    if (!reference) {
      return;
    }
    const fileRef = storedFileRef(reference);
    if (!fileRef) {
      setResult({ ref: reference, status: 'unavailable' });
      return;
    }
    let cancelled = false;
    getMetadata(fileRef)
      .then(() => {
        if (!cancelled) {
          setResult({ ref: reference, status: 'ready' });
        }
      })
      .catch((error: unknown) => {
        console.error('[Safentia] stored file status', error);
        if (!cancelled) {
          setResult({ ref: reference, status: 'unavailable' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reference]);

  if (!reference) {
    return 'unavailable';
  }
  return result?.ref === reference ? result.status : 'checking';
}

/** Raster images open in a new tab; everything else (PDFs included) is
 *  downloaded. A same-origin blob tab inherits the console's strict content
 *  policy, which browsers' PDF viewers do not reliably honour, and every
 *  non-image link here is labelled as a download anyway. */
function isViewableType(type: string): boolean {
  return /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(type);
}

/** Names that are certainly images (open a tab) or certainly not (no tab).
 *  A name with no extension may be either, so it gets a tab that closes again
 *  if the bytes turn out not to be an image. */
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const HAS_EXTENSION = /\.[a-z0-9]{2,5}$/i;

/**
 * Open (or download) a stored file from a click. Must be called synchronously
 * inside the click handler: a tab is opened BEFORE the bytes arrive, or the
 * browser's popup blocker would refuse it after the await. Images open in that
 * tab; anything else downloads under `fileName` (and the tab closes).
 * Rejects when the file cannot be read, so the caller can say so.
 */
export async function openStoredFile(
  reference: string,
  fileName?: string,
): Promise<void> {
  const fileRef = storedFileRef(reference);
  if (!fileRef) {
    throw new Error('Not a stored file');
  }
  const name = fileName || fileRef.name;
  const mayView = IMAGE_NAME.test(name) || !HAS_EXTENSION.test(name);
  const tab = mayView ? window.open('', '_blank') : null;
  const entry = acquire(fileRef);
  try {
    const { url, type } = await entry.promise;
    if (tab && !tab.closed && isViewableType(type)) {
      tab.opener = null;
      tab.location.href = url;
      return;
    }
    tab?.close();
    // Not viewable, or the tab was blocked: save the file instead.
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (error) {
    tab?.close();
    console.error('[Safentia] open stored file', error);
    throw error;
  } finally {
    // The tab or download has the bytes well before the grace period ends.
    release(entry);
  }
}
