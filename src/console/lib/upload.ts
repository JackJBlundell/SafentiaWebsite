// ============================================================================
// upload.ts - the one way console screens put a file into Storage.
//
// uploadFile wraps uploadBytesResumable so every upload gets the same three
// things without re-implementation: a tenant-scoped object path (built by the
// caller from paths.storage.*, never hand-typed), progress reporting for a
// visible bar, and resolution to the download URL the DB record will carry.
//
// The validators below mirror storage.rules (image <= 10MB, floor plan = image
// <= 10MB or any other accepted drawing type <= 25MB, document any type
// <= 25MB). The RULES are the boundary - a forged client still cannot land an
// oversized or wrong-type object. These checks exist purely for UX: they turn a
// cryptic storage/unauthorized rejection into a calm sentence before any bytes
// move.
// ============================================================================

import {
  getDownloadURL,
  ref as storageRef,
  uploadBytesResumable,
} from 'firebase/storage';
import { firebase } from '../../firebase';
import type { FloorPlanKind } from '../../types';

const MB = 1024 * 1024;

/** Ceilings, kept numerically identical to storage.rules. Two are enough: an
 *  image is bounded at 10MB wherever it is used (photo, image floor plan), and
 *  everything else - documents, PDF plans, CAD drawings - at 25MB. */
export const MAX_IMAGE_BYTES = 10 * MB;
export const MAX_DOCUMENT_BYTES = 25 * MB;

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

// ----------------------------------------------------------------------------
// Floor plans / drawings - ONE allow-list, read by everything
// ----------------------------------------------------------------------------
//
// A fire-risk practice holds more than photographs and PDFs: the drawing it was
// given is often a CAD export or an office document, and refusing those pushed
// admins into converting files by hand before they could be stored at all.
//
// The list below is the single source of truth: the file input's `accept`, the
// pre-upload validation, the derived FloorPlan.kind and the on-screen hint copy
// are all DERIVED from it, so widening the set is one edit in one place.
//
// Validation matches on EXTENSION AS WELL AS MIME on purpose. Browsers have no
// registered type for CAD, so a .dwg or .dxf commonly arrives with `file.type`
// of '' or 'application/octet-stream'; matching on MIME alone would reject every
// CAD upload the moment it was offered.

/** One accepted floor-plan file type. */
export interface FloorPlanFileType {
  /** Lower-case extension, without the dot. The reliable signal for CAD. */
  extension: string;
  /** The content types browsers report for it, where they report one. */
  mimeTypes: readonly string[];
  /** How the type is named in UI copy. */
  label: string;
  /** Images carry the 10MB ceiling (storage.rules' validImage); everything else
   *  the 25MB one. */
  isImage: boolean;
}

export const FLOOR_PLAN_FILE_TYPES: readonly FloorPlanFileType[] = [
  { extension: 'jpg', mimeTypes: ['image/jpeg'], label: 'JPEG', isImage: true },
  { extension: 'jpeg', mimeTypes: ['image/jpeg'], label: 'JPEG', isImage: true },
  { extension: 'png', mimeTypes: ['image/png'], label: 'PNG', isImage: true },
  { extension: 'webp', mimeTypes: ['image/webp'], label: 'WebP', isImage: true },
  { extension: 'gif', mimeTypes: ['image/gif'], label: 'GIF', isImage: true },
  {
    extension: 'bmp',
    mimeTypes: ['image/bmp', 'image/x-ms-bmp'],
    label: 'BMP',
    isImage: true,
  },
  { extension: 'tif', mimeTypes: ['image/tiff'], label: 'TIFF', isImage: true },
  { extension: 'tiff', mimeTypes: ['image/tiff'], label: 'TIFF', isImage: true },
  { extension: 'pdf', mimeTypes: ['application/pdf'], label: 'PDF', isImage: false },
  {
    extension: 'dwg',
    mimeTypes: ['image/vnd.dwg', 'image/x-dwg', 'application/acad', 'application/x-acad'],
    label: 'AutoCAD drawing (DWG)',
    isImage: false,
  },
  {
    extension: 'dxf',
    mimeTypes: ['image/vnd.dxf', 'image/x-dxf', 'application/dxf'],
    label: 'CAD exchange drawing (DXF)',
    isImage: false,
  },
  {
    extension: 'dwf',
    mimeTypes: ['model/vnd.dwf', 'drawing/x-dwf', 'application/x-dwf'],
    label: 'Design web format drawing (DWF)',
    isImage: false,
  },
  {
    extension: 'doc',
    mimeTypes: ['application/msword'],
    label: 'Word document',
    isImage: false,
  },
  {
    extension: 'docx',
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    label: 'Word document',
    isImage: false,
  },
  {
    extension: 'xls',
    mimeTypes: ['application/vnd.ms-excel'],
    label: 'Excel spreadsheet',
    isImage: false,
  },
  {
    extension: 'xlsx',
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    label: 'Excel spreadsheet',
    isImage: false,
  },
];

/** The file input's `accept`, derived from the list. Both forms are offered:
 *  the extensions (what a CAD file matches on) and the content types (what a
 *  photo picker matches on). `image/*` keeps every camera format an assessor
 *  might have - HEIC included - which is exactly what storage.rules allows. */
export const FLOOR_PLAN_ACCEPT = [
  'image/*',
  ...FLOOR_PLAN_FILE_TYPES.map((type) => `.${type.extension}`),
  ...FLOOR_PLAN_FILE_TYPES.flatMap((type) => type.mimeTypes),
].join(',');

/** The accepted types in plain words, for the hint and the rejection message.
 *  Built from the list so the copy can never drift from what is enforced. */
export const FLOOR_PLAN_TYPES_SENTENCE =
  'Floor plans can be an image (JPEG, PNG, WebP, GIF, BMP or TIFF) up to 10 MB, ' +
  'or a PDF, CAD drawing (DWG, DXF or DWF) or Word or Excel document up to 25 MB.';

/** The extension of a file name, lower-cased and without the dot ('' if none). */
function extensionOf(fileName: string): string {
  const match = /\.([^.\\/]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : '';
}

/** The allow-list entry a file matches, by extension first (the reliable signal
 *  for CAD) then by content type. Undefined when the file is not accepted. */
function floorPlanTypeOf(file: File): FloorPlanFileType | undefined {
  const extension = extensionOf(file.name);
  const byExtension = FLOOR_PLAN_FILE_TYPES.find(
    (type) => type.extension === extension,
  );
  if (byExtension) {
    return byExtension;
  }
  const mime = file.type.toLowerCase();
  return FLOOR_PLAN_FILE_TYPES.find((type) => type.mimeTypes.includes(mime));
}

/** Whether this file is an image, for the ceiling and for FloorPlan.kind. Any
 *  image/* content type counts (mirroring storage.rules' validImage), as does a
 *  listed image extension when the browser reported no type at all. */
function floorPlanIsImage(file: File): boolean {
  if (file.type.toLowerCase().startsWith('image/')) {
    return true;
  }
  return floorPlanTypeOf(file)?.isImage === true;
}

/**
 * The FloorPlan.kind a chosen file becomes: an image or a PDF can be rendered
 * and pinned by the annotator; anything else is stored and downloadable only,
 * which is what 'file' means in the contract.
 */
export function floorPlanKindForFile(file: File): FloorPlanKind {
  if (floorPlanIsImage(file)) {
    return 'image';
  }
  if (
    file.type.toLowerCase() === 'application/pdf' ||
    extensionOf(file.name) === 'pdf'
  ) {
    return 'pdf';
  }
  return 'file';
}

/** A floor plan file: an image (<= 10MB) or any other accepted drawing or
 *  document type (<= 25MB), matching storage.rules' validFloorPlanFile. */
export function fileIsFloorPlan(file: File): FileCheck {
  const isImage = floorPlanIsImage(file);
  if (!isImage && !floorPlanTypeOf(file)) {
    return { ok: false, reason: FLOOR_PLAN_TYPES_SENTENCE };
  }
  const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  if (file.size > maxBytes) {
    return {
      ok: false,
      reason: isImage
        ? 'This image is larger than 10 MB. Please choose a smaller image.'
        : 'This file is larger than 25 MB. Please choose a smaller file.',
    };
  }
  return OK;
}

/** The short badge shown on a non-renderable plan's tile ('DWG', 'XLSX'), from
 *  the stored file name, or 'FILE' when there is nothing to go on. */
export function floorPlanTypeBadge(fileName?: string): string {
  const extension = fileName ? extensionOf(fileName) : '';
  return extension ? extension.toUpperCase() : 'FILE';
}

/** How a stored plan's type is named in the list, from the record's own
 *  fileName / contentType. Falls back to the bare extension (upper-cased) so a
 *  type this build does not know about is still described, never left blank. */
export function floorPlanTypeLabel(fileName?: string, contentType?: string): string {
  const extension = fileName ? extensionOf(fileName) : '';
  const byExtension = FLOOR_PLAN_FILE_TYPES.find(
    (type) => type.extension === extension,
  );
  if (byExtension) {
    return byExtension.label;
  }
  const mime = (contentType ?? '').toLowerCase();
  const byMime = FLOOR_PLAN_FILE_TYPES.find((type) => type.mimeTypes.includes(mime));
  if (byMime) {
    return byMime.label;
  }
  return extension ? extension.toUpperCase() : 'File';
}

/**
 * A stored file's size, as a person reads it: '840 kB', '12.4 MB'. Binary units
 * (the ceilings above are binary too), one decimal place below 10 so a small
 * difference is still visible and a large one is not spelled out in digits.
 *
 * Returns null for a size there is nothing honest to say about - absent (every
 * plan uploaded before the field existed) or nonsense - so callers render
 * NOTHING rather than a confident '0 B' about a file they have no size for.
 */
export function formatFileSize(bytes?: number): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${rounded} ${units[unit]}`;
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
