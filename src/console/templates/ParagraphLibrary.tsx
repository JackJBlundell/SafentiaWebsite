// ============================================================================
// ParagraphLibrary - the org's Standard Paragraphs manager (FR-E21).
//
// Standard Paragraphs are the client-authored reference texts template
// questions point at via standardParagraphRef: when an assessor flags a
// question, the referenced paragraph feeds the standardised findings and the
// AI summary. Reads and writes go DIRECTLY to
// /standardParagraphs/{orgId}/{paragraphId} - the database rules make each
// entry admin-writable and validate its shape (reference + body + updatedAt).
//
// Deletion is guarded by usage: /templates and /templateDrafts are both
// subscribed (two org-level reads, shared by key with the templates list) and
// a paragraph any question still references cannot be deleted - the block
// names the referencing templates so the admin knows where to look.
// ============================================================================

import { useMemo, useState } from 'react';
import { push, ref, remove, set } from 'firebase/database';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { StandardParagraph, Template } from '../../types';
import { Card } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { Toolbar, ToolbarGroup } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { formatDate, LoadingNote, toEntries, useOrgScope } from '../customers/shared';
import shared from '../customers/shared.module.css';
import { templateUrls } from './shared';
import styles from './ParagraphLibrary.module.css';

interface ParagraphRow {
  id: string;
  paragraph: StandardParagraph;
  /** Names of the templates (live or draft) whose questions reference it. */
  referencedBy: string[];
}

const BODY_PREVIEW_LENGTH = 90;

function previewBody(body: string): string {
  return body.length > BODY_PREVIEW_LENGTH
    ? `${body.slice(0, BODY_PREVIEW_LENGTH).trimEnd()}…`
    : body;
}

/** Map paragraphId -> referencing template names across BOTH the live and the
 *  draft nodes: a reference in either blocks deletion, or publishing the draft
 *  would resurrect a dangling pointer. */
function buildUsage(
  templates: Record<string, Template> | null | undefined,
  drafts: Record<string, Template> | null | undefined,
): Map<string, Set<string>> {
  const usage = new Map<string, Set<string>>();
  const scan = (record: Record<string, Template> | null | undefined) => {
    for (const [, template] of toEntries(record)) {
      for (const section of template.sections ?? []) {
        for (const question of section.questions ?? []) {
          const refId = question.standardParagraphRef;
          if (!refId) continue;
          const names = usage.get(refId) ?? new Set<string>();
          names.add(template.name);
          usage.set(refId, names);
        }
      }
    }
  };
  scan(templates);
  scan(drafts);
  return usage;
}

// ----------------------------------------------------------------------------
// Add / edit form. Reference and body are required (the rules validate the
// same shape); title is optional and OMITTED when blank - RTDB rejects
// undefined and an empty string would be a lie of a title.
// ----------------------------------------------------------------------------

function ParagraphForm({
  paragraphId,
  initial,
  onClose,
}: {
  /** Null when adding; the existing id when editing. */
  paragraphId: string | null;
  initial: StandardParagraph | null;
  onClose: () => void;
}) {
  const { orgId, db } = useOrgScope();
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const save = async () => {
    const trimmedReference = reference.trim();
    const trimmedBody = body.trim();
    if (!trimmedReference || !trimmedBody) {
      setError('A reference and the paragraph body are both required.');
      return;
    }
    if (!db) return;
    setError(null);
    setPending(true);
    try {
      const database = firebase.db();
      // push() for a new entry; the reference itself is display data, never a
      // key (it can carry dots, which RTDB keys cannot).
      const id =
        paragraphId ?? push(ref(database, db.standardParagraphs(orgId))).key;
      if (!id) throw new Error('Could not mint an id');
      const trimmedTitle = title.trim();
      const paragraph: StandardParagraph = {
        reference: trimmedReference,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        body: trimmedBody,
        updatedAt: Date.now(),
      };
      await set(ref(database, db.standardParagraph(orgId, id)), paragraph);
      onClose();
    } catch {
      setError('Could not save the paragraph. Please try again.');
      setPending(false);
    }
  };

  return (
    <Card>
      <form
        className={shared.form}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 className={styles.panelTitle}>
          {paragraphId ? 'Edit paragraph' : 'Add paragraph'}
        </h2>
        {error && <ErrorNotice message={error} />}
        <div className={shared.fieldRow}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="paragraph-reference">
              Reference
            </label>
            <input
              id="paragraph-reference"
              className={shared.input}
              type="text"
              autoComplete="off"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <p className={shared.hint}>
              Your own numbering, for example 4.2.1. Shown to assessors and used
              in the findings summary.
            </p>
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="paragraph-title">
              Title (optional)
            </label>
            <input
              id="paragraph-title"
              className={shared.input}
              type="text"
              autoComplete="off"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
        </div>
        <div className={shared.field}>
          <label className={shared.label} htmlFor="paragraph-body">
            Body
          </label>
          <textarea
            id="paragraph-body"
            className={`${shared.input} ${styles.bodyInput}`}
            rows={5}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <div className={shared.formActions}>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving' : 'Save paragraph'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Row actions: edit opens the form; delete is two-step AND usage-guarded.
// ----------------------------------------------------------------------------

function RowActions({
  row,
  onEdit,
}: {
  row: ParagraphRow;
  onEdit: () => void;
}) {
  const { orgId, db } = useOrgScope();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async () => {
    // The usage guard: a referenced paragraph cannot be deleted, or the
    // referencing questions would point at nothing and the findings summary
    // would silently lose its source text.
    if (row.referencedBy.length > 0) {
      const count = row.referencedBy.length;
      setError(
        `Referenced by ${count} ${count === 1 ? 'template' : 'templates'} (${row.referencedBy.join(', ')}). Remove the references first.`,
      );
      return;
    }
    if (!confirming) {
      setError(null);
      setConfirming(true);
      return;
    }
    if (!db) return;
    try {
      await remove(ref(firebase.db(), db.standardParagraph(orgId, row.id)));
    } catch {
      setError('Could not delete the paragraph. Please try again.');
      setConfirming(false);
    }
  };

  return (
    <span className={styles.rowActions}>
      {error && (
        <span role="alert" className={styles.rowError}>
          {error}
        </span>
      )}
      <Button variant="secondary" onClick={onEdit}>
        Edit
      </Button>
      <Button
        variant="secondary"
        aria-label={
          confirming
            ? `Confirm delete of paragraph ${row.paragraph.reference}`
            : `Delete paragraph ${row.paragraph.reference}`
        }
        onClick={() => void onDelete()}
      >
        {confirming ? 'Confirm delete' : 'Delete'}
      </Button>
    </span>
  );
}

// ----------------------------------------------------------------------------
// The library page.
// ----------------------------------------------------------------------------

export function ParagraphLibrary() {
  const { ready, orgId, db } = useOrgScope();
  const [search, setSearch] = useState('');
  /** null = closed; 'new' = adding; otherwise the paragraph id being edited. */
  const [editing, setEditing] = useState<string | null>(null);

  const paragraphs = useRtdbQuery<Record<string, StandardParagraph> | null>({
    key: keys.standardParagraphs(orgId),
    path: ready ? db!.standardParagraphs(orgId) : '',
    enabled: ready,
  });
  // Both template nodes back the deletion guard; same query keys as the
  // templates list, so arriving from there attaches no new listener.
  const templates = useRtdbQuery<Record<string, Template> | null>({
    key: keys.templates(orgId),
    path: ready ? db!.templates(orgId) : '',
    enabled: ready,
  });
  const drafts = useRtdbQuery<Record<string, Template> | null>({
    key: keys.templateDrafts(orgId),
    path: ready ? db!.templateDrafts(orgId) : '',
    enabled: ready,
  });

  const rows: ParagraphRow[] = useMemo(() => {
    const usage = buildUsage(templates.data, drafts.data);
    const needle = search.trim().toLowerCase();
    return toEntries(paragraphs.data)
      .map(([id, paragraph]) => ({
        id,
        paragraph,
        referencedBy: [...(usage.get(id) ?? [])].sort((a, b) =>
          a.localeCompare(b, 'en-GB'),
        ),
      }))
      .filter((row) => {
        if (!needle) return true;
        return `${row.paragraph.reference} ${row.paragraph.title ?? ''} ${row.paragraph.body}`
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) =>
        a.paragraph.reference.localeCompare(b.paragraph.reference, 'en-GB', {
          numeric: true,
        }),
      );
  }, [paragraphs.data, templates.data, drafts.data, search]);

  const columns: Array<Column<ParagraphRow>> = useMemo(
    () => [
      {
        header: 'Reference',
        width: '1%',
        cell: (row) => (
          <span className={styles.reference}>{row.paragraph.reference}</span>
        ),
      },
      {
        header: 'Title',
        cell: (row) => row.paragraph.title ?? '',
      },
      {
        header: 'Body',
        cell: (row) => (
          <span className={styles.bodyPreview}>{previewBody(row.paragraph.body)}</span>
        ),
      },
      {
        header: 'Updated',
        desktopOnly: true,
        cell: (row) => formatDate(row.paragraph.updatedAt),
      },
      {
        header: 'Actions',
        align: 'end',
        width: '1%',
        cell: (row) => <RowActions row={row} onEdit={() => setEditing(row.id)} />,
      },
    ],
    [],
  );

  const total = toEntries(paragraphs.data).length;

  return (
    <div className={styles.root}>
      <PageHeader
        title="Standard paragraphs"
        lede="Your organisation's reference texts. Template questions reference a paragraph so flagged findings carry standardised wording, and the AI summary of findings is generated from the paragraphs the flagged questions reference."
        crumbs={[
          { label: 'Templates', to: templateUrls.list },
          { label: 'Standard paragraphs' },
        ]}
      />

      {paragraphs.isError && (
        <ErrorNotice message="Could not load the paragraph library. Please try again." />
      )}

      {paragraphs.isLoading ? (
        <LoadingNote>Loading standard paragraphs</LoadingNote>
      ) : (
        <>
          <Toolbar>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="paragraphs-search">
                  Search paragraphs
                </label>
                <input
                  id="paragraphs-search"
                  className={`${shared.input} ${styles.search}`}
                  type="search"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </ToolbarGroup>
            {editing === null && (
              <ToolbarGroup push>
                <Button onClick={() => setEditing('new')}>Add paragraph</Button>
              </ToolbarGroup>
            )}
          </Toolbar>

          {editing !== null && (
            <ParagraphForm
              paragraphId={editing === 'new' ? null : editing}
              initial={editing === 'new' ? null : (paragraphs.data?.[editing] ?? null)}
              onClose={() => setEditing(null)}
            />
          )}

          {total === 0 ? (
            <EmptyState
              title="No standard paragraphs yet"
              body="Add your organisation's reference paragraphs so template questions can point at them and findings carry consistent wording."
              action={
                editing === null ? (
                  <Button onClick={() => setEditing('new')}>Add paragraph</Button>
                ) : undefined
              }
            />
          ) : (
            <Card flush={rows.length > 0}>
              {rows.length === 0 ? (
                <p className={styles.noMatches}>
                  No paragraphs match. Adjust the search.
                </p>
              ) : (
                <DataTable
                  label="Standard paragraphs"
                  columns={columns}
                  rows={rows}
                  rowKey={(row) => row.id}
                />
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
