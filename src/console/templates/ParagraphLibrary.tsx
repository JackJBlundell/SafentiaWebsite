// ============================================================================
// ParagraphLibrary - the Standard Paragraphs library (FR-E21).
//
// A standard paragraph is settled, numbered wording an organisation keeps so
// that the same deficiency is described the same way whoever assessed the
// building - the bank an assessing practice would otherwise hold in a Word
// document. The library an admin manages here is the UNION of two populations,
// and the whole design of this screen follows from that:
//
//   - the BS 9792 Housing bank Safentia SHIPS (127 paragraphs, 27 subjects).
//     It lives in code (src/standardParagraphs/bs9792.ts), NOT in the database,
//     so a wording correction lands for every customer on the next deploy and
//     nothing has to be migrated. It is READ-ONLY here: no edit, no delete, and
//     the form below refuses a `sp-bs9792-` id outright.
//   - the organisation's OWN paragraphs at /standardParagraphs/{orgId}, which
//     are fully editable and deletable.
//
// Origin is decided by the ID, never by a stored flag (see standardParagraphs/
// index.ts), so no client write can forge a built-in and no missing field can
// lose one. Everything on this page - the list, the badges, the filter, the
// group headings - is derived from allParagraphs()/paragraphSubjects(); this
// file holds no second copy of that model.
//
// GROUPED AND COLLAPSIBLE because 127 rows in one flat table is a wall. Each
// subject is its own card; the org's own paragraphs open by default (that is
// what an admin came for) and the shipped subjects start closed. A search
// forces every matching group open and drops the toggles - a collapse control
// that fights the search would only produce empty results with no explanation.
//
// Reads and writes go DIRECTLY to /standardParagraphs/{orgId}/{paragraphId} -
// the database rules make each entry admin-writable and validate its shape
// (reference + body + updatedAt, with optional title and subject).
//
// Deletion is guarded by usage: /templates and /templateDrafts are both
// subscribed (two org-level reads, sharing the templates list's query keys, so
// arriving from there attaches no new listener) and a paragraph any question
// still references cannot be deleted - the block names the referencing
// templates so the admin knows where to look. The same usage map is shown as a
// column, because "which of my paragraphs is nobody using?" is a real question
// and the data to answer it was already being computed to power the guard.
// ============================================================================

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { push, ref, remove, set } from 'firebase/database';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  CUSTOM_SUBJECT,
  allParagraphs,
  isBuiltInParagraphId,
  paragraphSubjects,
  subjectOf,
} from '../../standardParagraphs';
import type { StandardParagraph, Template } from '../../types';
import { BS9792_PARAGRAPH_SUBJECTS } from '../../standardParagraphs/bs9792';
import { Card } from '../ui/Card';
import { DataTable, type Column, type RowExpansion } from '../ui/DataTable';
import { DescriptionList, Toolbar, ToolbarGroup } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { SearchField } from '../ui/SearchField';
import { formatDateShort, LoadingNote, toEntries, useOrgScope } from '../customers/shared';
import shared from '../customers/shared.module.css';
import { templateUrls } from './shared';
import styles from './ParagraphLibrary.module.css';

// ----------------------------------------------------------------------------
// Row and group model.
// ----------------------------------------------------------------------------

/** One place a paragraph is referenced from: enough to NAME it and to GO to it.
 *  `questionId` is the first question in that template that points at the
 *  paragraph - a template may reference the same wording from several questions,
 *  and landing on the first is what "go to the reference" usefully means. */
interface ParagraphReference {
  templateId: string;
  templateName: string;
  questionId: string;
}

interface ParagraphRow {
  id: string;
  paragraph: StandardParagraph;
  /** True for the wording Safentia ships; false for the organisation's own. */
  builtIn: boolean;
  /** The templates (live or draft) whose questions reference it, deduplicated
   *  by template so a paragraph cited three times in one template is one entry. */
  referencedBy: ParagraphReference[];
}

interface ParagraphGroup {
  subject: string;
  rows: ParagraphRow[];
}

/** What the origin filter can be narrowed to. */
type Origin = 'all' | 'included' | 'own';

/** The database rules' own ceilings, mirrored onto the inputs so a paragraph is
 *  never rejected at the write with nothing to show for it. Keep in step with
 *  database.rules.json > standardParagraphs. */
const MAX_REFERENCE = 64;
const MAX_TITLE = 200;
const MAX_BODY = 10000;
// Subject has no constant: it is chosen from the shipped headings, none of
// which is anywhere near the rules' 200-character ceiling.

const BODY_PREVIEW_LENGTH = 160;

/** One line of the wording for the row. Bodies carry real newlines (a shipped
 *  paragraph is often several sentences on separate lines), and a table cell
 *  showing only the first of them would look like the paragraph is a fragment. */
function previewBody(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > BODY_PREVIEW_LENGTH
    ? `${flat.slice(0, BODY_PREVIEW_LENGTH).trimEnd()}…`
    : flat;
}

/** Map paragraphId -> referencing template names across BOTH the live and the
 *  draft nodes: a reference in either blocks deletion, or publishing the draft
 *  would resurrect a dangling pointer. */
function buildUsage(
  templates: Record<string, Template> | null | undefined,
  drafts: Record<string, Template> | null | undefined,
): Map<string, ParagraphReference[]> {
  const usage = new Map<string, ParagraphReference[]>();
  const scan = (record: Record<string, Template> | null | undefined) => {
    for (const [templateId, template] of toEntries(record)) {
      for (const section of template.sections ?? []) {
        for (const question of section.questions ?? []) {
          const refId = question.standardParagraphRef;
          if (!refId || !question.id) continue;
          const found = usage.get(refId) ?? [];
          // FIRST question wins per template: the cell offers one way in per
          // template, and a second link to the same builder screen would only
          // ask the admin to choose between two identical destinations.
          if (found.some((entry) => entry.templateId === templateId)) continue;
          found.push({
            templateId,
            templateName: template.name,
            questionId: question.id,
          });
          usage.set(refId, found);
        }
      }
    }
  };
  scan(templates);
  scan(drafts);
  return usage;
}

/** Bucket rows under their subject headings.
 *
 *  Order comes from paragraphSubjects() - the source document's order, with the
 *  organisation's own last - and NOT from the data, so the library reads the
 *  same way every visit. Any subject present in the data but absent from that
 *  list (an older record, or one written by another client) is appended rather
 *  than dropped: a paragraph that exists and cannot be seen is the one outcome
 *  worse than an unexpected heading. Empty groups are omitted. */
function groupRows(
  rows: ParagraphRow[],
  orgParagraphs: Record<string, StandardParagraph> | null | undefined,
): ParagraphGroup[] {
  const buckets = new Map<string, ParagraphRow[]>();
  const order: string[] = [];
  for (const subject of paragraphSubjects(orgParagraphs)) {
    order.push(subject);
    buckets.set(subject, []);
  }
  for (const row of rows) {
    const subject = subjectOf(row);
    let bucket = buckets.get(subject);
    if (!bucket) {
      bucket = [];
      buckets.set(subject, bucket);
      order.push(subject);
    }
    bucket.push(row);
  }
  return order
    .map((subject) => ({ subject, rows: buckets.get(subject) ?? [] }))
    .filter((group) => group.rows.length > 0);
}

// ----------------------------------------------------------------------------
// What the page explains about itself. Three claims, and every one of them is
// checkable ON THIS PAGE: what a standard paragraph is, what ships with the
// product, and how templates relate to the library.
//
// DELIBERATELY UNDER-CLAIMED. The copy this replaced told an admin the AI
// summary of findings was generated from these paragraphs, and the form told
// them the reference was "shown to assessors and used in the findings summary".
// Neither happens. Nothing is said here about how a paragraph reaches an
// assessment or a report, because nothing about that is wired yet, and the
// wrong sentence in this block is exactly why this page was rebuilt.
// ----------------------------------------------------------------------------

function AboutLibrary({ includedCount }: { includedCount: number }) {
  return (
    <Card className={styles.about}>
      <p className={styles.aboutLead}>
        A standard paragraph is wording your practice has already settled on and
        numbered: the bank you would otherwise keep in a Word document. Agreeing
        it once here is what stops the same deficiency being written three
        different ways by three different assessors.
      </p>
      <ul className={styles.aboutPoints}>
        <li className={styles.aboutPoint}>
          <span className={styles.aboutTerm}>Included with Safentia</span>
          <span className={styles.aboutBody}>
            {includedCount} BS 9792 Housing paragraphs, grouped under{' '}
            {BS9792_PARAGRAPH_SUBJECTS.length} subjects. We maintain them, so a
            wording correction reaches you without you republishing anything.
            You can read them here; you cannot change or delete them.
          </span>
        </li>
        <li className={styles.aboutPoint}>
          <span className={styles.aboutTerm}>Your own paragraphs</span>
          <span className={styles.aboutBody}>
            Anything the included bank does not cover: house style, a landlord's
            own numbering, wording for a hazard you meet often. Yours are fully
            editable, and you can file them under one of those subjects or leave
            them under "{CUSTOM_SUBJECT}".
          </span>
        </li>
        <li className={styles.aboutPoint}>
          <span className={styles.aboutTerm}>Templates that use them</span>
          <span className={styles.aboutBody}>
            A template question can reference a paragraph from this library.
            "Used by" shows which templates already point at each one, and a
            paragraph a template still references cannot be deleted until you
            remove the reference.
          </span>
        </li>
      </ul>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Add / edit form, for the organisation's OWN paragraphs only.
//
// Reference and body are required (the rules validate the same shape); title
// and subject are optional and OMITTED when blank - RTDB rejects undefined, and
// an empty string would be a lie of a title.
// ----------------------------------------------------------------------------

function ParagraphForm({
  paragraphId,
  initial,
  onClose,
}: {
  /** Null when adding; the existing id when editing. Never a built-in id. */
  paragraphId: string | null;
  initial: StandardParagraph | null;
  onClose: () => void;
}) {
  const { orgId, db } = useOrgScope();
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [subject, setSubject] = useState(initial?.subject ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const referenceRef = useRef<HTMLInputElement>(null);

  // The form opens at the TOP of the page while the row that opened it can be
  // twenty subjects further down, so focus goes to the first field: it brings
  // the form into view and puts the caret where typing starts, in one move.
  useEffect(() => {
    referenceRef.current?.focus();
  }, []);

  const save = async () => {
    // Belt and braces on top of the caller: the shipped bank is code, and a
    // write under one of its ids would be both rejected by resolution (which
    // checks the built-ins first) and a lie in the org's node.
    if (paragraphId && isBuiltInParagraphId(paragraphId)) {
      setError('Included paragraphs cannot be edited.');
      return;
    }
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
      const trimmedSubject = subject.trim();
      const paragraph: StandardParagraph = {
        reference: trimmedReference,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        body: trimmedBody,
        updatedAt: Date.now(),
        ...(trimmedSubject ? { subject: trimmedSubject } : {}),
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
          {paragraphId ? 'Edit paragraph' : 'Add a paragraph of your own'}
        </h2>
        {error && <ErrorNotice message={error} />}
        <div className={shared.fieldRow}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="paragraph-reference">
              Reference
            </label>
            <input
              id="paragraph-reference"
              ref={referenceRef}
              className={shared.input}
              type="text"
              autoComplete="off"
              maxLength={MAX_REFERENCE}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <p className={shared.hint}>
              Your own numbering, for example 4.2.1. It is how the paragraph is
              listed here and in the template builder's picker.
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
              maxLength={MAX_TITLE}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <p className={shared.hint}>
              A short name for the shelf, e.g. "Portable appliance testing".
            </p>
          </div>
        </div>
        <div className={shared.field}>
          <label className={shared.label} htmlFor="paragraph-subject">
            Subject
          </label>
          <select
            id="paragraph-subject"
            className={shared.select}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          >
            {/* The list is the shipped subject headings and nothing else: a
                free-text subject would create a group heading the library's own
                ordering knows nothing about. */}
            <option value="">{CUSTOM_SUBJECT} (default)</option>
            {BS9792_PARAGRAPH_SUBJECTS.map((entry) => (
              <option key={entry.number} value={entry.title}>
                {entry.title}
              </option>
            ))}
          </select>
          <p className={shared.hint}>
            Which heading it files under. Leave it as "{CUSTOM_SUBJECT}" to keep
            your own wording together.
          </p>
        </div>
        <div className={shared.field}>
          <label className={shared.label} htmlFor="paragraph-body">
            Body
          </label>
          <textarea
            id="paragraph-body"
            className={`${shared.input} ${styles.bodyInput}`}
            rows={8}
            maxLength={MAX_BODY}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <p className={shared.hint}>
            The settled wording itself. Write it as the finished paragraph you
            want kept, not a note to yourself; line breaks are preserved.{' '}
            {body.length.toLocaleString('en-GB')} of{' '}
            {MAX_BODY.toLocaleString('en-GB')} characters.
          </p>
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
// Row pieces.
// ----------------------------------------------------------------------------

/** Origin, stated in words rather than by colour alone. */
function OriginBadge({ builtIn }: { builtIn: boolean }) {
  return (
    <span className={builtIn ? styles.badgeIncluded : styles.badgeOwn}>
      {builtIn ? 'Included' : 'Yours'}
    </span>
  );
}

/** Who points at this paragraph. Nothing referencing it is not an error - a
 *  library is allowed to hold wording that is not wired up yet - so it reads as
 *  a quiet fact, not a warning. */
function UsageCell({ row }: { row: ParagraphRow }) {
  if (row.referencedBy.length === 0) {
    return <span className={styles.unused}>Not referenced</span>;
  }
  // Naming the template answers "is this in use?"; the link answers "where?".
  // Both, because the second question always follows the first and the admin
  // would otherwise open templates one at a time hunting for the question.
  return (
    <ul className={styles.usedList}>
      {row.referencedBy.map((reference) => (
        <li key={reference.templateId} className={styles.usedEntry}>
          <span className={styles.usedName}>{reference.templateName}</span>
          <Button
            variant="ghost"
            to={templateUrls.builder(reference.templateId, reference.questionId)}
            aria-label={`Go to the reference in ${reference.templateName}`}
          >
            Go to reference
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The full wording plus the facts that do not earn a column of their own.
 *  Bodies run to 3,000 characters, so this - not the row preview - is how a
 *  paragraph actually gets read. */
function ParagraphDetail({ row }: { row: ParagraphRow }) {
  return (
    <div className={styles.detail}>
      <p className={styles.detailBody}>{row.paragraph.body}</p>
      <DescriptionList
        items={[
          { label: 'Subject', value: subjectOf(row) },
          {
            label: 'Source',
            value: row.builtIn
              ? 'Included with Safentia (BS 9792 Housing) - read only'
              : "Your organisation's own",
          },
          { label: 'Updated', value: formatDateShort(row.paragraph.updatedAt) },
          {
            label: 'Referenced by',
            value:
              row.referencedBy.length === 0
                ? 'No template question references this paragraph yet.'
                : row.referencedBy
                    .map((reference) => reference.templateName)
                    .join(', '),
          },
        ]}
      />
    </div>
  );
}

/** Edit and delete, for the organisation's own paragraphs only. Delete is
 *  two-step AND usage-guarded. */
function RowActions({ row, onEdit }: { row: ParagraphRow; onEdit: () => void }) {
  const { orgId, db } = useOrgScope();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async () => {
    // The usage guard: a referenced paragraph cannot be deleted, or the
    // referencing questions would be left pointing at nothing.
    if (row.referencedBy.length > 0) {
      const count = row.referencedBy.length;
      setError(
        `Referenced by ${count} ${count === 1 ? 'template' : 'templates'} (${row.referencedBy
          .map((reference) => reference.templateName)
          .join(', ')}). Remove the references first.`,
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
      <span className={styles.rowButtons}>
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
      {/* Beneath the buttons, not beside them: the guard names every template
          that still references the paragraph, which is a sentence, not a chip. */}
      {error && (
        <span role="alert" className={styles.rowError}>
          {error}
        </span>
      )}
    </span>
  );
}

// ----------------------------------------------------------------------------
// One subject: a card with a disclosure header and the table beneath it.
// ----------------------------------------------------------------------------

function ParagraphGroupCard({
  group,
  columns,
  expansion,
  open,
  onToggle,
}: {
  group: ParagraphGroup;
  columns: Array<Column<ParagraphRow>>;
  expansion: RowExpansion<ParagraphRow>;
  open: boolean;
  /** Null while a search is running: every listed group matched and is open, so
   *  a toggle here would only be a control that appears to do nothing. */
  onToggle: (() => void) | null;
}) {
  const idBase = useId();
  const panelId = `${idBase}-group`;
  const count = group.rows.length;
  const ownCount = group.rows.filter((row) => !row.builtIn).length;
  const summary =
    ownCount > 0 && ownCount < count
      ? `${count} paragraphs, ${ownCount} yours`
      : `${count} ${count === 1 ? 'paragraph' : 'paragraphs'}`;

  return (
    <Card flush className={styles.group}>
      <h2 className={styles.groupHeading}>
        {onToggle ? (
          <button
            type="button"
            className={styles.groupToggle}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={onToggle}
          >
            <span className={styles.caret} aria-hidden="true" />
            <span className={styles.groupTitle}>{group.subject}</span>
            <span className={styles.groupCount}>{summary}</span>
          </button>
        ) : (
          <span className={styles.groupStatic}>
            <span className={styles.groupTitle}>{group.subject}</span>
            <span className={styles.groupCount}>{summary}</span>
          </span>
        )}
      </h2>
      {/* Kept in the DOM so aria-controls always resolves to a real element;
          the table is built only while the group is open, so a page of 27
          subjects mounts one table, not 27. */}
      <div id={panelId} className={styles.groupBody} hidden={!open}>
        {open && (
          <DataTable
            label={`${group.subject} paragraphs`}
            columns={columns}
            rows={group.rows}
            rowKey={(row) => row.id}
            expansion={expansion}
          />
        )}
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// The library page.
// ----------------------------------------------------------------------------

export function ParagraphLibrary() {
  const { ready, orgId, db } = useOrgScope();
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState<Origin>('all');
  /** null = closed; 'new' = adding; otherwise the paragraph id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Which subjects are expanded. Remembered for the life of the page, and
   *  seeded with the org's own paragraphs: those are what an admin came for. */
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>([CUSTOM_SUBJECT]),
  );

  const paragraphs = useRtdbQuery<Record<string, StandardParagraph> | null>({
    key: keys.standardParagraphs(orgId),
    path: ready ? db!.standardParagraphs(orgId) : '',
    enabled: ready,
  });
  // Both template nodes back the deletion guard and the usage column; same
  // query keys as the templates list, so arriving from there attaches no new
  // listener.
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

  /** The whole library, before search or the origin filter: the shipped bank
   *  plus the organisation's own, each carrying its usage. */
  const allRows: ParagraphRow[] = useMemo(() => {
    const usage = buildUsage(templates.data, drafts.data);
    return allParagraphs(paragraphs.data).map((entry) => ({
      id: entry.id,
      paragraph: entry.paragraph,
      builtIn: entry.builtIn,
      referencedBy: [...(usage.get(entry.id) ?? [])].sort((a, b) =>
        a.templateName.localeCompare(b.templateName, 'en-GB'),
      ),
    }));
  }, [paragraphs.data, templates.data, drafts.data]);

  const counts = useMemo(
    () => ({
      all: allRows.length,
      included: allRows.filter((row) => row.builtIn).length,
      own: allRows.filter((row) => !row.builtIn).length,
    }),
    [allRows],
  );

  const needle = search.trim().toLowerCase();
  const searching = needle.length > 0;

  const groups = useMemo(() => {
    const matched = allRows.filter((row) => {
      if (origin === 'included' && !row.builtIn) return false;
      if (origin === 'own' && row.builtIn) return false;
      if (!needle) return true;
      // Subject is searched too: "means of escape" is how someone names a
      // paragraph whose number they cannot remember.
      return `${row.paragraph.reference} ${row.paragraph.title ?? ''} ${subjectOf(row)} ${row.paragraph.body}`
        .toLowerCase()
        .includes(needle);
    });
    return groupRows(matched, paragraphs.data);
  }, [allRows, origin, needle, paragraphs.data]);

  const shownCount = groups.reduce((sum, group) => sum + group.rows.length, 0);

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
        header: 'Paragraph',
        cell: (row) => (
          <span className={styles.paragraphCell}>
            {row.paragraph.title && (
              <span className={styles.paragraphTitle}>{row.paragraph.title}</span>
            )}
            <span className={styles.bodyPreview}>
              {previewBody(row.paragraph.body)}
            </span>
          </span>
        ),
      },
      {
        header: 'Source',
        width: '1%',
        cell: (row) => <OriginBadge builtIn={row.builtIn} />,
      },
      {
        header: 'Used by',
        desktopOnly: true,
        cell: (row) => <UsageCell row={row} />,
      },
      {
        header: 'Actions',
        align: 'end',
        width: '1%',
        // Nothing for a shipped paragraph: it is product content, and an Edit
        // button that always failed would be worse than no button at all.
        cell: (row) =>
          row.builtIn ? null : (
            <RowActions row={row} onEdit={() => setEditing(row.id)} />
          ),
      },
    ],
    [],
  );

  const expansion: RowExpansion<ParagraphRow> = useMemo(
    () => ({
      header: 'Full text',
      label: (row) => `full text of paragraph ${row.paragraph.reference}`,
      content: (row) => <ParagraphDetail row={row} />,
    }),
    [],
  );

  const toggleGroup = (subject: string) =>
    setOpenGroups((current) => {
      const next = new Set(current);
      if (!next.delete(subject)) next.add(subject);
      return next;
    });

  const loading = paragraphs.isLoading;
  const addButton = <Button onClick={() => setEditing('new')}>Add paragraph</Button>;

  return (
    <div className={styles.root}>
      <PageHeader
        title="Standard paragraphs"
        lede="Your organisation's bank of settled wording: the BS 9792 Housing paragraphs included with Safentia, plus any you add yourself."
        crumbs={[
          { label: 'Templates', to: templateUrls.list },
          { label: 'Standard paragraphs' },
        ]}
        action={editing === null ? addButton : undefined}
      />

      <AboutLibrary includedCount={counts.included} />

      {paragraphs.isError && (
        <ErrorNotice message="Could not load your organisation's paragraphs. The included BS 9792 bank is still listed below." />
      )}

      {loading ? (
        <LoadingNote>Loading standard paragraphs</LoadingNote>
      ) : (
        <>
          <Toolbar>
            <ToolbarGroup>
              <SearchField
                value={search}
                onChange={setSearch}
                label="Search standard paragraphs"
                placeholder="Reference, title, subject or wording"
                className={styles.search}
              />
            </ToolbarGroup>
            <ToolbarGroup>
              {/* Single choice, so aria-pressed on three buttons rather than a
                  select: the counts are the point, and a select hides them. */}
              <div
                className={styles.originFilter}
                role="group"
                aria-label="Show paragraphs from"
              >
                {(
                  [
                    ['all', 'All', counts.all],
                    ['included', 'Included', counts.included],
                    ['own', CUSTOM_SUBJECT, counts.own],
                  ] as Array<[Origin, string, number]>
                ).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    className={styles.originOption}
                    aria-pressed={origin === value}
                    onClick={() => setOrigin(value)}
                  >
                    {label}
                    <span className={styles.originCount}>{count}</span>
                  </button>
                ))}
              </div>
            </ToolbarGroup>
            {!searching && groups.length > 1 && (
              <ToolbarGroup push>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setOpenGroups(
                      new Set(groups.map((group) => group.subject)),
                    )
                  }
                >
                  Expand all
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setOpenGroups(new Set<string>())}
                >
                  Collapse all
                </Button>
              </ToolbarGroup>
            )}
          </Toolbar>

          {editing !== null && (
            <ParagraphForm
              paragraphId={editing === 'new' ? null : editing}
              initial={
                editing === 'new' ? null : (paragraphs.data?.[editing] ?? null)
              }
              onClose={() => setEditing(null)}
            />
          )}

          {origin === 'own' && counts.own === 0 ? (
            <EmptyState
              title="You have not added any paragraphs yet"
              body={`Everything listed today is the included BS 9792 bank. Add wording of your own for anything it does not cover - it will sit under "${CUSTOM_SUBJECT}", or under whichever subject you file it against.`}
              action={editing === null ? addButton : undefined}
            />
          ) : groups.length === 0 ? (
            <Card>
              <p className={styles.noMatches}>
                {searching ? (
                  <>
                    <span>No paragraphs match "{search.trim()}".</span>
                    <button
                      type="button"
                      className={styles.clearSearch}
                      onClick={() => setSearch('')}
                    >
                      Clear search
                    </button>
                  </>
                ) : (
                  <span>There are no paragraphs to show.</span>
                )}
              </p>
            </Card>
          ) : (
            <>
              {searching && (
                <p className={styles.matchNote} role="status">
                  {shownCount} {shownCount === 1 ? 'paragraph' : 'paragraphs'} in{' '}
                  {groups.length} {groups.length === 1 ? 'subject' : 'subjects'}{' '}
                  match "{search.trim()}".
                </p>
              )}
              <div className={styles.groups}>
                {groups.map((group) => (
                  <ParagraphGroupCard
                    key={group.subject}
                    group={group}
                    columns={columns}
                    expansion={expansion}
                    open={searching || openGroups.has(group.subject)}
                    onToggle={
                      searching ? null : () => toggleGroup(group.subject)
                    }
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
