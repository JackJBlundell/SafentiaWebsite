// ============================================================================
// OrganisationSettingsPage - the org's public face: name, contact details,
// branding (colours, font, logo, report cover image).
//
// Reads live from /organisations/{orgId}/profile; saves ONLY the fields that
// changed, through the updateOrgProfile callable. Both images - the logo and the
// report cover image - run the SAME pick -> crop -> upload flow (useOrgImage
// below): cropped square in ImageCropDialog, previewed in its tile, and uploaded
// to the tenant-scoped Storage area on save, so only a download URL travels
// through the callable and removal sends null. The font family is chosen
// from FontSelect's previewing listbox of broadly-installed families (stored
// as a bare name; resolveFontStack appends the platform stack). Brand colours
// are validated as six-digit hex here for a tidy input, and contrast-corrected
// automatically by buildTheme before use, so an admin cannot brick their own
// console with an unreadable colour.
// ============================================================================

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { resolveFontStack } from '../../design/tokens/typography';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  OrgContact,
  OrgProfile,
  UpdateOrgProfileInput,
  UpdateOrgProfileResult,
} from '../../types';
import { fileIsImage, uploadFile } from '../lib/upload';
import { BrandingPreview } from './BrandingPreview';
import { Card, CardHeader } from '../ui/Card';
import { AddressField } from '../ui/AddressField';
import { FontSelect, type FontOption } from '../ui/FontSelect';
import { CardGrid } from '../ui/Grid';
import { ImageCropDialog } from '../ui/ImageCropDialog';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import styles from './OrganisationSettingsPage.module.css';

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** The offered families. Values are BARE family names ('' = the Safentia
 *  default): resolveFontStack quotes the name and appends the platform stack
 *  wherever the value is applied, so only broadly-installed families are
 *  offered - a font the visitor's device lacks would silently fall back and
 *  the admin would be choosing a look nobody sees. */
const FONT_OPTIONS: FontOption[] = [
  { value: '', label: 'Safentia default (Inter)' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Palatino', label: 'Palatino' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Trebuchet MS', label: 'Trebuchet MS' },
  { value: 'Verdana', label: 'Verdana' },
  { value: 'Tahoma', label: 'Tahoma' },
  { value: 'Courier New', label: 'Courier New' },
];

/** The contact sub-fields, driven from the OrgContact type so a schema change
 *  here fails to compile rather than silently dropping a field. */
const CONTACT_FIELDS: {
  key: keyof OrgContact;
  label: string;
  type: 'text' | 'email' | 'tel';
}[] = [
  { key: 'name', label: 'Contact name', type: 'text' },
  { key: 'email', label: 'Contact email', type: 'email' },
  { key: 'phone', label: 'Contact phone', type: 'tel' },
  // Deliberately `text`, not `url`: the reports print this string as typed, and
  // people write "wmcompliance.co.uk". type="url" would mark that invalid and
  // push the admin towards a scheme nobody wants to read on a cover page.
  { key: 'website', label: 'Website', type: 'text' },
  // `address` is rendered separately below as the console's AddressField (the
  // same address control as the customer, site and building forms); it still
  // participates in the save loop via CONTACT_KEYS.
];

const CONTACT_KEYS: (keyof OrgContact)[] = [
  'name',
  'email',
  'phone',
  'address',
  'website',
];

interface FormState {
  name: string;
  contact: Record<keyof OrgContact, string>;
  fontFamily: string;
  primary: string;
  secondary: string;
}

function stateFromProfile(profile: OrgProfile): FormState {
  return {
    name: profile.name,
    contact: {
      name: profile.contact?.name ?? '',
      email: profile.contact?.email ?? '',
      phone: profile.contact?.phone ?? '',
      address: profile.contact?.address ?? '',
      website: profile.contact?.website ?? '',
    },
    fontFamily: profile.fontFamily ?? '',
    primary: profile.brand.primary,
    secondary: profile.brand.secondary,
  };
}

export function OrganisationSettingsPage() {
  const { claims, paths } = useAuth();
  const profile = useRtdbQuery<OrgProfile | null>({
    key: claims ? keys.orgProfile(claims.orgId) : ['orgProfile', 'none'],
    path: claims && paths ? paths.db.orgProfile(claims.orgId) : '',
    enabled: Boolean(claims && paths),
  });

  const update = useCallable<UpdateOrgProfileInput, UpdateOrgProfileResult>(
    'updateOrgProfile',
  );

  const [form, setForm] = useState<FormState | null>(null);
  const [saved, setSaved] = useState(false);

  // A save confirmation must not sit under a form the admin has since changed.
  const touch = () => setSaved(false);
  const logo = useOrgImage(profile.data?.logoUrl, 'logo', touch);
  const cover = useOrgImage(profile.data?.coverImageUrl, 'cover image', touch);

  // Seed the form once from the first live snapshot; after that the admin's
  // draft wins (a concurrent edit elsewhere must not wipe their typing).
  useEffect(() => {
    if (form === null && profile.data) {
      setForm(stateFromProfile(profile.data));
    }
  }, [form, profile.data]);

  if (!profile.data || !form) {
    return (
      <div>
        <PageHeader
          title="Organisation"
          lede="Your organisation's name, contact details and branding."
        />
        {profile.isError ? (
          <ErrorNotice message="Could not load your organisation profile. Please try again." />
        ) : (
          <p role="status" className={styles.loading}>
            Loading organisation profile
          </p>
        )}
      </div>
    );
  }

  const current = profile.data;
  const hexValid = HEX_PATTERN.test(form.primary) && HEX_PATTERN.test(form.secondary);

  // A fontFamily outside the curated list is surfaced as an extra "Custom"
  // option rather than silently coerced, so existing data is never lost by
  // merely opening this page.
  const customFont = (current.fontFamily ?? '').trim();
  const fontOptions: FontOption[] =
    customFont && !FONT_OPTIONS.some((option) => option.value === customFont)
      ? [...FONT_OPTIONS, { value: customFont, label: `Custom: ${customFont}` }]
      : FONT_OPTIONS;

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setSaved(false);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  };

  /** Build the changed-fields-only payload for the TEXT fields. Empty optional
   *  fields are sent as empty strings only when the field previously held a
   *  value (a clear IS a change); untouched fields are omitted entirely. The two
   *  image fields are merged in at submit, once their uploads have resolved. */
  const buildChanges = (): UpdateOrgProfileInput['profile'] => {
    const changes: UpdateOrgProfileInput['profile'] = {};
    const name = form.name.trim();
    if (name && name !== current.name) {
      changes.name = name;
    }
    const font = form.fontFamily.trim();
    if (font !== (current.fontFamily ?? '')) {
      // '' means "back to the Safentia default": the clear protocol sends
      // null so the callable removes the override rather than storing ''.
      changes.fontFamily = font === '' ? null : font;
    }
    if (
      form.primary !== current.brand.primary ||
      form.secondary !== current.brand.secondary
    ) {
      changes.brand = { primary: form.primary, secondary: form.secondary };
    }
    const contact: OrgContact = {};
    let contactChanged = false;
    for (const key of CONTACT_KEYS) {
      const next = form.contact[key].trim();
      if (next) {
        contact[key] = next;
      }
      if (next !== (current.contact?.[key] ?? '')) {
        contactChanged = true;
      }
    }
    if (contactChanged) {
      changes.contact = contact;
    }
    return changes;
  };

  const dirty = Object.keys(buildChanges()).length > 0 || logo.dirty || cover.dirty;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!hexValid) {
      return;
    }
    setSaved(false);

    // Uploads first: a failed upload must abort the save rather than write a
    // profile that points at nothing. Each hook surfaces its own failure beside
    // its own control, so the admin is told which image needs retrying.
    const logoChange = await logo.resolve();
    if (logoChange === 'error') {
      return;
    }
    const coverChange = await cover.resolve();
    if (coverChange === 'error') {
      return;
    }

    const changes = buildChanges();
    if ('url' in logoChange) {
      changes.logoUrl = logoChange.url;
    }
    if ('url' in coverChange) {
      changes.coverImageUrl = coverChange.url;
    }
    if (Object.keys(changes).length === 0) {
      return;
    }
    const result = await update.call({ profile: changes });
    if (result) {
      setSaved(true);
      // The preview object URLs are deliberately kept: each tile keeps showing
      // the freshly saved image until the live snapshot catches up.
      // Re-seed from the next live snapshot is unnecessary: the fields the
      // admin sees are exactly what they submitted.
      logo.settle();
      cover.settle();
    }
  };

  const busy = logo.uploading || cover.uploading || update.pending;

  return (
    <div>
      <PageHeader
        title="Organisation"
        lede="Your organisation's name, contact details and branding. Changes apply across the console, the app and your reports."
      />
      <form className={styles.form} onSubmit={(event) => void onSubmit(event)} noValidate>
        <CardGrid min={380}>
        <Card>
          <CardHeader
            title="Organisation"
            hint="Who you are and how customers reach you."
          />
          <div className={styles.cardBody}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="org-name">
              Organisation name
            </label>
            <input
              id="org-name"
              className={styles.input}
              type="text"
              value={form.name}
              onChange={(event) => setField('name', event.target.value)}
              aria-invalid={form.name.trim() === ''}
            />
            {form.name.trim() === '' && (
              <p role="alert" className={styles.inlineError}>
                The organisation name cannot be removed, only changed.
              </p>
            )}
          </div>
          {CONTACT_FIELDS.map(({ key, label, type }) => (
            <div className={styles.field} key={key}>
              <label className={styles.label} htmlFor={`org-contact-${key}`}>
                {label}
              </label>
              <input
                id={`org-contact-${key}`}
                className={styles.input}
                type={type}
                value={form.contact[key]}
                onChange={(event) =>
                  setField('contact', {
                    ...form.contact,
                    [key]: event.target.value,
                  })
                }
              />
            </div>
          ))}
          <div className={styles.field}>
            {/* No `geo`: the org profile keeps no point, so the map is purely
                the faster way to a correct address. */}
            <AddressField
              id="org-contact-address"
              label="Address"
              value={form.contact.address}
              onChange={(value) =>
                setField('contact', { ...form.contact, address: value })
              }
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label} id="org-font-label">
              Font family
            </span>
            <FontSelect
              id="org-font"
              labelledBy="org-font-label"
              value={form.fontFamily}
              options={fontOptions}
              onChange={(value) => setField('fontFamily', value)}
            />
            {/* Live preview: the same resolveFontStack the console applies, so
                what the admin sees here is exactly what visitors will get. */}
            <p
              className={styles.fontPreview}
              style={{ fontFamily: resolveFontStack(form.fontFamily || undefined) }}
              aria-hidden="true"
            >
              Fire risk assessment for 12 High Street, ready for review.
            </p>
            <p id="org-font-hint" className={styles.note}>
              Used across the console, the app and your reports. Choose the
              Safentia default to use Inter.
            </p>
          </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Brand"
            hint="Colours, logo and report cover image, used across the console, the app and your reports."
          />
          <div className={styles.cardBody}>
          <ColourField
            id="org-brand-primary"
            label="Primary colour"
            value={form.primary}
            onChange={(value) => setField('primary', value)}
          />
          <ColourField
            id="org-brand-secondary"
            label="Secondary colour"
            value={form.secondary}
            onChange={(value) => setField('secondary', value)}
          />
          <p className={styles.note}>
            Brand colours are contrast-checked automatically before use.
          </p>

          <OrgImageField
            idPrefix="org-logo"
            label="Logo"
            image={logo}
            alt={`${current.name} logo`}
            emptyLabel="No logo yet"
            chooseLabel="Choose logo"
            removeLabel="Remove logo"
            cropTitle="Position your logo"
            cropConfirmLabel="Use this logo"
            hint="PNG, JPEG, SVG or WebP. You will crop it to a square; it appears in the console header and on your reports."
          />

          <OrgImageField
            idPrefix="org-cover-image"
            label="Report cover image"
            image={cover}
            alt={`${current.name} report cover image`}
            emptyLabel="No cover image yet"
            chooseLabel="Choose cover image"
            removeLabel="Remove cover image"
            cropTitle="Position your cover image"
            cropConfirmLabel="Use this image"
            // Printed at physical size on an A4 cover, so it is cropped at
            // twice the logo's resolution - 512px would visibly soften there.
            cropOutputSize={1024}
            hint="Your organisation's own decorative image for the top-left panel of the report cover - not a photo of any building. If you leave it empty, that panel is painted from your brand colours instead."
          />
          </div>
        </Card>
        </CardGrid>

        {/* Where your branding lands: a live, honest preview of the report and
            the branded emails, driven by the CURRENT form values (unsaved edits
            included) so the admin sees the effect before saving. */}
        <Card>
          <CardHeader
            title="Where your branding appears"
            hint="A live preview of your report and notification emails, from your current edits."
          />
          <div className={styles.cardBody}>
            <BrandingPreview
              orgName={form.name.trim() || current.name}
              brandPrimary={form.primary}
              logoUrl={logo.shownUrl}
            />
          </div>
        </Card>

        <div className={styles.saveBar}>
        {!hexValid && (
          <ErrorNotice message="Brand colours must be six-digit hex values, e.g. #1A5FB4." />
        )}
        {update.error && <ErrorNotice message={update.error} />}
        {saved && (
          <p role="status" className={styles.success}>
            Organisation profile saved.
          </p>
        )}

        <Button type="submit" disabled={busy || !hexValid || !dirty}>
          {logo.uploading
            ? 'Uploading logo'
            : cover.uploading
              ? 'Uploading cover image'
              : update.pending
                ? 'Saving'
                : 'Save changes'}
        </Button>
        </div>
      </form>
    </div>
  );
}

/** What one image contributes to the save: a URL to set, null to clear, or no
 *  `url` key at all when the image was untouched. */
type OrgImageChange = { url?: string | null };

interface OrgImage {
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
  /** True when there is an unsaved change (a new crop or a pending removal). */
  dirty: boolean;
  onPick: (file: File | null) => void;
  onRemove: () => void;
  onCropDone: (blob: Blob | null) => void;
  /** Upload any freshly picked file and return the change to merge into the
   *  payload, or 'error' when the save must abort. */
  resolve: () => Promise<OrgImageChange | 'error'>;
  /** Drop the pending state after the callable succeeded. */
  settle: () => void;
}

/**
 * One pick -> crop -> upload flow for an organisation image. Both the logo and
 * the report cover image use it, so there is a single upload path to reason
 * about rather than two that drift.
 *
 * The upload is deferred to the parent's submit (via `resolve`) so a freshly
 * uploaded object is REUSED on a retry after a failed callable, rather than
 * orphaning a new Storage object per attempt - the same reason
 * useCustomerImage defers its own.
 *
 * `subject` is the noun this image is called in the copy ('logo', 'cover
 * image'); it drives the hints, the failure sentence and the object name, so a
 * failure names the control the admin has to go back to.
 */
function useOrgImage(
  currentUrl: string | undefined,
  subject: string,
  onTouch: () => void,
): OrgImage {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';

  const [file, setFile] = useState<File | null>(null);
  // The download URL of an already-uploaded image: kept after a successful
  // upload so a retry after a FAILED CALLABLE reuses it instead of orphaning
  // a fresh Storage object per attempt. Reset when a different file is chosen.
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [cropSource, setCropSource] = useState<File | null>(null);
  // Object URL previewing the cropped image in the tile BEFORE it is saved.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // True when the admin asked for the current image to be removed on save.
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

  /** The crop dialog resolved: null on cancel, or the square PNG to upload. */
  const onCropDone = (blob: Blob | null) => {
    setCropSource(null);
    if (!blob) {
      return;
    }
    onTouch();
    setError(null);
    setFile(
      new File([blob], `${subject.replace(/\s+/g, '-')}-${Date.now()}.png`, {
        type: 'image/png',
      }),
    );
    setUploadedUrl(null);
    setRemoving(false);
    setPreviewUrl(URL.createObjectURL(blob));
  };

  const onRemove = () => {
    onTouch();
    setFile(null);
    setUploadedUrl(null);
    setPreviewUrl(null);
    setRemoving(true);
    setError(null);
  };

  const resolve = async (): Promise<OrgImageChange | 'error'> => {
    if (file) {
      if (uploadedUrl) {
        // This file already reached Storage on a previous attempt whose
        // callable failed; reuse it rather than uploading a duplicate.
        return { url: uploadedUrl };
      }
      if (!paths) {
        return 'error';
      }
      setUploading(true);
      try {
        // The contract's dedicated org-asset location (image-bounded by the
        // Storage rules; tenant/env boundaries as everywhere else), reached
        // through the console's one Storage-upload helper (lib/upload.ts) like
        // every other screen that moves a file - the helper passes the content
        // type explicitly for the rules check.
        const url = await uploadFile({
          storagePath: paths.storage.orgAsset(orgId, file.name),
          file,
        });
        setUploadedUrl(url);
        return { url };
      } catch {
        setError(`Could not upload the ${subject}. Please try again.`);
        return 'error';
      } finally {
        setUploading(false);
      }
    }
    if (removing && current) {
      // Clear protocol: null removes the stored image.
      return { url: null };
    }
    return {};
  };

  const settle = () => {
    setFile(null);
    setUploadedUrl(null);
    setRemoving(false);
  };

  const hintOverride = file
    ? `Your cropped ${subject} will be uploaded when you save.`
    : removing && current
      ? `The ${subject} will be removed when you save.`
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
    settle,
  };
}

/** The control itself: the current (or freshly cropped) image beside the
 *  Choose/Remove buttons, an empty-state tile when there is none. */
function OrgImageField({
  idPrefix,
  label,
  image,
  alt,
  emptyLabel,
  chooseLabel,
  removeLabel,
  cropTitle,
  cropConfirmLabel,
  cropOutputSize,
  hint,
}: {
  idPrefix: string;
  label: string;
  image: OrgImage;
  alt: string;
  emptyLabel: string;
  chooseLabel: string;
  removeLabel: string;
  cropTitle: string;
  cropConfirmLabel: string;
  cropOutputSize?: number;
  hint: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.field}>
      <span className={styles.label} id={`${idPrefix}-label`}>
        {label}
      </span>
      <div className={styles.imageRow}>
        {image.shownUrl ? (
          <img src={image.shownUrl} alt={alt} className={styles.imageTile} />
        ) : (
          <span className={styles.imageEmpty}>{emptyLabel}</span>
        )}
        <div className={styles.imageActions}>
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            {chooseLabel}
          </Button>
          {image.hasImage && (
            <Button type="button" variant="ghost" onClick={image.onRemove}>
              {removeLabel}
            </Button>
          )}
        </div>
      </div>
      {/* The real picker: hidden, driven by the Choose button. */}
      <input
        id={idPrefix}
        ref={fileInputRef}
        className={styles.hiddenFileInput}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,image/webp"
        tabIndex={-1}
        aria-hidden="true"
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
      <p id={`${idPrefix}-hint`} className={styles.note}>
        {image.hintOverride ?? hint}
      </p>
      {image.cropSource && (
        <ImageCropDialog
          file={image.cropSource}
          title={cropTitle}
          confirmLabel={cropConfirmLabel}
          outputSize={cropOutputSize}
          onDone={image.onCropDone}
        />
      )}
    </div>
  );
}

/** Paired colour-picker and hex text input with a live on-colour swatch. */
function ColourField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const valid = HEX_PATTERN.test(value);
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.colourRow}>
        <input
          id={`${id}-picker`}
          type="color"
          className={styles.colourPicker}
          value={valid ? value.toLowerCase() : '#000000'}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`${label} picker`}
        />
        <input
          id={id}
          type="text"
          className={styles.input}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          aria-invalid={!valid}
        />
        {valid && (
          <span
            className={styles.swatch}
            style={{ backgroundColor: value }}
            aria-hidden="true"
          >
            Aa
          </span>
        )}
      </div>
    </div>
  );
}
