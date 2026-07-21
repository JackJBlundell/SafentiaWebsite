// ============================================================================
// TemplatesList - every assessment template the organisation owns (story 2048).
//
// One merged directory over TWO live nodes: /templates (the published, live
// lineage per template id) and /templateDrafts (work in progress). A published
// template with a draft in flight reads "v3 + draft in progress"; a draft that
// has never been published shows honestly as "Draft, never published". The two
// base templates (PAS 79, BS 9792) are ordinary org templates in this list -
// "customise from base" (story 2049) is simply New template > duplicate one.
//
// Creation writes the DRAFT node directly: database rules make
// /templateDrafts/{orgId}/{templateId} admin-writable, and publishing is the
// separate, server-owned publishTemplate step.
// ============================================================================

import { useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { push, ref, set } from 'firebase/database';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { ReportStandard, Template } from '../../types';
import { REPORT_STANDARDS } from '../../types';
import { Card } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { Toolbar, ToolbarGroup } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { LoadingNote, toEntries, useOrgScope } from '../customers/shared';
import shared from '../customers/shared.module.css';
import { isBaseTemplate, standardLabel, templateUrls } from './shared';
import styles from './TemplatesList.module.css';

// ----------------------------------------------------------------------------
// The merged row model.
// ----------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  name: string;
  standard: ReportStandard | undefined;
  /** The live published version, or null for a never-published draft. */
  publishedVersion: number | null;
  /** Live node status, when a live node exists. */
  liveStatus: 'published' | 'archived' | null;
  hasDraft: boolean;
}

function mergeRows(
  templates: Record<string, Template> | null | undefined,
  drafts: Record<string, Template> | null | undefined,
): TemplateRow[] {
  const rows: TemplateRow[] = [];
  const draftIds = new Set(Object.keys(drafts ?? {}));
  for (const [id, template] of toEntries(templates)) {
    rows.push({
      id,
      name: template.name,
      standard: template.standard,
      publishedVersion: template.version,
      liveStatus: template.status === 'archived' ? 'archived' : 'published',
      hasDraft: draftIds.has(id),
    });
  }
  // Drafts with no published node yet: real templates, just not live.
  for (const [id, draft] of toEntries(drafts)) {
    if (templates && templates[id]) continue;
    rows.push({
      id,
      name: draft.name,
      standard: draft.standard,
      publishedVersion: null,
      liveStatus: null,
      hasDraft: true,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
}

function statusText(row: TemplateRow): string {
  if (row.liveStatus === null) return 'Draft, never published';
  if (row.liveStatus === 'archived') return 'Archived';
  return row.hasDraft
    ? `v${row.publishedVersion} + draft in progress`
    : 'Published';
}

const COLUMNS_STATIC: Array<Column<TemplateRow>> = [
  {
    header: 'Name',
    cell: (row) => (
      <span className={styles.name}>
        {row.name}
        {isBaseTemplate(row.id) && (
          <span className={styles.baseBadge}>Base template</span>
        )}
      </span>
    ),
  },
  {
    header: 'Standard',
    cell: (row) => standardLabel(row.standard),
  },
  {
    header: 'Version',
    cell: (row) =>
      row.publishedVersion === null ? 'Draft' : `v${row.publishedVersion}`,
  },
  {
    header: 'Status',
    cell: (row) => statusText(row),
  },
  {
    header: 'Actions',
    align: 'end',
    width: '1%',
    cell: (row) => (
      <span className={styles.actions}>
        <Button variant="secondary" to={templateUrls.builder(row.id)}>
          Edit draft
        </Button>
        {row.publishedVersion !== null && (
          <Link className={styles.versionsLink} to={templateUrls.versions(row.id)}>
            Version history
          </Link>
        )}
      </span>
    ),
  },
];

// ----------------------------------------------------------------------------
// New-template panel: name + standard + start-from, writing the draft node.
// ----------------------------------------------------------------------------

function NewTemplatePanel({
  templates,
  onClose,
}: {
  templates: Record<string, Template> | null | undefined;
  onClose: () => void;
}) {
  const { orgId, db } = useOrgScope();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [standard, setStandard] = useState<ReportStandard>('custom');
  const [startFrom, setStartFrom] = useState('blank');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const sources = toEntries(templates);

  const onPickSource = (value: string) => {
    setStartFrom(value);
    // A duplicate keeps the source's standard so its report profile follows;
    // the admin can still override before creating.
    if (value !== 'blank') {
      const source = templates?.[value];
      setStandard(source?.standard ?? 'custom');
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the template a name.');
      return;
    }
    if (!db) return;
    setError(null);
    setPending(true);
    try {
      const database = firebase.db();
      const draftsNode = ref(database, db.templateDrafts(orgId));
      // push() keys are client-minted and globally unique - no network round
      // trip - so they also serve as fresh section/question ids below.
      const mintId = () => {
        const key = push(draftsNode).key;
        if (!key) throw new Error('Could not mint an id');
        return key;
      };
      const templateId = mintId();
      const source = startFrom === 'blank' ? null : templates?.[startFrom];
      // When duplicating, every section and question gets a NEW id. Answer
      // keys in assessments are question ids, and the standardised-findings
      // pipeline follows them: ids must never collide across templates or two
      // templates' answers and findings could cross-wire.
      const sections = (source?.sections ?? []).map((section) => ({
        ...section,
        id: mintId(),
        questions: (section.questions ?? []).map((question) => ({
          ...question,
          id: mintId(),
        })),
      }));
      const draft: Template = {
        name: trimmed,
        // A draft that has never been published sits at version 0; the
        // server-owned publish step assigns v1 onwards.
        version: 0,
        status: 'draft',
        standard,
        sections,
      };
      await set(ref(database, db.templateDraft(orgId, templateId)), draft);
      navigate(templateUrls.builder(templateId));
    } catch {
      setError('Could not create the template. Please try again.');
      setPending(false);
    }
  };

  return (
    <Card>
      <form
        className={shared.form}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2 className={styles.panelTitle}>New template</h2>
        {error && <ErrorNotice message={error} />}
        <div className={shared.fieldRow}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="new-template-name">
              Template name
            </label>
            <input
              id="new-template-name"
              className={shared.input}
              type="text"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="new-template-standard">
              Standard
            </label>
            <select
              id="new-template-standard"
              className={shared.select}
              value={standard}
              onChange={(event) => setStandard(event.target.value as ReportStandard)}
            >
              {REPORT_STANDARDS.map((value) => (
                <option key={value} value={value}>
                  {standardLabel(value)}
                </option>
              ))}
            </select>
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="new-template-source">
              Start from
            </label>
            <select
              id="new-template-source"
              className={shared.select}
              value={startFrom}
              onChange={(event) => onPickSource(event.target.value)}
            >
              <option value="blank">Blank</option>
              {sources.map(([id, template]) => (
                <option key={id} value={id}>
                  Duplicate: {template.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className={shared.formActions}>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating' : 'Create draft'}
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
// The list page.
// ----------------------------------------------------------------------------

/** What the builder passes through navigation state after a publish. */
interface PublishedState {
  publishedTemplateId?: string;
  publishedName?: string;
  publishedVersion?: number;
}

export function TemplatesList() {
  // No isAdmin branches here: TemplatesRoutes gates the whole area to admins.
  const { ready, orgId, db } = useOrgScope();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  // The builder lands here straight after a publish, carrying what it
  // published in navigation state; dismissing replaces the entry with no
  // state so a refresh or back-navigation does not resurrect the notice.
  const published = (location.state ?? null) as PublishedState | null;
  const publishNotice =
    published?.publishedName && typeof published.publishedVersion === 'number'
      ? `${published.publishedName} v${published.publishedVersion} is now available to assessors.`
      : null;
  const dismissPublishNotice = () =>
    navigate(location.pathname, { replace: true, state: null });

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

  const rows = useMemo(() => {
    const merged = mergeRows(templates.data, drafts.data);
    const needle = search.trim().toLowerCase();
    if (!needle) return merged;
    return merged.filter((row) =>
      `${row.name} ${standardLabel(row.standard)}`.toLowerCase().includes(needle),
    );
  }, [templates.data, drafts.data, search]);

  const total = mergeRows(templates.data, drafts.data).length;
  const loading = templates.isLoading || drafts.isLoading;

  return (
    <div className={styles.root}>
      <PageHeader
        title="Templates"
        lede="The assessment templates your organisation publishes to assessors. Edit a draft, publish a new version, or manage the Standard Paragraphs library."
        action={
          <Button variant="secondary" to={templateUrls.paragraphs}>
            Standard paragraphs
          </Button>
        }
      />

      {publishNotice && (
        <p role="status" className={styles.publishNotice}>
          <span>{publishNotice}</span>
          <button
            type="button"
            className={styles.publishNoticeDismiss}
            onClick={dismissPublishNotice}
          >
            Dismiss
          </button>
        </p>
      )}

      {(templates.isError || drafts.isError) && (
        <ErrorNotice message="Could not load templates. Please try again." />
      )}

      {loading ? (
        <LoadingNote>Loading templates</LoadingNote>
      ) : (
        <>
          <Toolbar>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="templates-search">
                  Search templates
                </label>
                <input
                  id="templates-search"
                  className={`${shared.input} ${styles.search}`}
                  type="search"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </ToolbarGroup>
            {!creating && (
              <ToolbarGroup push>
                <Button onClick={() => setCreating(true)}>New template</Button>
              </ToolbarGroup>
            )}
          </Toolbar>

          {creating && (
            <NewTemplatePanel
              templates={templates.data}
              onClose={() => setCreating(false)}
            />
          )}

          {total === 0 ? (
            <EmptyState
              title="No templates yet"
              body="Create your first assessment template. Start blank, or duplicate a base template and customise it."
              action={
                !creating ? (
                  <Button onClick={() => setCreating(true)}>New template</Button>
                ) : undefined
              }
            />
          ) : (
            <Card flush={rows.length > 0}>
              {rows.length === 0 ? (
                <p className={styles.noMatches}>
                  No templates match. Adjust the search.
                </p>
              ) : (
                <DataTable
                  label="Templates"
                  columns={COLUMNS_STATIC}
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
