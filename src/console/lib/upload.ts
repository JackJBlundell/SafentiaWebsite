// ============================================================================
// upload.ts - the one way console screens put a file into Storage.
//
// uploadFile wraps uploadBytesResumable so every upload gets the same three
// things without re-implementation: a tenant-scoped object path (built by the
// caller from paths.storage.*, never hand-typed), progress reporting for a
// visible bar, and resolution to the download URL the DB record will carry.
//
// The validators below mirror storage.rules (image <= 10MB, floor plan = image
// <= 10MB or PDF <= 25MB, document any type <= 25MB). The RULES are the
// boundary - a forged client still cannot land an oversized or wrong-type
// object. These checks exist purely for UX: they turn a cryptic
// storage/unauthorized rejection into a calm sentence before any bytes move.
// ============================================================================

import {
  getDownloadURL,
  ref as storageRef,
  uploadBytesResumable,
} from 'firebase/storage';
import { firebase } from '../../firebase';

const MB = 1024 * 1024;

/** Ceilings, kept numerically identical to storage.rules. */
export const MAX_IMAGE_BYTES = 10 * MB;
export const MAX_DOCUMENT_BYTES = 25 * MB;
export const MAX_PDF_PLAN_BYTES = 25 * MB;

/** The result of a pre-upload check: fine, or a reason a person can act on. */
export type FileCheck = { ok: true } | { ok: false; reason: string };

const OK: FileCheck = { ok: true };

/** An image within the ceiling (photos, image floor plans). */
export function fileIsImage(file: File, maxBytes: number = MAX_IMAGE_BYTES): FileCheck {
  if (!file.type.startsWith('image/')) {
    return {
      ok: false,
      reason: 'This file is not an image. Please choose a JPEG, PNG or similar image file.',
    };
  }
  if (file.size > maxBytes) {
    return {
      ok: false,
      reason: `This image is larger than ${Math.round(maxBytes / MB)} MB. Please choose a smaller image.`,
    };
  }
  return OK;
}

/** A floor plan file: an image (<= 10MB) or a PDF (<= 25MB), matching
 *  storage.rules' validFloorPlanFile. */
export function fileIsFloorPlan(file: File): FileCheck {
  if (file.type === 'application/pdf') {
    if (file.size > MAX_PDF_PLAN_BYTES) {
      return {
        ok: false,
        reason: 'This PDF is larger than 25 MB. Please choose a smaller file.',
      };
    }
    return OK;
  }
  if (file.type.startsWith('image/')) {
    return fileIsImage(file);
  }
  return {
    ok: false,
    reason: 'Floor plans can be an image up to 10 MB or a PDF up to 25 MB.',
  };
}

/** A building document: any content type, within the ceiling. */
export function fileIsDocument(
  file: File,
  maxBytes: number = MAX_DOCUMENT_BYTES,
): FileCheck {
  if (file.size > maxBytes) {
    return {
      ok: false,
      reason: `This file is larger than ${Math.round(maxBytes / MB)} MB. Please choose a smaller file.`,
    };
  }
  return OK;
}

/**
 * A unique id for a Storage object name (floor plan / document uploads generate
 * their object id client-side, then hand the resulting path or URL to the
 * callable that writes the DB record). Collision-resistant, not secret: the
 * object still lives under the caller's own tenant prefix and the rules decide
 * access, so uniqueness is all this needs to provide.
 */
export function newObjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface UploadFileOptions {
  /** The tenant-scoped object path, from a paths.storage.* builder. */
  storagePath: string;
  file: File;
  /** Called with 0..1 as bytes land, for a visible progress bar. */
  onProgress?: (fraction: number) => void;
}

/**
 * Upload one file and resolve to its download URL. Rejects with the raw
 * Storage error; callers translate to calm copy (they know what the user was
 * doing; this helper does not).
 */
export function uploadFile(options: UploadFileOptions): Promise<string> {
  const { storagePath, file, onProgress } = options;
  const task = uploadBytesResumable(
    storageRef(firebase.storage(), storagePath),
    file,
    // Pass the content type explicitly: the rules validate on it, and relying
    // on sniffing would make an accepted-locally file fail at the boundary.
    { contentType: file.type },
  );
  return new Promise<string>((resolve, reject) => {
    task.on(
      'state_changed',
      (snapshot) => {
        if (onProgress) {
          const fraction =
            snapshot.totalBytes > 0
              ? snapshot.bytesTransferred / snapshot.totalBytes
              : 0;
          onProgress(fraction);
        }
      },
      reject,
      () => {
        getDownloadURL(task.snapshot.ref).then(resolve, reject);
      },
    );
  });
}
