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
import type {
  AcceptReportInput,
  AcceptReportResult,
  Report,
  ReportAcceptance,
} from '../shared/types';

/** A signature has to be a name someone could actually be called. Two characters
 *  is the shortest real name we are willing to treat as an attestation, and at
 *  least one letter rules out a row of punctuation or digits standing in for a
 *  signature. */
const MIN_NAME_LENGTH = 2;
const HAS_LETTER = /\p{L}/u;

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
