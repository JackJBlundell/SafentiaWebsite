// ============================================================================
// builderModel - the template builder's pure core: id minting, normalisation
// of what RTDB hands back, the canonical fingerprint the autosave echo-guard
// compares, the live validation that mirrors the publishTemplate gate, and the
// summary counts the aside renders. Pure functions only, so every rule the
// builder enforces is testable without a DOM.
// ============================================================================

import {
  QUESTION_TYPES,
  type QuestionMatrix,
  type QuestionType,
  type ReportStandard,
  type StandardParagraph,
  type Template,
  type TemplateQuestion,
  type TemplateSection,
} from '../../types';
import { resolveParagraph } from '../../standardParagraphs';

// ----------------------------------------------------------------------------
// Ids.
// ----------------------------------------------------------------------------

/**
 * Mint an id for a new section or question. Question ids become ANSWER KEYS
 * (/assessmentAnswers/{assessmentId}/{questionId}), so they must be unique
 * within the template and stable for its whole life - never index-derived,
 * because a reorder would silently re-key every stored answer. A short slice
 * of a UUID gives collision-safe uniqueness at answer-key scale while keeping
 * RTDB paths readable.
 */
export function newId(prefix: 'q' | 's'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// ----------------------------------------------------------------------------
// Labels - readable names for every schema value the builder offers.
// ----------------------------------------------------------------------------

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  text: 'Short text',
  longtext: 'Long text',
  yesno: 'Yes / No',
  select: 'Single choice',
  multiselect: 'Multiple choice',
  photo: 'Photo',
  nonConformity: 'Non-conformity',
  matrix: 'Matrix (grid)',
};

export const STANDARD_LABELS: Record<ReportStandard, string> = {
  pas79: 'PAS 79',
  bs9792: 'BS 9792',
  custom: 'Custom',
};

/** True for the types whose answers are chosen from authored options. */
export function hasOptions(type: QuestionType): boolean {
  return type === 'select' || type === 'multiselect';
}

/** True for the types answered by picking one cell of an authored grid. */
export function hasMatrix(type: QuestionType): boolean {
  return type === 'matrix';
}

// ----------------------------------------------------------------------------
// Matrix grids. These ceilings MIRROR the publishTemplate gate
// (functions/src/functions/publishTemplate.ts, MATRIX_LIMITS) so the builder can
// never author a grid the publish would reject; change both together.
// ----------------------------------------------------------------------------

export const MATRIX_LIMITS = {
  /** A single-option axis is not a grid, it is a list. */
  minAxis: 2,
  maxAxis: 12,
  /** Total cells, so a template cannot carry an enormous grid. */
  maxCells: 100,
  /** Axis headings, option labels and cell outcomes. */
  labelMax: 200,
  /** A per-option definition, which can run to a paragraph of standard wording. */
  definitionMax: 5000,
} as const;

/**
 * The grid a question starts life with when its type becomes `matrix`: the
 * smallest shape the rules allow, so the editor opens on something real and the
 * author fills it in rather than assembling it from nothing.
 */
export function defaultMatrix(): QuestionMatrix {
  return {
    rowLabel: '',
    columnLabel: '',
    rows: ['', ''],
    columns: ['', ''],
    cells: [
      ['', ''],
      ['', ''],
    ],
  };
}

/**
 * Force a grid rectangular and drop definitions that no longer name an option.
 * Both invariants are also maintained by the editor's mutators, so this only
 * ever has work to do on data read back from RTDB (which stores no empty arrays
 * and can return an array-shaped node as an object map).
 */
export function normaliseMatrix(raw: unknown): QuestionMatrix {
  const value = (raw ?? {}) as Partial<QuestionMatrix>;
  const asLabel = (candidate: unknown): string =>
    typeof candidate === 'string' ? candidate : '';
  const rows = asArray<unknown>(value.rows).map(asLabel);
  const columns = asArray<unknown>(value.columns).map(asLabel);
  const rawCells = asArray<unknown>(value.cells);
  const cells = rows.map((_, rowIndex) => {
    const rawRow = asArray<unknown>(rawCells[rowIndex]);
    return columns.map((__, columnIndex) => asLabel(rawRow[columnIndex]));
  });

  const labels = new Set([...rows, ...columns].filter((label) => label.trim()));
  const definitions: Record<string, string> = {};
  const rawDefinitions = value.definitions;
  if (rawDefinitions && typeof rawDefinitions === 'object') {
    for (const [key, text] of Object.entries(
      rawDefinitions as Record<string, unknown>,
    )) {
      if (labels.has(key) && typeof text === 'string' && text.trim()) {
        definitions[key] = text;
      }
    }
  }
  const hasDefinitions = Object.keys(definitions).length > 0;

  return {
    rowLabel: asLabel(value.rowLabel),
    columnLabel: asLabel(value.columnLabel),
    rows,
    columns,
    cells,
    // Omitted rather than left empty: the write payload omits it too, and the
    // autosave echo-guard compares fingerprints of both.
    ...(hasDefinitions ? { definitions } : {}),
  };
}

// ----------------------------------------------------------------------------
// Normalisation - RTDB drops empty arrays and never stores undefined, so a
// draft read back from the node can be missing `sections`, `questions` or
// `options`. Normalising once at the boundary means the rest of the builder
// can treat those arrays as always present.
// ----------------------------------------------------------------------------

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  // RTDB can return an array-shaped node as an object map when keys are
  // sparse; recover the values in key order.
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, T>);
  }
  return [];
}

export function normaliseTemplate(raw: unknown): Template {
  const value = (raw ?? {}) as Partial<Template>;
  const sections = asArray<TemplateSection>(value.sections).map((section) => ({
    id: section.id ?? newId('s'),
    code: section.code ?? '',
    title: section.title ?? '',
    questions: asArray<TemplateQuestion>(section.questions).map((question) => {
      // options and matrix are pulled out of the spread so a type change can
      // drop the one that no longer applies: the write payload omits it, and a
      // stale copy left in the local draft would read as a foreign change.
      const { options, matrix, ...rest } = question;
      const type = (QUESTION_TYPES as readonly string[]).includes(question.type)
        ? question.type
        : 'text';
      return {
        ...rest,
        id: question.id ?? newId('q'),
        text: question.text ?? '',
        type,
        ...(hasOptions(type) ? { options: asArray<string>(options) } : {}),
        ...(hasMatrix(type) ? { matrix: normaliseMatrix(matrix) } : {}),
      };
    }),
  }));
  return {
    name: value.name ?? '',
    version: value.version ?? 0,
    status: 'draft',
    ...(value.standard ? { standard: value.standard } : {}),
    // Carried through untouched: the certificate is set by its own upload
    // control, and publishTemplate re-validates it (tenant boundary + position)
    // before it reaches a published version.
    ...(value.certificate ? { certificate: value.certificate } : {}),
    sections,
  };
}

// ----------------------------------------------------------------------------
// Fingerprint - a canonical, key-order-independent stringify. The autosave
// echo-guard compares what it last wrote against what the listener delivers;
// RTDB does not preserve object key order, so a plain JSON.stringify would
// read our own echo as a foreign change and clobber in-flight typing (the
// ServiceSchedulePanel precedent).
// ----------------------------------------------------------------------------

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

export function fingerprint(template: Template): string {
  return JSON.stringify(stable(normaliseTemplate(template)));
}

/**
 * The exact object autosave writes: undefined stripped (RTDB rejects it) and
 * empty optional strings dropped so the node never accumulates `guidance: ''`
 * husks. Structure and ids are preserved exactly.
 */
export function draftWritePayload(template: Template): Template {
  const prune = (question: TemplateQuestion): TemplateQuestion => {
    const next: TemplateQuestion = {
      id: question.id,
      text: question.text,
      type: question.type,
    };
    if (hasOptions(question.type) && question.options) {
      next.options = question.options;
    }
    // The grid is the substance of a matrix question, so it is written whole;
    // normalising here keeps it rectangular even if a draft predates the
    // editor's own guarantees.
    if (hasMatrix(question.type)) {
      next.matrix = normaliseMatrix(question.matrix);
    }
    if (question.required) next.required = true;
    if (question.allowsPhotos) next.allowsPhotos = true;
    if (question.allowsFlagLocation) next.allowsFlagLocation = true;
    if (question.guidance?.trim()) next.guidance = question.guidance;
    if (question.observation?.trim()) next.observation = question.observation;
    if (question.recommendation?.trim()) next.recommendation = question.recommendation;
    if (question.standardParagraphRef) {
      next.standardParagraphRef = question.standardParagraphRef;
    }
    return next;
  };
  return {
    name: template.name,
    version: template.version,
    status: 'draft',
    ...(template.standard ? { standard: template.standard } : {}),
    ...(template.certificate ? { certificate: template.certificate } : {}),
    sections: template.sections.map((section) => ({
      id: section.id,
      code: section.code,
      title: section.title,
      questions: section.questions.map(prune),
    })),
  };
}

// ----------------------------------------------------------------------------
// Validation - the client-side mirror of the publishTemplate gate, run live so
// the publish button is never a surprise rejection. Each issue carries the DOM
// anchor of the offending item so the aside can jump straight to it.
// ----------------------------------------------------------------------------

export interface ValidationIssue {
  message: string;
  /** The `id` attribute of the element to scroll to and reveal. */
  anchorId: string;
  /** Present when the issue sits inside a question that must be expanded. */
  questionId?: string;
}

/** DOM anchor for a section card. */
export function sectionAnchor(sectionId: string): string {
  return `builder-section-${sectionId}`;
}

/** DOM anchor for a question row. */
export function questionAnchor(questionId: string): string {
  return `builder-question-${questionId}`;
}

/**
 * Every reason a grid could not be published, in plain language. Exported so the
 * matrix editor can show the same wording inline, next to the offending axis,
 * rather than only in the publish checklist.
 */
export function matrixIssues(matrix: QuestionMatrix | undefined): string[] {
  const messages: string[] = [];
  if (!matrix) {
    return ['build the grid before publishing.'];
  }

  const axis = (labels: string[], noun: 'row' | 'column'): void => {
    const plural = `${noun}s`;
    if (labels.length < MATRIX_LIMITS.minAxis) {
      messages.push(`the grid needs at least ${MATRIX_LIMITS.minAxis} ${plural}.`);
    }
    if (labels.length > MATRIX_LIMITS.maxAxis) {
      messages.push(`the grid may have at most ${MATRIX_LIMITS.maxAxis} ${plural}.`);
    }
    if (labels.some((label) => !label.trim())) {
      messages.push(`every ${noun} needs a label.`);
    }
    if (labels.some((label) => label.trim().length > MATRIX_LIMITS.labelMax)) {
      messages.push(
        `a ${noun} label is longer than ${MATRIX_LIMITS.labelMax} characters.`,
      );
    }
    const seen = new Set<string>();
    for (const label of labels) {
      const key = label.trim().toLowerCase();
      if (key && seen.has(key)) {
        messages.push(`two ${plural} share the label "${label.trim()}".`);
        break;
      }
      seen.add(key);
    }
  };

  axis(matrix.rows, 'row');
  axis(matrix.columns, 'column');

  if (!matrix.rowLabel.trim()) {
    messages.push('name what the rows measure.');
  }
  if (!matrix.columnLabel.trim()) {
    messages.push('name what the columns measure.');
  }
  if (matrix.rows.length * matrix.columns.length > MATRIX_LIMITS.maxCells) {
    messages.push(`the grid may have at most ${MATRIX_LIMITS.maxCells} cells.`);
  }

  const emptyCell = matrix.cells.some(
    (row, rowIndex) =>
      row.length !== matrix.columns.length ||
      row.some((cell) => !cell.trim()) ||
      rowIndex >= matrix.rows.length,
  );
  if (emptyCell || matrix.cells.length !== matrix.rows.length) {
    messages.push('give every cell of the grid an outcome.');
  }
  if (
    matrix.cells.some((row) =>
      row.some((cell) => cell.trim().length > MATRIX_LIMITS.labelMax),
    )
  ) {
    messages.push(
      `a cell outcome is longer than ${MATRIX_LIMITS.labelMax} characters.`,
    );
  }
  if (
    Object.values(matrix.definitions ?? {}).some(
      (text) => text.trim().length > MATRIX_LIMITS.definitionMax,
    )
  ) {
    messages.push(
      `a definition is longer than ${MATRIX_LIMITS.definitionMax} characters.`,
    );
  }

  return messages;
}

export function validateTemplate(
  template: Template,
  paragraphs: Record<string, StandardParagraph> | null | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!template.name.trim()) {
    issues.push({
      message: 'Give the template a name.',
      anchorId: 'builder-template-name',
    });
  }

  const seenIds = new Map<string, string>();

  template.sections.forEach((section, sectionIndex) => {
    const sectionLabel = section.title.trim() || `Section ${sectionIndex + 1}`;
    const anchorId = sectionAnchor(section.id);

    if (!section.code.trim()) {
      issues.push({ message: `${sectionLabel}: enter a section code.`, anchorId });
    }
    if (!section.title.trim()) {
      issues.push({
        message: `Section ${sectionIndex + 1}: enter a section title.`,
        anchorId,
      });
    }
    if (section.questions.length === 0) {
      issues.push({
        message: `${sectionLabel}: add at least one question.`,
        anchorId,
      });
    }
    if (seenIds.has(section.id)) {
      issues.push({
        message: `${sectionLabel}: duplicate id "${section.id}" (also used by ${seenIds.get(section.id)}).`,
        anchorId,
      });
    } else {
      seenIds.set(section.id, sectionLabel);
    }

    section.questions.forEach((question, questionIndex) => {
      const questionLabel = `${sectionLabel}, question ${questionIndex + 1}`;
      const questionAnchorId = questionAnchor(question.id);

      if (!question.text.trim()) {
        issues.push({
          message: `${questionLabel}: enter the question text.`,
          anchorId: questionAnchorId,
          questionId: question.id,
        });
      }
      if (hasOptions(question.type)) {
        const options = (question.options ?? []).filter((option) => option.trim());
        if (options.length === 0) {
          issues.push({
            message: `${questionLabel}: a choice question needs at least one option.`,
            anchorId: questionAnchorId,
            questionId: question.id,
          });
        }
      }
      if (hasMatrix(question.type)) {
        for (const message of matrixIssues(question.matrix)) {
          issues.push({
            message: `${questionLabel}: ${message}`,
            anchorId: questionAnchorId,
            questionId: question.id,
          });
        }
      }
      if (seenIds.has(question.id)) {
        issues.push({
          message: `${questionLabel}: duplicate id "${question.id}" (also used by ${seenIds.get(question.id)}).`,
          anchorId: questionAnchorId,
          questionId: question.id,
        });
      } else {
        seenIds.set(question.id, questionLabel);
      }
      // `paragraphs` is the ORGANISATION's node alone, so this must resolve
      // through the shared helper rather than index it: a reference to one of
      // the paragraphs Safentia ships lives in code, not in that node, and a
      // bare lookup would report every built-in reference as a dangling one.
      if (
        question.standardParagraphRef &&
        !resolveParagraph(question.standardParagraphRef, paragraphs)
      ) {
        issues.push({
          message: `${questionLabel}: the referenced standard paragraph no longer exists.`,
          anchorId: questionAnchorId,
          questionId: question.id,
        });
      }
    });
  });

  return issues;
}

// ----------------------------------------------------------------------------
// Summary counts for the aside.
// ----------------------------------------------------------------------------

export interface TemplateCounts {
  sections: number;
  questions: number;
  byType: Partial<Record<QuestionType, number>>;
}

export function countTemplate(template: Template): TemplateCounts {
  const byType: Partial<Record<QuestionType, number>> = {};
  let questions = 0;
  for (const section of template.sections) {
    for (const question of section.questions) {
      questions += 1;
      byType[question.type] = (byType[question.type] ?? 0) + 1;
    }
  }
  return { sections: template.sections.length, questions, byType };
}
