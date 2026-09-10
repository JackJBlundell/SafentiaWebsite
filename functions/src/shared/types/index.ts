// ============================================================================
// Safentia domain types - the single schema contract.
//
// This mirrors section 6 of Safentia_Phase1_Project_Brief.md (the canonical
// Realtime Database schema) plus the Cloud Function call contracts (section 4.5).
//
// ARCHITECTURE NOTE (read before editing):
//   By project-lead decision there is NO shared npm package. This file is the
//   canonical contract and is MIRRORED, identically, into THREE places:
//     - FireRite/src/types/index.ts                         (mobile app)
//     - fireritesite/src/types/index.ts                     (web console)
//     - fireritesite/functions/src/shared/types/index.ts    (Cloud Functions)
//   When you change one, change ALL of them in the SAME change set: a `diff`
//   across the three must come back empty. The drift this risks is documented,
//   with the sync rule, in SCHEMA_CHANGES.md. Treat the three files as one
//   contract that happens to live across two repos.
//
// Why string-literal unions plus `const` arrays: the unions give us compile-time
// safety; the arrays give us a runtime allow-list the seed, the Functions input
// validation and the security-rules tests can all share, so "what values are
// legal" is stated exactly once.
// ============================================================================

// ----------------------------------------------------------------------------
// Environment (test mode isolation - section 4.8)
// ----------------------------------------------------------------------------

/**
 * The data root a signed-in user is bound to. Resolved ONCE from the user's
 * custom claim (`testMode`) at sign-in and carried transparently by the path
 * builders thereafter - never branched on per screen. `test` users can only ever
 * touch `/test`, `live` users only `/live`; the boundary is enforced by security
 * rules, not by client code (see brief 4.8).
 */
export type Environment = 'live' | 'test';
export const ENVIRONMENTS = ['live', 'test'] as const;

// ----------------------------------------------------------------------------
// Roles and permissions (section 5)
// ----------------------------------------------------------------------------

/** Organisation-level roles. A user holds a SET; permission is their union. */
export type OrgRole = 'admin' | 'assessor' | 'auditor' | 'finance' | 'viewer';
export const ORG_ROLES = ['admin', 'assessor', 'auditor', 'finance', 'viewer'] as const;

/** Customer-portal roles (Phase 2 surfaces; data paths built now). */
export type CustomerRole = 'admin' | 'finance' | 'viewer';
export const CUSTOMER_ROLES = ['admin', 'finance', 'viewer'] as const;

/** A role set is an object of optional `true` flags - never a list, so rules and
 *  clients can test a single role with one key lookup. */
export type OrgRoleSet = { [R in OrgRole]?: true };
export type CustomerRoleSet = { [R in CustomerRole]?: true };

/** Lifecycle of a person's membership (section 4.1 account states). */
export type MemberStatus = 'active' | 'locked' | 'archived';
export const MEMBER_STATUSES = ['active', 'locked', 'archived'] as const;

/**
 * The standings a PORTAL account can be moved between once it exists
 * (updateCustomerMember). `archived` is deliberately absent: a portal seat ends
 * by archiving the whole CUSTOMER - which cascades to every one of their
 * accounts and records why each was locked - or by removing the contact, so
 * offering `archived` per account would be a second, quieter route to the same
 * effect with none of that bookkeeping.
 */
export type PortalAccountStatus = 'active' | 'locked';
export const PORTAL_ACCOUNT_STATUSES = ['active', 'locked'] as const;

// ----------------------------------------------------------------------------
// Custom claims carried on the Firebase ID token (section 4.1)
// ----------------------------------------------------------------------------

/**
 * The shape `onMembershipChange` writes onto a user's ID token. The client reads
 * this to resolve org, permissions and environment. `customerId` and `testMode`
 * are optional: a normal Phase 1 org member has neither set.
 */
export interface SafentiaClaims {
  orgId: string;
  roles: OrgRoleSet;
  customerId?: string;
  /** true routes the user to `/test`; absent/false routes to `/live`. Set
   *  server-side from the member record only - never trusted from the client. */
  testMode?: boolean;
  /** Platform super-admin (FR-E24). Carried ACROSS every claim shape because a
   *  super admin is also an org member and/or portal user, and their claims are
   *  re-minted on membership changes and space switches. writeClaims re-derives
   *  it from the durable /platform/superAdmins marker on every write, so an
   *  ordinary membership change can never silently strip platform access. */
  superAdmin?: true;
}

// ----------------------------------------------------------------------------
// Risk / RAG (Red-Amber-Green) - a SAFETY semantic, never overridden by brand
// ----------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high' | 'pending';
export const RISK_LEVELS = ['low', 'medium', 'high', 'pending'] as const;

/**
 * TRUE counts of findings by severity. The report's risk meter must render
 * PROPORTIONALLY to these (brief 6 + story 1072): the legacy system's failing was
 * skewing the whole building red for one red item; we must not repeat it.
 */
export interface RagDistribution {
  low: number;
  medium: number;
  high: number;
}

/** Non-conformity severity. Single letters match the schema and the report. */
export type Severity = 'L' | 'M' | 'H';
export const SEVERITIES = ['L', 'M', 'H'] as const;

// ----------------------------------------------------------------------------
// Platform (global, NOT under an environment root - section 6)
// ----------------------------------------------------------------------------

export interface PlanLimits {
  /** -1 = unlimited. The sentinel is used consistently across every limit so
   *  the entitlements module can treat all four identically (Phase 3 §5.3). */
  orgStaff: number;
  customers: number;
  notificationsPerMonth: number;
  assessmentTemplates: number;
}

/** Phase 3 fills the values; the shape is fixed now so the invite-limit hook
 *  (story 1023) and Phase 3 entitlements slot in without reshaping. Stored at
 *  `/platform/plans/{env}/{planId}` - env-nested because `stripePriceId`
 *  differs between Stripe test and live modes (Phase 3 §5.3). */
export interface Plan {
  name: string;
  stripePriceId: string;
  /** Display only; Stripe is the billing truth. */
  priceMonthlyPence: number;
  currency: 'gbp';
  /** Feature flags gate whole surfaces; limits meter countable resources. */
  features: { branding: boolean; emailTemplates: boolean; prioritySupport: boolean };
  limits: PlanLimits;
  /** Display sort order on the subscribe matrix (bronze < silver < gold). */
  order: number;
}

/**
 * Self-serve onboarding state at `usersOnboarding/{uid}` (Phase 3 §5.4) - a
 * TOP-LEVEL node, outside the `/live`/`/test` env roots, because onboarding
 * spans the moment before the user's organisation (and therefore its env tree)
 * exists; the env is derived from the user's testMode claim at provisioning.
 * Owner-read, server-write only: the single resume point for the subscribe →
 * pay → provision → setup-wizard journey, so a reload at any stage lands the
 * user exactly where they left off.
 */
/**
 * The organisation details collected by the pre-plan onboarding step
 * (saveOnboardingDetails). `name` is what the organisation is founded under;
 * the optional fields use OrgContact's exact vocabulary so provisioning copies
 * them straight into the new org's `profile.contact` with no translation.
 */
export interface OnboardingOrgDetails {
  name: string;
  address?: string;
  phone?: string;
  website?: string;
}

export interface UserOnboarding {
  step: 'details' | 'plan' | 'payment' | 'setup' | 'done';
  planId?: string;
  /** The founding name, kept alongside orgDetails.name for compatibility -
   *  provisioning and the webhook read this field. */
  orgName?: string;
  /** Collected BEFORE plan choice ('details' is the journey's initial step);
   *  carried on the node so provisioning writes it into the org profile. */
  orgDetails?: OnboardingOrgDetails;
  /** Which environment (and therefore which STRIPE MODE) minted the Stripe
   *  ids below. An account's testMode claim can change between attempts
   *  (operator grant); ids from the other mode are invisible to the current
   *  mode's API and must be discarded, not retried - the flow self-heals by
   *  keeping the typed details and starting the payment afresh. Optional
   *  because nodes predating the stamp exist; absent reads as unknown, which
   *  callers treat as not-current. */
  env?: Environment;
  stripeCustomerId?: string;
  subscriptionId?: string;
  /** Set when the webhook provisions the organisation (step moves to 'setup'). */
  orgId?: string;
  setupStep?: 'profile' | 'team' | 'customer';
  setupDone?: Partial<Record<'profile' | 'team' | 'customer', boolean>>;
  /** Persisted so Stripe idempotency keys survive retries (Phase 3 §2). */
  attemptNonce?: string;
  createdAt: number;
  completedAt?: number;
}

/**
 * Per-user console UI state at `consoleState/{uid}` (Phase 3 §5.6) - the
 * dashboard's Getting Started checklist and the guided tour remember what this
 * PERSON has seen, not what their organisation has done, so the node is keyed
 * by uid and sits TOP-LEVEL beside `usersOnboarding` (a preference does not
 * change meaning between the live and test envs). Owner read/write: this is
 * presentation state only - nothing here grants access to anything, so there
 * is no server involvement to route through.
 */
export interface ConsoleState {
  /** The first-load tour, completed once per device class (Phase 3 §7). */
  tourDone?: { desktop?: boolean; mobile?: boolean };
  /** "Hide this checklist" on the dashboard's Getting Started card. */
  gettingStartedDismissed?: boolean;
  /** Checklist ticks that cannot be derived from org data (visit-based). */
  gettingStarted?: { templatesVisited?: boolean };
}

/** Finance-feed entry kinds (Phase 3 §5.5). Written by the Stripe webhook, plus
 *  `org_deleted` written by the offboarding tooling (the nightly retention sweep
 *  and the operator immediate-delete script) so a cancelled tenant's final
 *  reaping leaves a durable, super-admin-visible audit line (DECISIONS §8). */
export type FinanceEventType =
  | 'payment'
  | 'payment_failed'
  | 'refund'
  | 'subscription_started'
  | 'subscription_canceled'
  | 'plan_changed'
  | 'org_deleted';

/**
 * One entry in the super-admin billing activity feed at
 * `platform/financeEvents/{env}/{pushId}` (Phase 3 §5.5). Server-write only,
 * superAdmin read; capped to 12 months by the cleanup job. `orgName` is
 * denormalised at write time so the feed renders without N org lookups.
 */
export interface FinanceEvent {
  at: number;
  type: FinanceEventType;
  orgId: string;
  orgName: string;
  planId?: string;
  amountPence?: number;
  currency?: string;
  /** The Stripe event that produced this entry, for dashboard cross-reference. */
  stripeEventId: string;
}

/**
 * Publicly-readable client configuration (story 1080). Lives at
 * `/platform/clientConfig` (global, NOT environment-scoped) and is readable by
 * any client, signed in or not, so the force-update gate can evaluate before
 * sign-in. Written only by trusted/admin tooling, never the client.
 *
 * The minimum-supported-version gate compares the running app's version against
 * `minimumSupportedVersion`: a build below it is blocked with a link to the
 * store, so a defective build of a safety-critical product can be retired from
 * the field without a release. All fields are optional and the gate FAILS OPEN
 * (never blocks) when the value is absent or unreadable, so a missing config can
 * never brick the fleet.
 */
export interface ClientConfig {
  /** Lowest app version allowed to run, as a semver string e.g. "1.2.0". */
  minimumSupportedVersion?: string;
  /** Store links shown on the blocking upgrade screen. */
  iosStoreUrl?: string;
  androidStoreUrl?: string;
  /** Optional override message for the upgrade screen. */
  message?: string;
}

/**
 * Admin-editable AI context for the assessment summary writer, stored globally at
 * `/platform/aiContext`. This is the regulatory SOURCE OF TRUTH the AI is grounded
 * in: when the law or a standard changes, an admin pastes the updated text into
 * `regulatoryContext` - no code change or redeploy. Read server-side only (the
 * generateAssessmentDraft Function); the app never reads it. All fields optional
 * and the Function FALLS BACK to its built-in framework when this is absent, so a
 * missing or empty context can never break drafting.
 */
export interface AiContext {
  /** The regulatory framework the AI treats as source of truth (real UK
   *  instruments and standards). Replaces the built-in framework when present. */
  regulatoryContext?: string;
  /** Optional extra house guidance appended to the summary instructions. */
  additionalGuidance?: string;
  updatedAt?: number;
  updatedBy?: string;
}

// ----------------------------------------------------------------------------
// Organisation (section 6)
// ----------------------------------------------------------------------------

/** Per-org brand tokens that drive whitelabel theming (brief 9.1). These layer
 *  on top of the design system's accent/header; they NEVER override RAG. */
export interface OrgBrand {
  primary: string;
  secondary: string;
}

export interface OrgContact {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  /** Public website, shown in the report cover's contact strip beside the phone
   *  and email. Stored as the admin typed it (e.g. "wmcompliance.co.uk"); the
   *  renderer does not linkify it, so no scheme is required. */
  website?: string;
}

export interface OrgProfile {
  name: string;
  logoUrl?: string;
  brand: OrgBrand;
  contact?: OrgContact;
  /** Optional font family the org wants applied (whitelabel typography). Falls
   *  back to the design-system default when absent. */
  fontFamily?: string;
  /**
   * Decorative image for the report cover's top-left panel - the organisation's
   * own photograph rather than anything about the building being assessed (the
   * building's own photo sits in the panel below it). A tenant-scoped Storage
   * path, validated exactly as logoUrl is.
   *
   * Absent is a first-class state, not a gap: the renderer paints a panel from
   * the org's brand colours instead, so a cover always looks composed. That is
   * deliberately preferred to shipping a stock photograph, which would carry a
   * licence and would look like someone else's brand on every report.
   */
  coverImageUrl?: string;
  /**
   * Member-readable suspension mirror (Phase 3 SEV-1 fix). The subscription
   * node is admin-read by design, so non-admin staff in a suspended
   * organisation would otherwise meet raw server errors with no explanation;
   * this single boolean leaks no billing detail while letting every member see
   * an honest "subscription paused" notice. Written EXCLUSIVELY by the Stripe
   * webhook alongside status transitions (true on unpaid/canceled/incomplete,
   * removed on active) - updateOrgProfile's field whitelist rejects it from
   * client input, and the rules deny all client writes under /organisations.
   */
  suspended?: true;
}

/** Stripe subscription lifecycle states mirrored into RTDB by the webhook
 *  (Phase 3 §5.1). Narrowed from `string` - additive-safe: nothing wrote a
 *  status before Phase 3, so the union is the first and only vocabulary. */
export type SubscriptionStatus =
  | 'incomplete' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'trialing';

/** Phase 3 billing block; all additions optional so pre-billing orgs (no block,
 *  or a bare planId) remain valid - the entitlements module grandfathers them.
 *  Written ONLY server-side (webhook + billing callables); clients never write. */
export interface OrgSubscription {
  stripeCustomerId?: string;
  planId?: string;                    // 'bronze' | 'silver' | 'gold'
  status?: SubscriptionStatus;
  currentPeriodEnd?: number;          // ms epoch
  stripeSubscriptionId?: string;
  priceId?: string;
  cancelAtPeriodEnd?: boolean;
  /** Downgrade landing at period end (subscription schedule, Phase 3 §3.2). */
  pendingPlanId?: string;
  /** Dunning state machine (Phase 3 §3.5); entitlements stay unchanged while a
   *  grace window is open - never degrade a live safety tool over a card hiccup. */
  paymentState?: 'past_due' | 'action_required';
  graceUntil?: number;
  /**
   * Data-retention clock (DECISIONS §8). The ms-epoch instant AT or AFTER which a
   * FULLY-cancelled organisation's data may be reaped by the nightly
   * `cleanupExpiredOrgs` sweep. Stamped ONCE, at FINAL cancellation
   * (`customer.subscription.deleted` → status canceled), as `now + 12 months`;
   * CLEARED (deleted) the moment the org resubscribes to an active/trialing
   * subscription, so a returning customer is never reaped. Absent on every live
   * org - it exists only while a cancelled org sits inside its 12-month retention
   * window. Server-written only (the Stripe webhook); the operator immediate-delete
   * script bypasses it entirely.
   */
  retentionUntil?: number;
  /** Display metadata only (SAQ-A): never any card data beyond brand/last4/exp. */
  paymentMethod?: { brand: string; last4: string; expMonth: number; expYear: number };
  updatedAt?: number;
}

export interface OrgUsage {
  staffCount: number;
  customerCount: number;
  notificationsThisMonth: number;
}

/**
 * Configurable RAG derivation (Phase 2, story 2012; Schedule 1 group 5
 * "configurable RAG thresholds and roll-up calculation, agreed during
 * Discovery"). The building's risk level derives from its latest released
 * assessment's finding distribution and the state of its action plan; these
 * values tune that derivation per organisation.
 *
 * The DEFAULTS (RAG_CONFIG_DEFAULTS in the derivation module) are the
 * developer's proposed model and are explicitly subject to client agreement at
 * the Phase 2 review - which is exactly why this is data, not code.
 */
export interface RagConfig {
  /** Share of red findings (0..1) at or above which the building is high risk. */
  redShareForHigh: number;
  /** Combined share of amber and red findings (0..1) at or above which the
   *  building is at least medium risk. */
  amberRedShareForMedium: number;
  /** An open High-severity (or Life Protection) action holds the building at
   *  high risk regardless of shares. */
  openHighActionForcesHigh: boolean;
  /** An overdue action raises the derived level by one band. */
  overdueActionEscalates: boolean;
}

/** Organisation-level configuration, distinct from the public profile. */
export interface OrgSettings {
  ragConfig?: RagConfig;
  /**
   * House guidance appended to the AI summary prompt for THIS organisation -
   * "we always cite the Welsh regulations", "call out PV panels".
   *
   * Distinct from `/platform/aiContext`, which is one global record only
   * Safentia can write and which supplies the regulatory framework itself.
   * This is the customer's own steer on top of it, and it is guidance for the
   * model - never the verbatim wording of a standard paragraph, which is
   * printed as written and never paraphrased.
   */
  aiGuidance?: string;
  /** How many days ahead of a building's FRA review date the reminder sweep
   *  warns (story 2046 AC1). Descending, e.g. [60, 30, 7]. Absent falls back to
   *  the built-in default in lib/reviewWindows, so an org that never configures
   *  this still gets sensible reminders. */
  reviewReminderDays?: number[];
  /**
   * Master switch for the FRA-review reminder sweep. Absent means ON, so an org
   * that has never touched it keeps the reminders it already had; only an
   * explicit false stops the sweep for the whole organisation (admin notices
   * and customer emails alike, including the overdue notice).
   */
  reviewRemindersEnabled?: boolean;
  /** How many days ahead of an open information request's response deadline the
   *  deadline sweep chases the assigned assessor. Descending, e.g. [3, 1].
   *  Absent (or malformed) falls back to the built-in default: the ladder is
   *  short because the request's own window is a week. */
  infoRequestReminderDays?: number[];
  /** Master switch for the information-request half of the deadline sweep.
   *  Absent means ON; an explicit false stops those chases - including the
   *  overdue notice - for the whole organisation. */
  infoRequestRemindersEnabled?: boolean;
  /** How many days ahead of an open action's due date the deadline sweep chases
   *  the responsible party and the org's admins. Descending, e.g. [30, 7, 1].
   *  Absent (or malformed) falls back to the built-in default. */
  actionReminderDays?: number[];
  /** Master switch for the action half of the deadline sweep. Absent means ON;
   *  an explicit false stops the admin digest and the responsible-party emails
   *  for the whole organisation. */
  actionRemindersEnabled?: boolean;
}

export interface Organisation {
  profile: OrgProfile;
  settings?: OrgSettings;
  subscription?: OrgSubscription;
  usage?: OrgUsage;
}

// ----------------------------------------------------------------------------
// Membership (section 6)
// ----------------------------------------------------------------------------

/** Non-transactional email categories a member may quieten. Absent = all on.
 *  Security and account email (invitations, password reset) is never optional. */
export interface EmailPreferences {
  reviewDue?: boolean;
  actionAssigned?: boolean;
  awaitingValidation?: boolean;
  released?: boolean;
  /** An auditor has asked this assessor for more information. */
  infoRequested?: boolean;
  /** A deadline the recipient owns is approaching or has passed. */
  deadlineReminder?: boolean;
  /** A visit in this assessor's own diary: assigned, moved, cancelled, or listed
   *  in the morning "jobs due today" digest. One key for the whole diary,
   *  because an assessor who wants the day's changes wants all of them. */
  jobScheduled?: boolean;
  /** The verdict on an assessment this assessor carried out: an auditor accepted
   *  it, or it was released. ONE key for both, on the `jobScheduled` reasoning -
   *  an assessor who wants to hear their work cleared review wants to hear it was
   *  issued too. Deliberately NOT the `released` key above: that one is the
   *  ADMINISTRATORS' "a report is available" notice, and the same event read by a
   *  different person must not be silenced by one switch. */
  assessmentOutcome?: boolean;
}

export interface OrgMember {
  roles: OrgRoleSet;
  /** The member's own notification email choices (story 2066); written only via
   *  updateMyPreferences (self-scoped callable). */
  emailPreferences?: EmailPreferences;
  /** Marks a test user; `onMembershipChange` copies this into the custom claim
   *  (brief 4.8). Never set from the client. */
  testMode?: true;
  name: string;
  email: string;
  status: MemberStatus;
}

export interface CustomerMember {
  roles: CustomerRoleSet;
  name: string;
  email: string;
  status: MemberStatus;
  /** Job title (e.g. "Facilities Director"), shown when this account is chosen as
   *  a responsible party. Distinct from `roles`, which are portal permissions. */
  jobTitle?: string;
  /** Contact phone, carried onto a responsible party chosen from this account. */
  phone?: string;
  /**
   * Set when archiving the CUSTOMER locked this account, so restoring the
   * customer reactivates exactly the accounts that archive locked - and not one
   * that was locked on its own account beforehand. Written only by
   * manageCustomer's archive/restore cascade, never from a client.
   */
  lockedByCustomerArchive?: true;
}

/** Reverse index for login routing - `/userOrgs/{uid}/{orgId}: true`. */
export interface CustomerUserIndexEntry {
  orgId: string;
  customerId: string;
}

// ----------------------------------------------------------------------------
// Customer / Site / Building (section 6)
// ----------------------------------------------------------------------------

/**
 * A customer is an ORGANISATION the fire-safety company serves - a housing
 * association, a property group - never a person. People belong to it as
 * CustomerContact records (below). The org-level email/phone here are the
 * switchboard details; person-level details live on the contacts.
 */
export interface Customer {
  name: string;
  /** Head-office / correspondence address. */
  address?: string;
  email?: string;
  phone?: string;
  /** The customer's logo or a representative photo, uploaded by org staff. A
   *  tenant-scoped Storage URL, validated by requireTenantStorageRef exactly as
   *  Building.photoUrl and OrgProfile.logoUrl are. Shown where the customer is
   *  identified: the org's customer list and the portal chrome. */
  photoUrl?: string;
  /** Customer-level risk score (rolls up from buildings). */
  score?: number;
  /**
   * Optional end of the engagement with this customer, as epoch millis at
   * midnight UTC (the platform's date-only convention, as ServiceScheduleItem
   * uses). When the day has fully passed, the nightly customerContracts sweep
   * ARCHIVES the customer - which withdraws their portal access and silences
   * their reminders - and tells the org's admins it has done so.
   *
   * It is a convenience over the archive action, never a second source of truth
   * for access: `status` alone says whether a customer is live. Restoring an
   * archived customer clears a date that has already passed, so a restore can
   * never be undone by the next morning's sweep.
   */
  contractEndDate?: number;
  status: MemberStatus;
}

/**
 * A person at a customer organisation. Contacts exist INDEPENDENTLY of portal
 * accounts: assessors pick responsible parties from them in the app, sites
 * name them as site contacts, and inviting one to the portal links the
 * eventual account back here via `uid`. Exactly one contact per customer is
 * the primary; the primary is created with portal admin roles and is
 * auto-invited when the customer is created.
 * Path: /{env}/customerContacts/{orgId}/{customerId}/{contactId}.
 */
export interface CustomerContact {
  name: string;
  email?: string;
  phone?: string;
  /** Job title, e.g. "Facilities Director" - shown wherever the contact is
   *  offered as a responsible party. */
  jobTitle?: string;
  /**
   * Whether this person is sent a copy of every released fire risk assessment
   * report for their customer.
   *
   * ABSENT MEANS YES, and that is what makes the migration free: before this
   * field existed every contact holding an email address was mailed every
   * released report, so an unset record keeps behaving exactly as it always
   * did and nothing has to be backfilled. Only an explicit `false` takes
   * somebody off the distribution - which also means an older client that
   * cannot write this field can never silently stop a report reaching someone.
   * Readers must therefore test `receivesReports !== false`, never truthiness.
   *
   * It governs the RELEASE report email alone. Review reminders, visit notices
   * and action or deadline emails reach a contact for a different reason - a
   * booked visit, or remedial work recorded against them personally - so they
   * are not gated by this flag. Nor is the release digest, which is addressed
   * through `Action.responsibleContactId`: being off the report distribution is
   * not a reason to stop telling somebody about work they owe.
   */
  receivesReports?: boolean;
  /** Portal permissions this contact should hold once their account exists. */
  portalRoles?: CustomerRoleSet;
  /** The customer's primary contact. Reassigned, never removed. */
  isPrimary?: true;
  /** Linked account uid, set by acceptInvitation when their invite is used. */
  uid?: string;
  createdAt: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Site {
  name: string;
  address?: string;
  geo?: GeoPoint;
  /** The site's contact: a CustomerContact id under the owning customer. */
  contactId?: string;
}

export type AlarmCategory = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'M' | 'P1' | 'P2';
export const ALARM_CATEGORIES = ['L1', 'L2', 'L3', 'L4', 'L5', 'M', 'P1', 'P2'] as const;

export interface BuildingDetails {
  area?: number;
  floors?: number;
  occupiedFloors?: number;
  occupants?: number;
  isLandlord?: boolean;
  alarmType?: string;
  alarmCategory?: AlarmCategory;
}

/** Next-due dates for each statutory service (brief story 1047). Stored as epoch
 *  millis so they sort and compare without timezone ambiguity. */
export interface ServiceScheduleItem {
  nextDue?: number;
}

export interface ServiceSchedule {
  fireAlarmService?: ServiceScheduleItem;
  fireMarshalTraining?: ServiceScheduleItem;
  fireSafetyTraining?: ServiceScheduleItem;
  fireDrill?: ServiceScheduleItem;
  pat?: ServiceScheduleItem;
  extinguisherMaintenance?: ServiceScheduleItem;
  fraReview?: ServiceScheduleItem;
}

/** The statutory service keys, as a runtime list, so the service-schedule step
 *  and the seed iterate the exact same set. */
export const SERVICE_SCHEDULE_KEYS = [
  'fireAlarmService',
  'fireMarshalTraining',
  'fireSafetyTraining',
  'fireDrill',
  'pat',
  'extinguisherMaintenance',
  'fraReview',
] as const;
export type ServiceScheduleKey = (typeof SERVICE_SCHEDULE_KEYS)[number];

/**
 * A responsible party (the person accountable for fire safety / remedial actions).
 * Baked into the building as the reusable default (set by an admin, editable in
 * the app) so it is chosen once and applied everywhere, rather than re-typed on
 * every finding. The assessment carries its own copy (defaulted from the
 * building) so it can be switched for a specific visit without altering the
 * building's default. Only `name` is required.
 */
export interface ResponsibleParty {
  name: string;
  /** Role / job title, e.g. "Facilities Director". */
  role?: string;
  email?: string;
  phone?: string;
  /**
   * The CustomerContact this party is, under the building's customer. This is
   * what makes the record actionable: every automated email to a responsible
   * party - release, action assignment, deadline chase - resolves the person
   * through this id, so a party without one is a name on a page that nobody can
   * be told about.
   *
   * The platform only ever writes a party chosen from the customer's contact
   * directory, so this is present on anything recorded since. It stays OPTIONAL
   * for one reason: parties captured before that (and any imported by an admin)
   * carry a typed name alone, and a report must still render them honestly
   * rather than refusing to open.
   */
  contactId?: string;
}

export interface Building {
  name: string;
  customerId: string;
  address?: string;
  details?: BuildingDetails;
  /** The building's default responsible party (admin-set; the reusable default
   *  for assessments and their actions). The SOLE record of who is accountable
   *  for the building - the free-text predecessor it replaced was deleted from
   *  the contract and the data together (scripts/backfillResponsibleParty.ts),
   *  so there is no second place to look. */
  responsibleParty?: ResponsibleParty;
  /** Article 5(3) duty-holders (UK Fire Safety Order). */
  article53Persons?: string[];
  photoUrl?: string;
  riskLevel: RiskLevel;
  /** TRUE counts - the report meter must be proportional to these. */
  ragDistribution?: RagDistribution;
  serviceSchedule?: ServiceSchedule;
  lastAssessedAt?: number;
}

// ----------------------------------------------------------------------------
// Floor plans (section 6) - optional per building; absence is a first-class path
// ----------------------------------------------------------------------------

/** What a stored floor-plan file IS, which decides what can be done with it:
 *
 *  - `image` - a photo/screenshot/scan. Renders in the annotator and supports a
 *    flattened pin composite.
 *  - `pdf`   - renders in the annotator, annotated with pins only.
 *  - `file`  - any other drawing the practice actually holds: a CAD export
 *    (DWG/DXF/DWF), a TIFF, an office document. It is stored, listed and
 *    downloadable, but NOT renderable on a phone, so it is never offered for
 *    pin annotation. Admitting these was the point: a plan that cannot be
 *    annotated is still the drawing the assessor needs on site.
 *
 *  Absent defaults to 'image' (every plan predating this field is one). */
export type FloorPlanKind = 'image' | 'pdf' | 'file';

/** The floor-plan kinds the pin annotator can actually render. */
export const ANNOTATABLE_FLOOR_PLAN_KINDS: readonly FloorPlanKind[] = [
  'image',
  'pdf',
];

/** Whether a plan of this kind can be opened in the pin annotator. Absent kind
 *  is an image (see FloorPlan.kind), so it is annotatable. */
export function isAnnotatableFloorPlan(kind?: FloorPlanKind): boolean {
  return kind === undefined || ANNOTATABLE_FLOOR_PLAN_KINDS.includes(kind);
}

export interface FloorPlan {
  name: string;
  description?: string;
  imageUrl: string;
  /** See FloorPlanKind. Absent defaults to 'image'. */
  kind?: FloorPlanKind;
  /** The uploaded file's own name, kept so a non-renderable drawing can be
   *  named and downloaded as the thing the practice recognises ("Block A
   *  ground floor.dwg") rather than as an opaque object id. */
  fileName?: string;
  /** The content type the object was uploaded with, so a viewer can decide how
   *  to present it without sniffing bytes. */
  contentType?: string;
  /** The uploaded file's size in bytes. DISPLAY ONLY: a drawing that cannot be
   *  previewed is judged before download by what it is and how big it is, so
   *  the tile can say so instead of asking someone to find out by fetching it.
   *  Absent on every plan predating this field - show nothing rather than a
   *  guessed or zero size. */
  sizeBytes?: number;
  /** Display order within a building (story 2021), ascending. Absent sorts
   *  after ordered plans, then by name, so plans predating this field keep a
   *  stable position until an admin reorders them. */
  order?: number;
}

// ----------------------------------------------------------------------------
// Templates (section 6) - published versions are IMMUTABLE
// ----------------------------------------------------------------------------

export type QuestionType =
  | 'text'
  | 'longtext'
  | 'yesno'
  | 'select'
  | 'multiselect'
  | 'photo'
  | 'nonConformity'
  | 'matrix';
export const QUESTION_TYPES = [
  'text',
  'longtext',
  'yesno',
  'select',
  'multiselect',
  'photo',
  'nonConformity',
  'matrix',
] as const;

export type TemplateStatus = 'draft' | 'published' | 'archived';
export const TEMPLATE_STATUSES = ['draft', 'published', 'archived'] as const;

/** Which industry standard a template follows. Drives the report PROFILE that
 *  renders its assessments (report/profiles): `pas79` and `bs9792` get their
 *  standard-specific report treatment; `custom` (or an untagged template) gets
 *  the generic, best-effort report built purely from whatever sections it has.
 *  This is the ROBUST lineage signal - report selection keys off this, never off
 *  the template id or name (which a clone or custom author can change). */
export type ReportStandard = 'pas79' | 'bs9792' | 'custom';
export const REPORT_STANDARDS = ['pas79', 'bs9792', 'custom'] as const;

/**
 * A two-axis grid the assessor answers by choosing ONE cell (`matrix` questions).
 *
 * Modelled on the BS 9792 / PAS 79 "simple risk level estimator", where
 * likelihood of fire is crossed with potential consequences to give a risk
 * level. It is deliberately GENERIC - the axes, their options and the outcome in
 * every cell come from the template - so any standard can define its own grid
 * rather than this being one hard-coded fire-risk table.
 *
 * One cell fixes all three facts at once (row, column, and that cell's outcome),
 * which is why entry is a single choice rather than three. The paper form ticks
 * the three separately and so permits a combination the grid does not support
 * (High likelihood + Extreme harm recorded as "Tolerable"); reading the outcome
 * off the chosen cell makes that unrepresentable.
 */
export interface QuestionMatrix {
  /** Heading for the row axis, e.g. "Likelihood of fire". */
  rowLabel: string;
  /** Heading for the column axis, e.g. "Potential consequences of fire". */
  columnLabel: string;
  /** Row options, top to bottom. */
  rows: string[];
  /** Column options, left to right. */
  columns: string[];
  /** The outcome recorded for each cell, indexed `cells[rowIndex][columnIndex]`.
   *  The grid must be rectangular: one entry per row, each `columns.length` long. */
  cells: string[][];
  /** Optional definitions for the axis options, keyed by the option label. The
   *  BS 9792 estimator defines each of Low/Medium/High and each harm level, and
   *  those definitions are part of the assessment record, not decoration. */
  definitions?: Record<string, string>;
}

/**
 * The stored value of a `matrix` answer (`AssessmentAnswer.value`).
 *
 * Labels rather than indices: the assessment pins its `templateSnapshot` at
 * start, so labels are stable for its lifetime, and storing them keeps the
 * answer self-describing in the report and the audit trail without a lookup back
 * into the template. `outcome` is copied from the chosen cell, never chosen
 * independently.
 */
export interface MatrixAnswer {
  row: string;
  column: string;
  outcome: string;
}

export interface TemplateQuestion {
  id: string;
  text: string;
  type: QuestionType;
  /** For select / multiselect. */
  options?: string[];
  /**
   * Quick-fill answers for a FREE-TEXT question (`text` / `longtext`), offered
   * as one-tap chips above the input. Tapping one writes it into the answer,
   * which the assessor is then free to edit - they are a starting point, never a
   * constraint, and the field stays fully editable.
   *
   * These must be QUESTION-SPECIFIC. A generic set ("Satisfactory", "N/A") under
   * a field that wants a storey count or a person's name is noise at best and a
   * wrong answer at worst, which is why free-text questions carried no presets
   * at all until now. Authored per question in the template, so a custom
   * template can carry its own and nothing is hard-coded in the app.
   *
   * Distinct from `options`: those are the CLOSED set a select question may
   * answer with; these are open suggestions for a field that accepts anything.
   */
  presets?: string[];
  /**
   * How a FREE-TEXT question (`text` / `longtext`) should be presented. A
   * RENDERING HINT ONLY: the answer is still stored in `answer.text` exactly as
   * a plain text answer is, so completion, validation, the report and the
   * server's own submission gate are all unaffected by it. That is deliberate -
   * these could have been new question TYPES, but every one of those layers
   * would then need to learn about them, for no gain in what is actually
   * recorded.
   *
   * It exists because the fields that CANNOT have sensible quick-fill presets
   * are exactly the ones that need a better input instead. A pre-written
   * occupancy figure or travel distance would be a fabricated measurement in a
   * compliance document, so those questions get a numeric keypad rather than
   * suggestions; a date gets a picker; a duty-holder gets the customer's own
   * contacts. Absent means a plain text field.
   */
  inputKind?: 'date' | 'number' | 'person';
  /** For `inputKind: 'number'` - the unit shown beside the field (e.g. 'm',
   *  'persons'). Display only; it is not appended to the stored answer. */
  unit?: string;
  /** Required for `matrix` questions; ignored for every other type. */
  matrix?: QuestionMatrix;
  /** When true, the assessor may pin this answer's location on a floor plan. */
  allowsFlagLocation?: boolean;
  allowsPhotos?: boolean;
  /** Whether an answer is mandatory before submission. */
  required?: boolean;
  /** Standardised help text shown inline (brief 10.1). */
  guidance?: string;
  /**
   * Standardised finding wording (FR-E21, client requirement): when the
   * assessor flags this question as a deficiency, these pre-fill the finding's
   * observation and recommendation so wording is consistent across assessors.
   * The assessor may still amend on site - professional judgement stays central.
   */
  observation?: string;
  recommendation?: string;
  /** Id of the StandardParagraph this question references - either one Safentia
   *  ships (`sp-bs9792-...`) or one the organisation wrote (an RTDB push key).
   *  Resolve it through shared/standardParagraphs, never by reading one node. */
  standardParagraphRef?: string;
}

/**
 * One entry in the Standard Paragraphs library (FR-E21): settled reference
 * wording a template question can point at via `standardParagraphRef`.
 *
 * The library has TWO populations and an id says which is which:
 *   - the BS 9792 bank Safentia SHIPS, held in code (shared/standardParagraphs)
 *     with fixed `sp-bs9792-` ids. One source, never copied per organisation,
 *     so a wording correction lands for everyone on the next deploy.
 *   - the organisation's OWN, at /{env}/standardParagraphs/{orgId}/{paragraphId}
 *     under RTDB push keys (which always begin "-", so the two cannot collide).
 * Resolve a ref through shared/standardParagraphs, never by indexing one node.
 *
 * `reference` is the client's own numbering (e.g. "4.2.1") - display data,
 * never a key (RTDB keys cannot carry dots).
 *
 * WHAT READS THESE TODAY: the library screen and the template builder's picker,
 * and publishTemplate validates that a ref resolves. Nothing downstream consumes
 * them yet - they are not printed into the report, not shown to the assessor and
 * not fed to the AI summary. Said plainly because the previous version of this
 * comment claimed the AI summary was generated from them, which was never true,
 * and that claim reached the UI before anyone noticed.
 */
export interface StandardParagraph {
  reference: string;
  title?: string;
  body: string;
  updatedAt: number;
  /** The subject heading this paragraph sits under in the library, e.g.
   *  "Means of escape". Set on every paragraph in the built-in bank, which is
   *  grouped by it; optional on an organisation's own, which fall under
   *  "Your paragraphs" when they leave it unset. Display data, never a key. */
  subject?: string;
}

/** A section code is an OPAQUE, template-defined identifier for a subject within
 *  a template. Templates are fully customisable: an organisation may import the
 *  built-in base templates (PAS 79, BS 9792) or author a wholly custom one with
 *  any number of sections and any codes. The app therefore renders and orders
 *  sections from the template's OWN section list - never from a fixed global set.
 *  Zero-padded numeric strings ('01', '02', ...) are the convention because they
 *  sort lexicographically, but they are NOT required and NOT capped at 12. */
export type SectionCode = string;

/** The 12 canonical PAS 79 subject codes, in report order. Used ONLY to author
 *  the built-in PAS 79 base template and as a display fallback for it - it is NOT
 *  a constraint on BS 9792 or any custom template, which define their own. */
export const SECTION_CODES: SectionCode[] = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12',
];

export interface TemplateSection {
  id: string;
  code: SectionCode;
  title: string;
  questions: TemplateQuestion[];
}

export interface Template {
  name: string;
  version: number;
  status: TemplateStatus;
  /** When this version was published (stamped by publishTemplate; absent on
   *  drafts and on pre-builder seed data). */
  publishedAt?: number;
  /** The industry standard this template follows, selecting its report profile.
   *  Optional for backward tolerance: an untagged template renders under the
   *  generic (`custom`) profile. The two base templates set it explicitly. */
  standard?: ReportStandard;
  /** An organisation-supplied PDF (an accreditation certificate, a cover sheet)
   *  merged into every report rendered from this template. Absent = no insert. */
  certificate?: TemplateCertificate;
  sections: TemplateSection[];
}

/**
 * Where the accreditation PDF is spliced into the report. `afterCover` puts it
 * on page 2, immediately behind the title page and ahead of the contents - the
 * convention in the industry documents this report is modelled on, and now the
 * only supported position.
 *
 * `top` and `bottom` are retained ONLY so stored templates authored before this
 * change still parse; both are read as `afterCover` at render time (see
 * report/certificate.ts). Nothing offers them any more.
 */
export type CertificatePosition = 'afterCover' | 'top' | 'bottom';
export const CERTIFICATE_POSITIONS = ['afterCover'] as const;

/** A PDF spliced into the generated report. The pages are merged verbatim - the
 *  report renderer never rewrites them, so accreditation artwork stays intact. */
export interface TemplateCertificate {
  /** Tenant-scoped Storage path, validated by requireTenantStorageRef. */
  url: string;
  /** Original filename, shown in the console so admins can tell versions apart. */
  name: string;
  /** Whether the pages are prepended before the report or appended after it. */
  position: CertificatePosition;
  uploadedAt: number;
}

// ----------------------------------------------------------------------------
// Jobs (section 6) - the unit of distributed work
// ----------------------------------------------------------------------------

export type JobStatus =
  | 'scheduled'
  | 'inProgress'
  | 'readyForValidation'
  | 'infoRequired'
  | 'readyForRelease'
  | 'released'
  | 'cancelled';
export const JOB_STATUSES = [
  'scheduled',
  'inProgress',
  'readyForValidation',
  'infoRequired',
  'readyForRelease',
  'released',
  'cancelled',
] as const;

export interface Job {
  templateId: string;
  /** The job PINS the exact version it was created with so the assessment can
   *  never shift shape mid-flight (story 1031). */
  templateVersion: number;
  customerId: string;
  siteId: string;
  buildingId: string;
  assessorUid: string;
  scheduledFor: number;
  /** End of the visit's time slot. Slot scheduling enforces per-assessor
   *  clash-freedom between [scheduledFor, scheduledUntil). */
  scheduledUntil?: number;
  status: JobStatus;
}

// ----------------------------------------------------------------------------
// Assessments (section 6)
// ----------------------------------------------------------------------------

export type AssessmentStatus =
  | 'inProgress'
  | 'readyForValidation'
  | 'infoRequired'
  | 'readyForRelease'
  | 'released';
export const ASSESSMENT_STATUSES = [
  'inProgress',
  'readyForValidation',
  'infoRequired',
  'readyForRelease',
  'released',
] as const;

/** Client-facing stage names - use these EXACT words in UI copy (brief 6.1). */
export const ASSESSMENT_STAGE_LABELS: Record<AssessmentStatus, string> = {
  inProgress: 'Assessment in progress',
  readyForValidation: 'Ready for validation',
  infoRequired: 'More information required',
  readyForRelease: 'Complete, ready for release',
  released: 'Released',
};

export interface AssessmentNarrative {
  summary?: string;
  buildingDescription?: string;
  premisesCovered?: string;
  incidentHistory?: string;
  riskOpinion?: string;
}

/** Timestamps and attributions across the validation lifecycle. */
export interface AssessmentWorkflow {
  submittedAt?: number;
  checkedBy?: string;
  validatedBy?: string;
  acceptedAt?: number;
  releasedAt?: number;
  /** The account that performed the release (may differ from validatedBy: an
   *  admin can release what an auditor accepted). Stamped by releaseAssessment;
   *  the stage trigger prefers it for released-stage attribution. */
  releasedBy?: string;
}

export interface Assessment {
  jobId: string;
  buildingId: string;
  customerId: string;
  /** A copy of the pinned template at start time, so the assessment renders the
   *  exact questions it began with regardless of later template changes. */
  templateSnapshot: Template;
  conductedBy: string;
  conductedAt: number;
  /** The responsible party for this assessment and its actions. Defaulted from
   *  the building's `responsibleParty`; editable in-app so a visit can switch it
   *  without changing the building default. */
  responsibleParty?: ResponsibleParty;
  /** Manual overall-risk override set by the assessor. When present it drives the
   *  headline risk instead of the value calculated from the findings; `byUid` and
   *  `at` record who set it and when, so the manual change is auditable. */
  manualRiskLevel?: { level: RiskLevel; byUid: string; at: number };
  narrative?: AssessmentNarrative;
  workflow?: AssessmentWorkflow;
  status: AssessmentStatus;
}

// ----------------------------------------------------------------------------
// Assessment answers (section 6)
// ----------------------------------------------------------------------------

export interface AnswerPhoto {
  /** Storage path (tenant + env scoped). */
  path: string;
  title: string;
}

export interface FlagPin {
  /** Normalised 0..1 coordinates relative to the plan image, so the pin stays
   *  correct at any render size. */
  x: number;
  y: number;
  severity: Severity;
}

export interface AnswerFlag {
  planId: string;
  pins: FlagPin[];
  /** The flattened plan-plus-pins composite uploaded on save (brief 8). */
  flagImageUrl?: string;
}

/** A request for more information raised by an auditor on a specific question
 *  (story 1050). Retained as a thread for the audit trail. */
export interface InfoRequest {
  byUid: string;
  message: string;
  resolvedAt?: number;
  /** When the assessor is expected to have responded. Set for the whole batch
   *  when the auditor sends the basket (defaults to 7 days ahead, editable),
   *  so every request in one round shares a deadline. Drives the reminder
   *  sweep; absent on requests raised before deadlines existed. */
  dueBy?: number;
  /** Assessor's reply, kept alongside the request for the audit trail. */
  response?: string;
  respondedAt?: number;
}

/** Default window an assessor gets to answer an auditor's information request,
 *  counted from when the basket is sent. The auditor can override per batch. */
export const INFO_REQUEST_DUE_DAYS = 7;

export interface AssessmentAnswer {
  /** Free-text answer (text / longtext) or display text for other types. */
  text?: string;
  /** Typed value: boolean for yesno, string for select, string[] for
   *  multiselect. `unknown` is deliberate - callers narrow by question type. */
  value?: unknown;
  photos?: AnswerPhoto[];
  flags?: AnswerFlag[];
  /** Present when this answer is a non-conformity. */
  severity?: Severity;
  /** The assessor has explicitly judged this item NOT APPLICABLE to these
   *  premises. Mutually exclusive with `severity`: setting either one clears the
   *  other, so an answer can never be both a graded finding and not applicable.
   *
   *  It exists because "not applicable" and "not yet looked at" were previously
   *  the SAME state - an untouched non-conformity counts as answered - so the
   *  record could not distinguish an item the assessor had considered and
   *  dismissed from one they had never reached. It also removes the main source
   *  of friction in filling the form: once any part of a finding is started, both
   *  a severity AND an observation are required, so an item that simply does not
   *  apply had to be argued for in prose. N/A satisfies completion on its own.
   *
   *  A not-applicable answer is NOT a finding: it produces no action on release
   *  and carries no severity into the action plan. */
  notApplicable?: boolean;
  observation?: string;
  infoRequest?: InfoRequest;
  /** Server timestamp of the last write - the basis for last-write-wins conflict
   *  resolution (brief 12). */
  updatedAt?: number;
}

// ----------------------------------------------------------------------------
// Actions / action plan (section 6) - "LTP" = Life Protection
// ----------------------------------------------------------------------------

export type ActionStatus = 'open' | 'inProgress' | 'signedOff' | 'archived';
export const ACTION_STATUSES = ['open', 'inProgress', 'signedOff', 'archived'] as const;

/** Default due windows by severity (story 1045). High = 7 days, Medium = 30
 *  days, Low = 3 months; all editable by the assessor. */
export const DUE_WINDOW_DAYS: Record<Severity, number> = {
  H: 7,
  M: 30,
  L: 90,
};

export interface Action {
  assessmentId: string;
  sectionCode: SectionCode;
  question: string;
  observation: string;
  severity: Severity;
  /** The flag composite carried onto the action (brief 8 downstream + 1057). */
  locationFlagUrl?: string;
  images?: AnswerPhoto[];
  /** The responsible person's name AS RECORDED when the action was raised. Kept
   *  alongside the contact id, not derived from it: an action plan is a dated
   *  record of who was accountable at the time, and a contact later renamed or
   *  removed must not silently rewrite history. */
  responsible?: string;
  /** The CustomerContact accountable for this remedial work. The email seams
   *  (manageAction's assignment mail, deadlineReminders' chase) resolve the
   *  address through this rather than by matching on `responsible`, which is why
   *  name-matched lookups no longer decide whether someone gets told. */
  responsibleContactId?: string;
  dueBy?: number;
  /** The "LTP" flag - this remedial action protects life. */
  lifeProtection: boolean;
  status: ActionStatus;
  signedOffBy?: string;
  signedOffAt?: number;
  /** A note captured when the action is closed (signed off), recording HOW it
   *  was resolved (story 2044 AC2). Absent on open/in-progress actions. */
  completionNote?: string;
  /** Optional proof the remedial work was actually done, supplied at sign-off -
   *  a photo of the completed work or a contractor's PDF. Reuses the document
   *  shape because it IS one: a tenant Storage object with server-stamped
   *  provenance, never a client-supplied URL. Cleared by a reopen exactly as
   *  the completion note is; the status-history entry keeps the copy. */
  completionEvidence?: SafentiaDocument;
  /** The duty-holder's own latest word on this action, recorded from the
   *  customer portal (respondToAction). A CLAIM, never a closure: only a staff
   *  sign-off sets `status: 'signedOff'` and the provenance pair above, so this
   *  field tells the organisation there is something to verify. Cleared by a
   *  reopen exactly as the completion note is - the trail keeps the copy. */
  customerResponse?: ActionCustomerResponse;
  /** Append-only status-change trail (story 2044 AC3), oldest first, so a
   *  building owner can see when an action moved through its lifecycle without
   *  digging through the org-wide activity log. */
  statusHistory?: ActionStatusChange[];
}

/** One entry in an action's status history: what it moved to, who moved it, and
 *  when. `note` carries the completion note on the move to `signedOff`. */
export interface ActionStatusChange {
  status: ActionStatus;
  byUid: string;
  at: number;
  note?: string;
  /** The supporting evidence attached to a `signedOff` move. Held here as well
   *  as on the record so the trail still shows what was produced as proof after
   *  a later reopen clears the record's own copy. */
  evidence?: SafentiaDocument;
  /** Present ONLY on an entry a customer recorded about their own work. It is
   *  what separates "the duty-holder says the work is done" from "we verified
   *  and signed it off" in one trail, so a reader can never mistake a claim for
   *  an organisation's sign-off. */
  response?: ActionResponseState;
}

/** What a customer may claim about an action they are responsible for
 *  arranging: the work is in hand, or it is done and awaiting verification.
 *  Deliberately NOT an ActionStatus - a duty-holder can report progress but
 *  can never close their own compliance record. */
export type ActionResponseState = 'inHand' | 'completed';
export const ACTION_RESPONSE_STATES = ['inHand', 'completed'] as const;

/** The duty-holder's account of progress on an action, recorded through the
 *  respondToAction callable. `byUid` and `at` come from the verified portal
 *  session and the server clock, never the client, so a response can no more be
 *  back-dated or mis-attributed than a report acceptance can. */
export interface ActionCustomerResponse {
  state: ActionResponseState;
  /** The customer's dated note - what was done, by whom, when. Optional: a
   *  bare state change is a legitimate response on its own. */
  note?: string;
  byUid: string;
  at: number;
}

// ----------------------------------------------------------------------------
// Documents (section 6)
// ----------------------------------------------------------------------------

export type DocumentCategory =
  | 'fireDoorRecords'
  | 'floorPlans'
  | 'safetyPolicy'
  | 'emergencyPlans'
  | 'other'
  | 'ppmCertificates'
  | 'quotesRemedials'
  | 'trainingRecords'
  | 'signedWorkSurvey'
  | 'userGuides';
export const DOCUMENT_CATEGORIES = [
  'fireDoorRecords',
  'floorPlans',
  'safetyPolicy',
  'emergencyPlans',
  'other',
  'ppmCertificates',
  'quotesRemedials',
  'trainingRecords',
  'signedWorkSurvey',
  'userGuides',
] as const;

export interface SafentiaDocument {
  fileName: string;
  description?: string;
  storagePath: string;
  uploadedBy: string;
  uploadedAt: number;
}

// ----------------------------------------------------------------------------
// Log book (section 6) - APP WRITES ONLY in Phase 1, append-only
// ----------------------------------------------------------------------------

// The building Fire Safety Log Book holds GENUINE building fire-safety records
// only. Assessment WORKFLOW events (started, submitted, validated, released) are
// NOT log-book content - they live in the assessment's own activity timeline and
// the /activity audit trail. The one assessment-derived record that DOES belong
// here is `fraCompleted`: the milestone that a fire risk assessment was carried
// out / released for the building (written once, on release).
export type LogBookType =
  | 'fireIncident'
  | 'falseAlarm'
  | 'fireDoorRecord'
  | 'serviceConfirmed'
  | 'assessorAction'
  | 'fraCompleted';
export const LOG_BOOK_TYPES = [
  'fireIncident',
  'falseAlarm',
  'fireDoorRecord',
  'serviceConfirmed',
  'assessorAction',
  'fraCompleted',
] as const;

export interface LogBookEntry {
  type: LogBookType;
  /** Type-specific data; shape varies by `type`, validated at write time. */
  payload: Record<string, unknown>;
  byUid: string;
  at: number;
}

// ----------------------------------------------------------------------------
// Reports / notifications / activity / invitations (section 6)
// ----------------------------------------------------------------------------

export type ReportScope = 'building' | 'site' | 'customer';
export const REPORT_SCOPES = ['building', 'site', 'customer'] as const;

export interface Report {
  pdfPath: string;
  generatedAt: number;
  assessmentId?: string;
  emailedTo?: string[];
  webLink?: string;
  /** Present once the customer's contact has accepted the report. Until then the
   *  portal gates the PDF behind the acceptance prompt. */
  acceptance?: ReportAcceptance;
}

/** A customer contact's manual sign-off of a released report. The typed name is
 *  the artefact: it is what the contact entered, not a copy of their profile, so
 *  it stands as their own attestation in the audit trail. */
export interface ReportAcceptance {
  /** Name exactly as the contact typed it at the acceptance prompt. */
  name: string;
  /** The portal account that accepted, resolved server-side from the caller. */
  byUid: string;
  at: number;
}

export interface Notification {
  type: string;
  title: string;
  body: string;
  link?: string;
  readAt?: number;
}

/**
 * The actor recorded on an /activity entry the PLATFORM wrote rather than a
 * person - a scheduled sweep archiving a customer whose contract has ended, for
 * instance. It can never collide with a real uid (Firebase uids are 28 opaque
 * characters), and the console renders it as an automation rather than looking
 * it up in the staff directory and calling it a former member.
 */
export const SYSTEM_ACTOR_UID = 'system';

export interface ActivityEntry {
  actorUid: string;
  action: string;
  target: string;
  at: number;
}

/** One entry in the per-org email send log (`/{env}/emailLog/{orgId}`), appended
 *  server-side by the email seam (lib/email) for every dispatch attempt, so an
 *  admin can see what was sent, when, and whether it actually left. Admin-only
 *  read; never client-writable. */
export interface EmailLogEntry {
  /** The recipient, stored REDACTED: the first character of the local part plus
   *  the full domain (e.g. `j***@example.com`). The log only needs enough for an
   *  admin to recognise WHO was written to; storing the full address would
   *  duplicate PII into a long-lived log for no operational gain (data
   *  minimisation, brief 18.4). */
  to: string;
  subject: string;
  /** The send's business category (e.g. 'invitation', 'review-reminder'), so the
   *  log filters by purpose without parsing subjects. */
  category: string;
  /** Epoch millis, server clock, at the dispatch attempt. */
  sentAt: number;
  /** What actually happened: delivered to the provider, skipped because no
   *  provider key is configured, or the provider rejected / was unreachable. */
  outcome: 'sent' | 'skipped-no-provider' | 'failed';
  /** The EmailKindId that produced the send. Optional because entries written
   *  before the templating seam existed lack it; the console must tolerate
   *  both. */
  kindId?: string;
  /** The org template rendered for the send; absent means the built-in default
   *  copy was used. */
  templateId?: string;
  /**
   * How many queued sends this ONE email carried, when it was a bundle. Absent
   * or 1 means an ordinary single send - which is also what a bundle of one
   * renders as, deliberately: a digest of one item would read worse than the
   * message it replaced. Set only by the digest flush, so the send log can say
   * 'Digest of 12' where twelve emails would once have been listed.
   */
  bundledCount?: number;
}

// ----------------------------------------------------------------------------
// Org email templating (section 6b). Admins customise the copy of every
// outgoing email kind, toggle kinds off, and compose manual sends. A template
// is a subject plus an ordered list of blocks whose vocabulary matches the
// branded renderer one-to-one, so anything an admin can author is renderable
// by construction. Absent settings mean "enabled, built-in default copy" -
// the system needs no seeding and behaves exactly as before until an admin
// edits something.
// ----------------------------------------------------------------------------

/**
 * Every distinct outgoing email the platform sends, one id per (purpose,
 * audience) pair - the same business event can address admins, assessors and
 * customer contacts with different copy, and blurring them would make toggles
 * and templates ambiguous. 'manual' is the admin-composed send. The full
 * definitions (default copy, variable catalogues, audiences) live in the
 * mirrored emailKindCatalogue module; this is only the schema-level
 * vocabulary.
 */
export type EmailKindId =
  | 'invitation'
  | 'review-reminder-admin'
  | 'review-reminder-contact'
  | 'deadline-info-assessor'
  | 'deadline-action-contact'
  | 'deadline-admin-digest'
  | 'job-reminder'
  | 'job-assigned'
  | 'job-rescheduled'
  | 'job-cancelled'
  | 'visit-scheduled'
  | 'visit-rescheduled'
  | 'visit-reassigned'
  | 'visit-cancelled'
  | 'awaiting-validation'
  | 'released-admin'
  | 'released-contact'
  | 'released-assessor'
  | 'release-digest'
  | 'info-requested'
  | 'action-assigned'
  | 'field-contact-added'
  | 'contract-ended'
  | 'payment-failed'
  | 'payment-receipt'
  | 'subscription-ended'
  | 'manual';

export const EMAIL_KIND_IDS = [
  'invitation',
  'review-reminder-admin',
  'review-reminder-contact',
  'deadline-info-assessor',
  'deadline-action-contact',
  'deadline-admin-digest',
  'job-reminder',
  'job-assigned',
  'job-rescheduled',
  'job-cancelled',
  'visit-scheduled',
  'visit-rescheduled',
  'visit-reassigned',
  'visit-cancelled',
  'awaiting-validation',
  'released-admin',
  'released-contact',
  'released-assessor',
  'release-digest',
  'info-requested',
  'action-assigned',
  'field-contact-added',
  'contract-ended',
  'payment-failed',
  'payment-receipt',
  'subscription-ended',
  'manual',
] as const;

/** A label/value row authored inside a 'detail-rows' block. */
export interface EmailTemplateDetailRow {
  id: string;
  label: string;
  value: string;
}

/**
 * One block of an org email template. Every text field may carry {{variable}}
 * tokens resolved by the mirrored variable engine at render time; values are
 * HTML-escaped inside the renderer, never earlier.
 */
export type EmailTemplateBlock =
  | {
      id: string;
      type: 'paragraph';
      text: string;
      /** Drop the paragraph entirely when every {{variable}} in it resolves
       *  empty - e.g. an optional cancellation reason. */
      omitIfEmpty?: boolean;
    }
  | {
      id: string;
      type: 'detail-rows';
      /** 'kind' rows are supplied dynamically by the send site (digest lists,
       *  visit cards); 'custom' rows are authored in `rows`. */
      source: 'custom' | 'kind';
      rows?: EmailTemplateDetailRow[];
    }
  | {
      id: string;
      type: 'cta';
      label: string;
      /** Templated URL; ignored when useKindLink is set. */
      href?: string;
      /** Take the kind's canonical per-recipient link from the send site
       *  instead of an authored URL. */
      useKindLink?: boolean;
    };

/** An org-authored email template (`/{env}/emailTemplates/{orgId}/{id}`).
 *  Admin-editable directly under rules (the editor autosaves); the server
 *  validates renderability at send time and falls back to the built-in
 *  default rather than failing a business operation over a bad template. */
export interface EmailTemplate {
  name: string;
  /** Templated, like preheader, heading and all block text. */
  subject: string;
  preheader?: string;
  heading: string;
  blocks: EmailTemplateBlock[];
  /** Absent means the kind's default footer. */
  footerNote?: string;
  updatedAt: number;
  updatedBy: string;
}

/**
 * How a kind reaches its recipient, the rule that keeps one person from being
 * emailed a hundred times in a morning. The guarantee the three policies exist
 * to deliver is: FOR EACH (recipient address, kind), AT MOST ONE EMAIL PER UK
 * CALENDAR DAY - everything else that happened that day is bundled into it.
 *
 * - 'immediate' - always sends now, never queued, never counted against the
 *   day slot. Security and access-critical mail ('invitation',
 *   'payment-failed', 'subscription-ended'), the admin-composed 'manual' send,
 *   and the two kinds that are ALREADY one-per-recipient-per-day by
 *   construction ('job-reminder', 'deadline-admin-digest').
 * - 'collapse' - the FIRST event of the day sends immediately, in the kind's
 *   ordinary copy, and claims the day slot; every later event that day is
 *   queued and bundled into the next flush. Event-driven mail, where the first
 *   one is news and the twentieth is noise.
 * - 'digest' - never sends immediately; always queued. The sweep-driven
 *   reminders, which are a daily batch by nature and whose crons all run
 *   BEFORE the flush - so the digest still arrives the same morning.
 *
 * Declared per kind in the mirrored emailKindCatalogue, not stored per org:
 * the policy is a property of what the email IS, not a preference.
 */
export type EmailDeliveryPolicy = 'immediate' | 'collapse' | 'digest';

export const EMAIL_DELIVERY_POLICIES = [
  'immediate',
  'collapse',
  'digest',
] as const;

/** Per-kind org settings (`/{env}/emailSettings/{orgId}/kinds/{kindId}`).
 *  Absent node = enabled with the built-in default template. 'invitation' may
 *  never be disabled (security email); rules and server both enforce it. */
export interface EmailKindSettings {
  enabled?: boolean;
  templateId?: string;
  /**
   * The template rendered when this kind's sends are BUNDLED - two or more of
   * them collapsed into one daily email. Deliberately a second slot rather
   * than a second EmailKindId: an org's ordinary template is written in the
   * singular ('the review for Rose Court is due in 60 days') and cannot be
   * reused for forty buildings, but nor may it be rewritten under them. Absent
   * means the kind's built-in digest default. Only kinds whose catalogue entry
   * carries a `digest` block can be bundled, so only those show the slot.
   */
  digestTemplateId?: string;
}

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';
export const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'revoked'] as const;

export interface Invitation {
  orgId: string;
  customerId?: string;
  /** The CustomerContact this portal invite belongs to; acceptInvitation
   *  writes the accepted account's uid back onto that contact. */
  contactId?: string;
  email: string;
  roles: OrgRoleSet;
  /** Tokenised single-use accept secret. */
  token: string;
  expiresAt: number;
  status: InvitationStatus;
}

/**
 * Admin-facing summary of an invitation, kept under
 * /{env}/orgInvitations/{orgId}/{inviteId} so an organisation can LIST its own
 * invitations (the /invitations root is unreadable by clients - it holds the
 * bearer tokens). Maintained by the invitation Functions; the token is never
 * copied here, so a compromised admin read still cannot accept on a victim's
 * behalf.
 */
export interface InvitationSummary {
  email: string;
  roles: OrgRoleSet;
  customerId?: string;
  contactId?: string;
  status: InvitationStatus;
  expiresAt: number;
  createdAt: number;
  invitedBy: string;
}

// ============================================================================
// Cloud Function call contracts (brief 4.5)
//
// Every callable's input, success and error shape lives here and is imported by
// BOTH the Function and its caller, so the two never define the same shape twice.
// ============================================================================

/**
 * Structured, actionable error a Function returns to the client. The `code` is
 * what the UI branches on; `message` is human-readable British-English copy safe
 * to show an assessor. Raw Firebase errors are NEVER surfaced (brief 4.5 + 18.3).
 */
export type SafentiaErrorCode =
  | 'unauthenticated'
  | 'permission-denied'
  | 'app-check-failed'
  | 'invalid-argument'
  | 'not-found'
  | 'already-exists'
  | 'failed-precondition'
  | 'resource-exhausted'
  | 'internal';

export interface SafentiaError {
  code: SafentiaErrorCode;
  message: string;
  /** Optional machine-readable detail for the UI (e.g. which field failed). */
  details?: Record<string, unknown>;
}

// --- createInvitation (admin only) ---
export interface CreateInvitationInput {
  email: string;
  roles: OrgRoleSet;
  customerId?: string;
  /** Required with customerId: the contact this portal invitation is for. */
  contactId?: string;
}
export interface CreateInvitationResult {
  inviteId: string;
  expiresAt: number;
}

// --- previewInvitation (public, token-bearing) ---
/**
 * What /invite needs to know BEFORE it can ask the recipient for anything. The
 * page cannot read /invitations (it holds bearer tokens and is closed to
 * clients), so without this it can only guess which of "create an account" or
 * "sign in to the account you already have" applies, and it cannot name the
 * address the invitation was sent to.
 */
export interface PreviewInvitationInput {
  token: string;
}
export interface PreviewInvitationResult {
  /** The invited address. Safe to return only because the caller already holds
   *  the single-use token that was emailed to it (see previewInvitation.ts). */
  email: string;
  /** The inviting organisation's display name, for "join <org>" copy. */
  orgName: string;
  /** Present only for a customer-portal invitation: the customer being joined. */
  customerName?: string;
  /** Whether an account already exists for `email`, which decides whether the
   *  page offers sign-up or sign-in. */
  accountExists: boolean;
}

// --- acceptInvitation (public, token-bearing) ---
export interface AcceptInvitationInput {
  token: string;
  /** Required only for email/password account creation; absent for Google. */
  password?: string;
  displayName?: string;
}
export interface AcceptInvitationResult {
  orgId: string;
  uid: string;
  /** A Firebase custom token for the account this call just CREATED, so the
   *  page can sign the new member straight in instead of asking them to retype
   *  the password they chose seconds ago. Absent when the account already
   *  existed: those callers had to be signed in as it to get this far. */
  customToken?: string;
  /** The customer whose portal space this invitation joined, absent for a staff
   *  invitation. Returned so the page can make the space it just joined the
   *  ACTIVE one: accepting while already signed in elsewhere otherwise lands the
   *  member back in their previous space, looking as though nothing happened. */
  customerId?: string;
}
/**
 * Why an acceptInvitation call was refused. Every case below leaves the wire as
 * the same 'failed-precondition' code, so the reason travels in the error's
 * `details.reason` instead: /invite is the first screen a new customer ever
 * sees, and it must be able to tell "already used" from "expired" to offer the
 * right way forward rather than one raw message.
 */
export const INVITE_FAILURE_REASONS = [
  /** Already accepted, or revoked by an administrator. */
  'used',
  /** Still pending, but past its expiry. */
  'expired',
  /** The customer contact the invite was issued for has since been removed. */
  'contact-removed',
  /** That contact is already linked to a different account. */
  'contact-linked',
  /** An account already exists for the invited address, and the caller has not
   *  proved they are it. Possession of the token alone must not bind someone
   *  else's existing account, so acceptInvitation requires the caller to be
   *  signed in as that account first. */
  'sign-in-required',
] as const;
export type InviteFailureReason = (typeof INVITE_FAILURE_REASONS)[number];

// --- createJob (admin only) ---
export interface CreateJobInput {
  templateId: string;
  templateVersion: number;
  customerId: string;
  siteId: string;
  buildingId: string;
  assessorUid: string;
  scheduledFor: number;
  /** End of the slot; required by the console (clash checking), optional in the
   *  contract so historic date-only jobs remain valid. */
  scheduledUntil?: number;
}
export interface CreateJobResult {
  jobId: string;
}

// --- startAssessment (assessor-on-job only; idempotent) ---
export interface StartAssessmentInput {
  jobId: string;
}
export interface StartAssessmentResult {
  assessmentId: string;
  /** true when an existing assessment was resumed rather than created. */
  resumed: boolean;
}

// --- submitAssessment (assessor only) ---
export interface SubmitAssessmentInput {
  assessmentId: string;
}
export interface SubmitAssessmentResult {
  status: AssessmentStatus;
}

// --- changeAssessmentTemplate (the assessor on the job, while in progress) ---
/**
 * Swap the template an in-progress assessment is being conducted against. This
 * DELETES every answer already recorded: question ids are template-specific, so
 * answers cannot be carried across, and leaving them would silently attach a
 * previous template's evidence to a new question set. The client must warn
 * before calling.
 */
export interface ChangeAssessmentTemplateInput {
  assessmentId: string;
  /** The PUBLISHED template to switch to. Its current version is pinned. */
  templateId: string;
}
export interface ChangeAssessmentTemplateResult {
  templateName: string;
  templateVersion: number;
  /** How many recorded answers the change deleted, for the confirmation copy. */
  answersRemoved: number;
}

// --- setActiveOrganisation (any member of the target org) ---
// Switches which organisation the signed-in user is acting in, by re-minting
// their custom claims for that org. The client force-refreshes its token after,
// so org/roles/environment all follow the new claim.
export interface SetActiveOrganisationInput {
  orgId: string;
  /** Present to enter a PORTAL space at `orgId` rather than the staff console.
   *  The two halves are mutually exclusive in the token by design (a portal
   *  token carries `portalOrgId` and never `orgId`), so switching between them
   *  is a re-mint of the claims, not a second set held alongside. */
  customerId?: string;
}
export interface SetActiveOrganisationResult {
  orgId: string;
  /** The role names the user holds in the newly active org. Empty for a portal
   *  space, whose permissions come from the contact's `portalRoles` instead. */
  roles: OrgRole[];
  /** Echoes the customer entered, so the caller can confirm which half it
   *  landed in without re-reading its own request. */
  customerId?: string;
}

/** Which half of the product a space belongs to. */
export type SpaceKind = 'staff' | 'portal';
export const SPACE_KINDS = ['staff', 'portal'] as const;

/**
 * One switchable space in the picker: an organisation this account works FOR
 * (staff) or a customer whose records it can see (portal).
 *
 * Assembled client-side by merging `/userOrgs/{uid}` with
 * `/customerUserIndex/{uid}` and resolving display names, so it is a view model
 * rather than a stored record. Most people hold exactly one and never see the
 * picker; it exists because a person can legitimately be staff at the firm they
 * work for and a contact at a customer elsewhere.
 */
export interface UserSpace {
  kind: SpaceKind;
  orgId: string;
  /** Portal spaces only; absent on a staff space. */
  customerId?: string;
  /** What the person will recognise: the customer's name for a portal space,
   *  the organisation's for a staff one. */
  name: string;
  /** The assessing organisation behind a portal space, shown as context so a
   *  contact can tell two customers of different firms apart. */
  orgName?: string;
  /** The assessing organisation's logo, where the profile is readable and one is
   *  set, so the picker wears each space's own identity rather than a generic
   *  monogram. Readable for every org the user staffs and for the active portal
   *  org; absent otherwise, and the picker falls back to a monogram. */
  logoUrl?: string;
  /** The organisation's brand colour (its `brand.primary`), used as a FILL for
   *  the space's mark. Never painted as text or a border: an arbitrary org
   *  colour can be any contrast, so the picker computes a readable ink to sit on
   *  it rather than using it as ink itself. */
  brandColor?: string;
  /** True for the space the current claims already point at. */
  isCurrent: boolean;
}

// --- generateReport (admin / auditor only) ---
export interface GenerateReportInput {
  assessmentId: string;
  /** Optional recipients to email the report to once generated. */
  emailTo?: string[];
}
export interface GenerateReportResult {
  reportId: string;
  pdfPath: string;
}

// --- generateAssessmentDraft (assessor on job; AI-assisted, online only) ---
/** One issue the AI surfaced from the answers, tied to the UK regulation it
 *  engages. Severity uses the non-conformity scale so it lines up with the RAG
 *  meter and, downstream, the action plan. */
export interface DraftIssue {
  /** PAS 79 section code the finding sits under (e.g. "04"). */
  sectionCode: string;
  /** The question the finding relates to. */
  question: string;
  /** Plain-British description of the issue to be addressed. */
  finding: string;
  severity: Severity;
  /** The UK fire-safety regulation or standard the finding engages, e.g.
   *  "Regulatory Reform (Fire Safety) Order 2005, art. 14" or "BS 5839-1". */
  regulation: string;
  /** What the responsible person should do to remedy it. */
  recommendedAction: string;
}
export interface GenerateAssessmentDraftInput {
  assessmentId: string;
}
export interface GenerateAssessmentDraftResult {
  /** AI-drafted narrative blocks for the assessor to review and edit. */
  narrative: AssessmentNarrative;
  /** The issues the AI identified across the answers, grounded in UK regs. */
  issues: DraftIssue[];
}

// --- createOrganisation (any signed-in account; creator becomes admin) ---
export interface CreateOrganisationInput {
  name: string;
}
export interface CreateOrganisationResult {
  orgId: string;
}

// --- updateOrgProfile (admin) ---
export interface UpdateOrgProfileInput {
  /** Partial update; only present fields change. logoUrl points at an object the
   *  caller already uploaded through the tenant-scoped Storage pipeline. */
  profile: {
    name?: string;
    brand?: OrgBrand;
    contact?: OrgContact | null;
    /** null (or empty string) removes the override; the platform default applies. */
    fontFamily?: string | null;
    logoUrl?: string | null;
    /** Same tenant-scoped Storage reference as logoUrl; null removes it and the
     *  report cover falls back to a panel painted from the brand colours. */
    coverImageUrl?: string | null;
  };
}
export interface UpdateOrgProfileResult {
  updated: true;
}

// --- updateOrgSettings (admin) ---
export interface UpdateOrgSettingsInput {
  /** House guidance for the AI summary writer, this organisation's own. Explicit
   *  null clears it; absent leaves the stored value unchanged. Guidance FOR the
   *  model - never report wording, which is the standard paragraphs' job. */
  aiGuidance?: string | null;
  /** The full RAG config, replaced whole when present. Optional so a caller can
   *  save the reminder schedule on its own without resending scoring thresholds
   *  (and vice versa); each field written only when supplied. */
  ragConfig?: RagConfig;
  /** FRA-review reminder schedule (story 2046 AC1): descending positive day
   *  offsets, e.g. [60, 30, 7]. Explicit null clears it back to the built-in
   *  default; absent leaves the stored value unchanged. */
  reviewReminderDays?: number[] | null;
  /** Master on/off for the review reminder sweep. Absent leaves the stored
   *  value unchanged; false stops the sweep for the whole organisation. */
  reviewRemindersEnabled?: boolean;
  /** Information-request reminder schedule: descending positive day offsets,
   *  e.g. [3, 1]. Explicit null clears it back to the built-in default; absent
   *  leaves the stored value unchanged. */
  infoRequestReminderDays?: number[] | null;
  /** Master on/off for the information-request chases. */
  infoRequestRemindersEnabled?: boolean;
  /** Action reminder schedule: descending positive day offsets, e.g.
   *  [30, 7, 1]. Explicit null clears it back to the built-in default; absent
   *  leaves the stored value unchanged. */
  actionReminderDays?: number[] | null;
  /** Master on/off for the action chases. */
  actionRemindersEnabled?: boolean;
}
export interface UpdateOrgSettingsResult {
  updated: true;
}

// --- sendManualEmail (admin; explicit one-off send of an org template) ---
/** One addressee of a manual send, named by reference wherever possible so the
 *  server resolves the CURRENT address (a stale client cannot mail an old one):
 *  a member by uid, a customer contact by its customer/contact pair, or - for
 *  someone outside the system - a raw address. */
export type ManualEmailRecipient =
  | { type: 'member'; uid: string }
  | { type: 'contact'; customerId: string; contactId: string }
  | { type: 'email'; email: string };
export interface SendManualEmailInput {
  /** The org template to render (`/{env}/emailTemplates/{orgId}/{id}`); it must
   *  exist and be renderable - a manual send is an explicit act, so there is NO
   *  fall back to built-in copy. */
  templateId: string;
  /** 1..50 recipients; duplicates (case-insensitive on the resolved address)
   *  are sent once. */
  recipients: ManualEmailRecipient[];
  /** Author-supplied variable values for the template's tokens. Keys must not
   *  start `org.` or `recipient.` - those namespaces are server-derived and a
   *  caller must not be able to spoof them. */
  variables?: Record<string, string>;
}
export interface SendManualEmailResult {
  /** EXACTLY one row per INPUT recipient, in INPUT order (results.length ===
   *  recipients.length) - the client can join each row back to what it sent by
   *  index without guessing. `to` is REDACTED (j***@example.com) - the full
   *  address never travels back to the client (data minimisation, brief 18.4) -
   *  and is '***' where no address resolved at all. */
  results: Array<{
    /** Index into the request's `recipients` array this row reports on. */
    recipient: number;
    to: string;
    /** 'duplicate' = the same resolved address (case-insensitive) appeared
     *  earlier in the list; the earlier row carries the send outcome and this
     *  one was deliberately not sent twice. */
    outcome:
      | 'sent'
      | 'skipped-no-provider'
      | 'failed'
      | 'invalid-recipient'
      | 'duplicate';
  }>;
}

// --- updateMember (admin; the last active admin is protected server-side) ---
export interface UpdateMemberInput {
  memberUid: string;
  /** Replacement role set; omitted = unchanged. */
  roles?: OrgRoleSet;
  /** Target status; omitted = unchanged. Lock blocks sign-in on next token
   *  refresh; archive removes from pickers while preserving history. */
  status?: MemberStatus;
}
export interface UpdateMemberResult {
  updated: true;
}

// --- updateCustomerMember (the CUSTOMER-PORTAL twin of updateMember) ---
// Changes the roles - and optionally the standing - of a portal account that
// ALREADY EXISTS. Before this, `CustomerContact.portalRoles` was only an INTENT:
// acceptInvitation read it once to mint the account's /customerMembers record and
// nothing ever re-read it, so editing a contact's roles afterwards moved nothing
// and the only correction available was revoke-and-re-invite, which is not a
// correction but a new account.
//
// TWO legitimate callers, authorised on their own terms and never
// interchangeable: an ORG STAFF admin acting on a customer in their own
// organisation, and a PORTAL admin acting on a teammate of their own customer
// (whose org and customer come from the verified portal token, never the
// payload). The server writes the linked contact's `portalRoles` in the SAME
// atomic update, so the intent and the live grant stop disagreeing.
export interface UpdateCustomerMemberInput {
  /** The customer whose portal account this is. A STAFF caller must send it; a
   *  PORTAL caller's customer comes from their token, so anything sent here is
   *  ignored rather than trusted. */
  customerId?: string;
  /** The account to change: a uid under /customerMembers/{orgId}/{customerId}. */
  memberUid: string;
  /** Replacement role set; omitted = unchanged. Non-empty when sent - an
   *  account with no roles is a seat nobody can explain. */
  roles?: CustomerRoleSet;
  /** Target standing; omitted = unchanged. Locking strips their portal claims on
   *  the next token refresh, seconds later, without deleting anything. */
  status?: PortalAccountStatus;
}
export interface UpdateCustomerMemberResult {
  updated: true;
}

// --- revokeInvitation / resendInvitation (admin, own org only) ---
export interface RevokeInvitationInput {
  inviteId: string;
}
export interface RevokeInvitationResult {
  revoked: true;
}
export interface ResendInvitationInput {
  inviteId: string;
}
export interface ResendInvitationResult {
  /** The fresh expiry; resending mints a NEW token and kills the old link. */
  expiresAt: number;
}

// --- manageCustomer / manageSite / manageBuilding (admin CRUD; every action
//     writes an /activity entry server-side, which is why these are callables
//     rather than rules-governed client writes: the audit trail cannot be
//     skipped or forged when the same Function writes both) ---
/**
 * A partial update whose fields can also be explicitly CLEARED: `null` deletes
 * the field (RTDB write semantics), absent leaves it unchanged. Without this
 * distinction an edit form cannot empty a previously-set optional - omitting
 * the key reads as "no change", so a blanked phone number or responsible party
 * silently survives on the record. Servers still reject `null` on required
 * fields (name etc.); the type admits it so the CLEAR intent can travel.
 */
export type ClearableFields<T> = { [K in keyof T]?: T[K] | null };

export type ManageAction = 'create' | 'update' | 'archive';

export interface ManageCustomerInput {
  /** `restore` returns an archived customer to active. */
  action: ManageAction | 'restore';
  /** Required for update/archive. */
  customerId?: string;
  /** Fields to set (create) or change (update); null clears. Ignored for archive. */
  customer?: ClearableFields<Customer>;
  /**
   * Create only: the organisation's primary contact. The Function creates the
   * contact (isPrimary, portal admin) and, when an email is given, issues the
   * portal invitation and sends the branded email - all server-side, so a
   * customer can never exist half-provisioned.
   */
  primaryContact?: {
    name: string;
    email?: string;
    phone?: string;
    jobTitle?: string;
  };
}
export interface ManageCustomerResult {
  customerId: string;
  /** Present when action was create with a primaryContact. */
  primaryContactId?: string;
  /** Present when the primary contact was auto-invited (had an email). */
  inviteId?: string;
}

// --- manageCustomerContact (admin) ---
export interface ManageCustomerContactInput {
  action: 'create' | 'update' | 'remove';
  customerId: string;
  /** Required for update/remove. */
  contactId?: string;
  contact?: ClearableFields<CustomerContact>;
}
export interface ManageCustomerContactResult {
  contactId: string;
}

export interface ManageSiteInput {
  action: Exclude<ManageAction, 'archive'>;
  customerId: string;
  /** Required for update. */
  siteId?: string;
  site?: ClearableFields<Site>;
}
export interface ManageSiteResult {
  siteId: string;
}

export interface ManageBuildingInput {
  action: Exclude<ManageAction, 'archive'>;
  /** The site the building belongs to (buildings are stored per site). */
  siteId: string;
  /** Required for update. */
  buildingId?: string;
  building?: ClearableFields<Building>;
}
export interface ManageBuildingResult {
  buildingId: string;
}

// --- importRecords (admin; bulk CSV import of an estate) ---
/**
 * One building as a CSV import row carries it. A deliberate SUBSET of Building:
 * the platform-derived fields (riskLevel, ragDistribution, lastAssessedAt) can
 * never come from a file, and the pointer fields (photoUrl, floor plans) need
 * an upload rather than a cell. serviceSchedule carries the FRA review only -
 * the other statutory dates are maintained on the building record.
 */
export interface ImportBuildingRow {
  name: string;
  address?: string;
  responsibleParty?: ResponsibleParty;
  article53Persons?: string[];
  details?: BuildingDetails;
  serviceSchedule?: ServiceSchedule;
}

/** One site and the buildings that stand on it, as grouped from the CSV rows.
 *  `buildings` may be empty: a site can be recorded before its buildings are. */
export interface ImportSiteRow {
  name: string;
  address?: string;
  email?: string;
  phone?: string;
  geo?: GeoPoint;
  buildings: ImportBuildingRow[];
}

/**
 * A whole-file import, applied in ONE atomic write so a part-created estate can
 * never be left to unpick. `sites` mode creates sites and their buildings under
 * a customer; `buildings` mode adds buildings to one existing site.
 */
export interface ImportRecordsInput {
  mode: 'sites' | 'buildings';
  customerId: string;
  /** Required for `buildings`: the site the records land on. */
  siteId?: string;
  /** Required for `sites`. */
  sites?: ImportSiteRow[];
  /** Required for `buildings`. */
  buildings?: ImportBuildingRow[];
}
export interface ImportRecordsResult {
  sitesCreated: number;
  buildingsCreated: number;
}

// --- manageFloorPlan (admin; file already uploaded via Storage rules) ---
export interface ManageFloorPlanInput {
  action: 'create' | 'update' | 'remove' | 'reorder';
  buildingId: string;
  /** Required for update/remove. */
  planId?: string;
  plan?: ClearableFields<FloorPlan>;
  /** Required for `reorder` (story 2021): every plan id for this building in the
   *  intended order. The callable rejects a list that is not exactly the current
   *  set, so a stale reorder can never drop or invent a plan. */
  order?: string[];
}
export interface ManageFloorPlanResult {
  planId: string;
}

// --- manageBuildingDocument (admin; file already uploaded via Storage rules) ---
export interface ManageBuildingDocumentInput {
  action: 'create' | 'remove';
  buildingId: string;
  category: DocumentCategory;
  /** Required for remove. */
  docId?: string;
  document?: ClearableFields<SafentiaDocument>;
}
export interface ManageBuildingDocumentResult {
  docId: string;
}

// --- updateMyPreferences (any signed-in member; strictly self-scoped) ---
export interface UpdateMyPreferencesInput {
  emailPreferences: EmailPreferences;
}
export interface UpdateMyPreferencesResult {
  updated: true;
}

// --- manageAction (admin; the action plan between assessments, story 2043) ---
export interface ManageActionInput {
  buildingId: string;
  /** Required for update/signOff/reopen/start. */
  actionId?: string;
  /** `start` moves an open action to in progress (story 2044); `signOff` closes
   *  it (optionally with a completion note); `reopen` returns it to open. Status
   *  moves ONLY via these verbs so the provenance fields and the history trail
   *  can never be forged by a plain field edit. */
  action: 'create' | 'update' | 'start' | 'signOff' | 'reopen';
  /** create: observation + severity required. update: whitelisted fields only
   *  (responsibleContactId, dueBy, observation).
   *
   *  There is deliberately NO `responsible` here. Who owes an action is set by
   *  naming a CustomerContact, and the server writes the name from that
   *  contact's own record - a typed name could never be emailed, so it is no
   *  longer accepted. Null clears the assignment (name and link together). */
  fields?: {
    observation?: string;
    severity?: Severity;
    responsibleContactId?: string | null;
    dueBy?: number | null;
    lifeProtection?: boolean;
  };
  /** A note recorded on `signOff`, describing how the action was resolved
   *  (story 2044 AC2). Optional; ignored for every other verb. */
  completionNote?: string;
  /** Optional supporting evidence recorded on `signOff`: a file the caller has
   *  ALREADY uploaded to its own tenant Storage prefix. Only the file name and
   *  the object path travel - the server validates the path against that prefix
   *  and stamps uploadedBy/uploadedAt itself, so a free-text URL or another
   *  tenant's object can never become an action's proof. Ignored elsewhere. */
  completionEvidence?: {
    fileName: string;
    storagePath: string;
  };
}
export interface ManageActionResult {
  actionId: string;
}

// --- publishTemplate (admin) ---
// Drafts are edited directly under rules at /templateDrafts (autosave-friendly);
// publishing is the auditable, atomic moment: the callable validates the draft,
// bumps the version, promotes it to the live /templates node (client-immutable
// once published), archives a frozen copy under /templateVersions for history
// (story 2053), clears the draft and writes the activity entry.
export interface PublishTemplateInput {
  templateId: string;
}
export interface PublishTemplateResult {
  version: number;
}

// --- rescheduleJob / cancelJob (admin) ---
export interface RescheduleJobInput {
  jobId: string;
  scheduledFor: number;
  scheduledUntil?: number;
  /** Optionally move the visit to a different assessor at the same time. */
  assessorUid?: string;
}
export interface RescheduleJobResult {
  updated: true;
}
export interface CancelJobInput {
  jobId: string;
  /** Shown to the assessor in the cancellation notification. */
  reason?: string;
}
export interface CancelJobResult {
  cancelled: true;
}

// --- Auditor lifecycle (FR-E18): every transition server-side ---
export interface RequestInfoInput {
  assessmentId: string;
  /** One open InfoRequest per flagged question. */
  requests: Array<{ questionId: string; message: string }>;
  /** Response deadline stamped onto every request in this batch. Omitted =
   *  INFO_REQUEST_DUE_DAYS ahead of the server clock. */
  dueBy?: number;
}
export interface RequestInfoResult {
  flagged: number;
}
export interface AcceptAssessmentInput {
  assessmentId: string;
}
export interface AcceptAssessmentResult {
  accepted: true;
}
// --- acceptReport (portal; the customer contact signs the report off) ---
// Called once per report by a signed-in portal contact. The name is theirs to
// type; the server takes the uid and the timestamp from the verified session so
// neither can be spoofed by the client.
export interface AcceptReportInput {
  buildingId: string;
  reportId: string;
  /** The contact's full name, as typed at the acceptance prompt. */
  name: string;
}
export interface AcceptReportResult {
  acceptedAt: number;
}

// --- getReportDownloadUrl (portal + staff; the report PDF, authorised live) ---
// THE way a report PDF is opened. The stored object grants a portal token
// nothing: the server re-derives the building's owning customer, the caller's
// portal seat and their acceptance on EVERY request from live database state,
// then returns a short-lived signed URL. Nothing durable is embedded in the
// page, so the answer can never go stale the way a stamp on the file did.
export interface GetReportDownloadUrlInput {
  buildingId: string;
  reportId: string;
}
export interface GetReportDownloadUrlResult {
  /** A signed URL valid until `expiresAt`. Use it, do not store it - the client
   *  asks again on the next click rather than holding a link that will expire. */
  url: string;
  /** Epoch millis at which the URL stops working, so a screen can say honestly
   *  how long a link it is showing remains good for. */
  expiresAt: number;
}

// --- portalInviteTeammate (portal; a customer admin invites a colleague) ---
// The first WRITE a portal admin can make beyond accepting a report. The org
// and customer are taken from the caller's verified portal claims, NEVER the
// payload, so an admin can only ever invite into their OWN customer. Roles are
// CUSTOMER roles only; the callable rejects anything else, so no org-staff
// access can ride a portal invite. Gated on customerRoles.admin - the first
// place the product enforces a customer role rather than merely carrying it.
export interface PortalInviteTeammateInput {
  email: string;
  /** The teammate's name, for the CustomerContact the invitation links to. */
  name: string;
  /** Customer-portal roles to grant on acceptance. Must be non-empty and may
   *  only contain CustomerRole keys. */
  roles: CustomerRoleSet;
}
export interface PortalInviteTeammateResult {
  contactId: string;
  inviteId?: string;
}

// --- respondToAction (portal; the duty-holder reports progress on their work) ---
// The remedial work belongs to the customer; verifying and closing it belongs to
// the organisation. This callable records the FIRST half only: the customer says
// the work is in hand or done, optionally with a dated note. It can never set
// `status: 'signedOff'` or stamp `signedOffBy` - a duty-holder signing off their
// own compliance is exactly what the product must not allow. Authorised like
// acceptReport: portal claims, the building's owning customer re-derived from the
// reverse index at request time, and the caller's portal seat still active.
export interface RespondToActionInput {
  buildingId: string;
  actionId: string;
  /** Where the work stands, in the customer's own words. Sent on every response
   *  (a note-only update re-affirms the state it was already in). */
  state: ActionResponseState;
  /** What was done, who did it, when - free text, optional. */
  note?: string;
}
export interface RespondToActionResult {
  /** Server clock, so the screen can confirm the moment that was recorded. */
  respondedAt: number;
}

// --- recordPlatformAccess (super admin only) ---
// Story 2069 AC2: a super admin viewing a tenant's data is itself an audited
// event. Called when a platform operator opens an organisation's drill-down, it
// writes a `platform.access` entry into THAT org's own activity trail (from the
// verified superAdmin claim, never client input) so the tenant can see that the
// platform looked. Idempotent-friendly: a repeated view in the same session is
// fine to record; the org sees an honest access log.
export interface RecordPlatformAccessInput {
  /** The organisation whose data the super admin is viewing. */
  orgId: string;
  /** What was opened, for the trail (e.g. 'organisation', 'customer', 'building'). */
  scope: string;
  /** The specific record id opened, where applicable. */
  targetId?: string;
}
export interface RecordPlatformAccessResult {
  recorded: true;
}

export interface ReleaseAssessmentInput {
  assessmentId: string;
}
export interface ReleaseAssessmentResult {
  released: true;
  /** Action-plan items created from the assessment's non-conformities. */
  actionsCreated: number;
}

// --- registerInterest (public site; unauthenticated, App Check only) ---
// The marketing site's book-a-demonstration form. The lead is stored under the
// platform-global /platform/leads (a lead pre-dates any tenant, so there is no
// organisation or environment to scope it to) and the sales contact is notified
// by email. The result is deliberately opaque: a public endpoint must not reveal
// anything about what happened server-side beyond receipt.
export interface RegisterInterestInput {
  name: string;
  organisation: string;
  email: string;
  phone?: string;
  message?: string;
}
export interface RegisterInterestResult {
  received: true;
}

/** A stored register-interest lead (/platform/leads/{leadId}). Written by the
 *  registerInterest callable via the Admin SDK only; no client can address it. */
export interface PlatformLead {
  name: string;
  organisation: string;
  email: string;
  phone?: string;
  message?: string;
  /** Epoch millis, server clock, at receipt. */
  receivedAt: number;
}

// ----------------------------------------------------------------------------
// Phase 3 billing callables (§9). Named Request/Response per the billing plan
// (the plan's contracts are quoted verbatim so the client, the Functions and
// the plan document all agree on one shape).
// ----------------------------------------------------------------------------

// --- saveOnboardingDetails (verified-email authed user, no org yet) ---
// The FIRST self-serve step (§3.1): collect the organisation's details before
// any plan is chosen. Creates or updates usersOnboarding/{uid} at step 'plan';
// resubmitting while a journey is at 'details'/'plan'/'payment' updates the
// details without disturbing a payment already in flight (step stays
// 'payment' so the resume point survives an edit).
export interface SaveOnboardingDetailsRequest { details: OnboardingOrgDetails; }
export interface SaveOnboardingDetailsResponse { onboarding: UserOnboarding; }

// --- createSubscription (verified-email authed user, no org yet) ---
export interface CreateSubscriptionRequest {
  planId: string;
  /** @deprecated The organisation's name now comes from the onboarding node
   *  written by saveOnboardingDetails; the server ignores this field. Kept
   *  optional so older clients' payloads remain type-valid. */
  orgName?: string;
}
export interface CreateSubscriptionResponse {
  clientSecret: string; subscriptionId: string; stripeCustomerId: string;
  /** The Stripe MODE the server actually used (from the caller's testMode
   *  claim, or forced to 'test' by FIRERITE_FORCE_TEST_SIGNUPS). The client
   *  MUST load Stripe.js with the matching publishable key, or the Payment
   *  Element cannot mount the returned client secret (mixing a live key with
   *  a test secret throws at confirmPayment). */
  env: Environment;
}

// --- changeSubscription (org admin) ---
export interface ChangeSubscriptionRequest {
  orgId: string;
  planId: string;
  /** True = quote only: return what the change WOULD do (direction, proration
   *  amount for an upgrade, effective date) without touching Stripe state. */
  preview?: true;
}
export interface ChangeSubscriptionResponse {
  /** Upgrades apply immediately (prorated); downgrades land at period end. */
  effective: 'immediate' | 'period_end';
  prorationAmountPence?: number;
  effectiveAt: number;
}

// --- cancelSubscription (org admin; period-end only, resume until then) ---
export interface CancelSubscriptionRequest { orgId: string; resume?: boolean; }
export interface CancelSubscriptionResponse { cancelAtPeriodEnd: boolean; periodEnd: number; }

// --- resubscribe (org admin; restart a canceled subscription) ---
// A NEW subscription on the org's existing Stripe customer (the old one is
// terminally dead - Stripe subscriptions cannot be revived). Permitted only
// while the mirrored status is 'canceled' or 'incomplete' (a restart already
// in flight); the returned client secret drives the Payment Element, and the
// webhook lands the org snapshot when the payment confirms.
export interface ResubscribeRequest { orgId: string; planId: string; }
export interface ResubscribeResponse { clientSecret: string; subscriptionId: string; }

// --- createCardUpdateIntent (org admin; SetupIntent for Payment Element) ---
export interface CreateCardUpdateIntentRequest { orgId: string; }
export interface CreateCardUpdateIntentResponse { clientSecret: string; }

// --- listInvoices (org admin) ---
export interface ListInvoicesRequest { orgId: string; limit?: number; startingAfter?: string; }
export interface InvoiceSummary {
  id: string; number: string; created: number; amountPence: number;
  currency: string; status: 'paid' | 'open' | 'void' | 'uncollectible';
  /** Stripe-hosted invoice page / PDF - keeps invoice delivery out of PCI scope. */
  hostedInvoiceUrl?: string; pdfUrl?: string;
}
export interface ListInvoicesResponse { invoices: InvoiceSummary[]; hasMore: boolean; }

// --- getBillingState (authed - onboarding resume - or org admin) ---
export interface GetBillingStateRequest { orgId?: string; }
export interface GetBillingStateResponse {
  onboarding?: UserOnboarding;
  subscription?: OrgSubscription;
  /** The Stripe MODE this billing state belongs to, so the client loads the
   *  matching Stripe.js publishable key for any pending-payment secret below
   *  (see CreateSubscriptionResponse.env). */
  env?: Environment;
  /** For finishing an outstanding payment (existing PI/invoice client secret):
   *  an incomplete first payment, a 3DS challenge, or - the SEV-1 reactivation
   *  path - a suspended (unpaid/past_due) subscription's latest open invoice. */
  pendingPaymentClientSecret?: string;
  /** Ms epoch of Stripe's next automatic collection attempt on that open
   *  invoice (the dunning retry) - present only when Stripe has one scheduled,
   *  so the Billing tab can say WHEN the card will be tried again. */
  nextPaymentAttempt?: number;
}

// --- advanceOnboarding (authed owner of the onboarding node; §5.4) ---
// The setup wizard's steps are marked done by the callables that perform them
// (updateOrgProfile, createInvitation, manageCustomer); this callable exists
// ONLY for skip and finish, which perform no other action. Finishing DELETES
// the node - a completed journey is never read again (the gate routes via
// membership claims), so nothing is left to accumulate.
export interface AdvanceOnboardingRequest {
  /** Skip to this setup step without completing the current one. */
  skipTo?: 'profile' | 'team' | 'customer';
  /** Finish the wizard: stamps completedAt and sets step 'done'. */
  finish?: boolean;
}
export interface AdvanceOnboardingResponse { onboarding: UserOnboarding; }

// ----------------------------------------------------------------------------
// Helper: a record keyed by id, as RTDB returns a node of children.
// ----------------------------------------------------------------------------

/** RTDB returns object maps, not arrays. `Keyed<T>` models "a node of T children
 *  keyed by their id" so list reads are typed without pretending they're arrays. */
export type Keyed<T> = Record<string, T>;
