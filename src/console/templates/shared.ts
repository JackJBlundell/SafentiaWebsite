// ============================================================================
// Shared pieces for the Templates area: browser URLs and the readable label
// for each ReportStandard. One definition each so the list, version history
// and builder screens cannot drift apart. RTDB paths still come from
// useAuth().paths.db - these are only the router routes.
// ============================================================================

import type { ReportStandard, Template, TemplateSection } from '../../types';

export const templateUrls = {
  list: '/app/templates',
  builder: (templateId: string) => `/app/templates/builder/${templateId}`,
  versions: (templateId: string) => `/app/templates/${templateId}/versions`,
  paragraphs: '/app/templates/paragraphs',
} as const;

/** Readable label per standard. An untagged template renders under the
 *  generic profile (see ReportStandard in types), so it reads as Custom. */
const STANDARD_LABELS: Record<ReportStandard, string> = {
  pas79: 'PAS 79-1:2020',
  bs9792: 'BS 9792 Housing',
  custom: 'Custom',
};

export function standardLabel(standard: ReportStandard | undefined): string {
  return STANDARD_LABELS[standard ?? 'custom'];
}

/** The system-provided base templates every organisation arrives with. Their
 *  ids are FIXED at seed time (functions/src/seed/ids.ts: PAS79_TEMPLATE_ID
 *  and BS9792_TEMPLATE_ID), which is the only durable marker in the data -
 *  Template itself carries no ownership field, and an org's own copy of a
 *  base template gets a fresh pushed id. Only these ids are badged. */
const BASE_TEMPLATE_IDS = new Set([
  'tmpl-pas79-default',
  'tmpl-bs9792-housing',
]);

export function isBaseTemplate(templateId: string): boolean {
  return BASE_TEMPLATE_IDS.has(templateId);
}

/** Sections plus total questions for a frozen or draft template body. */
export function templateCounts(template: Pick<Template, 'sections'>): {
  sections: number;
  questions: number;
} {
  const sections: TemplateSection[] = template.sections ?? [];
  return {
    sections: sections.length,
    questions: sections.reduce(
      (sum, section) => sum + (section.questions?.length ?? 0),
      0,
    ),
  };
}
