// ============================================================================
// Standard paragraphs - resolution across the two places they come from.
//
// A paragraph is EITHER one Safentia ships (the BS 9792 bank in bs9792.ts,
// static product content held in code) OR one the organisation wrote (RTDB,
// /standardParagraphs/{orgId}). The shipped bank is never copied into an
// organisation's node: that would duplicate 127 paragraphs per customer and
// turn every wording correction into a migration. So every reader that needs
// "the paragraph behind this id" comes through here, and every list the UI
// shows is the UNION the functions below produce.
//
// WHICH IS WHICH IS DECIDED BY THE ID, not by a stored field. Shipped ids are
// fixed and prefixed (`sp-bs9792-`); an organisation's are RTDB push keys,
// which always begin "-". The two can never collide, and because the marker is
// the id rather than a flag in the record, no client write can forge a
// built-in and no missing field can lose one.
//
// MIRRORED at functions/src/shared/standardParagraphs/index.ts. Keep the two
// byte-identical, exactly as types/ and paths/ already are.
// ============================================================================

import type { StandardParagraph } from '../types';
import {
  BS9792_PARAGRAPH_PREFIX,
  BS9792_PARAGRAPH_SUBJECTS,
  BS9792_STANDARD_PARAGRAPHS,
} from './bs9792';

/** A paragraph with its id and its origin - what every list renders from. */
export interface ParagraphEntry {
  id: string;
  paragraph: StandardParagraph;
  /** True for the wording Safentia ships, false for the organisation's own. */
  builtIn: boolean;
}

/** The label an organisation's own paragraphs group under when they carry no
 *  subject of their own. Also the group heading in the library. */
export const CUSTOM_SUBJECT = 'Your paragraphs';

/** Every id prefix that marks shipped content. One today; a PAS 79 bank would
 *  add its own here and nothing else would need to change. */
const BUILT_IN_PREFIXES = [BS9792_PARAGRAPH_PREFIX];

/** Is this id one of ours? An organisation's paragraphs are push keys ("-..."),
 *  so a prefix test is exact rather than a heuristic. */
export function isBuiltInParagraphId(id: string): boolean {
  return BUILT_IN_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** The shipped bank as entries, in document order. */
export function builtInParagraphs(): ParagraphEntry[] {
  return BS9792_STANDARD_PARAGRAPHS.map(({ id, paragraph }) => ({
    id,
    paragraph,
    builtIn: true,
  }));
}

/** The shipped bank as a lookup, built once - resolution runs per question
 *  while a template is being pinned, so it must not be O(n) each time. */
const BUILT_IN_BY_ID: ReadonlyMap<string, StandardParagraph> = new Map(
  BS9792_STANDARD_PARAGRAPHS.map(({ id, paragraph }) => [id, paragraph]),
);

/**
 * The paragraph an id names, wherever it lives. Shipped content is checked
 * FIRST: a `sp-bs9792-` id can never be an organisation's, so a stray record
 * written under one of our ids cannot shadow the wording we ship.
 *
 * Returns undefined when the id resolves to nothing - a paragraph the
 * organisation deleted while a template still pointed at it. Callers render
 * that as a dangling reference rather than as empty wording; silently printing
 * nothing into a report is the one outcome this must not produce.
 */
export function resolveParagraph(
  id: string,
  orgParagraphs: Record<string, StandardParagraph> | null | undefined,
): StandardParagraph | undefined {
  return BUILT_IN_BY_ID.get(id) ?? orgParagraphs?.[id] ?? undefined;
}

/**
 * The whole library: the shipped bank followed by the organisation's own.
 *
 * Ordered by subject as the source document orders it, then by reference
 * within a subject, with the organisation's own paragraphs last under
 * CUSTOM_SUBJECT - an admin looking for their own wording should not have to
 * hunt for it among ours.
 */
export function allParagraphs(
  orgParagraphs: Record<string, StandardParagraph> | null | undefined,
): ParagraphEntry[] {
  const own: ParagraphEntry[] = Object.entries(orgParagraphs ?? {})
    // A shipped id appearing in the org node is not a second paragraph; it is
    // the same one, and the shipped copy wins (see resolveParagraph).
    .filter(([id]) => !isBuiltInParagraphId(id))
    .map(([id, paragraph]) => ({ id, paragraph, builtIn: false }))
    .sort((a, b) => compareReference(a.paragraph, b.paragraph));
  return [...builtInParagraphs(), ...own];
}

/** References sort the way a person reads them: "4.2.1" before "4.10.1". */
export function compareReference(
  a: StandardParagraph,
  b: StandardParagraph,
): number {
  return a.reference.localeCompare(b.reference, 'en-GB', { numeric: true });
}

/** The subject headings the library groups under, in order: the shipped
 *  subjects as the source document orders them, then the organisation's own. */
export function paragraphSubjects(
  orgParagraphs: Record<string, StandardParagraph> | null | undefined,
): string[] {
  const subjects = BS9792_PARAGRAPH_SUBJECTS.map((entry) => entry.title);
  const hasOwn = Object.keys(orgParagraphs ?? {}).some(
    (id) => !isBuiltInParagraphId(id),
  );
  return hasOwn ? [...subjects, CUSTOM_SUBJECT] : subjects;
}

/** The group heading an entry belongs under. */
export function subjectOf(entry: ParagraphEntry): string {
  return entry.paragraph.subject?.trim() || CUSTOM_SUBJECT;
}
