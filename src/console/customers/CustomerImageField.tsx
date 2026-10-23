// ============================================================================
// CustomerImageField - pick, crop and upload a customer's logo or photo.
//
// The same three-step flow the organisation logo uses (OrganisationSettingsPage):
// pick -> crop square in ImageCropDialog -> upload to the tenant-scoped Storage
// area on save, passing only the download URL to manageCustomer. The upload is
// deferred to the parent's submit (via `resolve`) so a freshly uploaded object
// is REUSED on a retry after a failed callable rather than orphaning a new one
// per attempt, exactly as the logo flow does.
//
// The object lands under the org's flat asset prefix (paths.storage.orgAsset):
// Storage on this platform is org-level with no customerId segment, that match
// is already image-only, admin-only and tenant/env-bounded in storage.rules, and
// requireTenantStorageRef accepts it - so a customer image needs no new Storage
// location or rule of its own.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { ImageCropDialog } from '../ui/ImageCropDialog';
import { fileIsImage, newObjectId, uploadFile } from '../lib/upload';
import shared from './shared.module.css';
import { StoredImage } from '../lib/StoredFile';
import styles from './CustomerImageField.module.css';

/** The photoUrl change a submit should apply: a URL to set, null to clear, or
 *  the key absent when the image was untouched. `'error'` means an upload
 *  failed and the save must abort. */
export type PhotoUrlChange = { photoUrl?: string | null };

export interface CustomerImage {
  /** The image the tile should show now (pending crop, else the saved one). */
  shownUrl: string | null;
  /** Whether a Remove control belongs on screen. */
  hasImage: boolean;
  error: string | null;
  /** Replaces the default hint while a change is pending, else null. */
  hintOverride: string | null;
  /** The picked file awaiting cropping; non-null renders the crop dialog. */
  cropSource: File | null;
  uploading: boolean;
  /** True when there is an unsaved image change (a new crop or a removal). */
  dirty: boolean;
  onPick: (file: File | null) => void;
  onRemove: () => void;
  onCropDone: (blob: Blob | null) => void;
  /** Upload any freshly picked file and return the change to merge into the
   *  customer payload. Reuses an already-uploaded object on a retry. */
  resolve: () => Promise<PhotoUrlChange | 'error'>;
}

/** Owns the pick/crop/upload state for one customer image. Lives in the parent
 *  form so `uploading`/`dirty` drive its buttons and `resolve` runs in submit. */
export function useCustomerImage(currentUrl: string | null | undefined): CustomerImage {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';

  const [file, setFile] = useState<File | null>(null);
  // The download URL of an already-uploaded image, kept so a retry after a
  // failed callable reuses it instead of orphaning a fresh Storage object.
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [cropSource, setCropSource] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Revoke each preview object URL when it is replaced, and on unmount.
  useEffect(
    () => () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    },
    [previewUrl],
  );

  const current = currentUrl ?? null;
  const shownUrl = removing ? null : (previewUrl ?? current);
  const dirty = file !== null || (removing && Boolean(current));

  const onPick = (picked: File | null) => {
    if (!picked) {
      return;
    }
    const check = fileIsImage(picked);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setError(null);
    setCropSource(picked);
  };

  const onCropDone = (blob: Blob | null) => {
    setCropSource(null);
    if (!blob) {
      return;
    }
    setError(null);
    setFile(new File([blob], `customer-${Date.now()}.png`, { type: 'image/png' }));
    setUploadedUrl(null);
    setRemoving(false);
    setPreviewUrl(URL.createObjectURL(blob));
  };

  const onRemove = () => {
    setFile(null);
    setUploadedUrl(null);
    setPreviewUrl(null);
    setRemoving(true);
    setError(null);
  };

  const resolve = async (): Promise<PhotoUrlChange | 'error'> => {
    if (file) {
      if (uploadedUrl) {
        return { photoUrl: uploadedUrl };
      }
      if (!paths) {
        return 'error';
      }
      setUploading(true);
      try {
        // The console's one Storage-upload helper (lib/upload), like every other
        // screen that moves a file; a fresh object id keeps each customer's image
        // distinct under the shared org asset prefix.
        const url = await uploadFile({
          storagePath: paths.storage.orgAsset(orgId, `${newObjectId()}.png`),
          file,
        });
        setUploadedUrl(url);
        return { photoUrl: url };
      } catch {
        setError('Could not upload the image. Please try again.');
        return 'error';
      } finally {
        setUploading(false);
      }
    }
    if (removing && current) {
      return { photoUrl: null };
    }
    return {};
  };

  const hintOverride = file
    ? 'Your cropped image will be uploaded when you save.'
    : removing && current
      ? 'The image will be removed when you save.'
      : null;

  return {
    shownUrl,
    hasImage: shownUrl !== null,
    error,
    hintOverride,
    cropSource,
    uploading,
    dirty,
    onPick,
    onRemove,
    onCropDone,
    resolve,
  };
}

/** The control itself: the current (or freshly cropped) image beside the
 *  Choose/Remove buttons, an empty-state tile when there is none. */
export function CustomerImageField({
  image,
  name,
  disabled,
}: {
  image: CustomerImage;
  /** The customer's name, so the image carries an identifying alt. */
  name: string;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={shared.field}>
      <span className={shared.label} id="customer-image-label">
        Logo or photo (optional)
      </span>
      <div className={styles.row}>
        {image.shownUrl ? (
          <StoredImage
            reference={image.shownUrl}
            alt={`${name} logo`}
            className={styles.tile}
          />
        ) : (
          <span className={styles.empty} aria-hidden="true">
            No image yet
          </span>
        )}
        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            Choose image
          </Button>
          {image.hasImage && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={image.onRemove}
            >
              Remove image
            </Button>
          )}
        </div>
      </div>
      {/* The real picker: visually removed, driven by the Choose image button. */}
      <input
        ref={fileInputRef}
        className={styles.hiddenFileInput}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        tabIndex={-1}
        aria-hidden="true"
        aria-labelledby="customer-image-label"
        onChange={(event) => {
          image.onPick(event.target.files?.[0] ?? null);
          // Reset so picking the same file again still fires change.
          event.target.value = '';
        }}
      />
      {image.error && (
        <p role="alert" className={styles.inlineError}>
          {image.error}
        </p>
      )}
      <p className={shared.note}>
        {image.hintOverride ??
          'PNG, JPEG, SVG or WebP. You will place it in a square - fill the square, or fit a wide logo whole; it appears where this customer is identified.'}
      </p>
      {image.cropSource && (
        <ImageCropDialog
          file={image.cropSource}
          title="Crop customer image"
          confirmLabel="Use this image"
          onDone={image.onCropDone}
        />
      )}
    </div>
  );
}
