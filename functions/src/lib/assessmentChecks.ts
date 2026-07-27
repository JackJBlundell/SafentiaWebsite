// ============================================================================
// Server-side submission completeness checks - story 1049.
//
// The mobile app shows a pre-submission checklist, but the SERVER re-validates the
// same rules so nothing can be submitted incomplete even from a tampered or
// offline-then-synced client (brief 18.4 "trust nothing from the client"). Kept
// pure (no I/O) so every branch is unit-testable deterministically (brief 18.2):
// the caller loads the snapshot + answers and the building, and passes them in.
//
// Three classes of requirement, mirroring the runner (1049 AC):
//   - Required questions answered (template `required` flag).
//   - Mandatory photos present (a question that requires photos must have >=1).
//   - The service-schedule step completed (every statutory service has a nextDue).
// ============================================================================

import {
  SERVICE_SCHEDULE_KEYS,
  type Template,
  type TemplateQuestion,
  type MatrixAnswer,
  type AssessmentAnswer,
  type Building,
  type Keyed,
} from '../shared/types';

/** A single unmet requirement, named so the UI can point the assessor at it. */
export interface MissingItem {
  kind: 'answer' | 'photo' | 'service';
  /** Question id, or the service key for a service gap. */
  ref: string;
  /** Human-readable British-English label for the missing item. */
  label: string;
}

/** True when an answer carries a meaningful response for its question. */
function hasAnswerValue(answer: AssessmentAnswer | undefined): boolean {
  if (!answer) {
    return false;
  }
  if (typeof answer.text === 'string' && answer.text.trim().length > 0) {
    return true;
  }
  if (answer.value === undefined || answer.value === null) {
    // No typed value and no text - unanswered.
    return typeof answer.text === 'string' && answer.text.trim().length > 0;
  }
  // A boolean false is a valid yes/no answer; an empty multiselect array is not.
  if (Array.isArray(answer.value)) {
    return answer.value.length > 0;
  }
  if (typeof answer.value === 'string') {
    return answer.value.trim().length > 0;
  }
  return true;
}

/** Narrow an untyped answer value to the `{ row, column, outcome }` shape. */
function isMatrixAnswer(value: unknown): value is MatrixAnswer {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof MatrixAnswer, unknown>>;
  return (
    typeof candidate.row === 'string' &&
    typeof candidate.column === 'string' &&
    typeof candidate.outcome === 'string'
  );
}

/**
 * Check a matrix answer against the grid it was asked from, returning a
 * plain-English problem or null when it is sound.
 *
 * The client picks a row and a column and the grid yields the outcome, so the
 * outcome is DERIVED, never chosen. We re-derive it from the pinned snapshot
 * here because a tampered or offline-synced client could otherwise record a
 * risk level the estimator never produces - on BS 9792 that is the difference
 * between "Intolerable" and "Trivial" on a regulated form.
 */
function matrixAnswerProblem(
  question: TemplateQuestion,
  value: unknown,
): string | null {
  const grid = question.matrix;
  if (!grid) {
    // A matrix question with no grid cannot yield a valid outcome at all.
    return `Answer cannot be validated: ${question.text}`;
  }
  if (!isMatrixAnswer(value)) {
    return `Answer incomplete: ${question.text}`;
  }
  const rowIndex = grid.rows.indexOf(value.row);
  const columnIndex = grid.columns.indexOf(value.column);
  if (rowIndex < 0 || columnIndex < 0) {
    return `Answer not valid for this question: ${question.text}`;
  }
  if (grid.cells[rowIndex]?.[columnIndex] !== value.outcome) {
    return `Answer does not match the risk grid: ${question.text}`;
  }
  return null;
}

/** True when an answer has at least one photo attached. */
function hasPhoto(answer: AssessmentAnswer | undefined): boolean {
  return Boolean(answer?.photos && answer.photos.length > 0);
}

/**
 * Compute every unmet submission requirement. An empty result means the assessment
 * is complete and may be submitted. The building is needed for the service-schedule
 * check (the statutory dates live on the building, story 1047).
 */
export function findMissingForSubmission(
  template: Template,
  answers: Keyed<AssessmentAnswer> | null | undefined,
  building: Building | null | undefined,
): MissingItem[] {
  const missing: MissingItem[] = [];
  const answerMap = answers ?? {};

  // 1. Required questions + mandatory photos, walking the pinned snapshot so the
  // exact questions the assessment began with are the ones validated.
  for (const section of template.sections ?? []) {
    for (const question of section.questions ?? []) {
      const answer = answerMap[question.id];
      if (question.required === true && !hasAnswerValue(answer)) {
        missing.push({
          kind: 'answer',
          ref: question.id,
          label: `Answer required: ${question.text}`,
        });
      }
      // A matrix answer is only checked once present: an optional matrix left
      // blank is fine, but a PRESENT one must be internally consistent.
      if (question.type === 'matrix' && hasAnswerValue(answer)) {
        const problem = matrixAnswerProblem(question, answer?.value);
        if (problem !== null) {
          missing.push({ kind: 'answer', ref: question.id, label: problem });
        }
      }
      // A question that requires photos (allowsPhotos AND required) must have one.
      // We treat a required photo question as one whose answer must include media.
      if (
        question.type === 'photo' &&
        question.required === true &&
        !hasPhoto(answer)
      ) {
        missing.push({
          kind: 'photo',
          ref: question.id,
          label: `Photo required: ${question.text}`,
        });
      }
    }
  }

  // 2. Service-schedule step: every statutory service must carry a next-due date,
  // since the report's service section depends on it (story 1047 / 1049).
  const schedule = building?.serviceSchedule;
  for (const key of SERVICE_SCHEDULE_KEYS) {
    const item = schedule?.[key];
    if (!item || typeof item.nextDue !== 'number') {
      missing.push({
        kind: 'service',
        ref: key,
        label: `Service schedule incomplete: ${key}`,
      });
    }
  }

  return missing;
}
