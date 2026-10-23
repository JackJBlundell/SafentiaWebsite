// ============================================================================
// deleteOrgData - the shared, DESTRUCTIVE org-erasure core (DECISIONS §8).
//
// One place that knows how to erase an entire organisation, reused by BOTH
// offboarding paths so they can never disagree about what "delete the org"
// means:
//   - the nightly `cleanupExpiredOrgs` sweep (retention clock elapsed), and
//   - the operator `deleteOrganisation.ts` immediate-delete script (on request,
//     before the clock elapses).
//
// This is the most dangerous code in the tree, so every safety rail is explicit:
//
//   * DRY RUN BY DEFAULT. `deleteOrgData(env, orgId, logger, { apply: false })`
//     reads and reports EXACTLY what it would remove, and writes NOTHING. Only
//     `apply: true` mutates. Both callers default to dry run.
//   * BOUNDED, NOT SCANNED. Deletion is a single multi-location `update` that
//     sets each org-scoped subtree ROOT to null; RTDB deletes the subtree
//     server-side, so we never read (let alone page) the potentially-huge
//     assessment/answer/report trees. The only reads are the small membership
//     and subscription nodes, needed to unpick the per-USER reverse indexes
//     (which are keyed by uid, not orgId, so they are not inside the org's
//     subtree) and the Stripe reverse markers.
//   * ENUMERATION DERIVED FROM THE SCHEMA. `orgRtdbRoots` addresses every
//     org-scoped collection through a path builder (the exportOrgData
//     precedent), never a hand-typed string, so a schema move is a one-line
//     change and a new collection is a one-line addition.
//   * AUTH ACCOUNTS ARE LEFT INTACT. A person may belong to several orgs (staff
//     and/or portal), so deleting their Firebase Auth user is unsafe to
//     automate. Instead we remove their membership + reverse-index entries and,
//     when their live claims still point at THIS org, strip that org from their
//     claims so their next token refresh routes them cleanly rather than into a
//     now-deleted tenant. Best-effort per user - one bad account never aborts
//     the erase.
//   * DURABLE AUDIT. Every applied deletion appends one `org_deleted` entry to
//     the super-admin finance feed, denormalising the org name captured before
//     the wipe.
// ============================================================================

import { auth, db, storage } from '../admin';
import { forEnv, ops, platform } from './paths';
import { portalSpaceKey } from '../shared/paths';
import type { Logger } from './logging';
import type {
  CustomerMember,
  DocumentCategory,
  Environment,
  FinanceEvent,
  OrgMember,
  OrgProfile,
  OrgSubscription,
  ReportScope,
} from '../shared/types';

/** A sentinel child id for multi-argument builders. Truncated away by orgRoot()
 *  below (the exportOrgData precedent), so its value is immaterial. */
const SENTINEL = '_sentinel_';

/**
 * Truncate a builder's output right after the orgId segment, yielding the
 * org-scoped subtree ROOT. An orgId is a unique push key, so its first
 * occurrence in the path is unambiguous (the env root and collection names that
 * precede it are lower-case words that cannot collide). For a builder that
 * already returns an org root this is a no-op.
 */
function orgRoot(path: string, orgId: string): string {
  const marker = `/${orgId}`;
  const at = path.indexOf(marker);
  return at < 0 ? path : path.slice(0, at + marker.length);
}

/**
 * Every org-scoped RTDB subtree root, addressed through a path builder. This is
 * the DELETION enumeration - reviewed against shared/paths for completeness (see
 * the RUNBOOK offboarding section). It intentionally covers the full export set
 * PLUS the two org-authored email collections exportOrgData omits
 * (`emailTemplates`, `emailSettings`), because deletion must leave nothing
 * behind. Pure (no I/O): the list is deterministic in `(env, orgId)`.
 *
 * Deliberately NOT here (documented exclusions, all keyed by something other
 * than orgId so scoping them would require an unbounded scan):
 *   - the tokenised global `/invitations` tree (keyed by inviteId; its
 *     admin-readable summaries under `orgInvitations/{orgId}` ARE reaped, and a
 *     stray bearer token is useless once the org it names is gone);
 *   - per-user `/notifications/{uid}` (keyed by uid, may mix several orgs);
 *   - the per-event Stripe idempotency markers `ops/stripeEvents` (keyed by
 *     eventId, swept on their own 30-day clock by cleanupBilling);
 *   - the `platform/financeEvents` billing audit feed (super-admin financial
 *     record, swept on its own 12-month clock - the deletion itself APPENDS to
 *     it rather than erasing it).
 * The per-USER reverse indexes (`userOrgs`, `customerUserIndex`) and the Stripe
 * reverse markers ARE reaped, but by deleteOrgData below because they need the
 * membership/subscription reads to locate the exact keys.
 */
export function orgRtdbRoots(
  env: Environment,
  orgId: string,
): Array<{ label: string; path: string }> {
  const { db: p } = forEnv(env);
  const cat = SENTINEL as DocumentCategory; // truncated away by orgRoot
  const scope = SENTINEL as ReportScope; // truncated away by orgRoot
  const entry = (label: string, path: string) => ({
    label,
    path: orgRoot(path, orgId),
  });

  return [
    // The organisation record (profile, settings, subscription, usage all hang
    // off this node and go with it).
    entry('organisation', p.organisation(orgId)),
    entry('orgMembers', p.orgMembers(orgId)),
    entry('buildingCustomerIndex', p.buildingCustomerIndex(orgId)),
    entry('orgInvitations', p.orgInvitations(orgId)),
    entry('customers', p.customers(orgId)),
    entry('customerContacts', p.customerContacts(orgId, SENTINEL)),
    entry('customerMembers', p.customerMembersByOrg(orgId)),
    entry('sites', p.sites(orgId, SENTINEL)),
    entry('buildings', p.buildingsRoot(orgId)),
    entry('buildingAccess', p.buildingAccess(orgId, SENTINEL)),
    entry('floorPlans', p.floorPlans(orgId, SENTINEL)),
    entry('templateDrafts', p.templateDrafts(orgId)),
    entry('templateVersions', p.templateVersions(orgId, SENTINEL)),
    entry('standardParagraphs', p.standardParagraphs(orgId)),
    entry('templates', p.templates(orgId)),
    entry('jobs', p.jobs(orgId)),
    entry('assessorJobs', p.assessorJobs(orgId, SENTINEL)),
    entry('assessments', p.assessments(orgId)),
    entry('assessmentAnswers', p.assessmentAnswers(orgId, SENTINEL)),
    entry('actions', p.actionsRoot(orgId)),
    entry('documents', p.documents(orgId, SENTINEL, cat)),
    entry('logBook', p.logBook(orgId, SENTINEL)),
    entry('reports', p.reports(orgId, scope, SENTINEL)),
    entry('notificationLedger', p.notificationLedger(orgId, SENTINEL)),
    entry('activity', p.activity(orgId)),
    entry('emailLog', p.emailLog(orgId)),
    // Email collections exportOrgData omits but deletion must not leave behind.
    entry('emailTemplates', p.emailTemplates(orgId)),
    entry('emailSettings', orgRoot(p.emailKindSetting(orgId, SENTINEL), orgId)),
    // Server-only per-org ops counters (rate-limit / quota accounting).
    entry('notificationCounts', ops.notificationCountsForOrg(env, orgId)),
    entry('manualEmailCounts', ops.manualEmailCountsForOrg(env, orgId)),
    entry('aiDraftCounts', ops.aiDraftCountsForOrg(env, orgId)),
    // Email bundling state. The bundles hold REAL recipient addresses until
    // they are flushed, so leaving them behind after an offboarding would keep
    // exactly the PII the deletion exists to remove.
    entry('emailBundles', ops.emailBundlesForOrg(env, orgId)),
    entry('emailDays', ops.emailDaysForOrg(env, orgId)),
  ];
}

/** The Storage object prefix holding every file the org owns (photos, floor
 *  plans, flag composites, documents, action evidence, org assets, report
 *  PDFs). Trailing slash so it can never match a different org whose id shares
 *  this one as a prefix. Pure. */
export function orgStoragePrefix(env: Environment, orgId: string): string {
  return `${env}/orgs/${orgId}/`;
}

/** What a deletion did (apply) or would do (dry run) - returned for logging and
 *  the operator script's stdout report. */
export interface DeleteOrgReport {
  orgId: string;
  env: Environment;
  applied: boolean;
  orgName: string;
  /** The org-scoped RTDB subtree roots removed (labels). */
  rtdbRoots: string[];
  /** The Storage prefix cleared. */
  storagePrefix: string;
  /** Storage objects removed (apply) or matched (dry run). */
  storageObjects: number;
  /** Staff members whose membership + userOrgs entry were removed. */
  staffMembers: number;
  /** Portal members whose membership + customerUserIndex entries were removed. */
  portalMembers: number;
  /** Auth accounts whose claims were stripped of this org (apply only). */
  claimsCleared: number;
}

/** All uids that appear as portal members under an org, paired with their
 *  customerId so the right customerUserIndex space key can be removed. */
function portalMemberEntries(
  customerMembers: Record<string, Record<string, CustomerMember>> | null,
): Array<{ uid: string; customerId: string }> {
  const out: Array<{ uid: string; customerId: string }> = [];
  if (!customerMembers) {
    return out;
  }
  for (const [customerId, members] of Object.entries(customerMembers)) {
    if (members && typeof members === 'object') {
      for (const uid of Object.keys(members)) {
        out.push({ uid, customerId });
      }
    }
  }
  return out;
}

/**
 * Erase one organisation. DRY RUN unless `apply` is true. Idempotent: a re-run
 * against an already-erased org finds empty membership nodes and simply removes
 * the (already-absent) roots again, which is a no-op.
 *
 * The caller owns the DECISION to delete (the sweep gates on the retention
 * clock; the operator script gates on a human `--apply`). This function makes
 * no policy judgement - it does exactly what it is told, safely.
 */
export async function deleteOrgData(
  env: Environment,
  orgId: string,
  logger: Logger,
  options: { apply: boolean },
): Promise<DeleteOrgReport> {
  const { apply } = options;
  const paths = forEnv(env);

  // --- Reads (small nodes only; never the bulk data trees) -----------------
  const [profileSnap, subSnap, membersSnap, customerMembersSnap] =
    await Promise.all([
      db.ref(paths.db.orgProfile(orgId)).get(),
      db.ref(paths.db.orgSubscription(orgId)).get(),
      db.ref(paths.db.orgMembers(orgId)).get(),
      db.ref(paths.db.customerMembersByOrg(orgId)).get(),
    ]);
  const profile = profileSnap.val() as OrgProfile | null;
  const orgName = profile?.name ?? '';
  const subscription = subSnap.val() as OrgSubscription | null;
  const members = (membersSnap.val() as Record<string, OrgMember> | null) ?? {};
  const staffUids = Object.keys(members);
  const portalMembers = portalMemberEntries(
    customerMembersSnap.val() as Record<
      string,
      Record<string, CustomerMember>
    > | null,
  );

  // --- The removal map: org-scoped roots + per-user reverse indexes + Stripe
  //     reverse markers, all set to null in ONE multi-location update. --------
  const roots = orgRtdbRoots(env, orgId);
  const removals: Record<string, null> = {};
  for (const { path } of roots) {
    removals[path] = null;
  }
  // userOrgs/{uid}/{orgId}: strip only THIS org from each staff member's login
  // index, never the whole node (they may belong to other orgs).
  for (const uid of staffUids) {
    removals[paths.db.userOrg(uid, orgId)] = null;
  }
  // customerUserIndex/{uid}/{orgId__customerId}: the portal space key names the
  // exact entry to drop, leaving other spaces the person holds untouched.
  for (const { uid, customerId } of portalMembers) {
    removals[paths.db.customerUserIndexEntry(uid, portalSpaceKey(orgId, customerId))] =
      null;
  }
  // Stripe reverse markers (server-only ops namespace), keyed by the ids the
  // org's subscription block carries.
  if (subscription?.stripeCustomerId) {
    removals[ops.stripeCustomer(env, subscription.stripeCustomerId)] = null;
  }
  if (subscription?.stripeSubscriptionId) {
    removals[ops.provisionedSub(env, subscription.stripeSubscriptionId)] = null;
  }

  // --- Storage: count now (both paths report it), delete only on apply -------
  const prefix = orgStoragePrefix(env, orgId);
  const bucket = storage.bucket();
  let storageObjects = 0;
  try {
    const [files] = await bucket.getFiles({ prefix });
    storageObjects = files.length;
  } catch (error) {
    logger.warn('Could not enumerate org storage prefix', {
      orgId,
      prefix,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const report: DeleteOrgReport = {
    orgId,
    env,
    applied: apply,
    orgName,
    rtdbRoots: roots.map((r) => r.label),
    storagePrefix: prefix,
    storageObjects,
    staffMembers: staffUids.length,
    portalMembers: portalMembers.length,
    claimsCleared: 0,
  };

  if (!apply) {
    logger.info('DRY RUN: organisation would be deleted', {
      orgId,
      env,
      orgName,
      rtdbRootCount: roots.length,
      storageObjects,
      staffMembers: report.staffMembers,
      portalMembers: report.portalMembers,
    });
    return report;
  }

  // ===================== DESTRUCTIVE FROM HERE ==============================

  // 1. RTDB: one atomic multi-location delete of every subtree + reverse index.
  await db.ref().update(removals);

  // 2. Storage: erase the whole org prefix (the SDK pages internally).
  try {
    await bucket.deleteFiles({ prefix, force: true });
  } catch (error) {
    // The RTDB data is already gone; a Storage hiccup must not throw away the
    // rest of the erase. Log loudly so an operator can re-run to mop up.
    logger.error('Org storage prefix deletion failed (RTDB already erased)', {
      orgId,
      prefix,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Auth: strip this org from any account whose live claims still point at
  //    it. The account itself is LEFT INTACT (it may belong to other orgs).
  const isSuperAdmin = async (uid: string): Promise<boolean> =>
    (await db.ref(platform.superAdmin(uid)).get()).val() === true;
  for (const uid of staffUids) {
    try {
      const user = await auth.getUser(uid);
      const claims = (user.customClaims ?? {}) as Record<string, unknown>;
      if (claims.orgId !== orgId) {
        continue; // Their active org is elsewhere - do not touch their token.
      }
      // Drop the org binding + roles; preserve testMode routing and heal the
      // durable super-admin grant, mirroring lib/claims.writeClaims.
      const next: Record<string, unknown> = {};
      if (claims.testMode === true) next.testMode = true;
      if (await isSuperAdmin(uid)) next.superAdmin = true;
      await auth.setCustomUserClaims(uid, next);
      await db.ref(platform.tokenRefresh(uid)).set(Date.now());
      report.claimsCleared += 1;
    } catch (error) {
      logger.warn('Could not clear org claims for member (account left intact)', {
        orgId,
        uid,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Portal accounts: same treatment, keyed on the disjoint portalOrgId claim.
  for (const { uid } of portalMembers) {
    try {
      const user = await auth.getUser(uid);
      const claims = (user.customClaims ?? {}) as Record<string, unknown>;
      if (claims.portalOrgId !== orgId) {
        continue;
      }
      const next: Record<string, unknown> = {};
      if (claims.testMode === true) next.testMode = true;
      if (await isSuperAdmin(uid)) next.superAdmin = true;
      await auth.setCustomUserClaims(uid, next);
      await db.ref(platform.tokenRefresh(uid)).set(Date.now());
      report.claimsCleared += 1;
    } catch (error) {
      logger.warn('Could not clear portal claims for member (account left intact)', {
        orgId,
        uid,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 4. Durable audit line on the super-admin finance feed. Synthetic child id
  //    (no Stripe event drives a deletion) that is a legal RTDB key and unique
  //    per (org, moment), so a re-run overwrites its own entry rather than
  //    double-counting.
  const at = Date.now();
  const auditId = `org-deletion-${orgId}-${at}`;
  const auditEntry: FinanceEvent = {
    at,
    type: 'org_deleted',
    orgId,
    orgName,
    stripeEventId: auditId,
  };
  await db.ref(platform.financeEvent(env, auditId)).set(auditEntry);

  logger.info('Organisation deleted', {
    orgId,
    env,
    orgName,
    rtdbRootCount: roots.length,
    storageObjects,
    staffMembers: report.staffMembers,
    portalMembers: report.portalMembers,
    claimsCleared: report.claimsCleared,
  });
  return report;
}
