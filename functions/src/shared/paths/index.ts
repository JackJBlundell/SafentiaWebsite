// ============================================================================
// Safentia path builders - the ONLY legal way to address RTDB and Storage.
//
// Brief 4.2 / 6 / 14: no hand-typed path strings anywhere in app or Function
// code. Every read and write goes through these builders so a schema move is a
// one-file change, and so the `/live` vs `/test` environment root (brief 4.8) is
// applied transparently and can never be hard-coded or forgotten by a caller.
//
// ARCHITECTURE NOTE: like the types contract, this file has NO shared package.
// It is mirrored identically into:
//   - Safentia/src/paths/index.ts                         (mobile app)
//   - fireritesite/functions/src/shared/paths/index.ts    (Cloud Functions)
// Change one, change the other in the same change set (see SCHEMA_CHANGES.md).
//
// Environment model (brief 4.8): tenant data lives under a sibling root per
// environment - `/live/...` for production users, `/test/...` for test users -
// while `/platform` stays global. The root segment names `live` / `test` are the
// chosen implementation of "two sibling roots, identical shape" and are recorded
// in SCHEMA_CHANGES.md. A caller never writes the root itself: they call
// `forEnv(env)` once (env comes from the user's claim) and use the returned
// builders, so addressing the wrong environment is impossible by construction.
// ============================================================================

import type {
  Environment,
  DocumentCategory,
  ReportScope,
} from '../types';

/** All RTDB paths are plain strings; this alias documents intent at call sites. */
export type RtdbPath = string;
/** All Storage object paths are plain strings; aliased for the same reason. */
export type StoragePath = string;

// ----------------------------------------------------------------------------
// Internal join helper: trims accidental slashes so builders can be composed
// without producing `//` or trailing separators (which RTDB treats as distinct
// keys and would silently fragment data).
// ----------------------------------------------------------------------------
function join(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter((s) => s.length > 0)
    .join('/');
}

// ----------------------------------------------------------------------------
// Global (NOT environment-scoped) - brief 6 `/platform`.
// ----------------------------------------------------------------------------
export const platform = {
  root: (): RtdbPath => 'platform',
  stats: (date: string): RtdbPath => join('platform', 'stats', date),
  superAdmins: (): RtdbPath => join('platform', 'superAdmins'),
  superAdmin: (uid: string): RtdbPath => join('platform', 'superAdmins', uid),
  plans: (): RtdbPath => join('platform', 'plans'),
  plan: (planId: string): RtdbPath => join('platform', 'plans', planId),
  /** Publicly-readable client config (force-update gate, story 1080). */
  clientConfig: (): RtdbPath => join('platform', 'clientConfig'),
  /** Admin-editable AI context (regulatory source-of-truth for the assessment
   *  summary writer). Global and not env-scoped: the regulations are universal.
   *  Read server-side only; never exposed to the app. */
  aiContext: (): RtdbPath => join('platform', 'aiContext'),
  /** Register-interest leads from the public site (registerInterest callable).
   *  Platform-global, not env-scoped: a lead pre-dates any tenant, so there is
   *  no organisation or environment to scope it to. Server-only; rules deny all
   *  client access. */
  leads: (): RtdbPath => join('platform', 'leads'),
  lead: (leadId: string): RtdbPath => join('platform', 'leads', leadId),
} as const;

// ----------------------------------------------------------------------------
// RTDB builders for a given environment. Every path is prefixed with the env
// root so a `test` user can only ever construct `/test/...` paths and a `live`
// user only `/live/...`. The rules layer enforces the same boundary (brief 4.8);
// these builders make the correct path the only one a caller can express.
// ----------------------------------------------------------------------------
function rtdbFor(env: Environment) {
  const root = (...segments: string[]): RtdbPath => join(env, ...segments);

  return {
    /** Organisations (brief 6). */
    organisation: (orgId: string) => root('organisations', orgId),
    /** The env-wide organisations root (`{orgId: Organisation}`), for the
     *  super-admin oversight console (FR-E24) - readable ONLY via the
     *  superAdmin rules cascade. ADDITIVE: same mirror note as `buildingsRoot`. */
    organisationsRoot: () => root('organisations'),
    orgProfile: (orgId: string) => root('organisations', orgId, 'profile'),
    /** Org-level configuration (RAG derivation etc.), distinct from profile. */
    orgSettings: (orgId: string) => root('organisations', orgId, 'settings'),
    orgSubscription: (orgId: string) =>
      root('organisations', orgId, 'subscription'),
    orgUsage: (orgId: string) => root('organisations', orgId, 'usage'),

    /** Membership + reverse login index. */
    orgMembers: (orgId: string) => root('orgMembers', orgId),
    orgMember: (orgId: string, uid: string) => root('orgMembers', orgId, uid),
    /** buildingId -> customerId (server-maintained by manageBuilding). Exists so
     *  rules can scope per-building reads (actions, reports) to the owning
     *  customer's portal users without a siteId in hand. */
    buildingCustomerIndex: (orgId: string) => root('buildingCustomerIndex', orgId),
    buildingCustomer: (orgId: string, buildingId: string) =>
      root('buildingCustomerIndex', orgId, buildingId),
    /** Admin-readable invitation summaries (never the token - see types). */
    orgInvitations: (orgId: string) => root('orgInvitations', orgId),
    orgInvitation: (orgId: string, inviteId: string) =>
      root('orgInvitations', orgId, inviteId),
    userOrgs: (uid: string) => root('userOrgs', uid),
    userOrg: (uid: string, orgId: string) => root('userOrgs', uid, orgId),

    /** Customers + customer membership (Phase 2 surfaces; paths now). */
    customers: (orgId: string) => root('customers', orgId),
    customer: (orgId: string, customerId: string) =>
      root('customers', orgId, customerId),
    /** People at a customer organisation (contacts precede portal accounts). */
    customerContacts: (orgId: string, customerId: string) =>
      root('customerContacts', orgId, customerId),
    customerContact: (orgId: string, customerId: string, contactId: string) =>
      root('customerContacts', orgId, customerId, contactId),
    customerMembers: (orgId: string, customerId: string) =>
      root('customerMembers', orgId, customerId),
    customerMember: (orgId: string, customerId: string, uid: string) =>
      root('customerMembers', orgId, customerId, uid),
    customerUserIndex: (uid: string) => root('customerUserIndex', uid),

    /** Sites. */
    sites: (orgId: string, customerId: string) =>
      root('sites', orgId, customerId),
    site: (orgId: string, customerId: string, siteId: string) =>
      root('sites', orgId, customerId, siteId),

    /** Buildings + customer-visibility access index. */
    buildings: (orgId: string, siteId: string) =>
      root('buildings', orgId, siteId),
    /** The org-wide buildings root (`{siteId: {buildingId: Building}}`), for
     *  the dashboard/reporting roll-ups (FR-E19). Rules grant the whole node to
     *  every org member, so one subscription covers the estate. ADDITIVE: the
     *  mirrors (app, Functions) adopt this builder on their next sync; it reads
     *  the same schema, so nothing moves. */
    buildingsRoot: (orgId: string) => root('buildings', orgId),
    building: (orgId: string, siteId: string, buildingId: string) =>
      root('buildings', orgId, siteId, buildingId),
    buildingAccess: (orgId: string, buildingId: string) =>
      root('buildingAccess', orgId, buildingId),
    buildingAccessUser: (orgId: string, buildingId: string, uid: string) =>
      root('buildingAccess', orgId, buildingId, uid),

    /** Floor plans (optional per building). */
    floorPlans: (orgId: string, buildingId: string) =>
      root('floorPlans', orgId, buildingId),
    floorPlan: (orgId: string, buildingId: string, planId: string) =>
      root('floorPlans', orgId, buildingId, planId),

    /** Templates (published versions immutable - enforced by rules). */
    /** Work-in-progress template drafts (admin-writable; see publishTemplate). */
    templateDrafts: (orgId: string) => root('templateDrafts', orgId),
    templateDraft: (orgId: string, templateId: string) =>
      root('templateDrafts', orgId, templateId),
    /** Frozen copies of every published version (story 2053; server-only writes). */
    templateVersions: (orgId: string, templateId: string) =>
      root('templateVersions', orgId, templateId),
    templateVersion: (orgId: string, templateId: string, version: number) =>
      root('templateVersions', orgId, templateId, String(version)),
    /** The organisation's Standard Paragraphs library (FR-E21). */
    standardParagraphs: (orgId: string) => root('standardParagraphs', orgId),
    standardParagraph: (orgId: string, paragraphId: string) =>
      root('standardParagraphs', orgId, paragraphId),
    templates: (orgId: string) => root('templates', orgId),
    template: (orgId: string, templateId: string) =>
      root('templates', orgId, templateId),

    /** Jobs + the assessor reverse index. */
    jobs: (orgId: string) => root('jobs', orgId),
    job: (orgId: string, jobId: string) => root('jobs', orgId, jobId),
    assessorJobs: (orgId: string, assessorUid: string) =>
      root('assessorJobs', orgId, assessorUid),
    assessorJob: (orgId: string, assessorUid: string, jobId: string) =>
      root('assessorJobs', orgId, assessorUid, jobId),

    /** Assessments + per-question answers. */
    assessments: (orgId: string) => root('assessments', orgId),
    assessment: (orgId: string, assessmentId: string) =>
      root('assessments', orgId, assessmentId),
    assessmentStatus: (orgId: string, assessmentId: string) =>
      root('assessments', orgId, assessmentId, 'status'),
    assessmentAnswers: (orgId: string, assessmentId: string) =>
      root('assessmentAnswers', orgId, assessmentId),
    assessmentAnswer: (orgId: string, assessmentId: string, questionId: string) =>
      root('assessmentAnswers', orgId, assessmentId, questionId),

    /** Actions / action plan (keyed by building). */
    actions: (orgId: string, buildingId: string) =>
      root('actions', orgId, buildingId),
    /** The org-wide actions root (`{buildingId: {actionId: Action}}`), for the
     *  dashboard/reporting roll-ups (FR-E19). One subscription instead of a
     *  per-building fan-out; same additive-mirror note as `buildingsRoot`. */
    actionsRoot: (orgId: string) => root('actions', orgId),
    action: (orgId: string, buildingId: string, actionId: string) =>
      root('actions', orgId, buildingId, actionId),

    /** Documents (keyed by building then category). */
    documents: (orgId: string, buildingId: string, category: DocumentCategory) =>
      root('documents', orgId, buildingId, category),
    document: (
      orgId: string,
      buildingId: string,
      category: DocumentCategory,
      docId: string,
    ) => root('documents', orgId, buildingId, category, docId),

    /** Log book (app writes only this phase; append-only by rules). */
    logBook: (orgId: string, buildingId: string) =>
      root('logBook', orgId, buildingId),
    logBookEntry: (orgId: string, buildingId: string, entryId: string) =>
      root('logBook', orgId, buildingId, entryId),

    /** Reports (scoped by building / site / customer). */
    reports: (orgId: string, scope: ReportScope, scopeId: string) =>
      root('reports', orgId, scope, scopeId),
    report: (orgId: string, scope: ReportScope, scopeId: string, reportId: string) =>
      root('reports', orgId, scope, scopeId, reportId),

    /** Per-user notifications. */
    notifications: (uid: string) => root('notifications', uid),
    notification: (uid: string, notifId: string) =>
      root('notifications', uid, notifId),

    /** Notification ledger (quota accounting; Phase 3 enforces). */
    notificationLedger: (orgId: string, yyyyMm: string) =>
      root('notificationLedger', orgId, yyyyMm),

    /** Activity stream (append-only by rules). */
    activity: (orgId: string) => root('activity', orgId),
    activityEntry: (orgId: string, logId: string) =>
      root('activity', orgId, logId),

    /** Per-org email send log (trackable emails). Appended server-side by the
     *  email seam (lib/email) with recipients REDACTED (PII minimisation);
     *  admin-only read, never client-writable. */
    emailLog: (orgId: string) => root('emailLog', orgId),
    emailLogEntry: (orgId: string, entryId: string) =>
      root('emailLog', orgId, entryId),

    /** Invitations (token-accepted; env carried on the invite link). */
    invitations: () => root('invitations'),
    invitation: (inviteId: string) => root('invitations', inviteId),
  } as const;
}

// ----------------------------------------------------------------------------
// Storage builders for a given environment. Layout mirrors RTDB tenancy AND the
// environment root (brief 4.3 / 4.8): `{env}/orgs/{orgId}/...`. Storage rules
// enforce the same boundary; these builders make the correct object path the
// only one a caller can express.
// ----------------------------------------------------------------------------
function storageFor(env: Environment) {
  const org = (orgId: string, ...rest: string[]): StoragePath =>
    join(env, 'orgs', orgId, ...rest);
  const buildingRoot = (orgId: string, buildingId: string, ...rest: string[]) =>
    org(orgId, 'buildings', buildingId, ...rest);

  return {
    /** Assessment photo (compressed on device before upload). */
    photo: (orgId: string, buildingId: string, photoId: string): StoragePath =>
      buildingRoot(orgId, buildingId, 'photos', photoId),
    /** Floor-plan source image. */
    floorPlan: (orgId: string, buildingId: string, planId: string): StoragePath =>
      buildingRoot(orgId, buildingId, 'floorPlans', planId),
    /** Flag composite (floor plan flattened with R/A/G pins - brief 8). */
    flagComposite: (orgId: string, buildingId: string, flagId: string): StoragePath =>
      buildingRoot(orgId, buildingId, 'flags', flagId),
    /** Uploaded document, grouped by category. */
    document: (
      orgId: string,
      buildingId: string,
      category: DocumentCategory,
      docId: string,
    ): StoragePath => buildingRoot(orgId, buildingId, 'documents', category, docId),
    /** Organisation-level asset (the whitelabel logo). Its own location rather
     *  than a contrived buildingId, so Storage rules can bound it as an image
     *  and tenant-URL validation reads naturally. */
    orgAsset: (orgId: string, assetId: string): StoragePath =>
      org(orgId, 'assets', assetId),
    /** Generated report PDF. */
    report: (orgId: string, reportId: string): StoragePath =>
      org(orgId, 'reports', `${reportId}.pdf`),
  } as const;
}

// ----------------------------------------------------------------------------
// Public factory. Resolve the environment ONCE from the signed-in user's claim,
// call `forEnv(env)`, and use `.db` / `.storage` everywhere thereafter.
// ----------------------------------------------------------------------------
export interface EnvPaths {
  env: Environment;
  db: ReturnType<typeof rtdbFor>;
  storage: ReturnType<typeof storageFor>;
}

export function forEnv(env: Environment): EnvPaths {
  return Object.freeze({
    env,
    db: rtdbFor(env),
    storage: storageFor(env),
  });
}

/** Convenience: derive the environment from a `testMode` claim value. Kept here
 *  so the "testMode -> which root" rule is stated exactly once. */
export function envFromTestMode(testMode: boolean | undefined): Environment {
  return testMode ? 'test' : 'live';
}
