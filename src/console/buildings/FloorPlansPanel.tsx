// ============================================================================
// FloorPlansPanel - a building's floor plans: live list, and admin add /
// rename / remove (story 1053).
//
// Floor plans are OPTIONAL by design: an assessor can complete an assessment
// without any, so the empty state explains what plans unlock rather than
// demanding one. The upload flow is client-first: validate (upload.ts, UX
// mirror of storage.rules), upload to the tenant-scoped object path with a
// visible progress bar, then hand the download URL to the manageFloorPlan
// callable which writes the DB record. The list reflects live via the RTDB
// bridge, so no optimistic bookkeeping is needed here.
//
// A building commonly has several plans (one per floor), so the add form takes
// a BATCH: each chosen file becomes its own record via its own create call, but
// the admin picks, names and confirms them in one pass. The batch runs one file
// at a time so each gets a truthful progress bar and its own outcome; a file
// that fails leaves the ones that already succeeded alone and can be retried on
// its own.
// ============================================================================

import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  FloorPlan,
  ManageFloorPlanInput,
  ManageFloorPlanResult,
} from '../../types';
import { EmptyState, ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { fileIsFloorPlan, newObjectId, uploadFile } from '../lib/upload';
import { Lightbox } from './Lightbox';
import styles from './FloorPlansPanel.module.css';

const EMPTY_STATE_BODY =
  'No floor plans yet. Assessors can still complete assessments; location flagging becomes available once plans are added.';

const REMOVE_CONFIRM_COPY =
  'Remove this floor plan? Past assessments keep their annotated copies.';

/** The single ordering rule used EVERYWHERE plans are listed (story 2021):
 *  ascending by the admin-set `order`; a plan without one (predating the field)
 *  sorts after every ordered plan; ties, and two unordered plans, fall back to
 *  the name. Kept as one function so the list, the reorder maths and any future
 *  reader agree on exactly one order. */
export function compareFloorPlans(a: FloorPlan, b: FloorPlan): number {
  const ao = a.order;
  const bo = b.order;
  if (ao !== undefined && bo !== undefined && ao !== bo) return ao - bo;
  if (ao !== undefined && bo === undefined) return -1;
  if (ao === undefined && bo !== undefined) return 1;
  return a.name.localeCompare(b.name);
}

export function FloorPlansPanel({ buildingId }: { buildingId: string }) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const isAdmin = claims?.roles.admin === true;
  const enabled = Boolean(orgId && paths);

  // Reorder is a whole-list operation, so it lives at the panel (which holds the
  // full ordered list) rather than in a row. The list reflects the new order via
  // the live RTDB listener once the callable writes it, so a failed reorder
  // leaves both the data and the UI as the server has them, never a lie.
  const reorder = useCallable<ManageFloorPlanInput, ManageFloorPlanResult>(
    'manageFloorPlan',
  );
  // Announced politely after a successful move so a screen-reader user hears the
  // plan's new position (visual users see the row jump).
  const [reorderMessage, setReorderMessage] = useState('');

  const plansQuery = useRtdbQuery<Record<string, FloorPlan> | null>({
    key: keys.floorPlans(orgId, buildingId),
    path: paths ? paths.db.floorPlans(orgId, buildingId) : '',
    enabled,
  });

  const plans = Object.entries(plansQuery.data ?? {}).sort(([, a], [, b]) =>
    compareFloorPlans(a, b),
  );

  // Swap a plan with its neighbour and send the FULL id list in the new order;
  // the callable validates it against the current set and rejects a stale one.
  const movePlan = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= plans.length || reorder.pending) {
      return;
    }
    const ids = plans.map(([id]) => id);
    const moved = plans[index][1].name;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    const result = await reorder.call({
      action: 'reorder',
      buildingId,
      order: ids,
    });
    if (result) {
      setReorderMessage(
        `${moved} moved to position ${target + 1} of ${plans.length}.`,
      );
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="floor-plans-heading">
      <h2 id="floor-plans-heading" className={styles.heading}>
        Floor plans
      </h2>

      {plansQuery.isError && (
        <ErrorNotice message="Could not load floor plans. Please try again." />
      )}

      {reorder.error && <ErrorNotice message={reorder.error} />}

      {plans.length === 0 && !plansQuery.isLoading && !plansQuery.isError && (
        <EmptyState title="No floor plans" body={EMPTY_STATE_BODY} />
      )}

      {plans.length > 0 && (
        <ul className={styles.list}>
          {plans.map(([planId, plan], index) => (
            <PlanRow
              key={planId}
              buildingId={buildingId}
              planId={planId}
              plan={plan}
              isAdmin={isAdmin}
              index={index}
              count={plans.length}
              reordering={reorder.pending}
              onMove={(direction) => void movePlan(index, direction)}
            />
          ))}
        </ul>
      )}

      {/* Polite live region: position feedback for assistive tech, off-screen. */}
      <p aria-live="polite" className={styles.visuallyHidden}>
        {reorderMessage}
      </p>

      {isAdmin && <AddPlanForm buildingId={buildingId} />}
    </section>
  );
}

// --- One plan row: thumbnail, name/description, admin edit + remove ----------

function PlanRow({
  buildingId,
  planId,
  plan,
  isAdmin,
  index,
  count,
  reordering,
  onMove,
}: {
  buildingId: string;
  planId: string;
  plan: FloorPlan;
  isAdmin: boolean;
  /** This row's position in the ordered list, and the list length, so the move
   *  controls can disable at the ends. */
  index: number;
  count: number;
  /** A reorder is in flight, so the move controls lock to avoid overlapping
   *  writes. */
  reordering: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  const manage = useCallable<ManageFloorPlanInput, ManageFloorPlanResult>(
    'manageFloorPlan',
  );
  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);

  const startEdit = () => {
    setName(plan.name);
    setDescription(plan.description ?? '');
    setFormError(null);
    setEditing(true);
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Enter a name for this floor plan.');
      return;
    }
    const result = await manage.call({
      action: 'update',
      buildingId,
      planId,
      plan: { name: trimmed, description: description.trim() || undefined },
    });
    if (result) {
      setEditing(false);
    }
  };

  const remove = async () => {
    const result = await manage.call({ action: 'remove', buildingId, planId });
    if (result) {
      setConfirmingRemove(false);
    }
  };

  return (
    <li className={styles.row}>
      {plan.kind === 'pdf' ? (
        // Non-image plans download directly: the tile links straight to the
        // stored PDF rather than opening an image lightbox.
        <a
          className={styles.pdfTile}
          href={plan.imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Download ${plan.name} (PDF)`}
        >
          PDF
        </a>
      ) : (
        <button
          type="button"
          className={styles.thumbnailButton}
          onClick={() => setViewing(true)}
          aria-label={`View ${plan.name} full size`}
        >
          <img className={styles.thumbnail} src={plan.imageUrl} alt="" />
        </button>
      )}
      {viewing && (
        <Lightbox
          src={plan.imageUrl}
          title={plan.name}
          onClose={() => setViewing(false)}
        />
      )}

      <div className={styles.rowBody}>
        {editing ? (
          <form className={styles.editForm} onSubmit={(event) => void saveEdit(event)}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`plan-name-${planId}`}>
                Name
              </label>
              <input
                id={`plan-name-${planId}`}
                className={styles.input}
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`plan-description-${planId}`}>
                Description
              </label>
              <input
                id={`plan-description-${planId}`}
                className={styles.input}
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            {formError && (
              <p role="alert" className={styles.inlineError}>
                {formError}
              </p>
            )}
            {manage.error && (
              <p role="alert" className={styles.inlineError}>
                {manage.error}
              </p>
            )}
            <div className={styles.rowActions}>
              <Button type="submit" size="md" disabled={manage.pending}>
                {manage.pending ? 'Saving' : 'Save'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={manage.pending}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className={styles.planName}>{plan.name}</p>
            {plan.description && (
              <p className={styles.planDescription}>{plan.description}</p>
            )}
            {manage.error && !confirmingRemove && (
              <p role="alert" className={styles.inlineError}>
                {manage.error}
              </p>
            )}
            {isAdmin && !confirmingRemove && (
              <div className={styles.rowActions}>
                {/* Move controls: keyboard-operable buttons are the accessible
                    baseline for reordering. The off-screen plan name gives each
                    button a distinct accessible name that still CONTAINS its
                    visible text (WCAG 2.5.3). Disabled at the list ends and while
                    a reorder is being saved. */}
                <Button
                  variant="ghost"
                  onClick={() => onMove(-1)}
                  disabled={index === 0 || reordering}
                >
                  Move up
                  <span className={styles.visuallyHidden}> {plan.name}</span>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => onMove(1)}
                  disabled={index === count - 1 || reordering}
                >
                  Move down
                  <span className={styles.visuallyHidden}> {plan.name}</span>
                </Button>
                <Button variant="ghost" onClick={startEdit} disabled={reordering}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmingRemove(true)}
                  disabled={reordering}
                >
                  Remove
                </Button>
              </div>
            )}
            {isAdmin && confirmingRemove && (
              <div className={styles.confirm}>
                <p className={styles.confirmCopy}>{REMOVE_CONFIRM_COPY}</p>
                {manage.error && (
                  <p role="alert" className={styles.inlineError}>
                    {manage.error}
                  </p>
                )}
                <div className={styles.rowActions}>
                  <Button
                    variant="secondary"
                    onClick={() => void remove()}
                    disabled={manage.pending}
                  >
                    {manage.pending ? 'Removing' : 'Remove plan'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirmingRemove(false)}
                    disabled={manage.pending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

// --- Add form: pick a batch -> validate -> upload each -> create each --------

/** Where one chosen file has got to. `added` is terminal: its DB record exists
 *  and it is never re-sent, which is what makes a partial failure retryable. */
type PendingStatus = 'ready' | 'uploading' | 'saving' | 'added' | 'failed';

interface PendingPlan {
  /** Stable across re-renders so the name input keeps focus while typing. */
  key: string;
  file: File;
  name: string;
  description: string;
  status: PendingStatus;
  /** 0..1, meaningful only while `status` is 'uploading'. */
  progress: number;
  /** Why this file failed, in words the admin can act on. */
  error: string | null;
  // The download URL of an already-uploaded object: kept after a successful
  // upload so a retry after a FAILED CALLABLE reuses it instead of orphaning a
  // fresh Storage object per attempt.
  uploadedUrl: string | null;
}

const STATUS_LABELS: Record<PendingStatus, string> = {
  ready: 'Ready to upload',
  uploading: 'Uploading',
  saving: 'Saving',
  added: 'Added',
  failed: 'Not added',
};

/** A first-guess plan name from the file name: drop the extension and tidy the
 *  separators, so "Ground_Floor.pdf" offers "Ground Floor" to edit. */
function planNameFromFile(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  const tidied = withoutExtension.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return tidied || fileName;
}

function AddPlanForm({ buildingId }: { buildingId: string }) {
  const { claims, paths } = useAuth();
  const manage = useCallable<ManageFloorPlanInput, ManageFloorPlanResult>(
    'manageFloorPlan',
  );
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PendingPlan[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Bumped after a clean run to reset the file input (its value is read-only).
  const [formNonce, setFormNonce] = useState(0);

  // Choosing files REPLACES the pending list, matching the file input's own
  // semantics. Nothing is lost by that: anything already added is a live record
  // showing in the list above, and only unadded files are discarded.
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFormError(null);
    const chosen = Array.from(event.target.files ?? []);
    setItems(
      chosen.map((file, index) => {
        const check = fileIsFloorPlan(file);
        return {
          key: `${Date.now().toString(36)}-${index}`,
          file,
          name: planNameFromFile(file.name),
          description: '',
          status: check.ok ? 'ready' : 'failed',
          progress: 0,
          error: check.ok ? null : check.reason,
          uploadedUrl: null,
        };
      }),
    );
  };

  const patch = (key: string, changes: Partial<PendingPlan>) => {
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...changes } : item)),
    );
  };

  const closeForm = () => {
    setItems([]);
    setFormError(null);
    setFormNonce((n) => n + 1);
    setOpen(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!claims || !paths) {
      return;
    }
    if (items.length === 0) {
      setFormError('Choose one or more floor plan files to upload.');
      return;
    }
    // Already-added files are skipped, so pressing the button again after a
    // partial failure retries ONLY what is outstanding.
    const outstanding = items.filter((item) => item.status !== 'added');
    if (outstanding.length === 0) {
      closeForm();
      return;
    }

    // A local working copy carries each file's uploadedUrl and edited name
    // through the run; the inputs are disabled meanwhile, so it cannot drift
    // from what the admin sees.
    const working = outstanding.map((item) => ({ ...item }));
    setRunning(true);
    let anyFailed = false;

    for (const entry of working) {
      const trimmedName = entry.name.trim();
      if (!trimmedName) {
        anyFailed = true;
        patch(entry.key, { status: 'failed', error: 'Enter a name for this plan.' });
        continue;
      }
      // Re-check on submit as well as on change: the ceilings are a UX mirror
      // of storage.rules, and a file chosen minutes ago is still unverified.
      const check = fileIsFloorPlan(entry.file);
      if (!check.ok) {
        anyFailed = true;
        patch(entry.key, { status: 'failed', error: check.reason });
        continue;
      }

      // The client names the storage object: paths.storage.floorPlan takes an
      // object id segment, so we mint one here. The DB record id is assigned by
      // the callable; the two need not match - the record carries the URL.
      if (entry.uploadedUrl === null) {
        const objectId = newObjectId();
        const storagePath = paths.storage.floorPlan(
          claims.orgId,
          buildingId,
          objectId,
        );
        patch(entry.key, { status: 'uploading', progress: 0, error: null });
        try {
          entry.uploadedUrl = await uploadFile({
            storagePath,
            file: entry.file,
            onProgress: (fraction) => patch(entry.key, { progress: fraction }),
          });
        } catch {
          anyFailed = true;
          patch(entry.key, {
            status: 'failed',
            progress: 0,
            error: 'The upload failed. Check your connection and try again.',
          });
          continue;
        }
      }

      patch(entry.key, {
        status: 'saving',
        error: null,
        uploadedUrl: entry.uploadedUrl,
      });
      const result = await manage.call({
        action: 'create',
        buildingId,
        plan: {
          name: trimmedName,
          description: entry.description.trim() || undefined,
          imageUrl: entry.uploadedUrl,
          kind: entry.file.type === 'application/pdf' ? 'pdf' : 'image',
        },
      });
      if (result) {
        patch(entry.key, { status: 'added', name: trimmedName, error: null });
      } else {
        anyFailed = true;
        // The callable's own copy is shown once below; this marks the row so the
        // admin can see WHICH file still needs another go.
        patch(entry.key, {
          status: 'failed',
          error: 'This plan could not be saved. Please try again.',
        });
      }
    }

    setRunning(false);
    if (!anyFailed) {
      closeForm();
    }
  };

  if (!open) {
    return (
      <div className={styles.addTrigger}>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Add floor plans
        </Button>
      </div>
    );
  }

  const outstandingCount = items.filter((item) => item.status !== 'added').length;
  const addedCount = items.length - outstandingCount;
  const hasFailure = items.some((item) => item.status === 'failed');

  return (
    <form
      key={formNonce}
      className={styles.addForm}
      onSubmit={(event) => void submit(event)}
      aria-label="Add floor plans"
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="new-plan-files">
          Plan files (each an image up to 10 MB, or a PDF up to 25 MB)
        </label>
        <input
          id="new-plan-files"
          className={styles.fileInput}
          type="file"
          accept="image/*,application/pdf"
          multiple
          onChange={onFileChange}
          disabled={running}
        />
        <p className={styles.hint}>
          Choose several files at once to add a plan per floor. Names start from
          the file name and can be edited below.
        </p>
      </div>

      {items.length > 0 && (
        <ul className={styles.pendingList}>
          {items.map((item) => (
            <li key={item.key} className={styles.pendingRow}>
              <div className={styles.pendingHead}>
                <span className={styles.pendingFile}>{item.file.name}</span>
                <span
                  className={
                    item.status === 'failed' ? styles.statusFailed : styles.status
                  }
                >
                  {STATUS_LABELS[item.status]}
                </span>
              </div>

              {item.status !== 'added' && (
                <>
                  <div className={styles.field}>
                    <label
                      className={styles.label}
                      htmlFor={`new-plan-name-${item.key}`}
                    >
                      Name
                    </label>
                    <input
                      id={`new-plan-name-${item.key}`}
                      className={styles.input}
                      type="text"
                      value={item.name}
                      onChange={(event) =>
                        patch(item.key, { name: event.target.value })
                      }
                      disabled={running}
                    />
                  </div>
                  <div className={styles.field}>
                    <label
                      className={styles.label}
                      htmlFor={`new-plan-description-${item.key}`}
                    >
                      Description (optional)
                    </label>
                    <input
                      id={`new-plan-description-${item.key}`}
                      className={styles.input}
                      type="text"
                      value={item.description}
                      onChange={(event) =>
                        patch(item.key, { description: event.target.value })
                      }
                      disabled={running}
                    />
                  </div>
                </>
              )}

              {item.status === 'uploading' && (
                <div className={styles.progressWrap}>
                  <progress
                    className={styles.progress}
                    value={item.progress}
                    max={1}
                    aria-label={`Upload progress for ${item.file.name}`}
                  />
                  <span className={styles.progressLabel}>
                    {Math.round(item.progress * 100)}%
                  </span>
                </div>
              )}

              {item.error && (
                <p role="alert" className={styles.inlineError}>
                  {item.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasFailure && addedCount > 0 && (
        <p className={styles.hint}>
          {addedCount === 1
            ? '1 plan was added and is kept. Fix the rest below and try again.'
            : `${addedCount} plans were added and are kept. Fix the rest below and try again.`}
        </p>
      )}

      {formError && (
        <p role="alert" className={styles.inlineError}>
          {formError}
        </p>
      )}
      {manage.error && (
        <p role="alert" className={styles.inlineError}>
          {manage.error}
        </p>
      )}

      <div className={styles.rowActions}>
        <Button type="submit" disabled={running}>
          {running
            ? 'Adding'
            : hasFailure
              ? 'Retry remaining'
              : outstandingCount > 1
                ? `Add ${outstandingCount} plans`
                : 'Add plan'}
        </Button>
        <Button variant="ghost" onClick={closeForm} disabled={running}>
          {addedCount > 0 ? 'Done' : 'Cancel'}
        </Button>
      </div>
    </form>
  );
}
