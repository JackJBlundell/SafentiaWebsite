// ============================================================================
// OrganisationSettingsPage - the org's public face: name, contact details,
// branding (colours, font, logo).
//
// Reads live from /organisations/{orgId}/profile; saves ONLY the fields that
// changed, through the updateOrgProfile callable. The logo is picked, cropped
// square in ImageCropDialog (512x512 PNG), previewed in its tile, and uploaded
// to the tenant-scoped Storage area on save - only its download URL travels
// through the callable; removal sends logoUrl null. The font family is chosen
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
import { AddressSearch } from '../ui/AddressSearch';
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
  // `address` is rendered separately below as the Mapbox AddressSearch (same
  // destination input as the site and building forms); it still participates in
  // the save loop via CONTACT_KEYS.
];

const CONTACT_KEYS: (keyof OrgContact)[] = ['name', 'email', 'phone', 'address'];

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
    },
    fontFamily: profile.fontFamily ?? '',
    primary: profile.brand.primary,
    secondary: profile.brand.secondary,
  };
}

export function OrganisationSettingsPage() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const profile = useRtdbQuery<OrgProfile | null>({
    key: claims ? keys.orgProfile(claims.orgId) : ['orgProfile', 'none'],
    path: claims && paths ? paths.db.orgProfile(claims.orgId) : '',
    enabled: Boolean(claims && paths),
  });

  const update = useCallable<UpdateOrgProfileInput, UpdateOrgProfileResult>(
    'updateOrgProfile',
  );

  const [form, setForm] = useState<FormState | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The download URL of an already-uploaded logo: kept after a successful
  // upload so a retry after a FAILED CALLABLE reuses it instead of orphaning
  // a fresh Storage object per attempt. Reset when a different file is chosen.
  const [uploadedLogoUrl, setUploadedLogoUrl] = useState<string | null>(null);
  // The picked file awaiting cropping; non-null renders the crop dialog.
  const [cropSource, setCropSource] = useState<File | null>(null);
  // Object URL previewing the cropped logo in the tile BEFORE it is saved.
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  // True when the admin asked for the current logo to be removed on save.
  const [removeLogo, setRemoveLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke each preview object URL when it is replaced, and on unmount.
  useEffect(
    () => () => {
      if (logoPreviewUrl) {
        URL.revokeObjectURL(logoPreviewUrl);
      }
    },
    [logoPreviewUrl],
  );

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

  /** Build the changed-fields-only payload. Empty optional fields are sent as
   *  empty strings only when the field previously held a value (a clear IS a
   *  change); untouched fields are omitted entirely. */
  const buildChanges = (logoUrl?: string): UpdateOrgProfileInput['profile'] => {
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
    if (logoUrl) {
      changes.logoUrl = logoUrl;
    } else if (removeLogo && current.logoUrl) {
      // Clear protocol: null removes the stored logo.
      changes.logoUrl = null;
    }
    return changes;
  };

  const dirty = Object.keys(buildChanges()).length > 0 || logoFile !== null;

  /** The logo the tile should show right now: the pending cropped preview,
   *  else the saved logo, else nothing (and nothing while a removal is
   *  pending). */
  const logoShownUrl = removeLogo ? null : (logoPreviewUrl ?? current.logoUrl ?? null);

  const onPickLogo = (file: File | null) => {
    if (!file) {
      return;
    }
    const check = fileIsImage(file);
    if (!check.ok) {
      setLogoError(check.reason);
      return;
    }
    setLogoError(null);
    setCropSource(file);
  };

  /** The crop dialog resolved: null on cancel, or the 512x512 PNG to upload. */
  const onCropDone = (blob: Blob | null) => {
    setCropSource(null);
    if (!blob) {
      return;
    }
    setSaved(false);
    setLogoFile(new File([blob], `logo-${Date.now()}.png`, { type: 'image/png' }));
    setUploadedLogoUrl(null);
    setRemoveLogo(false);
    setLogoPreviewUrl(URL.createObjectURL(blob));
  };

  const onRemoveLogo = () => {
    setSaved(false);
    setLogoFile(null);
    setUploadedLogoUrl(null);
    setLogoPreviewUrl(null);
    setRemoveLogo(true);
    setLogoError(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!paths || !hexValid) {
      return;
    }
    setSaved(false);
    setUploadError(null);

    let logoUrl: string | undefined;
    if (logoFile) {
      if (uploadedLogoUrl) {
        // This file already reached Storage on a previous attempt whose
        // callable failed; reuse it rather than uploading a duplicate.
        logoUrl = uploadedLogoUrl;
      } else {
        setUploading(true);
        try {
          // The contract's dedicated org-asset location (image-bounded by the
          // Storage rules; tenant/env boundaries as everywhere else). The file
          // is the crop dialog's output, already named logo-{ts}.png with
          // contentType image/png.
          // Routed through the console's one Storage-upload helper
          // (lib/upload.ts), like every other screen that moves a file; the
          // helper passes the content type explicitly for the rules check.
          logoUrl = await uploadFile({
            storagePath: paths.storage.orgAsset(
              orgId,
              logoFile.name.replace(/[^\w.-]/g, '_'),
            ),
            file: logoFile,
          });
        } catch {
          setUploadError('Could not upload the logo. Please try again.');
          setUploading(false);
          return;
        }
        setUploading(false);
        setUploadedLogoUrl(logoUrl);
      }
    }

    const changes = buildChanges(logoUrl);
    if (Object.keys(changes).length === 0) {
      return;
    }
    const result = await update.call({ profile: changes });
    if (result) {
      setSaved(true);
      setLogoFile(null);
      setUploadedLogoUrl(null);
      setRemoveLogo(false);
      // The preview object URL is deliberately kept: the tile keeps showing
      // the freshly saved logo until the live snapshot catches up.
      // Re-seed from the next live snapshot is unnecessary: the fields the
      // admin sees are exactly what they submitted.
    }
  };

  const busy = uploading || update.pending;

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
            <AddressSearch
              id="org-contact-address"
              label="Address"
              value={form.contact.address}
              onChange={(value) =>
                setField('contact', { ...form.contact, address: value })
              }
              onSelect={(selection) =>
                // The org record has no geo field; the search is purely the
                // faster way to type a correct address.
                setField('contact', { ...form.contact, address: selection.address })
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
            hint="Colours and logo, used across the console, the app and your reports."
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

          <div className={styles.field}>
            <span className={styles.label} id="org-logo-label">
              Logo
            </span>
            <div className={styles.logoRow}>
              {logoShownUrl ? (
                <img
                  src={logoShownUrl}
                  alt={`${current.name} logo`}
                  className={styles.logoTile}
                />
              ) : (
                <span className={styles.logoEmpty}>No logo yet</span>
              )}
              <div className={styles.logoActions}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose logo
                </Button>
                {logoShownUrl && (
                  <Button type="button" variant="ghost" onClick={onRemoveLogo}>
                    Remove logo
                  </Button>
                )}
              </div>
            </div>
            {/* The real picker: hidden, driven by the Choose logo button. */}
            <input
              id="org-logo"
              ref={fileInputRef}
              className={styles.hiddenFileInput}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                onPickLogo(event.target.files?.[0] ?? null);
                // Reset so picking the same file again still fires change.
                event.target.value = '';
              }}
            />
            {logoError && (
              <p role="alert" className={styles.inlineError}>
                {logoError}
              </p>
            )}
            <p id="org-logo-hint" className={styles.note}>
              {logoFile
                ? 'Your cropped logo will be uploaded when you save.'
                : removeLogo && current.logoUrl
                  ? 'The logo will be removed when you save.'
                  : 'PNG, JPEG, SVG or WebP. You will crop it to a square; it appears in the console header and on your reports.'}
            </p>
          </div>
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
              logoUrl={logoShownUrl}
            />
          </div>
        </Card>

        <div className={styles.saveBar}>
        {!hexValid && (
          <ErrorNotice message="Brand colours must be six-digit hex values, e.g. #1A5FB4." />
        )}
        {uploadError && <ErrorNotice message={uploadError} />}
        {update.error && <ErrorNotice message={update.error} />}
        {saved && (
          <p role="status" className={styles.success}>
            Organisation profile saved.
          </p>
        )}

        <Button type="submit" disabled={busy || !hexValid || !dirty}>
          {uploading ? 'Uploading logo' : update.pending ? 'Saving' : 'Save changes'}
        </Button>
        </div>
      </form>

      {cropSource && <ImageCropDialog file={cropSource} onDone={onCropDone} />}
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
