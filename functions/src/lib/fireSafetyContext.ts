// ============================================================================
// AI summary: grounding context + guardrails (the ONLY place the model is used).
//
// The model writes ONE thing - the prose summary of the issues to be addressed.
// It is NOT asked to find issues, decide severities, or pick regulations: those
// are produced deterministically (assessmentDraft.ts + fireSafetyRegulations.ts)
// and handed to it as fixed facts. Its job is to synthesise them into a clear,
// professional, regulation-aware summary an assessor will review and edit.
//
// Guardrails (deliberately strict, because this is a safety-critical document):
//   - Use ONLY the findings and the regulations provided. Introduce no new
//     findings; cite no regulation that is not in the list given.
//   - Do not overstate severity or imply legal certification - this is a draft
//     for a competent assessor, who remains the author and decision-maker.
//   - British English, professional, concise, proportionate.
//   - Plain prose only (no markdown, no JSON, no headings).
// ============================================================================

import { UK_FIRE_SAFETY_FRAMEWORK } from './fireSafetyRegulations';
import type { DraftIssue, RagDistribution, Severity } from '../shared/types';

const SEVERITY_WORD: Record<Severity, string> = {
  H: 'HIGH',
  M: 'MEDIUM',
  L: 'LOW',
};

/**
 * Build the summary writer's system prompt. The regulatory framework is injected
 * from the admin-editable DB context (`/platform/aiContext.regulatoryContext`)
 * when present, so updating the law is a copy-paste with no redeploy; it falls
 * back to the built-in UK framework when the context is empty. Optional house
 * guidance from the same DB record is appended after the strict rules.
 */
export function buildSummarySystemPrompt(
  framework?: string,
  additionalGuidance?: string,
): string {
  const grounding =
    framework && framework.trim().length > 0
      ? framework.trim()
      : UK_FIRE_SAFETY_FRAMEWORK;

  const lines = [
    'You are a chartered UK fire risk assessor drafting the SUMMARY section of a',
    'fire risk assessment carried out to PAS 79-1:2020. You write the summary only;',
    'a competent assessor reviews and edits everything you produce, and remains the',
    'author and decision-maker. This is decision-support drafting, not legal advice',
    'or certification.',
    '',
    'REGULATORY CONTEXT (your source of truth - treat as authoritative):',
    grounding,
    '',
    'YOUR TASK: write a clear, professional summary of the issues that need to be',
    'addressed at this building, based ONLY on the findings provided to you.',
    '',
    'STRICT RULES (a safety-critical document - follow exactly):',
    '1. Use ONLY the findings listed in the user message. Do NOT invent, infer or',
    '   add any finding that is not given to you.',
    '2. Cite ONLY the regulations/standards attached to those findings (and the',
    '   regulatory context above). Do NOT cite any instrument that is not listed,',
    '   and do not fabricate article numbers or British Standard numbers.',
    '3. Reflect the severities as given. Do not upgrade or downgrade them, and do',
    '   not imply a building-wide rating beyond what the findings support.',
    '4. If there are no findings, state that the fire precautions were satisfactory',
    '   against the matters assessed - do not manufacture concerns.',
    '5. British English. Professional, concise, proportionate. Lead with the most',
    '   serious matters. No alarmist or absolute language.',
    '6. Output PLAIN PROSE ONLY - no markdown, no headings, no bullet characters in',
    '   the first sentence, no JSON, no preamble such as "Here is the summary".',
  ];

  if (additionalGuidance && additionalGuidance.trim().length > 0) {
    lines.push('', 'ADDITIONAL HOUSE GUIDANCE:', additionalGuidance.trim());
  }

  return lines.join('\n');
}

/** The user message: the building name plus the deterministic findings (with their
 *  fixed severities and real regulation citations) the model must summarise. */
export function buildSummaryPrompt(
  buildingName: string,
  issues: DraftIssue[],
  dist: RagDistribution,
): string {
  const lines: string[] = [];
  lines.push(`Building: ${buildingName}`);
  lines.push(
    `Findings recorded: ${dist.high} high, ${dist.medium} medium, ${dist.low} low severity.`,
  );
  lines.push('');

  if (issues.length === 0) {
    lines.push(
      'No non-conformities were recorded. Write a brief summary stating that the',
      'fire precautions were found satisfactory against the matters assessed, and',
      'inviting the assessor to add any overall observations.',
    );
    return lines.join('\n');
  }

  lines.push('FINDINGS TO SUMMARISE (use only these; cite only these regulations):');
  issues.forEach((issue, i) => {
    lines.push('');
    lines.push(`${i + 1}. [${SEVERITY_WORD[issue.severity]}] (PAS 79 section ${issue.sectionCode})`);
    lines.push(`   Question: ${issue.question}`);
    lines.push(`   Finding: ${issue.finding}`);
    lines.push(`   Regulation engaged: ${issue.regulation}`);
  });
  lines.push('');
  lines.push(
    'Write the summary now: a short opening sentence stating the number and',
    'severity mix of issues, then the significant findings in priority order',
    '(most serious first), each with the regulation it engages, and a closing',
    'sentence on actioning them. Plain prose only.',
  );
  return lines.join('\n');
}
