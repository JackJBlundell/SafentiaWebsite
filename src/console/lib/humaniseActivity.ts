// ============================================================================
// humaniseActivity - plain-English phrasing for /activity audit codes.
//
// The Functions write machine-vocabulary action codes ("customer.created",
// "assessment.stage.released", "member.updated (roles)") to the audit trail;
// this module is the ONE place those codes become sentences, so the dashboard
// feeds and the activity log cannot phrase the same event differently.
//
// The map below is exhaustive over every write site in functions/src (grep
// `action:` under functions/src/functions and functions/src/report). Codes may
// carry a parenthesised detail suffix - "document.created (insurance)",
// "member.updated (roles, name)" - which is split off and surfaced separately
// so the phrase stays a phrase. A code this map has never seen still renders
// honestly: dots and camelCase become spaces, nothing is guessed at.
//
// Phrases are lowercase verb phrases by design: feeds compose them after the
// actor's name ("Jane Doe released an assessment"); table cells that show the
// phrase alone use sentenceCase().
// ============================================================================

/** The customer directory route; kept in step with urls.customer in
 *  src/console/customers/shared.tsx (the router truth for /app/customers). */
const CUSTOMER_URL = (customerId: string) => `/app/customers/${customerId}`;

/** The job detail route (JobsRoutes mounts ":jobId" under /app/jobs). */
const JOB_URL = (jobId: string) => `/app/jobs/${jobId}`;

/** Exhaustive over the static action codes the Functions write. Dynamic
 *  families (assessment.stage.*) are handled below the map. */
const PHRASES: Record<string, string> = {
  'organisation.created': 'created the organisation',
  'customer.created': 'created a customer',
  'customer.updated': 'updated a customer',
  'customer.archived': 'archived a customer',
  'customer.restored': 'restored a customer',
  'customerContact.created': 'added a customer contact',
  'customerContact.updated': 'updated a customer contact',
  'customerContact.removed': 'removed a customer contact',
  // Written by the portalInviteTeammate callable. The actor is a customer-portal
  // admin rather than a staff member, which the feed already handles: an unknown
  // uid renders as the plain actor. Distinct from customerContact.created so the
  // org can tell a self-service portal invite from a staff-added contact.
  'customerContact.invited': 'invited a colleague to the portal',
  'site.created': 'created a site',
  'site.updated': 'updated a site',
  'building.created': 'created a building',
  'building.updated': 'updated a building',
  'building.serviceSchedule updated': "updated a building's service schedule",
  'document.created': 'uploaded a building document',
  'document.removed': 'removed a building document',
  'floorPlan.created': 'added a floor plan',
  'floorPlan.updated': 'updated a floor plan',
  'floorPlan.removed': 'removed a floor plan',
  'action.created': 'raised an action item',
  'action.updated': 'updated an action item',
  'action.signedOff': 'signed off an action item',
  'action.reopened': 'reopened an action item',
  'actions.created': 'raised action items',
  'assessment.started': 'started an assessment',
  'assessment.submitted': 'submitted an assessment',
  'assessment.accepted': 'accepted an assessment',
  'assessment.released': 'released an assessment',
  'assessment.infoRequested': 'requested more information on an assessment',
  'job.cancelled': 'cancelled a job',
  'job.rescheduled': 'rescheduled a job',
  'invitation.resent': 'resent an invitation',
  'invitation.revoked': 'revoked an invitation',
  'member.updated': 'updated a staff member',
  'orgProfile.updated': 'updated the organisation profile',
  'orgSettings.ragConfig.updated': 'updated the risk-banding settings',
  'template.published': 'published a template',
  'report.generated': 'generated an assessment report',
  // Written by the acceptReport callable. The actor is a customer-portal
  // contact rather than a staff member, which the feed already handles: it
  // renders an unknown uid as the plain actor, never a broken staff lookup.
  'report.accepted': 'accepted an assessment report',
  // Written by the recordPlatformAccess callable when a Safentia super admin
  // opens this org's read-only oversight view (story 2069 AC2). The actor is a
  // platform operator, not a member of this org, so the feed renders the unknown
  // uid as the plain actor; the phrase names it honestly as a platform view. The
  // target carries the scope ("organisation", "customer:<id>", "building:<id>").
  'platform.access': 'viewed this organisation as a platform administrator',
};

/** assessment.stage.<status> phrases, keyed by the AssessmentStatus vocabulary
 *  (ASSESSMENT_STAGE_LABELS in the shared types is the client-facing truth). */
const STAGE_PHRASES: Record<string, string> = {
  inProgress: 'moved an assessment back in progress',
  readyForValidation: 'marked an assessment ready for validation',
  infoRequired: 'flagged an assessment as needing more information',
  readyForRelease: 'marked an assessment ready for release',
  released: 'released an assessment',
};

export interface HumanisedAction {
  /** Lowercase verb phrase: "released an assessment". */
  phrase: string;
  /** The parenthesised detail the Functions appended, if any: "manual risk:
   *  high", "roles, name", "insurance". Surfaced verbatim - it is audit data. */
  detail?: string;
}

/** Split "code (detail)" into its parts; most codes carry no detail. */
function splitDetail(action: string): { base: string; detail?: string } {
  const match = /^(.*?)\s*\((.*)\)$/.exec(action);
  if (!match) {
    return { base: action };
  }
  return { base: match[1], detail: match[2] };
}

/** Fallback for a code the map has never seen: dots and camelCase become
 *  spaces, nothing is guessed at ("widgetGroup.frobbed" -> "widget group
 *  frobbed"). */
function fallbackPhrase(base: string): string {
  return base
    .split('.')
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

export function humaniseAction(action: string): HumanisedAction {
  const { base, detail } = splitDetail(action);

  const mapped = PHRASES[base];
  if (mapped) {
    return detail === undefined ? { phrase: mapped } : { phrase: mapped, detail };
  }

  const stageMatch = /^assessment\.stage\.(.+)$/.exec(base);
  if (stageMatch) {
    const stage = stageMatch[1];
    const phrase =
      STAGE_PHRASES[stage] ??
      `moved an assessment to ${fallbackPhrase(stage)}`;
    return detail === undefined ? { phrase } : { phrase, detail };
  }

  const phrase = fallbackPhrase(base);
  return detail === undefined ? { phrase } : { phrase, detail };
}

/** "released an assessment" -> "Released an assessment", for table cells that
 *  show the phrase without an actor in front of it. */
export function sentenceCase(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** True for every release audit line, INCLUDING the manual-risk variant
 *  releaseAssessment writes ("assessment.released (manual risk: high)") - an
 *  exact-match filter would silently drop manually banded releases. */
export function isReleaseAction(action: string): boolean {
  return splitDetail(action).base === 'assessment.released';
}

/** The console URL for an activity target, where one can be derived reliably
 *  from the entry alone. Only two families qualify:
 *    - customer.* targets a customerId, and /app/customers/:customerId exists
 *      for every org role (archived customers keep their detail page);
 *    - job.* targets a jobId, and /app/jobs/:jobId exists for every org role.
 *  Site and building targets need ancestor ids the entry does not carry, and
 *  released assessments have no console view yet, so those stay text rather
 *  than dead links. Template routes are admin-gated, so they stay text too. */
export function activityTargetUrl(
  action: string,
  target: string,
): string | undefined {
  if (!target) {
    return undefined;
  }
  const { base } = splitDetail(action);
  if (base.startsWith('customer.')) {
    return CUSTOMER_URL(target);
  }
  if (base.startsWith('job.')) {
    return JOB_URL(target);
  }
  return undefined;
}
