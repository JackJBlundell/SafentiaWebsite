// ============================================================================
// TemplateBuilder - the template editor (FR-E21, stories 2049-2052 + 2054).
//
// The draft lives at /templateDrafts/{orgId}/{templateId} and is a DIRECT,
// rules-governed write surface (admin-only by database rules), which is what
// makes autosave possible: every edit debounces into one whole-draft write.
// Publishing is the auditable moment and goes through the publishTemplate
// callable, which validates, bumps the version, promotes the draft to the
// immutable live node, archives the frozen copy and clears the draft.
//
// Echo discipline (the ServiceSchedulePanel precedent): the draft node is also
// subscribed live, so our own write comes straight back. A canonical
// fingerprint of the last write is kept; an incoming snapshot matching it (or
// arriving while edits are still debouncing) never re-seeds local state, so
// in-flight typing is never clobbered. A NON-matching snapshot while idle is a
// genuine concurrent edit and is adopted.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ref, remove, set } from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  REPORT_STANDARDS,
  type PublishTemplateInput,
  type PublishTemplateResult,
  type ReportStandard,
  type StandardParagraph,
  type Template,
  type TemplateSection,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DescriptionList, PageGrid } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import {
  countTemplate,
  draftWritePayload,
  fingerprint,
  newId,
  normaliseTemplate,
  QUESTION_TYPE_LABELS,
  STANDARD_LABELS,
  validateTemplate,
  type ValidationIssue,
} from './builderModel';
import { CertificatePanel } from './CertificatePanel';
import { SectionEditor } from './SectionEditor';
import styles from './TemplateBuilder.module.css';

const TEMPLATES_URL = '/app/templates';
const AUTOSAVE_DEBOUNCE_MS = 800;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function TemplateBuilder() {
  const { templateId = '' } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const ready = Boolean(claims && paths && templateId);

  const draftPath = ready ? paths!.db.templateDraft(orgId, templateId) : '';

  const draftQuery = useRtdbQuery<Template | null>({
    key: keys.templateDraft(orgId, templateId),
    path: draftPath,
    enabled: ready,
  });
  const liveQuery = useRtdbQuery<Template | null>({
    key: keys.template(orgId, templateId),
    path: ready ? paths!.db.template(orgId, templateId) : '',
    enabled: ready,
  });
  const paragraphsQuery = useRtdbQuery<Record<string, StandardParagraph> | null>({
    key: keys.standardParagraphs(orgId),
    path: ready ? paths!.db.standardParagraphs(orgId) : '',
    enabled: ready,
  });

  // --- Local editing state + autosave -----------------------------------------
  const [model, setModel] = useState<Template | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const modelRef = useRef<Template | null>(null);
  /** Canonical fingerprint of the last state we wrote or seeded; the guard
   *  that tells our own echo apart from a genuine concurrent edit. */
  const lastSyncedRef = useRef<string | null>(null);
  /** True from the first unsaved keystroke until the write lands. */
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** True while the publish callable is in flight: edits and autosave writes
   *  are suppressed so a keystroke cannot resurrect the draft node the
   *  callable is about to clear. */
  const publishingRef = useRef(false);
  /** Another admin's write landed under our unsaved edits (fix is social, not
   *  technical: detection only, the last save wins). */
  const [conflict, setConflict] = useState(false);

  const flush = useCallback(async () => {
    const current = modelRef.current;
    if (!current || !draftPath || publishingRef.current) {
      return;
    }
    const payload = draftWritePayload(current);
    lastSyncedRef.current = fingerprint(payload);
    try {
      await set(ref(firebase.db(), draftPath), payload);
      // Only mark clean if nothing changed while the write was in flight.
      if (modelRef.current === current) {
        dirtyRef.current = false;
        setSaveState('saved');
      }
    } catch {
      // Stay dirty: the echo-guard keeps protecting the unsaved model, and the
      // next edit re-queues the write.
      setSaveState('error');
    }
  }, [draftPath]);

  const applyChange = useCallback(
    (next: Template) => {
      if (publishingRef.current) {
        return;
      }
      modelRef.current = next;
      setModel(next);
      dirtyRef.current = true;
      setSaveState('saving');
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flush();
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Seed (and live-refresh) local state from the draft node - but never over
  // in-flight edits, and never from our own echo.
  const draftData = draftQuery.data;
  useEffect(() => {
    if (draftData === null || draftData === undefined) {
      // Draft removed elsewhere (published or discarded): drop local state so
      // the start-a-draft panel shows, unless edits are mid-flight.
      if (!dirtyRef.current && modelRef.current !== null) {
        modelRef.current = null;
        lastSyncedRef.current = null;
        setModel(null);
        setSaveState('idle');
      }
      return;
    }
    const incoming = normaliseTemplate(draftData);
    const incomingFingerprint = fingerprint(incoming);
    if (incomingFingerprint === lastSyncedRef.current) {
      // Our own write echoing back.
      return;
    }
    if (dirtyRef.current) {
      // In-flight edits are never clobbered. But a snapshot that matches
      // neither our last write NOR the state we are about to write is another
      // admin editing the same draft: surface it (detection only, no merge -
      // whoever saves last wins, and the notice says so).
      const pending = modelRef.current;
      if (
        pending &&
        incomingFingerprint !== fingerprint(draftWritePayload(pending))
      ) {
        setConflict(true);
      }
      return;
    }
    lastSyncedRef.current = incomingFingerprint;
    modelRef.current = incoming;
    setModel(incoming);
  }, [draftData]);

  // Unsaved changes must survive an accidental tab close.
  const hasUnsaved = saveState === 'saving' || saveState === 'error';
  useEffect(() => {
    if (!hasUnsaved) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsaved]);

  // On unmount, push any still-debouncing edit immediately rather than lose it.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      if (dirtyRef.current) {
        void flushRef.current();
      }
    },
    [],
  );

  // --- Publish / discard --------------------------------------------------------
  const publish = useCallable<PublishTemplateInput, PublishTemplateResult>(
    'publishTemplate',
  );
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);

  // --- Question row expansion (owned here so validation jumps can reveal) -------
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const toggleQuestion = (questionId: string) =>
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(questionId)) {
        next.delete(questionId);
      } else {
        next.add(questionId);
      }
      return next;
    });

  const jumpToIssue = (issue: ValidationIssue) => {
    if (issue.questionId) {
      setExpandedIds((current) => new Set(current).add(issue.questionId!));
    }
    // Let the expansion render before scrolling to the anchor.
    requestAnimationFrame(() => {
      const element = document.getElementById(issue.anchorId);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  // --- Gates and loading ----------------------------------------------------------
  if (!ready) {
    return (
      <p role="status" className={styles.hint}>
        Loading the template builder
      </p>
    );
  }
  // No admin check here: TemplatesRoutes gates the whole area, and the real
  // boundary is the database rules (draft writes) and the callable's check.
  if (draftQuery.isLoading || liveQuery.isLoading) {
    return (
      <p role="status" className={styles.hint}>
        Loading the template
      </p>
    );
  }
  if (draftQuery.isError || liveQuery.isError) {
    return (
      <ErrorNotice message="Could not load the template. Please try again." />
    );
  }

  const live = liveQuery.data ?? null;
  const crumbs = [
    { label: 'Templates', to: TEMPLATES_URL },
    { label: model?.name.trim() || live?.name || 'Template builder' },
  ];

  // Neither a draft nor a live template: nothing to edit at this address.
  if (!model && !live) {
    return (
      <>
        <PageHeader title="Template not found" crumbs={crumbs} />
        <EmptyState
          title="This template does not exist"
          body="It may have been removed, or the link may be out of date. Choose a template from the templates list."
          action={
            <Button to={TEMPLATES_URL} variant="secondary">
              Go to templates
            </Button>
          }
        />
      </>
    );
  }

  // Live exists but no draft yet: editing starts by seeding a draft from it.
  if (!model && live) {
    const startDraft = async () => {
      setStartError(null);
      const seeded = draftWritePayload(normaliseTemplate(live));
      try {
        await set(ref(firebase.db(), draftPath), seeded);
        // The live listener echoes the node straight back and seeds the model.
      } catch {
        setStartError('Could not start a draft. Please try again.');
      }
    };
    return (
      <>
        <PageHeader
          title={live.name}
          lede="Published templates are immutable. Changes are made on a draft and published as a new version."
          crumbs={crumbs}
        />
        <Card>
          <CardHeader
            title="No draft in progress"
            hint={`The live version is v${live.version}. Starting a draft copies its content; assessors keep using v${live.version} until you publish.`}
          />
          <div className={styles.startPanel}>
            <Button onClick={() => void startDraft()}>
              Start a new draft from v{live.version}
            </Button>
            {startError && <ErrorNotice message={startError} />}
          </div>
        </Card>
      </>
    );
  }

  // --- The editor -------------------------------------------------------------------
  const template = model!;
  const paragraphs = paragraphsQuery.data ?? null;
  const issues = validateTemplate(template, paragraphs);
  const counts = countTemplate(template);
  const liveVersion = live?.version;
  const nextVersion = (liveVersion ?? 0) + 1;
  const canPublish = issues.length === 0 && !hasUnsaved && !publish.pending;

  const updateSection = (sectionId: string, next: TemplateSection) =>
    applyChange({
      ...template,
      sections: template.sections.map((section) =>
        section.id === sectionId ? next : section,
      ),
    });

  const moveSection = (index: number, direction: -1 | 1) => {
    const sections = [...template.sections];
    const target = index + direction;
    [sections[index], sections[target]] = [sections[target], sections[index]];
    applyChange({ ...template, sections });
  };

  const removeSection = (sectionId: string) =>
    applyChange({
      ...template,
      sections: template.sections.filter((section) => section.id !== sectionId),
    });

  const addSection = () =>
    applyChange({
      ...template,
      sections: [
        ...template.sections,
        {
          // Fresh unique ids: section ids anchor the structure, question ids
          // become answer keys (see newId).
          id: newId('s'),
          // Zero-padded numbering is the house convention (it sorts
          // lexicographically); codes stay fully editable.
          code: String(template.sections.length + 1).padStart(2, '0'),
          title: '',
          questions: [],
        },
      ],
    });

  const moveQuestionToSection = (
    fromSectionId: string,
    questionId: string,
    targetSectionId: string,
  ) => {
    const source = template.sections.find((section) => section.id === fromSectionId);
    const question = source?.questions.find((entry) => entry.id === questionId);
    if (!source || !question || fromSectionId === targetSectionId) {
      return;
    }
    applyChange({
      ...template,
      sections: template.sections.map((section) => {
        if (section.id === fromSectionId) {
          return {
            ...section,
            questions: section.questions.filter((entry) => entry.id !== questionId),
          };
        }
        if (section.id === targetSectionId) {
          return { ...section, questions: [...section.questions, question] };
        }
        return section;
      }),
    });
  };

  const discardDraft = async () => {
    setDiscardError(null);
    clearTimeout(timerRef.current);
    dirtyRef.current = false;
    modelRef.current = null;
    lastSyncedRef.current = null;
    setModel(null);
    setSaveState('idle');
    try {
      await remove(ref(firebase.db(), draftPath));
    } catch {
      setDiscardError('Could not discard the draft. Please try again.');
    }
  };

  const doPublish = async () => {
    // Push any still-debouncing edit first: the callable reads the draft node.
    clearTimeout(timerRef.current);
    if (dirtyRef.current) {
      await flush();
    }
    // From here until the callable settles, applyChange and flush are inert:
    // a keystroke landing mid-publish must not re-write (resurrect) the draft
    // node the callable clears.
    publishingRef.current = true;
    try {
      const result = await publish.call({ templateId });
      if (result) {
        // Nothing left to save: the draft is gone server-side. Clear the
        // pending timer and the dirty flag BEFORE navigating so the unmount
        // flush cannot write the draft back.
        clearTimeout(timerRef.current);
        dirtyRef.current = false;
        navigate(TEMPLATES_URL, {
          state: {
            publishedTemplateId: templateId,
            publishedName: template.name,
            publishedVersion: result.version,
          },
        });
      }
    } finally {
      publishingRef.current = false;
    }
  };

  const sectionLabel = (section: TemplateSection, index: number) =>
    section.title.trim() || `Section ${index + 1}`;

  const saveIndicator =
    saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : null;

  const aside = (
    <div className={styles.asideStack}>
      <Card>
        <CardHeader title="Summary" as="h3" />
        <DescriptionList
          items={[
            { label: 'Sections', value: String(counts.sections) },
            { label: 'Questions', value: String(counts.questions) },
          ]}
        />
        {counts.questions > 0 && (
          <ul className={styles.summaryTypes}>
            {Object.entries(counts.byType).map(([type, count]) => (
              <li key={type}>
                <span>
                  {QUESTION_TYPE_LABELS[type as keyof typeof QUESTION_TYPE_LABELS]}
                </span>
                <span>{count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Checks"
          as="h3"
          hint="The same checks publishing runs. Select one to jump to it."
        />
        {issues.length === 0 ? (
          <p className={styles.allClear}>Every check passes. Ready to publish.</p>
        ) : (
          <ul className={styles.validationList}>
            {issues.map((issue, index) => (
              <li key={`${issue.anchorId}-${index}`}>
                <button
                  type="button"
                  className={styles.validationJump}
                  onClick={() => jumpToIssue(issue)}
                >
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Publish" as="h3" />
        <div className={styles.publishBody}>
          <p className={styles.hint}>
            {liveVersion !== undefined
              ? `Live version: v${liveVersion}.`
              : 'This template has never been published.'}
          </p>
          {confirmingPublish ? (
            <>
              <p className={styles.publishWarning}>
                Publishing makes v{nextVersion} available to assessors and
                cannot be edited afterwards.
              </p>
              <div className={styles.publishActions}>
                <Button
                  disabled={!canPublish}
                  onClick={() => void doPublish()}
                >
                  {publish.pending ? 'Publishing' : `Publish v${nextVersion}`}
                </Button>
                <Button
                  variant="ghost"
                  disabled={publish.pending}
                  onClick={() => setConfirmingPublish(false)}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className={styles.publishActions}>
              <Button
                disabled={!canPublish}
                onClick={() => setConfirmingPublish(true)}
              >
                Publish as v{nextVersion}
              </Button>
            </div>
          )}
          {issues.length > 0 && (
            <p className={styles.hint}>
              Resolve the checks above before publishing.
            </p>
          )}
          {publish.error && <ErrorNotice message={publish.error} />}
          {live && (
            <>
              <div className={styles.publishActions}>
                <InlineDiscard onConfirm={() => void discardDraft()} />
              </div>
              {discardError && <ErrorNotice message={discardError} />}
            </>
          )}
        </div>
      </Card>
    </div>
  );

  return (
    <>
      <PageHeader
        title={template.name.trim() || 'Untitled template'}
        lede="Changes save automatically to the draft. Assessors only see them once published."
        crumbs={crumbs}
        action={
          saveIndicator && (
            <span role="status" className={styles.saveIndicator}>
              {saveIndicator}
            </span>
          )
        }
      />

      {saveState === 'error' && (
        <ErrorNotice message="Your latest changes could not be saved. Check your connection; editing again retries." />
      )}

      {conflict && (
        <p role="status" className={styles.conflictNotice}>
          Someone else is editing this draft; the last save wins.
        </p>
      )}

      <PageGrid aside={aside}>
        <div className={styles.stack}>
          <Card>
            <CardHeader
              title="Template"
              hint="The name assessors see when a job is created from this template."
            />
            <div className={styles.sectionBody}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="builder-template-name">
                  Template name
                </label>
                <input
                  id="builder-template-name"
                  className={styles.input}
                  type="text"
                  autoComplete="off"
                  value={template.name}
                  onChange={(event) =>
                    applyChange({ ...template, name: event.target.value })
                  }
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="builder-template-standard">
                  Industry standard
                </label>
                <select
                  id="builder-template-standard"
                  className={styles.select}
                  value={template.standard ?? ''}
                  onChange={(event) => {
                    const value = event.target.value as ReportStandard | '';
                    const next = { ...template };
                    if (value) {
                      next.standard = value;
                    } else {
                      delete next.standard;
                    }
                    applyChange(next);
                  }}
                >
                  <option value="">Not set (generic report)</option>
                  {REPORT_STANDARDS.map((standard) => (
                    <option key={standard} value={standard}>
                      {STANDARD_LABELS[standard]}
                    </option>
                  ))}
                </select>
                <p className={styles.hint}>
                  The standard selects the report profile used when assessments
                  from this template are released: PAS 79 and BS 9792 receive
                  their standard-specific report treatment; Custom, or no
                  standard, receives the generic report built from the
                  template&apos;s own sections.
                </p>
              </div>
              <CertificatePanel
                template={template}
                onChange={applyChange}
                disabled={publish.pending}
              />
            </div>
          </Card>

          {template.sections.map((section, index) => (
            <SectionEditor
              key={section.id}
              section={section}
              index={index}
              count={template.sections.length}
              otherSections={template.sections
                .filter((other) => other.id !== section.id)
                .map((other) => ({
                  id: other.id,
                  label: sectionLabel(
                    other,
                    template.sections.findIndex((s) => s.id === other.id),
                  ),
                }))}
              paragraphs={paragraphs}
              expandedQuestionIds={expandedIds}
              onToggleQuestion={toggleQuestion}
              onChange={(next) => updateSection(section.id, next)}
              onMove={(direction) => moveSection(index, direction)}
              onRemove={
                template.sections.length > 1
                  ? () => removeSection(section.id)
                  : undefined
              }
              onMoveQuestionToSection={(questionId, targetSectionId) =>
                moveQuestionToSection(section.id, questionId, targetSectionId)
              }
            />
          ))}

          <div>
            <Button variant="secondary" onClick={addSection}>
              Add section
            </Button>
          </div>
        </div>
      </PageGrid>
    </>
  );
}

// ----------------------------------------------------------------------------
// Discard draft, with the same two-step confirm as the destructive controls in
// the editor body. Separate from InlineConfirm only for its stronger copy.
// ----------------------------------------------------------------------------

function InlineDiscard({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Discard draft
      </Button>
    );
  }
  return (
    <span className={styles.confirmGroup}>
      <span className={styles.confirmPrompt}>
        Discard every unpublished change? The live version is unaffected.
      </span>
      <Button
        variant="secondary"
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        Discard
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}
