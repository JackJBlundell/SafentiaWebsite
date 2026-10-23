// ============================================================================
// DocumentsPanel - a building's document library, grouped by category, with
// admin add (upload + record) and remove.
//
// Reads live per category: /documents/{orgId}/{buildingId}/{category} is one
// node per category, and DOCUMENT_CATEGORIES is a bounded compile-time set, so
// one listener per category is the natural, indexed shape (no client-side
// filtering of a larger subtree).
//
// A SafentiaDocument stores its Storage object path, not a download URL. Each
// row fetches the file through the SDK (so App Check is sent) only when it is
// opened, with the signed-in member's own access, exactly as the rules intend.
//
// NOTE on building reference images (story 2022): the schema has no gallery
// concept - DocumentCategory has no images entry, Building carries a single
// photoUrl, and there is no DB node the app subscribes to for an org-provided
// gallery (paths.storage.photo is the app's assessment-photo area). Rather
// than invent a node nothing reads, reference images are deferred pending a
// schema decision; see the wave report.
// ============================================================================

import { useCallback, useState, type ChangeEvent, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  DOCUMENT_CATEGORIES,
  type DocumentCategory,
  type ManageBuildingDocumentInput,
  type ManageBuildingDocumentResult,
  type SafentiaDocument,
} from '../../types';
import { EmptyState, ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { fileIsDocument, newObjectId, uploadFile } from '../lib/upload';
import { StoredFileLink } from '../lib/StoredFile';
import { useStoredFileStatus } from '../lib/useStoredFileUrl';
import { StoredLightbox } from './Lightbox';
import styles from './DocumentsPanel.module.css';

/** Image documents open in the lightbox; everything else keeps its direct
 *  download link. The record stores no MIME type, so the extension decides. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

function isImageDocument(fileName: string): boolean {
  return IMAGE_EXTENSIONS.test(fileName);
}

/** Human titles for every DocumentCategory. Kept exhaustive by the Record type:
 *  adding a category without a label is a compile error. */
export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  fireDoorRecords: 'Fire door records',
  floorPlans: 'Floor plans',
  safetyPolicy: 'Safety policy',
  emergencyPlans: 'Emergency plans',
  other: 'Other documents',
  ppmCertificates: 'PPM certificates',
  quotesRemedials: 'Quotes and remedials',
  trainingRecords: 'Training records',
  signedWorkSurvey: 'Signed work surveys',
  userGuides: 'User guides',
};

interface CategoryDocs {
  category: DocumentCategory;
  docs: [string, SafentiaDocument][];
  isError: boolean;
}

/**
 * Subscribe to every category node for the building. DOCUMENT_CATEGORIES is a
 * compile-time constant tuple, so the hook call order inside this loop is
 * identical on every render - the Rules-of-Hooks invariant holds even though a
 * linter cannot prove it statically.
 */
function useDocumentsByCategory(
  orgId: string,
  buildingId: string,
  dbPath: ((category: DocumentCategory) => string) | null,
): CategoryDocs[] {
  const sections: CategoryDocs[] = [];
  for (const category of DOCUMENT_CATEGORIES) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- fixed constant set, stable order
    const query = useRtdbQuery<Record<string, SafentiaDocument> | null>({
      key: keys.documents(orgId, buildingId, category),
      path: dbPath ? dbPath(category) : '',
      enabled: Boolean(orgId && dbPath),
    });
    sections.push({
      category,
      docs: Object.entries(query.data ?? {}).sort(
        ([, a], [, b]) => b.uploadedAt - a.uploadedAt,
      ),
      isError: query.isError,
    });
  }
  return sections;
}

export function DocumentsPanel({ buildingId }: { buildingId: string }) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const isAdmin = claims?.roles.admin === true;

  const sections = useDocumentsByCategory(
    orgId,
    buildingId,
    paths ? (category) => paths.db.documents(orgId, buildingId, category) : null,
  );

  const populated = sections.filter((section) => section.docs.length > 0);
  const anyError = sections.some((section) => section.isError);

  return (
    <section className={styles.panel} aria-labelledby="documents-heading">
      <h2 id="documents-heading" className={styles.heading}>
        Documents
      </h2>

      {anyError && (
        <ErrorNotice message="Could not load some documents. Please try again." />
      )}

      {populated.length === 0 && !anyError && (
        <EmptyState
          title="No documents"
          body="Certificates, policies and plans uploaded for this building appear here, grouped by category."
        />
      )}

      {populated.map(({ category, docs }) => (
        <div key={category} className={styles.category}>
          <h3 className={styles.categoryHeading}>{CATEGORY_LABELS[category]}</h3>
          <ul className={styles.list}>
            {docs.map(([docId, doc]) => (
              <DocumentRow
                key={docId}
                buildingId={buildingId}
                category={category}
                docId={docId}
                doc={doc}
                isAdmin={isAdmin}
              />
            ))}
          </ul>
        </div>
      ))}

      {isAdmin && <AddDocumentForm buildingId={buildingId} />}
    </section>
  );
}

// --- One document row ---------------------------------------------------------

function DocumentRow({
  buildingId,
  category,
  docId,
  doc,
  isAdmin,
}: {
  buildingId: string;
  category: DocumentCategory;
  docId: string;
  doc: SafentiaDocument;
  isAdmin: boolean;
}) {
  const manage = useCallable<
    ManageBuildingDocumentInput,
    ManageBuildingDocumentResult
  >('manageBuildingDocument');
  const [confirming, setConfirming] = useState(false);
  const [viewing, setViewing] = useState(false);
  // Checked without downloading; an unreachable file stays plain text - the
  // record is still legible, and the rules told us the object is not ours to
  // open right now.
  const fileStatus = useStoredFileStatus(doc.storagePath);
  const closeViewer = useCallback(() => setViewing(false), []);

  // Removing removes the DB record only: the stored object is not purged in
  // this wave (a later lifecycle/cleanup pass owns Storage garbage collection).
  const remove = async () => {
    const result = await manage.call({
      action: 'remove',
      buildingId,
      category,
      docId,
    });
    if (result) {
      setConfirming(false);
    }
  };

  return (
    <li className={styles.row}>
      <div className={styles.rowBody}>
        {fileStatus !== 'ready' ? (
          <span className={styles.fileName}>{doc.fileName}</span>
        ) : isImageDocument(doc.fileName) ? (
          // Images open full size in the lightbox, fetched when opened.
          <button
            type="button"
            className={styles.fileLinkButton}
            onClick={() => setViewing(true)}
          >
            {doc.fileName}
          </button>
        ) : (
          // The record stores the path (stable, tenant-scoped); the file is
          // fetched through the SDK only when clicked.
          <StoredFileLink
            className={styles.fileLink}
            reference={doc.storagePath}
            fileName={doc.fileName}
          >
            {doc.fileName}
          </StoredFileLink>
        )}
        {viewing && (
          <StoredLightbox
            reference={doc.storagePath}
            title={doc.fileName}
            onClose={closeViewer}
          />
        )}
        {doc.description && (
          <p className={styles.description}>{doc.description}</p>
        )}
        <p className={styles.meta}>Uploaded {formatDate(doc.uploadedAt)}</p>

        {manage.error && (
          <p role="alert" className={styles.inlineError}>
            {manage.error}
          </p>
        )}

        {isAdmin && !confirming && (
          <div className={styles.rowActions}>
            <Button variant="ghost" onClick={() => setConfirming(true)}>
              Remove
            </Button>
          </div>
        )}
        {isAdmin && confirming && (
          <div className={styles.confirm}>
            <p className={styles.confirmCopy}>
              Remove this document from the building record?
            </p>
            <div className={styles.rowActions}>
              <Button
                variant="secondary"
                onClick={() => void remove()}
                disabled={manage.pending}
              >
                {manage.pending ? 'Removing' : 'Remove document'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming(false);
                  manage.clearError();
                }}
                disabled={manage.pending}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function formatDate(epochMillis: number): string {
  return new Date(epochMillis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// --- Add form: category + file + description -> upload -> create record --------

function AddDocumentForm({ buildingId }: { buildingId: string }) {
  const { claims, paths } = useAuth();
  const manage = useCallable<
    ManageBuildingDocumentInput,
    ManageBuildingDocumentResult
  >('manageBuildingDocument');
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<DocumentCategory>('fireDoorRecords');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formNonce, setFormNonce] = useState(0);
  // The object path of an already-uploaded file: kept after a successful
  // upload so a retry after a FAILED CALLABLE reuses it instead of orphaning
  // a fresh Storage object per attempt. Reset when the chosen file or the
  // category changes (the category is part of the object path).
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    setError(null);
    setUploadedPath(null);
    if (chosen) {
      const check = fileIsDocument(chosen);
      if (!check.ok) {
        setError(check.reason);
        setFile(null);
        return;
      }
    }
    setFile(chosen);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!file) {
      setError('Choose a file to upload.');
      return;
    }
    if (!claims || !paths) {
      return;
    }
    const check = fileIsDocument(file);
    if (!check.ok) {
      setError(check.reason);
      return;
    }

    // The client names the storage object; the record then carries this path.
    // A retry whose upload already succeeded reuses that object outright.
    let storagePath = uploadedPath;
    if (storagePath === null) {
      const objectId = newObjectId();
      storagePath = paths.storage.document(
        claims.orgId,
        buildingId,
        category,
        objectId,
      );

      setProgress(0);
      try {
        await uploadFile({ storagePath, file, onProgress: setProgress });
      } catch {
        setProgress(null);
        setError('The upload failed. Check your connection and try again.');
        return;
      }
      setProgress(null);
      setUploadedPath(storagePath);
    }

    const result = await manage.call({
      action: 'create',
      buildingId,
      category,
      document: {
        fileName: file.name,
        description: description.trim() || undefined,
        storagePath,
      },
    });
    if (result) {
      setDescription('');
      setFile(null);
      setUploadedPath(null);
      setFormNonce((n) => n + 1);
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <div className={styles.addTrigger}>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Add document
        </Button>
      </div>
    );
  }

  const busy = progress !== null || manage.pending;

  return (
    <form
      key={formNonce}
      className={styles.addForm}
      onSubmit={(event) => void submit(event)}
      aria-label="Add document"
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="new-document-category">
          Category
        </label>
        <select
          id="new-document-category"
          className={styles.select}
          value={category}
          onChange={(event) => {
            setCategory(event.target.value as DocumentCategory);
            setUploadedPath(null);
          }}
          disabled={busy}
        >
          {DOCUMENT_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {CATEGORY_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="new-document-file">
          File (up to 25 MB)
        </label>
        <input
          id="new-document-file"
          className={styles.fileInput}
          type="file"
          onChange={onFileChange}
          disabled={busy}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="new-document-description">
          Description (optional)
        </label>
        <input
          id="new-document-description"
          className={styles.input}
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={busy}
        />
      </div>

      {progress !== null && (
        <div className={styles.progressWrap}>
          <progress
            className={styles.progress}
            value={progress}
            max={1}
            aria-label="Upload progress"
          />
          <span className={styles.progressLabel}>
            {Math.round(progress * 100)}%
          </span>
        </div>
      )}

      {error && (
        <p role="alert" className={styles.inlineError}>
          {error}
        </p>
      )}
      {manage.error && (
        <p role="alert" className={styles.inlineError}>
          {manage.error}
        </p>
      )}

      <div className={styles.rowActions}>
        <Button type="submit" disabled={busy}>
          {progress !== null
            ? 'Uploading'
            : manage.pending
              ? 'Saving'
              : 'Add document'}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
