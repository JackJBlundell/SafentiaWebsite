// ============================================================================
// Atomic organisation bootstrap (Phase 3, plan sections 3.1.5 / 4.3).
//
// Factored out of createOrganisation.ts so BOTH founding paths run the exact
// same provisioning:
//   - the operator path (createOrganisation callable, superAdmin-gated) passes
//     an EMPTY subscription - operator-founded orgs are grandfathered/unlimited
//     and carry no Stripe fields; and
//   - the self-serve path (Stripe webhook, first transition of an onboarding
//     subscription to 'active') passes the full subscription snapshot.
//
// The bootstrap is ONE multi-location update - profile, usage counters, the
// founder's admin membership, the /userOrgs login index, the base templates,
// the subscription snapshot (when present) and the audit entry land together,
// so the database is never left with a half-created organisation (brief 18.3).
// The base templates (PAS 79 + BS 9792, see baseTemplates.ts) are part of that
// write because an org without them cannot start a single assessment. The founder's
// claims are then re-minted exactly as createOrganisation always did.
//
// IDEMPOTENCY. Stripe retries webhooks, so the self-serve path must be safe to
// re-enter. When the subscription carries a stripeSubscriptionId we
// transaction-claim ops/provisionedSubs/{env}/{subscriptionId} (server-only ops
// namespace, rules-denied) storing {orgId, at} BEFORE bootstrapping; a re-entry
// loses the claim and simply returns the stored orgId with alreadyProvisioned
// true. The operator path has no subscription id, needs no marker (the callable
// is a deliberate, rate-limited human act) and skips it entirely.
//
// FAILURE HANDLING is split at the bootstrap commit, because releasing the
// marker is only safe while no org data exists:
//   - failure BEFORE the multi-location update commits: the marker is RELEASED
//     so the webhook retry reclaims and reprovisions from scratch;
//   - failure AFTER it commits (the tail: marker stamp, claims): the marker is
//     KEPT - the org exists, and releasing would let the retry mint a SECOND
//     org for the same subscription. The marker is stamped bootstrapped:true
//     immediately after the commit, and a re-entry that finds that stamp
//     RESUMES the tail idempotently (re-runs writeClaims, which converges)
//     and returns the stored orgId with alreadyProvisioned true.
// ============================================================================

import { auth, db } from '../admin';
import { forEnv, ops } from './paths';
import { activityUpdate } from './events';
import { BASE_TEMPLATES } from './baseTemplates';
import { computeClaims, writeClaims } from './claims';
import type { Logger } from './logging';
import type {
  Environment,
  OnboardingOrgDetails,
  OrgContact,
  OrgMember,
  OrgProfile,
  OrgSubscription,
  OrgUsage,
} from '../shared/types';

/** Platform-default brand for a fresh org. This mirrors DEFAULT_BRAND in the
 *  design system's palette and is not an independent choice: a new org has not
 *  branded itself yet, its console still says "Powered by Safentia", and the
 *  honest pre-branding state is the product's own accent. Pinning a colour the
 *  palette no longer contains would leave a stale copy behind instead.
 *  The admin re-brands via updateOrgProfile; a default means the themed report
 *  and portal are never left without valid colours. */
export const DEFAULT_BRAND = { primary: '#D9C554', secondary: '#1E3A8A' } as const;

// ============================================================================
// Contract
// ============================================================================

export interface ProvisionOrgArgs {
  env: Environment;
  /** The founding admin's uid (verified token on the operator path; the
   *  onboarding node's owner on the self-serve path). */
  uid: string;
  /** The founder's email (from their Auth record / verified token - never
   *  client input). Memberships are email-keyed, so it is required. */
  email: string;
  orgName: string;
  /** The details collected by the pre-plan onboarding step, on the self-serve
   *  path (absent on the operator path). Their contact fields land on the new
   *  org's profile.contact - the vocabulary already matches OrgContact. */
  orgDetails?: OnboardingOrgDetails;
  /** Full subscription snapshot including stripeSubscriptionId on the
   *  self-serve path; EMPTY ({}) on the operator path - operator orgs carry no
   *  Stripe fields and the entitlements module grandfathers them. */
  subscription: OrgSubscription;
}

/** The idempotency record at ops/provisionedSubs/{env}/{subscriptionId}. */
export interface ProvisionedSubMarker {
  orgId: string;
  at: number;
  /** Stamped immediately after the atomic bootstrap commits. Its presence is
   *  what makes the marker UNRELEASABLE: once the org's data exists, a
   *  failure in the tail (claims) must resume, never reprovision. Absent
   *  while the claim is held but the bootstrap has not yet landed. */
  bootstrapped?: true;
}

// ============================================================================
// Provisioning
// ============================================================================

/** The founding admin's member record, built from the Auth record (never
 *  client input). Deterministic per (uid, email, env), which is what lets the
 *  resume path rebuild it identically to recompute the same claims. */
async function founderMember(
  uid: string,
  email: string,
  env: Environment,
): Promise<OrgMember> {
  const userRecord = await auth.getUser(uid);
  return {
    roles: { admin: true },
    name: userRecord.displayName ?? email,
    email,
    status: 'active',
    // A test-env founder produces a test member, mirroring 4.8 (the marker
    // is what onMembershipChange copies into the testMode claim).
    ...(env === 'test' ? { testMode: true as const } : {}),
  };
}

/**
 * Provision a new organisation for a founding admin: atomic bootstrap, then
 * claims. Idempotent per subscription.stripeSubscriptionId (see file header);
 * a re-entry returns the previously-minted orgId with alreadyProvisioned true,
 * never bootstraps a second org, and - when the marker shows the bootstrap
 * committed - re-runs the idempotent claims tail so a tail failure on the
 * first delivery is healed by the retry.
 */
export async function provisionOrganisation(
  args: ProvisionOrgArgs,
  logger: Logger,
): Promise<{ orgId: string; alreadyProvisioned: boolean }> {
  const { env, uid, email, orgName, orgDetails, subscription } = args;
  const paths = forEnv(env);

  // Mint the org id up front (push key, exactly as createOrganisation always
  // has) so the idempotency marker can record it before any org data exists.
  const orgId = db.ref().push().key as string;

  // 1. Idempotency claim - ONLY when a Stripe subscription is present. The
  // transaction sets {orgId, at} iff the node is absent; losing the claim means
  // a previous (or concurrent) delivery already provisioned this subscription.
  const subscriptionId = subscription.stripeSubscriptionId;
  if (subscriptionId) {
    const markerRef = db.ref(ops.provisionedSub(env, subscriptionId));
    const result = await markerRef.transaction(
      (current: ProvisionedSubMarker | null) => {
        if (current !== null) {
          // Already claimed: abort so committed comes back false.
          return undefined;
        }
        const marker: ProvisionedSubMarker = { orgId, at: Date.now() };
        return marker;
      },
    );
    if (!result.committed) {
      // Re-entry: hand back the org the first delivery created. The snapshot
      // carries the stored marker; fall back to a read if the runtime did not
      // populate it (defensive - the Admin SDK always does).
      const stored: ProvisionedSubMarker | null =
        (result.snapshot?.val() as ProvisionedSubMarker | null) ??
        ((await markerRef.get()).val() as ProvisionedSubMarker | null);
      if (!stored?.orgId) {
        // Cannot happen in practice (the claim always stores an orgId); throw
        // rather than invent an org so the webhook retry path can recover.
        throw new Error(
          `Provisioning marker for subscription ${subscriptionId} exists but holds no orgId.`,
        );
      }
      if (stored.bootstrapped) {
        // The bootstrap committed on a previous delivery, but its tail may
        // have failed before the claims landed. writeClaims converges (it
        // overwrites with the same computed value), so re-running it here
        // costs one write and guarantees the founder's claims regardless of
        // where the first delivery died.
        const member = await founderMember(uid, email, env);
        await writeClaims(uid, computeClaims(member, stored.orgId));
      }
      // No bootstrapped stamp = a concurrent delivery holds the claim and is
      // mid-bootstrap; its own success or release path resolves the marker,
      // so this delivery just reports the org it will (or did) create.
      logger.info('Organisation already provisioned for subscription', {
        subscriptionId,
        orgId: stored.orgId,
      });
      return { orgId: stored.orgId, alreadyProvisioned: true };
    }
  }

  // Set the moment the atomic bootstrap commits: from then on the marker must
  // NEVER be released (the org exists; a released marker would let a Stripe
  // retry bootstrap a duplicate org for the same subscription).
  let bootstrapCommitted = false;
  try {
    // 2. The founder's member record carries their identity for pickers and
    // the audit trail. The Auth record is the source (never client input).
    const member = await founderMember(uid, email, env);
    // The details collected before plan choice become the profile's contact
    // block, shaped EXACTLY as updateOrgProfile shapes it (present fields
    // only, OrgContact vocabulary) so the console edits what onboarding wrote.
    const contact: OrgContact = {};
    if (orgDetails?.address) contact.address = orgDetails.address;
    if (orgDetails?.phone) contact.phone = orgDetails.phone;
    if (orgDetails?.website) contact.website = orgDetails.website;
    const profile: OrgProfile = {
      name: orgName,
      brand: { ...DEFAULT_BRAND },
      ...(Object.keys(contact).length > 0 ? { contact } : {}),
    };
    // Usage counters seeded at birth (Phase 3 brief 5.2): the founding admin is
    // the first seat, and starting the node here means the transactional
    // adjusters never meet an org without one.
    const usage: OrgUsage = {
      staffCount: 1,
      customerCount: 0,
      notificationsThisMonth: 0,
    };

    // 3. Atomic bootstrap: everything lands in ONE multi-location update - the
    // audit entry can never be skipped (which is why founding is server-side,
    // not a rules-governed client write). The subscription snapshot and the
    // Stripe customer reverse index are included only when present, so the
    // operator path writes neither.
    const update: Record<string, unknown> = {
      [paths.db.orgProfile(orgId)]: profile,
      [paths.db.orgUsage(orgId)]: usage,
      [paths.db.orgMember(orgId, uid)]: member,
      [paths.db.userOrg(uid, orgId)]: true,
      ...activityUpdate(paths, orgId, {
        actorUid: uid,
        action: 'organisation.created',
        target: orgId,
      }),
    };
    // The system templates, current wording from code. /templates is
    // server-write-only, so this is the only route by which an org gets them.
    for (const { id, template } of BASE_TEMPLATES) {
      update[paths.db.template(orgId, id)] = template;
    }
    if (Object.keys(subscription).length > 0) {
      update[paths.db.orgSubscription(orgId)] = subscription;
    }
    if (subscription.stripeCustomerId) {
      // Reverse index (plan 4.3): customer-level webhook events without org
      // metadata resolve through this mapping. Written here, atomically with
      // the org itself, because this is the moment the org first exists.
      update[ops.stripeCustomer(env, subscription.stripeCustomerId)] = orgId;
    }
    await db.ref().update(update);
    bootstrapCommitted = true;

    // 4. Stamp the marker so any re-entry from here on RESUMES the tail
    // instead of reprovisioning. Stamped before the tail runs: if writeClaims
    // (or even this stamp) fails, the catch keeps the marker and the webhook
    // retry heals the tail against the same orgId.
    if (subscriptionId) {
      await db
        .ref(ops.provisionedSub(env, subscriptionId))
        .update({ bootstrapped: true });
    }

    // 5. Point the founder's ACTIVE org at the new tenant (same path as
    // setActiveOrganisation). onMembershipChange also fires on the membership
    // write and recomputes the same claims - the explicit writeClaims just
    // guarantees the switch even if the trigger lands late.
    const nextClaims = computeClaims(member, orgId);
    await writeClaims(uid, nextClaims);

    logger.info('Organisation provisioned', {
      orgId,
      founder: uid,
      env,
      selfServe: Boolean(subscriptionId),
    });
    return { orgId, alreadyProvisioned: false };
  } catch (caught) {
    // Release the claim ONLY while the bootstrap has not committed, so a
    // webhook retry can reclaim and reprovision from scratch. Once the org's
    // data exists the marker is kept - the retry resumes the tail via the
    // bootstrapped branch above instead of minting a second org. The operator
    // path has no marker to release and simply rethrows.
    if (subscriptionId && !bootstrapCommitted) {
      await db
        .ref(ops.provisionedSub(env, subscriptionId))
        .remove()
        .catch(() => undefined);
    }
    throw caught;
  }
}
