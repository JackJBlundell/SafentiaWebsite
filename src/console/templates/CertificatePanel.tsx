// ============================================================================
// CertificatePanel - attach an organisation PDF to a template.
//
// The certificate (an accreditation certificate, a signed cover sheet) is merged
// into EVERY report rendered from this template, before the report or after it.
// The panel edits the DRAFT template in place, exactly as the name and standard
// controls above it do; publishTemplate re-validates the result (the position
// against CERTIFICATE_POSITIONS, the url against the caller's own Storage root)
// before it can reach a published version. Nothing here is trusted server-side.
//
// The upload follows the FloorPlansPanel pattern: the object id is minted
// client-side, the file goes up resumably with a progress bar, and the resolved
// URL is CACHED in local state. That cache matters - if the draft write that
// follows fails, retrying reuses the object already in Storage instead of making
// the admin upload the file a second time.
// ============================================================================

import { useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { CERTIFICATE_POSITIONS } from '../../types';
import type { CertificatePosition, Template, TemplateCertificate } from '../../types';
import { ErrorNotice } from '../ui/Page';
import { MAX_DOCUMENT_BYTES, newObjectId, uploadFile } from '../lib/upload';
import styles from './TemplateBuilder.module.css';

const POSITION_LABELS: Record<CertificatePosition, string> = {
  top: 'Before the report',
  bottom: 'After the report',
};

export interface CertificatePanelProps {
  template: Template;
  /** Applies an edited template to the builder's draft state (autosaved). */
  onChange: (next: Template) => void;
  /** True while a publish is in flight; edits are suppressed then. */
  disabled: boolean;
}

export function CertificatePanel({
  template,
  onChange,
  disabled,
}: CertificatePanelProps) {
  const { claims, paths } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const certificate = template.certificate;

  const choose = () => {
    setError(null);
    fileInput.current?.click();
  };

  const upload = async (file: File) => {
    // PDF only: the pages are spliced into the report verbatim, so any other
    // format has nothing the merge step could use.
    if (file.type !== 'application/pdf') {
      setError('The certificate must be a PDF file.');
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError('This PDF is larger than 25 MB. Please choose a smaller file.');
      return;
    }
    if (!claims?.orgId || !paths) {
      return;
    }

    setError(null);
    setProgress(0);
    try {
      // The certificate is an organisation-level asset, not building media, so
      // it lives under the org's assets prefix - but in its own `certificates`
      // segment, whose Storage rule admits PDFs. The sibling `assets/{assetId}`
      // rule stays image-only so a PDF can never become the whitelabel logo.
      const url = await uploadFile({
        storagePath: paths.storage.orgCertificate(claims.orgId, newObjectId()),
        file,
        onProgress: setProgress,
      });
      const next: TemplateCertificate = {
        url,
        name: file.name,
        // Replacing a certificate keeps wherever the admin had positioned it;
        // a first upload defaults to the front, which is where an accreditation
        // certificate is normally read.
        position: certificate?.position ?? 'top',
        uploadedAt: Date.now(),
      };
      onChange({ ...template, certificate: next });
    } catch {
      setError(
        'The certificate could not be uploaded. Please check your connection and try again.',
      );
    } finally {
      setProgress(null);
    }
  };

  const remove = () => {
    setError(null);
    const next = { ...template };
    delete next.certificate;
    onChange(next);
  };

  const setPosition = (position: CertificatePosition) => {
    if (!certificate) {
      return;
    }
    onChange({ ...template, certificate: { ...certificate, position } });
  };

  const busy = progress !== null;

  return (
    <div className={styles.field}>
      <span className={styles.label}>Certificate</span>
      <p className={styles.hint}>
        A PDF merged into every report generated from this template, such as an
        accreditation certificate or a signed cover sheet. Its pages are included
        exactly as uploaded.
      </p>
      {/* Password-protected files cannot be merged reliably: the pages can copy
          across as unreadable content without raising an error, so the report
          would go out with a corrupt certificate rather than none. Warning the
          admin here is the only practical guard. */}
      <p className={styles.hint}>
        Do not upload a password-protected PDF. Reports are generated
        automatically on release, so a certificate that cannot be read is left
        out of the report rather than holding up the release.
      </p>

      {certificate ? (
        <>
          <p className={styles.hint}>Attached: {certificate.name}</p>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="builder-certificate-position">
              Where it appears
            </label>
            <select
              id="builder-certificate-position"
              className={styles.select}
              value={certificate.position}
              disabled={disabled || busy}
              onChange={(event) =>
                setPosition(event.target.value as CertificatePosition)
              }
            >
              {CERTIFICATE_POSITIONS.map((position) => (
                <option key={position} value={position}>
                  {POSITION_LABELS[position]}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : (
        <p className={styles.hint}>No certificate is attached.</p>
      )}

      {busy && (
        <p className={styles.hint}>
          Uploading {Math.round((progress ?? 0) * 100)}%
        </p>
      )}
      {error && <ErrorNotice message={error} />}

      <div className={styles.certificateActions}>
        <Button variant="secondary" onClick={choose} disabled={disabled || busy}>
          {certificate ? 'Replace certificate' : 'Upload certificate'}
        </Button>
        {certificate && (
          <Button variant="secondary" onClick={remove} disabled={disabled || busy}>
            Remove
          </Button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared immediately so choosing the SAME file again still fires a
          // change event.
          event.target.value = '';
          if (file) {
            void upload(file);
          }
        }}
      />
    </div>
  );
}
