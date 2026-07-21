// ============================================================================
// builderModel - the template builder's pure core: id minting, normalisation
// of what RTDB hands back, the canonical fingerprint the autosave echo-guard
// compares, the live validation that mirrors the publishTemplate gate, and the
// summary counts the aside renders. Pure functions only, so every rule the
// builder enforces is testable without a DOM.
// ============================================================================

import {
  QUESTION_TYPES,
  type QuestionType,
  type ReportStandard,
  type StandardParagraph,
  type Template,
  type TemplateQuestion,
  type TemplateSection,
} from '../../types';

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
    questions: asArray<TemplateQuestion>(section.questions).map((question) => ({
      ...question,
      id: question.id ?? newId('q'),
      text: question.text ?? '',
      type: (QUESTION_TYPES as readonly string[]).includes(question.type)
        ? question.type
        : 'text',
      ...(hasOptions(question.type)
        ? { options: asArray<string>(question.options) }
        : {}),
    })),
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
      if (seenIds.has(question.id)) {
        issues.push({
          message: `${questionLabel}: duplicate id "${question.id}" (also used by ${seenIds.get(question.id)}).`,
          anchorId: questionAnchorId,
          questionId: question.id,
        });
      } else {
        seenIds.set(question.id, questionLabel);
      }
      if (
        question.standardParagraphRef &&
        !(paragraphs && paragraphs[question.standardParagraphRef])
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
