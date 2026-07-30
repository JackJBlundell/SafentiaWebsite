// ============================================================================
// Query-key factory - the web twin of FireRite/src/query/keys.ts (CONVENTIONS
// section 2). Kept IDENTICAL to the app's factory on purpose: the console will
// grow into the same domains in later waves, and two diverging key schemes for
// one database is how invalidation bugs start.
//
// One hierarchical key per domain, arrays only, the single source of truth for
// both subscription identity and invalidation. Keys are intentionally aligned
// with the `paths` builders so a screen names "what it wants" the same way it
// addresses it in RTDB. Grouping by a shared prefix (e.g. ['jobs', orgId])
// means invalidating that prefix invalidates every child.
// ============================================================================

import type { DocumentCategory, ReportScope } from '../types';

export const keys = {
  /** The signed-in org's brand/profile (drives whitelabel theming). */
  orgProfile: (orgId: string) => ['orgProfile', orgId] as const,
  orgMember: (orgId: string, uid: string) => ['orgMember', orgId, uid] as const,
  /** The whole staff directory node (also resolves actor uids to names). */
  orgMembers: (orgId: string) => ['orgMembers', orgId] as const,
  /** Pending staff invitation summaries. */
  orgInvitations: (orgId: string) => ['orgInvitations', orgId] as const,
  /** Org-wide settings (RAG config and future levers). */
  orgSettings: (orgId: string) => ['orgSettings', orgId] as const,

  jobs: (orgId: string) => ['jobs', orgId] as const,
  job: (orgId: string, jobId: string) => ['jobs', orgId, jobId] as const,
  /** A bounded jobs-board window ordered by scheduledFor. The window size is
   *  PART of the key (see `logBookWindow` below): widening the window must mint
   *  a new key so the bridge re-subscribes. Shares the `jobs` prefix so
   *  invalidating that prefix covers every window. */
  jobsWindow: (orgId: string, windowSize: number) =>
    ['jobs', orgId, 'window', windowSize] as const,
  /** One local day of jobs for the scheduling timeline: an indexed window
   *  (orderByChild('scheduledFor').startAt(dayStart).endAt(dayEnd)). The day
   *  start is PART of the key so picking another date mints a new key and the
   *  bridge re-subscribes (same reasoning as `logBookWindow`). Shares the
   *  `jobs` prefix so invalidating that prefix covers every day. */
  jobsForDay: (orgId: string, dayStartMs: number) =>
    ['jobs', orgId, 'day', dayStartMs] as const,
  /** The assessor's own JOBS list: full Job rows read from /jobs filtered by
   *  assessorUid (the Jobs tab). Distinct cache entry from `assessorJobs` below. */
  assessorJobList: (orgId: string, assessorUid: string) =>
    ['jobs', orgId, 'assessor', assessorUid] as const,
  /** The /assessorJobs REVERSE INDEX (jobId -> status string), a different node
   *  and shape from assessorJobList - they must NOT share a cache key or one
   *  read's data corrupts the other's (blank jobs bug). */
  assessorJobs: (orgId: string, assessorUid: string) =>
    ['assessorJobs', orgId, assessorUid] as const,
  /** Jobs pinning ONE template, read from /jobs via an indexed query on
   *  templateId (the version-history usage counts). A DISTINCT cache entry from
   *  the whole /jobs node (`jobs` above): this holds only the filtered subset,
   *  so it must never share a key with the jobs board's full read. Shares the
   *  `jobs` prefix so invalidating that prefix covers it. */
  jobsByTemplate: (orgId: string, templateId: string) =>
    ['jobs', orgId, 'template', templateId] as const,

  /** Published templates the assessor can browse (story 1032). */
  templates: (orgId: string) => ['templates', orgId] as const,
  template: (orgId: string, templateId: string) =>
    ['template', orgId, templateId] as const,
  /** The work-in-progress draft the builder edits (FR-E21). Its own root key,
   *  never sharing `template`'s: the two nodes have the same shape but
   *  different lifecycles, and a draft echo must not repaint a published view. */
  templateDraft: (orgId: string, templateId: string) =>
    ['templateDraft', orgId, templateId] as const,
  /** Work-in-progress template drafts (the builder area, FR-E21). */
  templateDrafts: (orgId: string) => ['templateDrafts', orgId] as const,
  /** The frozen, immutable version history of one template (story 2053). */
  templateVersions: (orgId: string, templateId: string) =>
    ['templateVersions', orgId, templateId] as const,
  /** The org's Standard Paragraphs library (FR-E21). */
  standardParagraphs: (orgId: string) => ['standardParagraphs', orgId] as const,

  /** Customer / site / building hierarchy reads (job context, history filters). */
  customers: (orgId: string) => ['customers', orgId] as const,
  customer: (orgId: string, customerId: string) =>
    ['customer', orgId, customerId] as const,
  customerMembersByOrg: (orgId: string) => ['customerMembers', orgId] as const,
  customerMembers: (orgId: string, customerId: string) =>
    ['customerMembers', orgId, customerId] as const,
  /** People at a customer organisation (contacts precede portal accounts). */
  customerContacts: (orgId: string, customerId: string) =>
    ['customerContacts', orgId, customerId] as const,
  sites: (orgId: string, customerId: string) =>
    ['sites', orgId, customerId] as const,
  site: (orgId: string, customerId: string, siteId: string) =>
    ['site', orgId, customerId, siteId] as const,
  buildings: (orgId: string, siteId: string) =>
    ['buildings', orgId, siteId] as const,
  /** The org-wide buildings root (dashboard/reporting roll-ups, FR-E19). The
   *  'root' discriminator keeps this entry from ever colliding with a per-site
   *  key above (the shapes differ: this one is nested by siteId). Shares the
   *  `buildings` prefix so prefix invalidation covers it. */
  buildingsRoot: (orgId: string) => ['buildings', orgId, 'root'] as const,

  /** Floor plans for a building (job detail viewer + flag-location picker). */
  floorPlans: (orgId: string, buildingId: string) =>
    ['floorPlans', orgId, buildingId] as const,

  assessment: (orgId: string, assessmentId: string) =>
    ['assessment', orgId, assessmentId] as const,
  /** Assessments in ONE lifecycle stage (the validation queue). The stage is
   *  part of the key because each stage is its own indexed subscription
   *  (orderByChild('status') + equalTo), so the two queue sections never share
   *  or clobber a cache entry. Shares the `assessments`... prefix deliberately
   *  NOT with `assessment` (a different node shape). */
  assessmentsByStatus: (orgId: string, status: string) =>
    ['assessments', orgId, 'status', status] as const,
  /** A BOUNDED window of assessments in one lifecycle stage. The window size is
   *  part of the key for the same reason as `logBookWindow`: the dashboard's
   *  release card and the full released list read the same indexed node through
   *  different limits, and one cache entry cannot honestly hold both windows.
   *  Shares the `assessments` prefix so prefix invalidation covers it. */
  assessmentsByStatusWindow: (
    orgId: string,
    status: string,
    windowSize: number,
  ) => ['assessments', orgId, 'status', status, 'window', windowSize] as const,
  assessmentAnswers: (orgId: string, assessmentId: string) =>
    ['assessmentAnswers', orgId, assessmentId] as const,
  buildingAssessments: (orgId: string, buildingId: string) =>
    ['buildingAssessments', orgId, buildingId] as const,

  building: (orgId: string, siteId: string, buildingId: string) =>
    ['building', orgId, siteId, buildingId] as const,
  actions: (orgId: string, buildingId: string) =>
    ['actions', orgId, buildingId] as const,
  /** The org-wide actions root (dashboard/reporting roll-ups, FR-E19); same
   *  'root' discriminator reasoning as `buildingsRoot`. */
  actionsRoot: (orgId: string) => ['actions', orgId, 'root'] as const,
  logBook: (orgId: string, buildingId: string) =>
    ['logBook', orgId, buildingId] as const,
  /** A bounded log-book window. The window size is PART of the key on purpose:
   *  useRtdbQuery re-subscribes on key changes (the build callback's identity
   *  is not a dependency), so widening the window must mint a new key. Shares
   *  the `logBook` prefix so invalidating that prefix covers every window. */
  logBookWindow: (orgId: string, buildingId: string, windowSize: number) =>
    ['logBook', orgId, buildingId, 'window', windowSize] as const,
  documents: (orgId: string, buildingId: string, category: DocumentCategory) =>
    ['documents', orgId, buildingId, category] as const,

  reports: (orgId: string, scope: ReportScope, scopeId: string) =>
    ['reports', orgId, scope, scopeId] as const,

  /** A bounded activity window; sized keys for the same reason as
   *  `logBookWindow` above. */
  activity: (orgId: string, windowSize: number) =>
    ['activity', orgId, 'window', windowSize] as const,
  /** A time-bounded activity window (orderByChild('at').startAt(sinceMs)) for
   *  the monthly reporting roll-ups (FR-E19). The since-timestamp is PART of
   *  the key so a different reporting horizon mints a new key and the bridge
   *  re-subscribes; shares the `activity` prefix for invalidation. */
  activitySince: (orgId: string, sinceMs: number) =>
    ['activity', orgId, 'since', sinceMs] as const,

  /** A bounded email send-log window (admin-only read; orderByChild('sentAt')
   *  + limitToLast). Sized keys for the same reason as `logBookWindow` above. */
  emailLog: (orgId: string, windowSize: number) =>
    ['emailLog', orgId, 'window', windowSize] as const,

  notifications: (uid: string) => ['notifications', uid] as const,

  /** Global client config for the force-update gate (story 1080). */
  clientConfig: () => ['clientConfig'] as const,

  /** The SDK's synthetic connectivity node (`.info/connected`). Client state,
   *  not a database domain, so it takes no orgId; the console's connection
   *  banner is its only reader. */
  infoConnected: () => ['infoConnected'] as const,
} as const;

/** A query key is always a readonly array of primitives. */
export type QueryKey = readonly (string | number)[];
