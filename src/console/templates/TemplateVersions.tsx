// ============================================================================
// TemplateVersions - one template's frozen version history (story 2053).
//
// /templateVersions/{orgId}/{templateId}/{version} holds the immutable
// snapshot each publish froze; nothing here can edit anything, and the lede
// says so. The "Assessments" figure counts JOBS whose templateId +
// templateVersion pin this exact pair: jobs pin the version at creation
// (story 1031), so this is the honest usage measure without scanning every
// assessment. The jobs are read with an INDEXED query on templateId
// (orderByChild('templateId').equalTo) so the screen pulls only THIS template's
// jobs, never the whole /jobs node - which grows for the life of the org and
// would be an unbounded read here. Its own cache key keeps that filtered subset
// from ever clobbering the jobs board's full read.
// ============================================================================

import { useMemo, useState } from 'react';
import { equalTo, orderByChild, query } from 'firebase/database';
import { useParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Job, Template } from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { formatDate, LoadingNote, toEntries, useOrgScope } from '../customers/shared';
import { standardLabel, templateCounts, templateUrls } from './shared';
import styles from './TemplateVersions.module.css';

/** A frozen snapshot MAY carry a publish timestamp; the Template type does not
 *  promise one, so the row only shows a date when the object actually has it. */
type FrozenVersion = Template & { publishedAt?: number };

interface VersionRow {
  version: number;
  snapshot: FrozenVersion;
  /** Jobs pinning this templateId + version pair (story 1031). */
  assessments: number;
}

/** The read-only inline expansion: sections as collapsed groups, question
 *  texts inside. Deliberately NO edit affordances - the snapshot is frozen. */
function VersionDetail({ snapshot }: { snapshot: FrozenVersion }) {
  const sections = snapshot.sections ?? [];
  if (sections.length === 0) {
    return <p className={styles.emptyVersion}>This version has no sections.</p>;
  }
  return (
    <div className={styles.detail}>
      {sections.map((section) => (
        <details key={section.id} className={styles.section}>
          <summary className={styles.sectionSummary}>
            <span className={styles.sectionCode}>{section.code}</span>
            <span className={styles.sectionTitle}>{section.title}</span>
            <span className={styles.sectionCount}>
              {(section.questions ?? []).length} questions
            </span>
          </summary>
          <ol className={styles.questionList}>
            {(section.questions ?? []).map((question) => (
              <li key={question.id} className={styles.question}>
                {question.text}
              </li>
            ))}
          </ol>
        </details>
      ))}
    </div>
  );
}

function VersionCard({ row }: { row: VersionRow }) {
  const [open, setOpen] = useState(false);
  const counts = templateCounts(row.snapshot);
  const publishedAt = row.snapshot.publishedAt;
  const hintParts = [
    // Only claim a publish date the frozen object actually carries.
    publishedAt !== undefined ? `Published ${formatDate(publishedAt)}` : null,
    `${counts.sections} sections`,
    `${counts.questions} questions`,
    `${row.assessments} ${row.assessments === 1 ? 'assessment' : 'assessments'}`,
  ].filter(Boolean);
  return (
    <Card>
      <CardHeader
        title={`Version ${row.version}`}
        hint={hintParts.join(' | ')}
        action={
          <Button variant="secondary" onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide' : 'View'}
          </Button>
        }
      />
      {open && <VersionDetail snapshot={row.snapshot} />}
    </Card>
  );
}

export function TemplateVersions() {
  const { templateId = '' } = useParams();
  const { ready, orgId, db } = useOrgScope();

  const template = useRtdbQuery<Template | null>({
    key: keys.template(orgId, templateId),
    path: ready ? db!.template(orgId, templateId) : '',
    enabled: ready && templateId !== '',
  });
  // Values may be null: integer keys make the SDK coerce this node to an
  // array with holes (toEntries handles both shapes via Object.entries).
  const versions = useRtdbQuery<Record<string, FrozenVersion | null> | null>({
    key: keys.templateVersions(orgId, templateId),
    path: ready ? db!.templateVersions(orgId, templateId) : '',
    enabled: ready && templateId !== '',
  });
  // Only THIS template's jobs, via an indexed query on templateId, under a cache
  // key distinct from the jobs board's full read. Every row's usage figure below
  // is derived from this bounded subset - no whole-node scan, no per-version
  // fan-out - and the counts stay exact because the index returns every job
  // pinning the template, across all its versions.
  const jobs = useRtdbQuery<Record<string, Job> | null>({
    key: keys.jobsByTemplate(orgId, templateId),
    path: ready ? db!.jobs(orgId) : '',
    enabled: ready && templateId !== '',
    build: (node) => query(node, orderByChild('templateId'), equalTo(templateId)),
  });

  const rows: VersionRow[] = useMemo(() => {
    const usage = new Map<number, number>();
    for (const [, job] of toEntries(jobs.data)) {
      // The indexed query already narrows to this templateId; this guard is
      // belt-and-braces so a stray row can never inflate a count.
      if (job.templateId !== templateId) continue;
      usage.set(job.templateVersion, (usage.get(job.templateVersion) ?? 0) + 1);
    }
    // The node is keyed by integer version ("1", "2", ...), so the Firebase
    // SDK hands it back as an ARRAY with null holes once the keys look dense
    // enough - and a publish mid-flight leaves a {publishing: true} claim
    // placeholder in its slot. Only values that are real frozen templates
    // (non-null, with a sections array) become rows; both shapes render.
    return toEntries(versions.data)
      .filter((entry): entry is [string, FrozenVersion] => {
        const value = entry[1] as unknown;
        return (
          value !== null &&
          typeof value === 'object' &&
          Array.isArray((value as { sections?: unknown }).sections)
        );
      })
      .map(([key, snapshot]) => {
        const version = Number(key);
        return {
          version,
          snapshot,
          assessments: usage.get(version) ?? 0,
        };
      })
      .sort((a, b) => b.version - a.version);
  }, [versions.data, jobs.data, templateId]);

  const name = template.data?.name ?? 'Template';

  return (
    <div className={styles.root}>
      <PageHeader
        title={`${name} version history`}
        lede={`Every published version of this ${standardLabel(template.data?.standard)} template, newest first. Published versions are immutable: assessments pin the version they started on, so a frozen snapshot can never change under them. To make changes, edit the draft and publish a new version.`}
        crumbs={[
          { label: 'Templates', to: templateUrls.list },
          { label: name },
        ]}
      />

      {versions.isError && (
        <ErrorNotice message="Could not load the version history. Please try again." />
      )}

      {versions.isLoading ? (
        <LoadingNote>Loading version history</LoadingNote>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No published versions yet"
          body="This template has not been published. Publish the draft from the builder to freeze its first version."
          action={
            <Button variant="secondary" to={templateUrls.builder(templateId)}>
              Open the builder
            </Button>
          }
        />
      ) : (
        <div className={styles.list}>
          {rows.map((row) => (
            <VersionCard key={row.version} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
