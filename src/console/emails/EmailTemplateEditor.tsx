// ============================================================================
// EmailTemplateEditor - authoring one org email template (the TemplateBuilder
// architecture, without the draft/publish split: the template node at
// /emailTemplates/{orgId}/{id} is a DIRECT, rules-governed write surface and
// the node IS live - the send path validates renderability and falls back to
// the built-in default, so a half-typed template can never fail a business
// operation).
//
// Autosave: every edit debounces into one whole-object write stamped with
// updatedAt/updatedBy. Echo discipline (the ServiceSchedulePanel precedent via
// TemplateBuilder): the node is subscribed live, so our own write comes
// straight back; a canonical fingerprint of the last write is kept, and an
// incoming snapshot matching it - or arriving while edits still debounce -
// never re-seeds local state.
//
// The aside is the payoff of authoring blocks rather than raw HTML: the SAME
// mirrored renderer the server sends with (variable engine + branded HTML)
// runs here against each variable's catalogue example, inside a fully
// sandboxed iframe, so what the author sees is what the recipient gets.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ref, set } from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { EmailTemplate, EmailTemplateBlock, OrgProfile } from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { PageGrid } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import {
  blockAnchor,
  blockTypeLabel,
  CATALOGUE_VARIABLES,
  emailTemplateFingerprint,
  newBlockId,
  normaliseEmailTemplate,
  PREVIEW_EXAMPLE_VARIABLES,
  templateWritePayload,
  validateEmailTemplate,
  type EmailValidationIssue,
} from './emailEditorModel';
import { renderBrandedEmail, SAFENTIA_BRAND, type EmailBrand } from './emailHtml';
import { renderTemplate, type EmailTemplateShape } from './emailVariableEngine';
import { useDragReorder } from './useDragReorder';
import styles from './EmailTemplateEditor.module.css';

const TEMPLATES_URL = '/app/emails/templates';
const AUTOSAVE_DEBOUNCE_MS = 800;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

// ----------------------------------------------------------------------------
// Org brand for the preview. The HEX_COLOUR idiom mirrors
// functions/src/lib/emailTemplates.ts (orgEmailBrand): per-field fallback to
// the platform brand, so a missing or malformed stored value never breaks the
// preview - exactly what the send path does.
// ----------------------------------------------------------------------------

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

function orgEmailBrand(profile: OrgProfile | null | undefined): EmailBrand {
  const primary = profile?.brand?.primary;
  const name = profile?.name;
  return {
    name: typeof name === 'string' && name.trim() ? name : SAFENTIA_BRAND.name,
    accent:
      typeof primary === 'string' && HEX_COLOUR.test(primary)
        ? primary
        : SAFENTIA_BRAND.accent,
  };
}

// Stand-ins for what only a real send supplies: kind rows (digest lists, visit
// cards) and the kind's canonical link. Without them a source:'kind' details
// card and a use-kind-link button would silently vanish from the preview,
// which would read as a bug rather than as "filled in at send time".
const PREVIEW_KIND_ROWS = [
  { label: 'Example detail', value: 'Filled in by the email type when it sends' },
];
const PREVIEW_KIND_LINK = 'https://example.com/preview-link';

// ----------------------------------------------------------------------------
// Caret-insertion plumbing. The palette inserts into the LAST-FOCUSED text
// field; a focused element alone is not enough (clicking the chip steals
// focus), so each templated field registers a LOCATOR on focus and the insert
// resolves it against the CURRENT model - never against a closure captured at
// focus time, which would be stale after further typing.
// ----------------------------------------------------------------------------

type FieldLocator =
  | { kind: 'subject' }
  | { kind: 'preheader' }
  | { kind: 'heading' }
  | { kind: 'footer' }
  | { kind: 'block-text'; blockId: string }
  | { kind: 'row'; blockId: string; rowId: string; part: 'label' | 'value' }
  | { kind: 'cta-label'; blockId: string }
  | { kind: 'cta-href'; blockId: string };

interface FocusedField {
  locator: FieldLocator;
  el: HTMLInputElement | HTMLTextAreaElement;
}

/** Apply new text at a locator; null when the locator no longer resolves
 *  (its block or row was deleted after focus). */
function withLocatorText(
  template: EmailTemplate,
  locator: FieldLocator,
  text: string,
): EmailTemplate | null {
  switch (locator.kind) {
    case 'subject':
      return { ...template, subject: text };
    case 'preheader':
      return { ...template, preheader: text };
    case 'heading':
      return { ...template, heading: text };
    case 'footer':
      return { ...template, footerNote: text };
    default: {
      const block = template.blocks.find((entry) => entry.id === locator.blockId);
      if (!block) return null;
      let next: EmailTemplateBlock | null = null;
      if (locator.kind === 'block-text' && block.type === 'paragraph') {
        next = { ...block, text };
      } else if (locator.kind === 'cta-label' && block.type === 'cta') {
        next = { ...block, label: text };
      } else if (locator.kind === 'cta-href' && block.type === 'cta') {
        next = { ...block, href: text };
      } else if (locator.kind === 'row' && block.type === 'detail-rows') {
        const rows = block.rows ?? [];
        if (!rows.some((row) => row.id === locator.rowId)) return null;
        next = {
          ...block,
          rows: rows.map((row) =>
            row.id === locator.rowId ? { ...row, [locator.part]: text } : row,
          ),
        };
      }
      if (!next) return null;
      return {
        ...template,
        blocks: template.blocks.map((entry) => (entry.id === block.id ? next! : entry)),
      };
    }
  }
}

// ----------------------------------------------------------------------------
// Two-step inline delete for a block (the house destructive-control idiom).
// ----------------------------------------------------------------------------

function InlineDeleteBlock({
  label,
  onConfirm,
  disabled = false,
  disabledReason,
}: {
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (disabled) {
    return (
      <Button
        variant="ghost"
        aria-label={`Delete ${label}`}
        disabled
        title={disabledReason}
      >
        Delete
      </Button>
    );
  }
  if (!confirming) {
    return (
      <Button variant="ghost" aria-label={`Delete ${label}`} onClick={() => setConfirming(true)}>
        Delete
      </Button>
    );
  }
  return (
    <span className={styles.confirmGroup}>
      <span className={styles.confirmPrompt}>Delete this block?</span>
      <Button
        variant="secondary"
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        Delete
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

// ----------------------------------------------------------------------------
// The editor.
// ----------------------------------------------------------------------------

export default function EmailTemplateEditor() {
  const { templateId = '' } = useParams<{ templateId: string }>();
  const { claims, paths, user } = useAuth();
  const orgId = claims?.orgId ?? '';
  const ready = Boolean(claims && paths && templateId);
  const templatePath = ready ? paths!.db.emailTemplate(orgId, templateId) : '';

  const templateQuery = useRtdbQuery<EmailTemplate | null>({
    key: keys.emailTemplate(orgId, templateId),
    path: templatePath,
    enabled: ready,
  });
  const profileQuery = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(orgId),
    path: ready ? paths!.db.orgProfile(orgId) : '',
    enabled: ready,
  });

  // --- Local editing state + autosave (the TemplateBuilder clone) -------------
  const [model, setModel] = useState<EmailTemplate | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [conflict, setConflict] = useState(false);
  const modelRef = useRef<EmailTemplate | null>(null);
  /** Canonical fingerprint of the last state we wrote or seeded: the guard
   *  that tells our own echo apart from a genuine concurrent edit. */
  const lastSyncedRef = useRef<string | null>(null);
  /** True from the first unsaved keystroke until the write lands. */
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const uid = user?.uid ?? '';

  const flush = useCallback(async () => {
    const current = modelRef.current;
    if (!current || !templatePath) return;
    const payload = templateWritePayload(current, uid);
    // Fingerprint the payload, not the model: the two agree on content by
    // construction, and the payload is exactly what will echo back.
    lastSyncedRef.current = emailTemplateFingerprint(payload);
    try {
      await set(ref(firebase.db(), templatePath), payload);
      if (modelRef.current === current) {
        dirtyRef.current = false;
        setSaveState('saved');
      }
    } catch {
      // Stay dirty: the echo-guard keeps protecting the unsaved model, and
      // the next edit re-queues the write.
      setSaveState('error');
    }
  }, [templatePath, uid]);

  const applyChange = useCallback(
    (next: EmailTemplate) => {
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

  // Seed (and live-refresh) local state from the node - never over in-flight
  // edits, and never from our own echo.
  const templateData = templateQuery.data;
  useEffect(() => {
    if (templateData === null || templateData === undefined) {
      // Deleted elsewhere: drop local state so the not-found panel shows,
      // unless edits are mid-flight (the next flush recreates the node).
      if (!dirtyRef.current && modelRef.current !== null) {
        modelRef.current = null;
        lastSyncedRef.current = null;
        setModel(null);
        setSaveState('idle');
      }
      return;
    }
    const incoming = normaliseEmailTemplate(templateData);
    const incomingFingerprint = emailTemplateFingerprint(incoming);
    if (incomingFingerprint === lastSyncedRef.current) return; // Our own echo.
    if (dirtyRef.current) {
      // In-flight edits are never clobbered; a snapshot matching neither our
      // last write nor the pending model is another admin editing here.
      const pending = modelRef.current;
      if (pending && incomingFingerprint !== emailTemplateFingerprint(pending)) {
        setConflict(true);
      }
      return;
    }
    lastSyncedRef.current = incomingFingerprint;
    modelRef.current = incoming;
    setModel(incoming);
  }, [templateData]);

  // Unsaved changes must survive an accidental tab close.
  const hasUnsaved = saveState === 'saving' || saveState === 'error';
  useEffect(() => {
    if (!hasUnsaved) return;
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
      if (dirtyRef.current) void flushRef.current();
    },
    [],
  );

  // --- Caret insertion --------------------------------------------------------
  const lastFocusedRef = useRef<FocusedField | null>(null);
  const trackFocus =
    (locator: FieldLocator) =>
    (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      lastFocusedRef.current = { locator, el: event.currentTarget };
    };

  const insertVariable = (name: string) => {
    const target = lastFocusedRef.current;
    const current = modelRef.current;
    if (!target || !current) return;
    const token = `{{${name}}}`;
    const { el } = target;
    // The element is controlled, so its DOM value IS the model value; the
    // selection is read off the element because only it knows the caret.
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const nextText = el.value.slice(0, start) + token + el.value.slice(end);
    const next = withLocatorText(current, target.locator, nextText);
    if (!next) return; // The field's block was deleted since it was focused.
    applyChange(next);
    // Refocus after React re-renders the new value, caret just after the token.
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  };

  // --- Block mutations --------------------------------------------------------
  const blocks = model?.blocks ?? [];

  const moveBlock = useCallback(
    (from: number, to: number) => {
      const current = modelRef.current;
      if (!current || from === to) return;
      const next = [...current.blocks];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      applyChange({ ...current, blocks: next });
    },
    [applyChange],
  );

  const { containerRef, getItemStyle, getHandleProps, dragState, announcement } =
    useDragReorder({
      count: blocks.length,
      onReorder: moveBlock,
      itemLabel: (index) =>
        blocks[index] ? `${blockTypeLabel(blocks[index])} block` : 'Block',
    });

  // --- Gates ------------------------------------------------------------------
  if (!ready || templateQuery.isLoading) {
    return (
      <p role="status" className={styles.hint}>
        Loading the template
      </p>
    );
  }
  if (templateQuery.isError) {
    return <ErrorNotice message="Could not load the template. Please try again." />;
  }

  const crumbs = [
    { label: 'Emails', to: '/app/emails' },
    { label: 'Templates', to: TEMPLATES_URL },
    { label: model?.name.trim() || 'Email template' },
  ];

  if (!model) {
    return (
      <>
        <PageHeader title="Template not found" crumbs={crumbs} />
        <EmptyState
          title="This template does not exist"
          body="It may have been deleted, or the link may be out of date. Choose a template from the templates list."
          action={
            <Button to={TEMPLATES_URL} variant="secondary">
              Go to templates
            </Button>
          }
        />
      </>
    );
  }

  const template = model;
  const issues = validateEmailTemplate(template);

  const updateBlock = (blockId: string, next: EmailTemplateBlock) =>
    applyChange({
      ...template,
      blocks: template.blocks.map((block) => (block.id === blockId ? next : block)),
    });

  const removeBlock = (blockId: string) =>
    applyChange({
      ...template,
      blocks: template.blocks.filter((block) => block.id !== blockId),
    });

  const addBlock = (type: EmailTemplateBlock['type']) => {
    const block: EmailTemplateBlock =
      type === 'paragraph'
        ? { id: newBlockId(), type: 'paragraph', text: '' }
        : type === 'detail-rows'
          ? {
              id: newBlockId(),
              type: 'detail-rows',
              source: 'custom',
              rows: [{ id: newBlockId(), label: '', value: '' }],
            }
          : { id: newBlockId(), type: 'cta', label: '' };
    applyChange({ ...template, blocks: [...template.blocks, block] });
  };

  const jumpToIssue = (issue: EmailValidationIssue) => {
    document
      .getElementById(issue.anchorId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // --- Live preview -----------------------------------------------------------
  // Rendered through the SAME mirrored pipeline the server sends with, against
  // each variable's catalogue example, so the preview reads like a real email.
  const brand = orgEmailBrand(profileQuery.data);
  const shape: EmailTemplateShape = {
    subject: template.subject,
    ...(template.preheader?.trim() ? { preheader: template.preheader } : {}),
    heading: template.heading,
    blocks: template.blocks,
    ...(template.footerNote?.trim() ? { footerNote: template.footerNote } : {}),
  };
  const rendered = renderTemplate(
    shape,
    PREVIEW_EXAMPLE_VARIABLES,
    'preview',
    PREVIEW_KIND_ROWS,
    PREVIEW_KIND_LINK,
  );
  const previewHtml = renderBrandedEmail({
    brand,
    preheader: rendered.preheader,
    heading: rendered.heading,
    paragraphs: rendered.paragraphs,
    detailRows: rendered.detailRows,
    cta: rendered.cta,
    // A blank footer means "the assigned email type's own footer" at send
    // time; the preview cannot know the kind, so it shows a neutral stand-in.
    footerNote:
      rendered.footerNote?.trim() || `You are receiving this email from ${brand.name}.`,
  });

  const saveIndicator =
    saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : null;

  const aside = (
    <div className={styles.asideStack}>
      <Card>
        <CardHeader
          title="Preview"
          as="h3"
          hint="Rendered with your organisation's branding and example values for every variable."
        />
        <p className={styles.previewSubject}>
          <span className={styles.previewSubjectLabel}>Subject</span>
          <span>{rendered.subject.trim() || 'No subject yet'}</span>
        </p>
        {/* sandbox="" (no allow-* at all): the srcDoc is our own renderer's
            output, but template text is author input - no scripts, no
            navigation, nothing escapes the frame. */}
        <iframe
          className={styles.previewFrame}
          title="Email preview"
          sandbox=""
          srcDoc={previewHtml}
        />
      </Card>

      <Card>
        <CardHeader
          title="Checks"
          as="h3"
          hint="Advisory only - the template always saves. Select one to jump to it."
        />
        {issues.length === 0 ? (
          <p className={styles.allClear}>Everything reads well.</p>
        ) : (
          <ul className={styles.validationList}>
            {issues.map((issue, index) => (
              <li key={`${issue.anchorId}-${index}`}>
                <button
                  type="button"
                  className={styles.validationJump}
                  onClick={() => jumpToIssue(issue)}
                >
                  {issue.token && (
                    <code className={styles.tokenChip}>{`{{${issue.token}}}`}</code>
                  )}{' '}
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );

  return (
    <>
      <PageHeader
        title={template.name.trim() || 'Untitled template'}
        lede="Changes save automatically. Emails use this wording as soon as the template is assigned to an email type."
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
          Someone else is editing this template; the last save wins.
        </p>
      )}
      {/* Reorder announcements for screen readers (both drag paths). */}
      <span role="status" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <PageGrid aside={aside}>
        <div className={styles.stack}>
          <Card>
            <CardHeader
              title="Email"
              hint="The subject and heading may use {{variables}} from the palette below."
            />
            <div className={styles.cardBody}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email-template-name">
                  Template name
                </label>
                <input
                  id="email-template-name"
                  className={styles.input}
                  type="text"
                  autoComplete="off"
                  value={template.name}
                  onChange={(event) =>
                    applyChange({ ...template, name: event.target.value })
                  }
                />
                <p className={styles.hint}>
                  Only shown in this console - recipients never see it.
                </p>
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email-template-subject">
                  Subject
                </label>
                <input
                  id="email-template-subject"
                  className={styles.input}
                  type="text"
                  autoComplete="off"
                  value={template.subject}
                  onFocus={trackFocus({ kind: 'subject' })}
                  onChange={(event) =>
                    applyChange({ ...template, subject: event.target.value })
                  }
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email-template-preheader">
                  Preview line
                </label>
                <input
                  id="email-template-preheader"
                  className={styles.input}
                  type="text"
                  autoComplete="off"
                  value={template.preheader ?? ''}
                  onFocus={trackFocus({ kind: 'preheader' })}
                  onChange={(event) =>
                    applyChange({ ...template, preheader: event.target.value })
                  }
                />
                <p className={styles.hint}>
                  Shown by inboxes next to the subject. Optional.
                </p>
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email-template-heading">
                  Heading
                </label>
                <input
                  id="email-template-heading"
                  className={styles.input}
                  type="text"
                  autoComplete="off"
                  value={template.heading}
                  onFocus={trackFocus({ kind: 'heading' })}
                  onChange={(event) =>
                    applyChange({ ...template, heading: event.target.value })
                  }
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email-template-footer">
                  Footer note
                </label>
                <input
                  id="email-template-footer"
                  className={styles.input}
                  type="text"
                  autoComplete="off"
                  value={template.footerNote ?? ''}
                  onFocus={trackFocus({ kind: 'footer' })}
                  onChange={(event) =>
                    applyChange({ ...template, footerNote: event.target.value })
                  }
                />
                <p className={styles.hint}>
                  The "why you are receiving this" line. Leave blank to use the
                  assigned email type's own footer.
                </p>
              </div>
            </div>
          </Card>

          <div ref={containerRef} className={styles.blockList}>
            {blocks.map((block, index) => (
              <div
                key={block.id}
                id={blockAnchor(block.id)}
                style={getItemStyle(index)}
                className={
                  dragState?.from === index
                    ? `${styles.blockItem} ${styles.blockItemLifted}`
                    : styles.blockItem
                }
              >
                <Card>
                  <div className={styles.blockHeader}>
                    <span className={styles.dragHandle} {...getHandleProps(index)}>
                      <span aria-hidden="true">&#8801;</span>
                    </span>
                    <span className={styles.blockTitle}>{blockTypeLabel(block)}</span>
                    <span className={styles.blockControls}>
                      <Button
                        variant="ghost"
                        aria-label={`Move ${blockTypeLabel(block)} block up`}
                        disabled={index === 0}
                        onClick={() => moveBlock(index, index - 1)}
                      >
                        Up
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label={`Move ${blockTypeLabel(block)} block down`}
                        disabled={index === blocks.length - 1}
                        onClick={() => moveBlock(index, index + 1)}
                      >
                        Down
                      </Button>
                      <InlineDeleteBlock
                        label={`${blockTypeLabel(block)} block`}
                        onConfirm={() => removeBlock(block.id)}
                        disabled={blocks.length === 1}
                        disabledReason="An email needs at least one block - add another before deleting this one."
                      />
                    </span>
                  </div>

                  {block.type === 'paragraph' && (
                    <div className={styles.blockBody}>
                      <div className={styles.field}>
                        <label
                          className={styles.label}
                          htmlFor={`paragraph-${block.id}`}
                        >
                          Paragraph text
                        </label>
                        <textarea
                          id={`paragraph-${block.id}`}
                          className={styles.textarea}
                          rows={3}
                          value={block.text}
                          onFocus={trackFocus({ kind: 'block-text', blockId: block.id })}
                          onChange={(event) =>
                            updateBlock(block.id, { ...block, text: event.target.value })
                          }
                        />
                      </div>
                      <label className={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          className={styles.checkbox}
                          checked={block.omitIfEmpty === true}
                          onChange={(event) =>
                            updateBlock(block.id, {
                              id: block.id,
                              type: 'paragraph',
                              text: block.text,
                              ...(event.target.checked ? { omitIfEmpty: true } : {}),
                            })
                          }
                        />
                        Hide when empty
                      </label>
                      <p className={styles.hint}>
                        When ticked, the paragraph is left out of the sent email if
                        every variable in it turns out blank.
                      </p>
                    </div>
                  )}

                  {block.type === 'detail-rows' && (
                    <div className={styles.blockBody}>
                      <div className={styles.radioGroup} role="radiogroup" aria-label="Row source">
                        <label className={styles.checkboxRow}>
                          <input
                            type="radio"
                            className={styles.checkbox}
                            name={`rows-source-${block.id}`}
                            checked={block.source === 'custom'}
                            onChange={() =>
                              updateBlock(block.id, {
                                id: block.id,
                                type: 'detail-rows',
                                source: 'custom',
                                rows: block.rows ?? [
                                  { id: newBlockId(), label: '', value: '' },
                                ],
                              })
                            }
                          />
                          Rows I write here
                        </label>
                        <label className={styles.checkboxRow}>
                          <input
                            type="radio"
                            className={styles.checkbox}
                            name={`rows-source-${block.id}`}
                            checked={block.source === 'kind'}
                            onChange={() =>
                              // Authored rows are dropped on the switch: a
                              // 'kind' block never carries them (see the
                              // editor model's normaliseBlock).
                              updateBlock(block.id, {
                                id: block.id,
                                type: 'detail-rows',
                                source: 'kind',
                              })
                            }
                          />
                          Rows from the email type
                        </label>
                      </div>
                      {block.source === 'kind' ? (
                        <p className={styles.hint}>
                          The email type fills this card in when it sends - for
                          example a reminder's list of assessments, or a visit's
                          date and address. Nothing to write here.
                        </p>
                      ) : (
                        <div className={styles.rowList}>
                          {(block.rows ?? []).map((row) => (
                            <div key={row.id} className={styles.rowLine}>
                              <input
                                className={styles.input}
                                type="text"
                                autoComplete="off"
                                aria-label="Row label"
                                placeholder="Label"
                                value={row.label}
                                onFocus={trackFocus({
                                  kind: 'row',
                                  blockId: block.id,
                                  rowId: row.id,
                                  part: 'label',
                                })}
                                onChange={(event) =>
                                  updateBlock(block.id, {
                                    ...block,
                                    rows: (block.rows ?? []).map((entry) =>
                                      entry.id === row.id
                                        ? { ...entry, label: event.target.value }
                                        : entry,
                                    ),
                                  })
                                }
                              />
                              <input
                                className={styles.input}
                                type="text"
                                autoComplete="off"
                                aria-label="Row value"
                                placeholder="Value"
                                value={row.value}
                                onFocus={trackFocus({
                                  kind: 'row',
                                  blockId: block.id,
                                  rowId: row.id,
                                  part: 'value',
                                })}
                                onChange={(event) =>
                                  updateBlock(block.id, {
                                    ...block,
                                    rows: (block.rows ?? []).map((entry) =>
                                      entry.id === row.id
                                        ? { ...entry, value: event.target.value }
                                        : entry,
                                    ),
                                  })
                                }
                              />
                              <Button
                                variant="ghost"
                                aria-label={`Remove row ${row.label.trim() || 'without a label'}`}
                                onClick={() =>
                                  updateBlock(block.id, {
                                    ...block,
                                    rows: (block.rows ?? []).filter(
                                      (entry) => entry.id !== row.id,
                                    ),
                                  })
                                }
                              >
                                Remove
                              </Button>
                            </div>
                          ))}
                          <div>
                            <Button
                              variant="secondary"
                              onClick={() =>
                                updateBlock(block.id, {
                                  ...block,
                                  rows: [
                                    ...(block.rows ?? []),
                                    { id: newBlockId(), label: '', value: '' },
                                  ],
                                })
                              }
                            >
                              Add row
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {block.type === 'cta' && (
                    <div className={styles.blockBody}>
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor={`cta-label-${block.id}`}>
                          Button label
                        </label>
                        <input
                          id={`cta-label-${block.id}`}
                          className={styles.input}
                          type="text"
                          autoComplete="off"
                          value={block.label}
                          onFocus={trackFocus({ kind: 'cta-label', blockId: block.id })}
                          onChange={(event) =>
                            updateBlock(block.id, { ...block, label: event.target.value })
                          }
                        />
                      </div>
                      <label className={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          className={styles.checkbox}
                          checked={block.useKindLink === true}
                          onChange={(event) =>
                            updateBlock(block.id, {
                              id: block.id,
                              type: 'cta',
                              label: block.label,
                              ...(block.href ? { href: block.href } : {}),
                              ...(event.target.checked ? { useKindLink: true } : {}),
                            })
                          }
                        />
                        Use this email type's standard link
                      </label>
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor={`cta-href-${block.id}`}>
                          Link URL
                        </label>
                        <input
                          id={`cta-href-${block.id}`}
                          className={styles.input}
                          type="text"
                          autoComplete="off"
                          disabled={block.useKindLink === true}
                          value={block.href ?? ''}
                          onFocus={trackFocus({ kind: 'cta-href', blockId: block.id })}
                          onChange={(event) =>
                            updateBlock(block.id, { ...block, href: event.target.value })
                          }
                        />
                        <p className={styles.hint}>
                          {block.useKindLink === true
                            ? 'The email type supplies its own link for each recipient - the URL above is ignored.'
                            : 'Must start with https:// to appear in the sent email.'}
                        </p>
                      </div>
                    </div>
                  )}
                </Card>
              </div>
            ))}
          </div>

          <div className={styles.addRow}>
            <span className={styles.addLabel}>Add block</span>
            <Button variant="secondary" onClick={() => addBlock('paragraph')}>
              Paragraph
            </Button>
            <Button variant="secondary" onClick={() => addBlock('detail-rows')}>
              Details card
            </Button>
            <Button variant="secondary" onClick={() => addBlock('cta')}>
              Button
            </Button>
          </div>

          <Card>
            <CardHeader
              title="Variables"
              as="h3"
              hint="Select a text field, then a variable to insert it at the cursor. Which variables carry real values depends on the email type this template is assigned to; the rest are left unfilled."
            />
            <div className={styles.palette}>
              {CATALOGUE_VARIABLES.map((spec) => (
                <button
                  key={spec.name}
                  type="button"
                  className={styles.chip}
                  title={`${spec.label} - example: ${spec.example}`}
                  // Keep focus (and the caret) in the text field: the click
                  // still fires, the field never blurs.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertVariable(spec.name)}
                >
                  {`{{${spec.name}}}`}
                </button>
              ))}
            </div>
          </Card>
        </div>
      </PageGrid>
    </>
  );
}
