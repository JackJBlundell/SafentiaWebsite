// ============================================================================
// getReportDownloadUrl (callable) - the ONE way a customer-portal reader opens a
// report PDF, and the place report authorisation is now decided.
//
// WHY THIS EXISTS. Until this callable, a portal reader opened the object
// directly and the Storage rule admitted them by comparing their `customerId`
// claim with a `customerId` stamped into the object's CUSTOM METADATA when the
// report was generated. That is authorisation frozen into a file at write time.
// It goes stale the moment anything moves: a building changes hands, a portal
// account is locked, a customer is archived - the stamp still says yes. Worse,
// a report generated while the building->customer index was missing was stamped
// with an empty string and became permanently unopenable by anybody, which is
// how a live customer lost access to their own fire risk assessment.
//
// Storage rules CANNOT read the Realtime Database (they can query Firestore
// only, and this platform is RTDB-backed), so the fix cannot live in the rules -
// see the note on the `reports/{reportFile}` match in storage.rules. Instead the
// object stops granting anything to a portal token and the SERVER decides on
// every single request, from live database state, then hands back a short-lived
// V4 signed URL. Nothing durable is embedded in the page and nothing about the
// decision is cached in the object.
//
// WHAT IS RE-DERIVED, EVERY CALL:
//   - the building's owning customer, from /buildingCustomerIndex (falling back
//     to the building record the index is derived from), NOT from the report;
//   - that a portal caller's customer IS that owner;
//   - that their /customerMembers record is STILL `active` (a lock, an archive
//     cascade or a removal denies here even while their token still carries the
//     claim, which it does until it refreshes);
//   - that their live role permits it (see PORTAL_ROLE_MAY_DOWNLOAD);
//   - that they have ACCEPTED the report. acceptReport's sign-off gate was
//     presentation-only while the object was directly readable; routing the file
//     through here makes it a real gate. Staff are NOT gated: they need the PDF
//     to answer the question the customer is ringing up about.
//
// Staff callers are admitted on org tenancy alone, exactly as the Storage rule
// still admits them: the report path is built from their OWN verified orgId, so
// a staff caller can only ever address their own organisation's reports.
//
// SIGNING PREREQUISITE: a V4 signed URL is signed by the runtime service account
// through the IAM signBlob API, which needs `roles/iam.serviceAccountTokenCreator`
// on itself. Without it every call fails at the last step, so that failure is
// caught and logged loudly with the exact grant needed rather than surfacing as
// an anonymous crash.
// ============================================================================

import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { db, storage } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  getClaims,
  getPortalClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import type { EnvPaths } from '../lib/paths';
import {
  CUSTOMER_ROLES,
  type Building,
  type CustomerMember,
  type CustomerRole,
  type CustomerRoleSet,
  type GetReportDownloadUrlInput,
  type GetReportDownloadUrlResult,
  type Report,
  type SafentiaClaims,
} from '../shared/types';

/** How long a minted URL stays valid. Long enough to survive a slow connection,
 *  a print dialogue and a reader who clicks then answers the phone; short enough
 *  that a URL copied out of the address bar and pasted into a chat is dead
 *  before it is useful. The client never stores it - it asks again per click. */
const URL_TTL_MS = 15 * 60_000;

/**
 * WHICH PORTAL ROLES MAY OPEN A REPORT PDF. This table is the ONLY thing that
 * decides, and restricting access is a one-line change here.
 *
 * TODAY every portal role may download, which is exactly what the Storage rule
 * this callable replaces granted (it never looked at roles at all), so nobody
 * loses access on the switchover. The product owner is still deciding whether a
 * `viewer` should be excluded; when that lands, flip `viewer` to false and
 * nothing else in the codebase moves.
 */
const PORTAL_ROLE_MAY_DOWNLOAD: Record<CustomerRole, boolean> = {
  admin: true,
  finance: true,
  viewer: true,
};

/** A portal member carrying no role flags at all - a record predating roles, or
 *  one whose roles were cleared - is judged as the LEAST-privileged seat rather
 *  than waved through. That keeps the table above the single decision point: an
 *  empty role set can never become a quiet way past a restriction added to it. */
const DEFAULT_PORTAL_ROLE: CustomerRole = 'viewer';

/** Does this member's LIVE role set permit a download? Roles come from the
 *  /customerMembers record rather than the token, because the token is a cached
 *  copy that can be minutes stale and this is the authorisation decision. Only
 *  a literal `true` on a known role counts (the same defensive reconstruction
 *  computePortalClaims applies), so a malformed record cannot assert a role. */
function portalRoleMayDownload(roles: CustomerRoleSet | undefined): boolean {
  const held = CUSTOMER_ROLES.filter(
    (role) => (roles as Record<string, unknown> | undefined)?.[role] === true,
  );
  const effective: readonly CustomerRole[] =
    held.length > 0 ? held : [DEFAULT_PORTAL_ROLE];
  return effective.some((role) => PORTAL_ROLE_MAY_DOWNLOAD[role]);
}

/**
 * Resolve the building's owning customer AT REQUEST TIME. The reverse index is
 * the primary source - it is what manageBuilding maintains and what the database
 * rules scope portal reads by - but it is a DERIVED index, and a building
 * created by another path (a seed, an estate import) may have no entry. Rather
 * than deny a real customer their own report because of a missing index row, we
 * fall back to the record the index is derived from in the first place: the
 * building's own `customerId`. That fallback scans the org's buildings tree
 * because the index is what usually spares us a siteId, so it is deliberately
 * the second branch and not the first.
 */
async function resolveOwningCustomer(
  paths: EnvPaths,
  orgId: string,
  buildingId: string,
): Promise<string | null> {
  const indexed = (
    await db.ref(paths.db.buildingCustomer(orgId, buildingId)).get()
  ).val() as string | null;
  if (indexed) {
    return indexed;
  }

  const buildingsSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
  const bySite =
    (buildingsSnap.val() as Record<
      string,
      Record<string, Building> | null
    > | null) ?? {};
  for (const buildings of Object.values(bySite)) {
    const building = buildings?.[buildingId];
    if (building?.customerId) {
      return building.customerId;
    }
  }
  return null;
}

/** Portal tokens and staff tokens are disjoint by construction (a portal token
 *  carries portalOrgId + customerId and never orgId), so the shape of the
 *  verified token - never anything the client sent - decides which identity is
 *  resolved. Asking getClaims for a portal caller would deny them outright. */
function isPortalToken(request: CallableRequest): boolean {
  const portalOrgId = request.auth?.token?.portalOrgId;
  return typeof portalOrgId === 'string' && portalOrgId.length > 0;
}

export const getReportDownloadUrl = onCall<GetReportDownloadUrlInput>(
  callableOptions,
  (request) =>
    runCallable<GetReportDownloadUrlResult>(
      createLogger({ fn: 'getReportDownloadUrl' }),
      async () => {
        // 1. Attestation, identity, rate limit.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'getReportDownloadUrl');

        // 2. Resolve the caller as a portal reader OR org staff, from the token
        // shape. Both resolvers reject a token that carries neither.
        const portal = isPortalToken(request);
        const claims: SafentiaClaims = portal
          ? getPortalClaims(request)
          : getClaims(request);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        // 3. Validate the input. Both ids are interpolated into database paths,
        // so they are validated as KEYS: a value carrying `/` would address a
        // node one level deeper than intended.
        const input = assertObject(request.data);
        const buildingId = requireDbKey(input, 'buildingId', TEXT_LIMITS.shortText);
        const reportId = requireDbKey(input, 'reportId', TEXT_LIMITS.shortText);

        // A single refusal for every portal authorisation failure below. Telling
        // a reader WHICH check failed would let a portal account probe another
        // customer's building ids, and none of the distinctions are actionable
        // by them anyway - the recovery is the same conversation every time.
        const denied = () =>
          fail.permissionDenied('You do not have access to this report.');

        if (portal) {
          // Always present on this branch (getPortalClaims rejects a token
          // without one); the fallback exists only to keep the type honest.
          const customerId = claims.customerId ?? '';

          // 4a. The building must belong to the caller's OWN customer, derived
          // now rather than read off the report - a building that has since
          // changed hands must not still open for the previous customer.
          const owner = await resolveOwningCustomer(paths, orgId, buildingId);
          if (!owner || owner !== customerId) {
            throw denied();
          }

          // 4b. Their portal seat must still be live. This is the check the
          // object metadata could never make: locking an account, archiving the
          // customer (portalAccessCascade) or removing the member denies here
          // immediately, without waiting for their ID token to refresh.
          const member = (
            await db.ref(paths.db.customerMember(orgId, customerId, uid)).get()
          ).val() as CustomerMember | null;
          if (member?.status !== 'active') {
            throw denied();
          }
          if (!portalRoleMayDownload(member.roles)) {
            throw denied();
          }
        }

        // 5. Load the report. Reports are scoped by building (the unit a
        // customer reads), which is why the input carries the building too. The
        // org comes from the verified token, so this path is tenant-safe for
        // staff and portal callers alike.
        const report = (
          await db
            .ref(paths.db.report(orgId, 'building', buildingId, reportId))
            .get()
        ).val() as Report | null;
        if (!report) {
          throw fail.notFound('That report could not be found.', {
            field: 'reportId',
          });
        }

        // 6. The acceptance gate, now REAL. acceptReport records the customer
        // contact's sign-off; while the PDF was directly readable, hiding the
        // link was presentation only. Staff are deliberately exempt - they need
        // the document to answer questions about it.
        if (portal && !report.acceptance) {
          throw fail.failedPrecondition(
            'Please accept this report before downloading it.',
            { field: 'reportId' },
          );
        }

        if (!report.pdfPath) {
          throw fail.notFound(
            'The file for this report is not available. Please contact your fire safety provider.',
            { field: 'reportId' },
          );
        }

        // 7. Confirm the object is really there BEFORE minting a URL. A signed
        // URL to a missing object opens a raw XML error page in a new tab, which
        // tells the reader nothing and looks like a broken product; a designed
        // not-found gives them a sentence and someone to ring.
        const file = storage.bucket().file(report.pdfPath);
        const [exists] = await file.exists();
        if (!exists) {
          createLogger({ fn: 'getReportDownloadUrl', orgId }).error(
            'Report record references a Storage object that is not there',
            { buildingId, reportId, pdfPath: report.pdfPath },
          );
          throw fail.notFound(
            'The file for this report could not be found. Please contact your fire safety provider.',
            { field: 'reportId' },
          );
        }

        // 8. Mint the short-lived URL. V4 signing is performed by the runtime
        // service account via the IAM signBlob API, so a missing
        // Service Account Token Creator grant fails HERE, after every
        // authorisation check has passed - logged with the exact remedy because
        // the symptom (every download failing at once, for everyone) otherwise
        // looks nothing like an IAM problem.
        const expiresAt = Date.now() + URL_TTL_MS;
        let url: string;
        try {
          [url] = await file.getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: expiresAt,
          });
        } catch (error) {
          createLogger({ fn: 'getReportDownloadUrl', orgId }).error(
            'Signing a report URL failed - the runtime service account likely lacks iam.serviceAccounts.signBlob (grant it roles/iam.serviceAccountTokenCreator on itself)',
            { buildingId, reportId, error: String(error) },
          );
          throw fail.internal(
            'The report could not be prepared for download. Please try again shortly.',
          );
        }

        return { url, expiresAt };
      },
    ),
);
