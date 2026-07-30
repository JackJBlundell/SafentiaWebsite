// ============================================================================
// AI summary: grounding context + guardrails (the ONLY place the model is used).
//
// The model writes ONE thing - the prose summary of the issues to be addressed.
// It is NOT asked to find issues, decide severities, or pick regulations: those
// are produced deterministically (assessmentDraft.ts + fireSafetyRegulations.ts)
// and handed to it as fixed facts. Its job is to synthesise them into a clear,
// professional, regulation-aware summary an assessor will review and edit.
//
// SYNTHESIS, NOT ENUMERATION. The first version of this prompt closed by asking
// for "the significant findings in priority order, each with the regulation it
// engages", and the model did exactly that - it walked every finding and
// reproduced the action plan in prose, which is not a summary and is not what
// the reader of a summary wants. Section 3 of the report ALREADY carries the
// itemised schedule (every finding with its severity, regulation and due date),
// so the summary's whole job is the judgement on top: what is the shape of the
// risk here. The prompt now names only the high-severity matters (max three),
// covers the rest by theme, and caps the whole thing at 180 words. The
// deterministic fallbackSummary was changed to the same shape, so which path ran
// does not show in the finished report.
//
// Guardrails (deliberately strict, because this is a safety-critical document):
//   - Use ONLY the findings and the regulations provided. Introduce no new
//     findings; cite no regulation that is not in the list given.
//   - Do not overstate severity or imply legal certification - this is a draft
//     for a competent assessor, who remains the author and decision-maker.
//   - British English, professional, proportionate, written for a building owner.
//   - Plain prose only (no markdown, no JSON, no headings, no bullets).
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
    'YOUR TASK: write the EXECUTIVE SUMMARY of this assessment - a short piece of',
    'prose that tells the responsible person what the overall fire risk position at',
    'this building is and what it turns on, based ONLY on the findings provided.',
    '',
    'THIS IS A SUMMARY, NOT A LIST. The report already contains the complete,',
    'itemised schedule of every finding with its severity, regulation and due date',
    '(Section 3, the action plan). Restating those items one by one here adds',
    'nothing and buries the judgement the reader actually needs from you. Synthesise',
    'instead: what is the shape of the risk at this building?',
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
    '5. LENGTH: at most 180 words, in one or two paragraphs. This is a hard ceiling.',
    '6. Do NOT enumerate the findings. Name specifically only the HIGH severity',
    '   matters, and at most three of them, because those are what drive the',
    '   immediate remedial priority. Cover everything else by THEME in a clause or',
    '   two ("a number of medium-severity matters concerning compartmentation and',
    '   signage"), never item by item. If there are no high-severity findings, say',
    '   so plainly and characterise what was found instead.',
    '7. Cite regulations sparingly - only where one materially frames a matter you',
    '   have named. Do not attach a citation to every sentence.',
    '8. British English. Professional, proportionate, and written for a building',
    '   owner rather than a specialist. No alarmist or absolute language.',
    '9. Output PLAIN PROSE ONLY - no markdown, no headings, no bullet points or',
    '   bullet characters anywhere, no numbered lists, no JSON, and no preamble such',
    '   as "Here is the summary".',
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

  // The findings are handed over as EVIDENCE to reason from, not as a running
  // order to transcribe - the label says so, because a bare numbered list
  // invites the model to walk it item by item and produce the action plan again
  // rather than a summary of it.
  lines.push(
    'EVIDENCE - the findings recorded at this building. Draw on these and nothing',
    'else, and cite no regulation that does not appear here. This is the material',
    'you are summarising, NOT an order of service to work through:',
  );
  issues.forEach((issue, i) => {
    lines.push('');
    lines.push(`${i + 1}. [${SEVERITY_WORD[issue.severity]}] (PAS 79 section ${issue.sectionCode})`);
    lines.push(`   Question: ${issue.question}`);
    lines.push(`   Finding: ${issue.finding}`);
    lines.push(`   Regulation engaged: ${issue.regulation}`);
  });
  lines.push('');
  lines.push(
    'Write the executive summary now, in at most 180 words of plain prose:',
    '- Open with the overall position: how many matters were identified, their',
    '  severity mix, and what that means for the risk at this building.',
    '- Name specifically only the high-severity matters (at most three), with the',
    '  regulation where it materially frames the point.',
    '- Draw the remainder together by theme in a clause or two. Do NOT list them.',
    '- Close with one sentence on remediation: the responsible person actions the',
    '  schedule in Section 3 within the stated timescales, and the work is',
    '  re-inspected.',
    'Prose only - no bullet points, no numbered lists, no headings.',
  );
  return lines.join('\n');
}
