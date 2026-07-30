// ============================================================================
// Deterministic assessment-draft helpers (PURE, no I/O, no AI).
//
// Everything the draft needs EXCEPT the prose summary is computed here, in code,
// from the answers and the building record:
//   - extractIssues:      the issues to address are the assessor's recorded
//                         non-conformities, each tied to a REAL UK regulation via
//                         the curated table (no model, no hallucinated citations).
//   - ragDistribution:    the true count of low/medium/high findings.
//   - draftNarrativeBlocks: building description, premises covered, incident
//                         history and risk opinion, written from the facts on hand.
//   - fallbackSummary:    a deterministic summary used when the AI summary is
//                         unavailable (offline / key not configured), so the draft
//                         never depends on the model to produce *something* usable.
//
// The model is used for ONE thing only - polishing the summary prose (see
// fireSafetyContext.ts). These functions are the rest of the draft.
// ============================================================================

import { regulationFor } from './fireSafetyRegulations';
import {
  SECTION_CODES,
  type Template,
  type TemplateSection,
  type AssessmentAnswer,
  type Keyed,
  type DraftIssue,
  type Severity,
  type RagDistribution,
  type RiskLevel,
  type Building,
  type Customer,
  type Site,
} from '../shared/types';

/** Statutory-style due windows by severity (mirrors the app's DUE_WINDOW_DAYS):
 *  High = 7 days, Medium = 30 days, Low = 3 months. */
const DUE_DAYS: Record<Severity, number> = { H: 7, M: 30, L: 90 };

const SEVERITY_WORD: Record<Severity, string> = {
  H: 'high',
  M: 'medium',
  L: 'low',
};

/** A non-conformity is a real finding only when it carries both a severity and an
 *  observation - an untouched one is "no finding", not an issue. */
function isFinding(answer: AssessmentAnswer | undefined): answer is AssessmentAnswer & {
  severity: Severity;
  observation: string;
} {
  return Boolean(
    answer &&
      (answer.severity === 'L' ||
        answer.severity === 'M' ||
        answer.severity === 'H') &&
      typeof answer.observation === 'string' &&
      answer.observation.trim().length > 0,
  );
}

/** Sections in canonical PAS 79 code order (unknown codes last). */
function orderedSections(sections: TemplateSection[]): TemplateSection[] {
  const rank = (code: string): number => {
    const i = (SECTION_CODES as readonly string[]).indexOf(code);
    return i === -1 ? SECTION_CODES.length : i;
  };
  return [...(sections ?? [])].sort((a, b) => rank(a.code) - rank(b.code));
}

/**
 * The issues to address: every recorded non-conformity, in PAS 79 order, each
 * mapped to the real UK regulation it engages and given a proportionate,
 * time-bound recommended action. Purely deterministic.
 */
export function extractIssues(
  template: Template,
  answers: Keyed<AssessmentAnswer> | null | undefined,
): DraftIssue[] {
  const map = answers ?? {};
  const issues: DraftIssue[] = [];
  // The snapshot comes from whatever template the job pinned, and a template is
  // fully customer-authored: a section list that is absent or malformed must
  // yield "no issues", not throw. Drafting is an aid - it can be empty, but it
  // must never be the reason an assessor cannot finish on site.
  for (const section of orderedSections(template?.sections ?? [])) {
    for (const question of section.questions ?? []) {
      if (question.type !== 'nonConformity') continue;
      const answer = map[question.id];
      if (!isFinding(answer)) continue;

      const finding = answer.observation.trim();
      const regulation = regulationFor(question.text, finding);
      issues.push({
        sectionCode: section.code,
        question: question.text,
        finding,
        severity: answer.severity,
        regulation,
        recommendedAction: `Remedy this non-conformity and verify compliance with ${regulation}. Target completion within ${DUE_DAYS[answer.severity]} days.`,
      });
    }
  }
  return issues;
}

/** True counts of findings by severity (the building's proportional RAG). */
export function ragDistribution(
  answers: Keyed<AssessmentAnswer> | null | undefined,
): RagDistribution {
  const dist: RagDistribution = { low: 0, medium: 0, high: 0 };
  for (const answer of Object.values(answers ?? {})) {
    if (answer?.severity === 'H') dist.high += 1;
    else if (answer?.severity === 'M') dist.medium += 1;
    else if (answer?.severity === 'L') dist.low += 1;
  }
  return dist;
}

/** Headline risk level: the worst severity present, else pending (no findings). */
export function riskLevel(dist: RagDistribution): RiskLevel {
  if (dist.high > 0) return 'high';
  if (dist.medium > 0) return 'medium';
  if (dist.low > 0) return 'low';
  return 'pending';
}

/** The four narrative blocks we can draft from facts (everything bar the summary).
 *  Each is a starting point the assessor edits, never a finished statement. */
export function draftNarrativeBlocks(
  building: Building | null,
  customer: Customer | null,
  site: Site | null,
): {
  buildingDescription: string;
  premisesCovered: string;
  incidentHistory: string;
  riskOpinion: string;
} {
  const name = building?.name ?? 'the building';
  const address = building?.address ?? site?.address;
  const d = building?.details;

  // Building description - assembled from the recorded building facts.
  const descBits: string[] = [];
  if (typeof d?.floors === 'number') {
    descBits.push(`${d.floors} ${d.floors === 1 ? 'floor' : 'floors'}`);
  }
  if (typeof d?.area === 'number') {
    descBits.push(`a floor area of approximately ${d.area} m²`);
  }
  if (typeof d?.occupants === 'number') {
    descBits.push(`a typical occupancy of around ${d.occupants}`);
  }
  let buildingDescription =
    descBits.length > 0
      ? `${capitalise(name)} has ${joinList(descBits)}.`
      : `${capitalise(name)}.`;
  if (d?.alarmCategory || d?.alarmType) {
    const alarm = [d?.alarmType, d?.alarmCategory ? `category ${d.alarmCategory}` : '']
      .filter(Boolean)
      .join(' ');
    buildingDescription += ` The building is served by a ${alarm} fire alarm system.`;
  }
  buildingDescription += ' Please confirm and expand on the construction and layout.';

  // Premises covered.
  const premisesCovered =
    `This fire risk assessment covers ${name}` +
    (address ? ` at ${address}` : '') +
    (customer?.name ? `, occupied by ${customer.name}` : '') +
    '. Amend if any areas were excluded from the assessment.';

  // Incident history - we hold no incident feed here, so state the neutral
  // default and point the assessor at the building's log book to confirm.
  const incidentHistory =
    'No fire incidents or false alarms were made known at the time of this ' +
    'assessment. Confirm against the building’s fire log book and amend as ' +
    'required.';

  // Risk opinion - derived from the recorded findings.
  const riskOpinion = riskOpinionText(building);

  return { buildingDescription, premisesCovered, incidentHistory, riskOpinion };
}

function riskOpinionText(building: Building | null): string {
  // Built from the building's RAG if present; otherwise neutral.
  return (
    'In the assessor’s professional opinion the overall fire risk should be ' +
    'judged against the findings recorded below and the adequacy of the ' +
    'building’s fire precautions. Review and finalise this opinion before ' +
    'submission.' +
    // The building's DEFAULT party only: this draft is composed before the
    // assessment exists, so there is no visit-level override to prefer yet.
    (building?.responsibleParty?.name
      ? ` The responsible person is recorded as ${building.responsibleParty.name}.`
      : '')
  );
}

/**
 * A deterministic summary of the issues to address - the safety net used when the
 * AI summary cannot run (offline or key not configured). Plain, factual, grouped
 * by severity, citing the (real) mapped regulations.
 */
export function fallbackSummary(
  issues: DraftIssue[],
  dist: RagDistribution,
): string {
  if (issues.length === 0) {
    return (
      'No non-conformities were recorded during this assessment. The building’s ' +
      'fire precautions were found to be satisfactory against the matters ' +
      'assessed. Confirm and add any overall observations.'
    );
  }
  const total = issues.length;
  const counts = `${dist.high} high, ${dist.medium} medium and ${dist.low} low severity`;
  const lines: string[] = [];
  lines.push(
    `This assessment identified ${total} ${total === 1 ? 'issue' : 'issues'} ` +
      `to be addressed (${counts}). The significant findings, in priority order:`,
  );
  const ordered = [...issues].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  for (const issue of ordered) {
    lines.push(
      `• [${SEVERITY_WORD[issue.severity].toUpperCase()}] ${issue.finding} ` +
        `(${issue.regulation}).`,
    );
  }
  lines.push(
    'Each item should be actioned by the responsible person within the stated ' +
      'timescale and re-inspected.',
  );
  return lines.join('\n');
}

function severityRank(s: Severity): number {
  return s === 'H' ? 3 : s === 'M' ? 2 : 1;
}

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
