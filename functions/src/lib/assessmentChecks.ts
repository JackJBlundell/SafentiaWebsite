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
  SEVERITIES,
  type Template,
  type TemplateQuestion,
  type MatrixAnswer,
  type AssessmentAnswer,
  type Building,
  type Keyed,
} from '../shared/types';

// ----------------------------------------------------------------------------
// "Not applicable" - the shared reading of the flag, for every server surface.
//
// `AssessmentAnswer.notApplicable` records that the assessor CONSIDERED an item
// and judged it does not apply to these premises. The app offers it on
// non-conformities and on free-text questions (`text` / `longtext`), so a
// question that wants prose about something the building does not have can be
// closed with a tap rather than an argument in the box. The contract makes it
// mutually exclusive with the answer it replaces - `severity` on a finding,
// typed text on a free-text question (typing clears the flag) - so in
// well-formed data exactly one of them is ever present.
//
// Answers arrive from a client, and a client can be tampered with or can sync a
// record written by an older build, so the server states its PRECEDENCE for the
// contract-violating case where both are set. The rule, applied everywhere:
//
//   - A graded severity ALWAYS wins for anything that reports risk: the action
//     plan, the finding distribution and the report all keep treating such an
//     answer as the finding it is graded as. Suppressing a graded finding
//     because a flag says "not applicable" is the dangerous direction of error
//     on a fire-safety record; creating a visible action for an item somebody
//     also flagged N/A is merely a nuisance somebody can see and correct.
//   - The SUBMISSION GATE is the one exception: there the bare flag satisfies
//     completion, exactly as the app's rule does (see the note on
//     isNotApplicableAnswer). The gate must never be stricter than the app or a
//     legitimate assessment is refused at submit.
// ----------------------------------------------------------------------------

/** True when the answer carries a real L/M/H grade - i.e. it IS a finding. */
export function hasGradedFinding(answer: AssessmentAnswer | undefined): boolean {
  return Boolean(
    answer?.severity && (SEVERITIES as readonly string[]).includes(answer.severity),
  );
}

/**
 * The raw flag, unqualified - the COMPLETION rule.
 *
 * This deliberately mirrors the app's `isNotApplicableAnswer`
 * (FireRite/src/features/assessment/data/completion.ts) exactly - same name on
 * both sides because the two must agree: the app treats an answer as answered
 * when `notApplicable === true`, with no further conditions, so the server
 * accepts it on the same terms. WHICH question types may use it is a separate
 * decision, made once at the call site below. Adding a "and no
 * severity" qualifier here would make the server STRICTER than the app and
 * refuse an assessment the assessor was told was complete - the one failure
 * this pair of rules exists to prevent (brief 18.4 re-validates the app's rules,
 * it does not invent harsher ones).
 */
export function isNotApplicableAnswer(answer: AssessmentAnswer | undefined): boolean {
  return answer?.notApplicable === true;
}

/**
 * The flag as the RISK-REPORTING surfaces read it: not applicable, and not
 * graded. This is the predicate that suppresses actions, finding counts and
 * finding styling, and it is qualified by severity on purpose - see the
 * precedence note above.
 */
export function isEffectiveNotApplicable(
  answer: AssessmentAnswer | undefined,
): boolean {
  return isNotApplicableAnswer(answer) && !hasGradedFinding(answer);
}

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
      // An answer marked "not applicable" is ANSWERED: the assessor considered
      // the item and judged it does not apply to these premises, and that
      // judgement satisfies completion on its own - there is no severity to
      // grade and nothing to describe, so `hasAnswerValue` (which looks for text
      // or a typed value) would otherwise refuse a complete assessment at
      // submit.
      //
      // SCOPED to the four question types the app offers the N/A control on:
      // `nonConformity`; the two free-text types (`text` / `longtext` - a
      // question that wants prose can be one the premises make meaningless, so
      // it carries the same control; see TextInputQuestion); and `photo`, where
      // an item that is not there has nothing to photograph and demanding
      // evidence of it is demanding evidence of nothing (see PhotoQuestion - it
      // exempts BOTH gates below, the answer and the mandatory photo). The scope
      // is the point of this constant, and it cuts both ways:
      //
      //   - Wider than the app would be LOOSER than the app, and would hand a
      //     tampered client a way to submit a required yes/no, select or matrix
      //     question blank by setting one flag.
      //   - Narrower than the app would be STRICTER than the app, and would
      //     refuse at submit every assessment in which an assessor used a
      //     control the app itself offered them - the exact failure this
      //     re-validation exists to prevent (brief 18.4 re-validates the app's
      //     rules, it does not invent harsher ones).
      //
      // The app's twin of this list is `offersNotApplicable` in
      // FireRite/src/features/assessment/data/completion.ts. The two change
      // together or not at all.
      const notApplicableSatisfies =
        (question.type === 'nonConformity' ||
          question.type === 'text' ||
          question.type === 'longtext' ||
          question.type === 'photo') &&
        isNotApplicableAnswer(answer);
      if (
        question.required === true &&
        !hasAnswerValue(answer) &&
        !notApplicableSatisfies
      ) {
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
      //
      // A photo question is gated TWICE - once by the generic answer check above
      // and once here - so the not-applicable exemption has to be applied twice
      // as well, or a question the app counts as complete is refused at submit
      // by the second gate with the first one satisfied. Same flag, same
      // reasoning: there is nothing to photograph at premises where the item does
      // not exist. Photos are still ACCEPTED under the flag (the app keeps
      // offering the camera as evidence for the decision); they are simply no
      // longer demanded.
      if (
        question.type === 'photo' &&
        question.required === true &&
        !hasPhoto(answer) &&
        !notApplicableSatisfies
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
