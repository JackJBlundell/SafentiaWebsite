// ============================================================================
// Assessment-template limit check - Phase 3 billing §6.
//
// The inviteLimits idiom applied to publishTemplate: pure, database-free
// decisions here, the RTDB reads at the call site. What counts against the
// ceiling is deliberate (§6):
//
//   - Only NON-ARCHIVED live templates count. Archiving flips status (the
//     degrade policy never deletes), and an archived template is not a thing
//     the org can run assessments against, so it releases its slot.
//   - Only publishing a NEW template id is a create. Republishing an existing
//     id - however many versions it accrues - edits a template the org already
//     has, and the block-new-creates-only policy (§6.3) must never stop an org
//     from correcting a template it relies on.
// ============================================================================

import { fail } from './errors';
import type { Template } from '../shared/types';

/** What the org currently publishes and what its plan permits, if anything. */
export interface TemplateLimitContext {
  /** Non-archived live templates the org already has. */
  currentTemplateCount: number;
  /** The plan's template ceiling, or undefined when the org has no enforced limit. */
  templateLimit: number | undefined;
  /** The plan's display name, so the refusal can say which plan is full. */
  planName?: string;
}

/**
 * Does this publish create a NEW template? True only when there is no live
 * node for the id yet - a republish bumps an existing template's version and
 * never counts against the limit.
 */
export function isNewTemplatePublish(live: Template | null): boolean {
  return live === null;
}

/**
 * Count the live templates that occupy a plan slot: every non-archived entry
 * under /templates/{orgId}. Read defensively - the node is client-shaped only
 * through this platform's own writes, but a malformed child should not crash
 * a publish, so anything object-shaped without status 'archived' counts.
 */
export function countBillableTemplates(
  templates: Record<string, Template> | null | undefined,
): number {
  if (!templates) {
    return 0;
  }
  return Object.values(templates).filter(
    (template) => template !== null && typeof template === 'object' && template.status !== 'archived',
  ).length;
}

/**
 * Pure decision: is publishing one more NEW template within the org's plan?
 * Unlimited when templateLimit is undefined. Throws the structured
 * 'resource-exhausted' error - rendered by the console as a calm upsell
 * notice - when the limit would be exceeded.
 */
export function assertWithinTemplateLimit(ctx: TemplateLimitContext): void {
  if (ctx.templateLimit === undefined) {
    // No plan limit configured: grandfather behaviour, unlimited.
    return;
  }
  if (ctx.currentTemplateCount + 1 > ctx.templateLimit) {
    throw fail.resourceExhausted(
      ctx.planName
        ? `The ${ctx.planName} plan includes up to ${ctx.templateLimit} assessment templates. To add more, please upgrade your plan or archive a template you no longer use.`
        : 'Your plan has reached its assessment template limit. To add more, please upgrade your plan or archive a template you no longer use.',
      { limit: ctx.templateLimit, current: ctx.currentTemplateCount },
    );
  }
}
