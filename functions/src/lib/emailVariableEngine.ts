// ============================================================================
// emailVariableEngine - the pure {{variable}} substitution and template
// rendering model for org email templating (section 6b).
//
// Turns an admin-authored EmailTemplate (subject + ordered blocks) plus a flat
// variable map into the exact structure renderBrandedEmail consumes, in one of
// two modes: 'send' (unknown variables resolve to '' and are reported so the
// server can decide whether to fall back to the default template) and
// 'preview' (unknown tokens are left literal AND reported so the editor can
// highlight them in place). Pure by design: no imports beyond the mirrored
// types contract, no I/O, so the console's live template preview and the
// Cloud Functions send path share this exact implementation byte-for-byte
// (ragDerivation precedent - see scripts/verify-schema-mirror.sh).
//
// Values are plain text throughout: HTML escaping stays inside the branded
// renderer, at the boundary, never here.
// ============================================================================

import type { EmailTemplateBlock } from '../../types';

/** A {{ variable.name }} token: identifier-ish, dots/dashes allowed after the
 *  first character, optional inner whitespace. Exported for editor tooling
 *  (syntax highlighting); internal callers always work on a fresh copy so a
 *  consumer-mutated lastIndex can never skew results. */
export const VARIABLE_TOKEN = /\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.-]*)\s*\}\}/g;

/** Fresh regex per call: VARIABLE_TOKEN is global, and global regexes carry
 *  mutable lastIndex state that String.prototype.matchAll seeds from - a
 *  shared instance would make results depend on who scanned last. */
const freshToken = (): RegExp => new RegExp(VARIABLE_TOKEN.source, 'g');

/** Own-property lookup only, so hostile variable names like 'constructor' or
 *  '__proto__' can never resolve to prototype junk. */
const hasVariable = (variables: Record<string, string>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(variables, name);

/** Structural shape of a renderable template: EmailTemplate minus metadata
 *  (name/updatedAt/updatedBy play no part in rendering, and built-in default
 *  templates are authored directly in this shape). */
export interface EmailTemplateShape {
  subject: string;
  preheader?: string;
  heading: string;
  blocks: EmailTemplateBlock[];
  footerNote?: string;
}

export interface SubstitutionResult {
  text: string;
  /** Distinct unknown variable names, in order of first appearance. */
  unknown: string[];
  /** Distinct known variables that resolved to '' (drives omitIfEmpty). */
  usedEmpty: string[];
}

/** mode 'send': an unknown variable resolves to '' and is collected in
 *  `unknown`. mode 'preview': unknown tokens are left as the literal
 *  {{token}} so the editor can highlight them - and still reported. Known
 *  variables resolving to '' are collected in `usedEmpty`. */
export function substitute(
  template: string,
  variables: Record<string, string>,
  mode: 'send' | 'preview',
): SubstitutionResult {
  const unknown: string[] = [];
  const usedEmpty: string[] = [];
  const text = template.replace(freshToken(), (token, name: string) => {
    if (!hasVariable(variables, name)) {
      if (!unknown.includes(name)) unknown.push(name);
      return mode === 'preview' ? token : '';
    }
    const value = variables[name];
    if (value === '' && !usedEmpty.includes(name)) usedEmpty.push(name);
    return value;
  });
  return { text, unknown, usedEmpty };
}

/** All distinct {{tokens}} used in a string, in order of first appearance. */
export function extractVariables(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(freshToken())) {
    const name = match[1];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export interface RenderedTemplate {
  subject: string;
  preheader?: string;
  heading: string;
  paragraphs: string[];
  detailRows: Array<{ label: string; value: string }>;
  cta?: { label: string; url: string };
  footerNote?: string;
  /** Plain-text body: heading, paragraphs, detail rows as "label: value"
   *  lines, cta as "label: url", footer - joined with blank lines. */
  text: string;
  /** Union of unknown variables across every field, deduped, in first-seen
   *  order. Populated in BOTH modes - preview leaves tokens literal but still
   *  reports them so the editor can list them. */
  unknown: string[];
}

/** Render a whole template against a flat variable map. kindRows feed
 *  source:'kind' detail blocks (digest lists, visit cards) and kindLink feeds
 *  useKindLink ctas - both supplied by the send site per kind/recipient. */
export function renderTemplate(
  template: EmailTemplateShape,
  variables: Record<string, string>,
  mode: 'send' | 'preview',
  kindRows?: Array<{ label: string; value: string }>,
  kindLink?: string,
): RenderedTemplate {
  const unknown: string[] = [];
  const collect = (names: string[]): void => {
    for (const name of names) if (!unknown.includes(name)) unknown.push(name);
  };
  const sub = (text: string): SubstitutionResult => {
    const result = substitute(text, variables, mode);
    collect(result.unknown);
    return result;
  };

  // Subject is a single-line field: strip any newlines a template (or a
  // multi-line variable value) smuggled in, collapsing each run to one space.
  const subject = sub(template.subject).text.replace(/[\r\n]+/g, ' ');
  const preheader = template.preheader === undefined ? undefined : sub(template.preheader).text;
  const heading = sub(template.heading).text;
  const footerNote = template.footerNote === undefined ? undefined : sub(template.footerNote).text;

  const paragraphs: string[] = [];
  const detailRows: Array<{ label: string; value: string }> = [];
  let cta: { label: string; url: string } | undefined;

  for (const block of template.blocks) {
    if (block.type === 'paragraph') {
      const result = sub(block.text);
      if (block.omitIfEmpty) {
        // Drop when the paragraph used at least one variable and ALL of them
        // resolved empty or unknown (unknown counts as empty in both modes -
        // the author's intent is "nothing to say here").
        const used = extractVariables(block.text);
        const allEmpty =
          used.length > 0 &&
          used.every((name) => result.unknown.includes(name) || result.usedEmpty.includes(name));
        if (allEmpty) continue;
      }
      // Whatever the flags, an empty/whitespace-only paragraph renders as an
      // ugly gap - drop it.
      if (result.text.trim() === '') continue;
      paragraphs.push(result.text);
    } else if (block.type === 'detail-rows') {
      if (block.source === 'kind') {
        // Kind rows are supplied verbatim by the send site (already final
        // values, no tokens); authored rows on a 'kind' block are ignored.
        if (kindRows) detailRows.push(...kindRows);
      } else {
        for (const row of block.rows ?? []) {
          const value = sub(row.value).text;
          // A row without a value is noise ("Reference:  ") - drop it. Rows
          // with an empty label but a value still carry information, so stay.
          if (value.trim() === '') continue;
          detailRows.push({ label: sub(row.label).text, value });
        }
      }
    } else {
      // cta - always substitute (so unknown variables in later/dropped ctas
      // are still reported to the editor), but only the FIRST surviving cta
      // renders: renderBrandedEmail supports exactly one button.
      const label = sub(block.label).text;
      let url: string;
      if (block.useKindLink) {
        // No canonical link supplied for this kind/recipient: nothing real to
        // point at, so the cta is dropped in both modes.
        if (kindLink === undefined) continue;
        url = kindLink;
      } else {
        url = sub(block.href ?? '').text;
      }
      // Guard the scheme: only http(s) may reach a rendered email (blocks
      // javascript: and friends). In preview the author keeps seeing the
      // button so they can spot and fix the bad link.
      if (mode === 'send' && !/^https?:\/\//i.test(url)) continue;
      if (!cta) cta = { label, url };
    }
  }

  const segments: string[] = [heading, ...paragraphs];
  if (detailRows.length > 0) {
    segments.push(detailRows.map((row) => `${row.label}: ${row.value}`).join('\n'));
  }
  if (cta) segments.push(`${cta.label}: ${cta.url}`);
  if (footerNote !== undefined && footerNote.trim() !== '') segments.push(footerNote);
  const text = segments.filter((segment) => segment.trim() !== '').join('\n\n');

  return { subject, preheader, heading, paragraphs, detailRows, cta, footerNote, text, unknown };
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isOptionalString = (value: unknown): boolean => value === undefined || isString(value);
const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean';

/** One well-formed block: known type, required string fields, optional fields
 *  either absent or correctly typed. */
function isRenderableBlock(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  if (!isString(block.id)) return false;
  switch (block.type) {
    case 'paragraph':
      return isString(block.text) && isOptionalBoolean(block.omitIfEmpty);
    case 'detail-rows':
      if (block.source !== 'custom' && block.source !== 'kind') return false;
      if (block.rows === undefined) return true;
      return (
        Array.isArray(block.rows) &&
        block.rows.every((row: unknown) => {
          if (typeof row !== 'object' || row === null) return false;
          const r = row as Record<string, unknown>;
          return isString(r.id) && isString(r.label) && isString(r.value);
        })
      );
    case 'cta':
      return (
        isString(block.label) && isOptionalString(block.href) && isOptionalBoolean(block.useKindLink)
      );
    default:
      return false;
  }
}

/** Structural guard used by the server before trusting a client-written doc:
 *  the rules constrain writes, but a renderable check at the send boundary
 *  means a malformed template degrades to the built-in default instead of
 *  failing a business operation. Never throws. */
export function isRenderableTemplate(value: unknown): value is EmailTemplateShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  // Whitespace-only subject/heading would render a blank email header, so
  // "non-empty" means non-blank here.
  if (!isString(doc.subject) || doc.subject.trim() === '') return false;
  if (!isString(doc.heading) || doc.heading.trim() === '') return false;
  if (!isOptionalString(doc.preheader) || !isOptionalString(doc.footerNote)) return false;
  return Array.isArray(doc.blocks) && doc.blocks.every(isRenderableBlock);
}
