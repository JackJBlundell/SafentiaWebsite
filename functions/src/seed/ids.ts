// ============================================================================
// Deterministic identifiers and shared time anchors for the seed.
//
// Every fixed record in the seed uses a STABLE id (declared here once) and is
// written with `set()`, so re-running the seed overwrites the same nodes rather
// than appending new ones - that is what makes the whole seed idempotent
// (story 1014 AC2). Nothing here uses `push()` or a random id.
//
// Times are anchored to a single `NOW` captured at module load and expressed as
// relative offsets, so the seeded world always looks "current" (jobs due soon,
// services next-due in the future, history in the recent past) on whatever day
// it is run, while staying internally consistent within a single run.
// ============================================================================

/** Epoch-millis anchor for the whole run (brief: all dates are epoch millis). */
export const NOW = Date.now();

const DAY = 24 * 60 * 60 * 1000;
/** Days from NOW as epoch millis. Negative = past, positive = future. */
export const days = (n: number): number => NOW + n * DAY;

// --- Organisation ------------------------------------------------------------
export const ORG_ID = 'org-firerite-demo';

// A SECOND organisation, with its own brand, that the primary assessor (Alex)
// also belongs to - so the org switcher (Account screen) and per-org whitelabel
// theming can be demonstrated by switching between two live organisations.
export const ORG2_ID = 'org-aegis-fire';

// org2's own customer -> site -> building -> job, so the org has real, themed
// content the moment Alex switches into it (not an empty shell).
export const ORG2 = {
  customer: 'cust-vantage-properties',
  site: 'site-vantage-quarter',
  building: 'bld-vantage-house',
  job: 'job-vantage-house',
} as const;

// --- Members (Firebase Auth uids are these exact strings) --------------------
// One per role plus a multi-role user, to exercise the union-permission model.
export const UID = {
  admin: 'seed-user-admin',
  assessor: 'seed-user-assessor', // the assessor we log in as
  auditor: 'seed-user-auditor',
  finance: 'seed-user-finance',
  viewer: 'seed-user-viewer',
  adminAssessor: 'seed-user-admin-assessor', // holds TWO roles
  owner: 'seed-user-jack', // project owner, real Google account (admin+assessor)
} as const;

// Shared, known credentials so a human can actually sign in to the seeded world.
// These are test-mode accounts under /test only - never production identities.
export const SEED_PASSWORD = 'Firerite-Test-2026!';
export const EMAIL_DOMAIN = 'firerite-demo.test';

// --- Templates ---------------------------------------------------------------
// An organisation arrives with TWO importable base templates: the PAS 79 default
// and the BS 9792 Housing FRA. Both are published, immutable v1 templates; jobs
// pin { templateId, version }. Orgs may also author wholly custom templates - the
// app renders and answers any of them (section codes are template-defined).
export const PAS79_TEMPLATE_ID = 'tmpl-pas79-default';
export const PAS79_TEMPLATE_VERSION = 1;

export const BS9792_TEMPLATE_ID = 'tmpl-bs9792-housing';
export const BS9792_TEMPLATE_VERSION = 1;

// --- Customers ---------------------------------------------------------------
export const CUSTOMER = {
  meridian: 'cust-meridian-estates',
  northgate: 'cust-northgate-care',
  harbourside: 'cust-harbourside-retail',
} as const;

// --- Customer contacts (keyed under their customer) ---------------------------
// The people at each customer organisation. Exactly one per customer is the
// primary; sites point at one via `contactId` and buildings' responsible-party
// snapshots reference them the same way.
export const CONTACT = {
  meridianHelen: 'contact-meridian-helen-carter',
  meridianMarcus: 'contact-meridian-marcus-webb',
  northgateRaymond: 'contact-northgate-raymond-ellis',
  northgatePriya: 'contact-northgate-priya-nair',
  harboursideNadia: 'contact-harbourside-nadia-hassan',
  harboursideTom: 'contact-harbourside-tom-fielding',
} as const;

// --- Sites (keyed under their customer) --------------------------------------
export const SITE = {
  meridianCentral: 'site-meridian-central',
  meridianRiverside: 'site-meridian-riverside',
  northgateLodge: 'site-northgate-lodge',
  harboursideQuay: 'site-harbourside-quay',
} as const;

// --- Buildings ---------------------------------------------------------------
// Spread so the app can show: a released history, a mid-lifecycle assessment,
// an info-request loop, and a genuinely pending (never-assessed) building.
export const BUILDING = {
  meridianTowerA: 'bld-meridian-tower-a', // released, full history + actions
  meridianTowerB: 'bld-meridian-tower-b', // released, mostly-green RAG mix
  meridianAnnexe: 'bld-meridian-annexe', // NO assessment yet (pending)
  riversideMill: 'bld-riverside-mill', // readyForValidation (mid-lifecycle)
  northgateLodgeHouse: 'bld-northgate-lodge-house', // open infoRequest loop
  harboursideUnit: 'bld-harbourside-unit', // scheduled job, NO floor plan
} as const;

// --- Floor plans -------------------------------------------------------------
export const PLAN = {
  towerAGround: 'plan-tower-a-ground',
  towerAFirst: 'plan-tower-a-first',
  towerBGround: 'plan-tower-b-ground',
  riversideGround: 'plan-riverside-ground',
  lodgeGround: 'plan-lodge-ground',
} as const;

// --- Jobs --------------------------------------------------------------------
export const JOB = {
  towerA: 'job-tower-a',
  towerB: 'job-tower-b',
  riversideMill: 'job-riverside-mill',
  lodgeHouse: 'job-lodge-house',
  harboursideUnit: 'job-harbourside-unit', // scheduled, not yet started
} as const;

// --- Assessments -------------------------------------------------------------
// An assessment id MUST be `job-<jobId>` - the canonical, deterministic scheme
// the client (assessmentIdForJob), the startAssessment callable AND the security
// rules all enforce (`$assessmentId === 'job-' + jobId`). Deriving the seed ids
// from JOB the same way is what lets start/resume re-find the seeded assessment
// instead of minting a second, empty one for the same job.
export const ASSESSMENT = {
  towerA: `job-${JOB.towerA}`,
  towerB: `job-${JOB.towerB}`,
  riversideMill: `job-${JOB.riversideMill}`,
  lodgeHouse: `job-${JOB.lodgeHouse}`,
} as const;
