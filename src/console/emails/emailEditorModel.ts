// ============================================================================
// emailEditorModel - the email template editor's pure core: id minting,
// normalisation of what RTDB hands back, the canonical fingerprint the
// autosave echo-guard compares, the advisory validation the aside renders, and
// the starter document the templates list creates (the builderModel precedent:
// pure functions only, so every rule the editor enforces is testable without a
// DOM).
//
// Validation here is ADVISORY, unlike the template builder's publish gate:
// email templates have no publish moment - the server checks renderability at
// send time and falls back to the built-in default rather than failing a
// business operation - so nothing here blocks saving. The checks exist to
// tell the author what the send path will do with what they wrote.
// ============================================================================

import type {
  EmailTemplate,
  EmailTemplateBlock,
  EmailTemplateDetailRow,
} from '../../types';
import { EMAIL_KINDS, type EmailVariableSpec } from './emailKindCatalogue';
import { extractVariables } from './emailVariableEngine';

// ----------------------------------------------------------------------------
// Ids. Block ids anchor React keys, DOM anchors and the drag handles, so they
// must be unique within the template and stable across reorders - never
// index-derived (the builderModel newId rationale).
// ----------------------------------------------------------------------------

export function newBlockId(): string {
  return `b-${crypto.randomUUID().slice(0, 8)}`;
}

// ----------------------------------------------------------------------------
// Catalogue variable union. The palette offers every variable ANY kind
// supplies, because a template is authored before (and independently of) the
// kinds it is assigned to; the editor's hint explains that the real set
// depends on the assignment. Deduped by name (specs shared across kinds are
// identical objects in the catalogue), common variables first so the two an
// author reaches for most sit at the front.
// ----------------------------------------------------------------------------

const COMMON_VARIABLE_NAMES = ['org.name', 'recipient.name'];

function collectCatalogueVariables(): EmailVariableSpec[] {
  const byName = new Map<string, EmailVariableSpec>();
  for (const kind of Object.values(EMAIL_KINDS)) {
    for (const spec of kind.variables) {
      if (!byName.has(spec.name)) byName.set(spec.name, spec);
    }
  }
  const common = COMMON_VARIABLE_NAMES.map((name) => byName.get(name)).filter(
    (spec): spec is EmailVariableSpec => spec !== undefined,
  );
  const rest = [...byName.values()]
    .filter((spec) => !COMMON_VARIABLE_NAMES.includes(spec.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
  return [...common, ...rest];
}

/** Every variable any kind supplies, common (`org.name`, `recipient.name`)
 *  first, the rest alphabetical. Drives the editor's insert palette. */
export const CATALOGUE_VARIABLES: EmailVariableSpec[] = collectCatalogueVariables();

/** The names alone, for the unknown-variable check. */
export const KNOWN_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  CATALOGUE_VARIABLES.map((spec) => spec.name),
);

/** Every catalogue variable's example value - what the live preview
 *  substitutes, so the preview reads like a real email rather than a wall of
 *  tokens. */
export const PREVIEW_EXAMPLE_VARIABLES: Record<string, string> =
  Object.fromEntries(CATALOGUE_VARIABLES.map((spec) => [spec.name, spec.example]));

// ----------------------------------------------------------------------------
// Normalisation - RTDB drops empty arrays and never stores undefined, so a
// template read back can be missing `blocks` or a custom rows array, and an
// array-shaped node with sparse keys can come back as an object map.
// Normalising once at the boundary means the editor treats every array as
// present (the builderModel precedent).
// ----------------------------------------------------------------------------

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, T>);
  }
  return [];
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

function normaliseRow(raw: unknown): EmailTemplateDetailRow {
  const row = (raw ?? {}) as Partial<EmailTemplateDetailRow>;
  return {
    id: row.id ?? newBlockId(),
    label: asText(row.label),
    value: asText(row.value),
  };
}

/** Normalise one block; null for a type the editor does not understand. The
 *  rules constrain writes to the three known types, so an unknown block only
 *  arises from corruption - and a block the editor cannot render cannot be
 *  edited, so it is dropped rather than carried as an opaque husk the send
 *  path would reject anyway. */
function normaliseBlock(raw: unknown): EmailTemplateBlock | null {
  const block = (raw ?? {}) as Record<string, unknown>;
  const id = typeof block.id === 'string' && block.id ? block.id : newBlockId();
  switch (block.type) {
    case 'paragraph':
      return {
        id,
        type: 'paragraph',
        text: asText(block.text),
        ...(block.omitIfEmpty === true ? { omitIfEmpty: true } : {}),
      };
    case 'detail-rows': {
      const source = block.source === 'kind' ? 'kind' : 'custom';
      return {
        id,
        type: 'detail-rows',
        source,
        // Kind rows are supplied by the send site, so authored rows only
        // exist on 'custom'; a stale copy left behind by a source switch
        // would read as a foreign change to the echo-guard.
        ...(source === 'custom' ? { rows: asArray(block.rows).map(normaliseRow) } : {}),
      };
    }
    case 'cta':
      return {
        id,
        type: 'cta',
        label: asText(block.label),
        ...(typeof block.href === 'string' && block.href ? { href: block.href } : {}),
        ...(block.useKindLink === true ? { useKindLink: true } : {}),
      };
    default:
      return null;
  }
}

/** Tolerant of partial RTDB data: every field lands as a well-typed value the
 *  editor can bind inputs to. Optional strings normalise to '' for editing
 *  and are dropped again by the write payload, so the round trip is stable. */
export function normaliseEmailTemplate(raw: unknown): EmailTemplate {
  const value = (raw ?? {}) as Partial<EmailTemplate>;
  return {
    name: asText(value.name),
    subject: asText(value.subject),
    preheader: asText(value.preheader),
    heading: asText(value.heading),
    blocks: asArray(value.blocks)
      .map(normaliseBlock)
      .filter((block): block is EmailTemplateBlock => block !== null),
    footerNote: asText(value.footerNote),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    updatedBy: asText(value.updatedBy),
  };
}

// ----------------------------------------------------------------------------
// Write payload + fingerprint. The canonical CONTENT of a template - metadata
// (updatedAt/updatedBy) deliberately excluded, because the stamp changes on
// every write: fingerprinting it would make our own echo look foreign the
// moment a flush restamped it, and the echo-guard exists precisely so an echo
// never clobbers in-flight typing (the ServiceSchedulePanel precedent via
// builderModel).
// ----------------------------------------------------------------------------

/** Prune a block to exactly what autosave writes: undefined stripped (RTDB
 *  rejects it), false/empty optionals dropped so the node never accumulates
 *  `omitIfEmpty: false` husks. */
function pruneBlock(block: EmailTemplateBlock): EmailTemplateBlock {
  switch (block.type) {
    case 'paragraph':
      return {
        id: block.id,
        type: 'paragraph',
        text: block.text,
        ...(block.omitIfEmpty ? { omitIfEmpty: true } : {}),
      };
    case 'detail-rows':
      return {
        id: block.id,
        type: 'detail-rows',
        source: block.source,
        ...(block.source === 'custom' && (block.rows ?? []).length > 0
          ? { rows: block.rows }
          : {}),
      };
    case 'cta':
      return {
        id: block.id,
        type: 'cta',
        label: block.label,
        ...(block.useKindLink
          ? { useKindLink: true }
          : block.href?.trim()
            ? { href: block.href }
            : {}),
      };
  }
}

/** Content only - no metadata. Shared by the fingerprint and the write
 *  payload so fingerprint(payload) === fingerprint(model) by construction. */
function canonicalContent(template: EmailTemplate) {
  return {
    name: template.name,
    subject: template.subject,
    ...(template.preheader?.trim() ? { preheader: template.preheader } : {}),
    heading: template.heading,
    blocks: template.blocks.map(pruneBlock),
    ...(template.footerNote?.trim() ? { footerNote: template.footerNote } : {}),
  };
}

/** Key-order-independent stringify: RTDB does not preserve object key order,
 *  so a plain JSON.stringify would read our own echo as a foreign change. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

export function emailTemplateFingerprint(template: EmailTemplate): string {
  return JSON.stringify(stable(canonicalContent(normaliseEmailTemplate(template))));
}

/** The exact object autosave writes: canonical content plus a fresh stamp.
 *  Stamped here rather than in the component so every write path (autosave,
 *  duplicate, create) stamps identically. */
export function templateWritePayload(template: EmailTemplate, uid: string): EmailTemplate {
  return {
    ...canonicalContent(template),
    updatedAt: Date.now(),
    updatedBy: uid,
  };
}

// ----------------------------------------------------------------------------
// The starter document a new template opens on: modest real content (the
// manual kind's shape) rather than a blank form, so the live preview shows an
// email from the first render and the author edits rather than assembles.
// ----------------------------------------------------------------------------

export function starterTemplate(name: string, uid: string): EmailTemplate {
  return {
    name,
    subject: 'A message from {{org.name}}',
    heading: '{{org.name}}',
    blocks: [{ id: newBlockId(), type: 'paragraph', text: 'Write your message here.' }],
    updatedAt: Date.now(),
    updatedBy: uid,
  };
}

// ----------------------------------------------------------------------------
// Advisory validation. Each issue carries the DOM anchor of the offending
// field or block so the aside can jump straight to it (the builderModel
// jump-to-issue idiom). Two levels: 'advice' for things the send path will
// visibly degrade (a blank subject, a button with no destination), 'info' for
// the unknown-variable case - a {{token}} no catalogue kind supplies is
// legitimately a custom variable on a manual template, so it is surfaced, not
// condemned.
// ----------------------------------------------------------------------------

export interface EmailValidationIssue {
  message: string;
  /** The `id` attribute of the element to scroll to. */
  anchorId: string;
  level: 'advice' | 'info';
  /** Present on unknown-variable issues so the aside can render the token as
   *  a chip. */
  token?: string;
}

/** DOM anchor for a block card. */
export function blockAnchor(blockId: string): string {
  return `email-block-${blockId}`;
}

const BLOCK_TYPE_LABELS: Record<EmailTemplateBlock['type'], string> = {
  paragraph: 'Paragraph',
  'detail-rows': 'Details card',
  cta: 'Button',
};

export function blockTypeLabel(block: EmailTemplateBlock): string {
  return BLOCK_TYPE_LABELS[block.type];
}

export function validateEmailTemplate(template: EmailTemplate): EmailValidationIssue[] {
  const issues: EmailValidationIssue[] = [];

  if (!template.name.trim()) {
    issues.push({
      message: 'Name the template so it can be recognised in lists.',
      anchorId: 'email-template-name',
      level: 'advice',
    });
  }
  if (!template.subject.trim()) {
    issues.push({
      message: 'Give the email a subject line - without one it arrives blank in the inbox list.',
      anchorId: 'email-template-subject',
      level: 'advice',
    });
  }
  if (!template.heading.trim()) {
    issues.push({
      message: 'Give the email a heading - it is the first line of the message itself.',
      anchorId: 'email-template-heading',
      level: 'advice',
    });
  }

  template.blocks.forEach((block, index) => {
    const label = `Block ${index + 1} (${blockTypeLabel(block)})`;
    const anchorId = blockAnchor(block.id);
    if (block.type === 'paragraph' && !block.text.trim()) {
      issues.push({
        message: `${label}: an empty paragraph is dropped from the sent email.`,
        anchorId,
        level: 'advice',
      });
    }
    if (
      block.type === 'detail-rows' &&
      block.source === 'custom' &&
      (block.rows ?? []).length === 0
    ) {
      issues.push({
        message: `${label}: the details card has no rows, so it will not appear.`,
        anchorId,
        level: 'advice',
      });
    }
    if (block.type === 'cta' && !block.useKindLink && !block.href?.trim()) {
      issues.push({
        message: `${label}: the button has no destination - give it a link, or use the email type's own link.`,
        anchorId,
        level: 'advice',
      });
    }
  });

  // Unknown variables, checked across every templated field. "Unknown" means
  // unknown to EVERY catalogue kind: a template is free-form until assigned,
  // and manual sends may supply custom variables, so this is information for
  // the author, never an error.
  const seen = new Set<string>();
  const check = (text: string, anchorId: string): void => {
    for (const name of extractVariables(text)) {
      if (KNOWN_VARIABLE_NAMES.has(name) || seen.has(name)) continue;
      seen.add(name);
      issues.push({
        message: `is not supplied by any email type - it is treated as a custom variable and left unfilled unless the send provides it.`,
        anchorId,
        level: 'info',
        token: name,
      });
    }
  };
  check(template.subject, 'email-template-subject');
  check(template.preheader ?? '', 'email-template-preheader');
  check(template.heading, 'email-template-heading');
  for (const block of template.blocks) {
    const anchorId = blockAnchor(block.id);
    if (block.type === 'paragraph') check(block.text, anchorId);
    if (block.type === 'detail-rows') {
      for (const row of block.rows ?? []) {
        check(row.label, anchorId);
        check(row.value, anchorId);
      }
    }
    if (block.type === 'cta') {
      check(block.label, anchorId);
      check(block.href ?? '', anchorId);
    }
  }
  check(template.footerNote ?? '', 'email-template-footer');

  return issues;
}
