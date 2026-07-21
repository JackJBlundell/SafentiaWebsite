// ============================================================================
// generateReport (callable, admin / auditor only) - brief 4.5 #8, section 11,
// stories 1071-1076.
//
// Renders the three-section industry-standard fire risk assessment report
// SERVER-SIDE and only server-side (story 1076): the PDF is written to the
// tenant + environment-scoped Storage path, a /reports record is created, and the
// generation is logged to /activity. This callable is the ON-DEMAND path (an
// admin or auditor regenerating a report); the same report is ALSO generated
// automatically on release by onAssessmentStageChange. Both share the
// generateAndStoreReport core, so the two paths can never diverge.
//
// Flow:
//   1. App Check + auth + role gate (admin OR auditor - story 1076 AC1).
//   2. Validate input (GenerateReportInput from the mirrored contract).
//   3. Delegate to generateAndStoreReport: assemble → render → upload → record
//      the /reports + /activity entries atomically (brief 18.3).
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import { assertAppCheck, assertAuth, assertOrgRole, getClaims, envFor } from '../lib/guards';
import { assertRateLimit } from '../lib/rateLimit';
import {
  assertObject,
  requireString,
  TEXT_LIMITS,
  requireEmail,
} from '../lib/validate';
import type {
  GenerateReportInput,
  GenerateReportResult,
} from '../shared/types';

/**
 * Validate and bound the optional recipient list. We cap the count so a caller
 * cannot pass an unbounded array, and validate each address's shape with the same
 * helper sign-in uses, rejecting (not coercing) anything malformed (brief 18.4).
 */
function validateEmailRecipients(input: Record<string, unknown>): string[] {
  const raw = input.emailTo;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw fail.invalidArgument('The emailTo field must be a list of addresses.', {
      field: 'emailTo',
    });
  }
  if (raw.length > 25) {
    throw fail.invalidArgument('Too many recipients were provided.', {
      field: 'emailTo',
      max: 25,
    });
  }
  // Reuse requireEmail by presenting each entry as a single-field object, so the
  // shape and length rules are applied identically to every address.
  return raw.map((value, i) =>
    requireEmail({ email: value }, `emailTo[${i}]`),
  );
}

export const generateReport = onCall<GenerateReportInput>(
  callableOptions,
  (request) =>
    runCallable<GenerateReportResult>(
      createLogger({ fn: 'generateReport' }),
      async () => {
        // 1. Attestation, identity and role gate. Either admin or auditor may
        // generate a report (story 1076 AC1); the union model means a multi-role
        // user passes if they hold either.
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'generateReport');
        const claims = getClaims(request);
        assertOrgRole(claims, ['admin', 'auditor']);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        // 2. Validate input.
        const input = assertObject(request.data);
        const assessmentId = requireString(
          input,
          'assessmentId',
          TEXT_LIMITS.shortText,
        );
        const emailTo = validateEmailRecipients(input);

        const logger = createLogger({ fn: 'generateReport', orgId });

        // 3. Delegate to the shared core (assemble → render → upload → record).
        // A missing assessment is the one hard failure; the core throws a plain
        // Error which we map to a structured not-found.
        try {
          // Lazy-load the report core (and its pdfkit dependency) at first use:
          // every deployed function loads the whole barrel graph at cold start,
          // so a static import here would make EVERY function pay for pdfkit.
          const { generateAndStoreReport } = await import('../report/generateAndStore');
          const { reportId, pdfPath } = await generateAndStoreReport({
            paths,
            orgId,
            assessmentId,
            actorUid: uid,
            emailTo,
            logger,
          });
          return { reportId, pdfPath };
        } catch (caught) {
          if (
            caught instanceof Error &&
            caught.message.startsWith('Assessment not found')
          ) {
            throw fail.notFound('This assessment could not be found.');
          }
          throw caught; // Unexpected: handled by runCallable as a generic internal.
        }
      },
    ),
);
