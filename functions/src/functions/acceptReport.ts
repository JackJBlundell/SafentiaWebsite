// ============================================================================
// acceptReport (callable, customer portal) - the contact's manual sign-off of a
// released fire risk assessment report.
//
// The portal gates the PDF behind an acceptance prompt: until a report carries
// an `acceptance`, the contact sees a form asking them to type their name, not a
// download link. This callable records that acceptance.
//
// Trust boundary: ONLY the typed name comes from the client. The accepting uid
// and the timestamp are taken from the verified session and the server clock, so
// an acceptance cannot be attributed to another account or back-dated. The
// caller's right to accept is re-derived server-side from the
// /buildingCustomerIndex reverse index - the same signal the database and
// Storage rules use to scope a portal token to its own customer's reports - and
// never from anything the client sends.
//
// Idempotent by design: a second accept returns the FIRST acceptance untouched.
// The signed name is an attestation, so the earliest one is the record; a repeat
// submission (a double-click, a re-opened email link) must never overwrite it.
// That is enforced by a TRANSACTION on the acceptance node, not by a read
// followed by a write: two concurrent accepts (a double-click across two warm
// instances, two contacts of the same customer signing at once) both read "no
// acceptance yet", and a plain write would let the loser overwrite the record of
// who actually signed. The transaction aborts for the loser, who is handed the
// winner's acceptance. Only the winner appends the /activity entry, so the trail
// carries exactly one accepted event per report.
//
// WHO MAY SIGN is a product decision held in one table (PORTAL_ROLE_MAY_ACCEPT
// below): a customer `admin` or `finance` contact speaks for the customer, a
// `viewer` does not. The acceptance is the one portal write that gates every
// other seat's download, so a read-only seat being able to make it would turn
// "viewer" into a quiet sign-off authority. Viewers still READ and DOWNLOAD once
// someone entitled has accepted (getReportDownloadUrl's own role table).
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  getPortalClaims,
  envFor,
} from '../lib/guards';
import {
  assertObject,
  requireDbKey,
  requireString,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import {
  CUSTOMER_ROLES,
  type AcceptReportInput,
  type AcceptReportResult,
  type CustomerMember,
  type CustomerRole,
  type CustomerRoleSet,
  type Report,
  type ReportAcceptance,
} from '../shared/types';

/** A signature has to be a name someone could actually be called. Two characters
 *  is the shortest real name we are willing to treat as an attestation, and at
 *  least one letter rules out a row of punctuation or digits standing in for a
 *  signature. */
const MIN_NAME_LENGTH = 2;
const HAS_LETTER = /\p{L}/u;

/**
 * WHICH PORTAL ROLES MAY ACCEPT AND SIGN OFF A REPORT. This table is the ONLY
 * thing that decides, so tightening or loosening it is a one-line change here.
 *
 * A `viewer` is excluded by name (product decision): their seat exists to READ
 * the customer's fire safety position, while an acceptance is a binding,
 * first-wins attestation made on the customer's behalf - and the act that
 * unlocks the download for every other seat. `admin` and `finance` act for the
 * account. The portal mirrors this table (ROLE_MAY_ACCEPT in the web portal's
 * shared.tsx) only so a viewer is never shown a form that would be turned away;
 * change the two together.
 */
const PORTAL_ROLE_MAY_ACCEPT: Record<CustomerRole, boolean> = {
  admin: true,
  finance: true,
  viewer: false,
};

/** A member carrying no role flags at all - a record predating roles, or one
 *  whose roles were cleared - is judged as the LEAST-privileged seat rather than
 *  waved through, so an empty role set can never become a quiet way past the
 *  table above (the posture respondToAction and getReportDownloadUrl take). */
const DEFAULT_PORTAL_ROLE: CustomerRole = 'viewer';

/** Does this member's LIVE role set permit an acceptance? Roles come from the
 *  /customerMembers record rather than the token, because the token is a cached
 *  copy that can be minutes stale and this is the authorisation decision. Only
 *  a literal `true` on a known role counts (the defensive reconstruction
 *  computePortalClaims applies), so a malformed record cannot assert a role.
 *  Exported so the role table is pinned by unit tests without the onCall
 *  wrapper. */
export function portalRoleMayAccept(roles: CustomerRoleSet | undefined): boolean {
  const held = CUSTOMER_ROLES.filter(
    (role) => (roles as Record<string, unknown> | undefined)?.[role] === true,
  );
  const effective: readonly CustomerRole[] =
    held.length > 0 ? held : [DEFAULT_PORTAL_ROLE];
  return effective.some((role) => PORTAL_ROLE_MAY_ACCEPT[role]);
}

export const acceptReport = onCall<AcceptReportInput>(callableOptions, (request) =>
  runCallable<AcceptReportResult>(
    createLogger({ fn: 'acceptReport' }),
    async () => {
      // 1. Attestation, identity, rate limit, then the PORTAL identity (a staff
      // token resolves to nothing here - portal and staff claims are disjoint).
      assertAppCheck(request);
      const { uid } = assertAuth(request);
      await assertRateLimit(uid, 'acceptReport');
      const claims = getPortalClaims(request);
      const { paths } = envFor(claims);
      const orgId = claims.orgId;

      // 2. Validate the input. The name is the only client-supplied value that
      // reaches storage.
      const input = assertObject(request.data);
      // The two ids are interpolated into database paths, so they are validated
      // as keys: a value carrying `/` would address a node one level deeper than
      // intended and let the acceptance write land on a sibling field.
      const buildingId = requireDbKey(input, 'buildingId', TEXT_LIMITS.shortText);
      const reportId = requireDbKey(input, 'reportId', TEXT_LIMITS.shortText);
      const name = requireString(input, 'name', TEXT_LIMITS.shortText).trim();
      if (name.length < MIN_NAME_LENGTH || !HAS_LETTER.test(name)) {
        throw fail.invalidArgument(
          'Please type your full name to accept this report.',
          { field: 'name' },
        );
      }

      // 3. Authorise: this building must belong to the caller's own customer.
      // Re-derived from the reverse index rather than inferred from the report
      // record, so a report whose index entry has since moved cannot be signed
      // off by the previous customer.
      const ownerSnap = await db
        .ref(paths.db.buildingCustomer(orgId, buildingId))
        .get();
      if ((ownerSnap.val() as string | null) !== claims.customerId) {
        throw fail.permissionDenied(
          'You do not have access to this report.',
        );
      }

      // 3b. Their portal seat must still be live. The token outlives a lock, an
      // archive or a removal by up to an hour, and an acceptance is a binding,
      // first-wins attestation, so it is checked against /customerMembers now
      // rather than trusted from the token (as getReportDownloadUrl does). The
      // same LIVE record carries the roles judged below, so a seat demoted to
      // viewer a minute ago cannot sign on the strength of its older token.
      const seat = (
        await db
          .ref(paths.db.customerMember(orgId, claims.customerId, uid))
          .get()
      ).val() as CustomerMember | null;
      if (seat?.status !== 'active') {
        throw fail.permissionDenied(
          'You do not have access to this report.',
        );
      }
      // 3c. ...and carry a role allowed to sign for the customer. Checked after
      // the ownership and seat checks, so this distinct copy is only ever shown
      // to a live member of the owning customer - it reveals nothing to a probe.
      if (!portalRoleMayAccept(seat.roles)) {
        throw fail.permissionDenied(
          'Only a customer administrator or finance contact can accept this report.',
        );
      }

      // 4. Load the report. Reports are scoped by building (the unit a customer
      // reads), which is why the input carries the building as well as the id.
      const reportPath = paths.db.report(orgId, 'building', buildingId, reportId);
      const reportSnap = await db.ref(reportPath).get();
      const report = reportSnap.val() as Report | null;
      if (!report) {
        throw fail.notFound('That report could not be found.', {
          field: 'reportId',
        });
      }

      // 5. Claim the acceptance transactionally. The callback runs against the
      // node's CURRENT value on the server, so exactly one concurrent caller can
      // find it empty: returning `undefined` aborts for everyone else, leaving
      // the first attestation standing (file header). The caller sees success
      // either way, so a retried submission is indistinguishable from the
      // original for the user.
      const acceptance: ReportAcceptance = {
        name,
        byUid: uid,
        at: Date.now(),
      };
      const outcome = await db
        .ref(`${reportPath}/acceptance`)
        .transaction((current: ReportAcceptance | null) =>
          current === null ? acceptance : undefined,
        );

      // 6. Only the winner appends the audit entry, so the trail carries one
      // accepted event per report rather than one per submission. The entry
      // follows the acceptance rather than sharing its write: the transaction is
      // what makes the record single-writer, and a multi-location update cannot
      // take part in one.
      const stored = outcome.snapshot.val() as ReportAcceptance | null;
      if (!outcome.committed) {
        return { acceptedAt: stored ? stored.at : acceptance.at };
      }

      await db.ref().update(
        activityUpdate(paths, orgId, {
          actorUid: uid,
          action: 'report.accepted',
          target: reportId,
        }),
      );

      createLogger({ fn: 'acceptReport', orgId }).info('Report accepted', {
        buildingId,
        reportId,
      });
      return { acceptedAt: acceptance.at };
    },
  ),
);
