// ============================================================================
// generateAndStoreReport - the report side effects, in ONE place.
//
// Assembles the model, renders the PDF, uploads it to the tenant + env-scoped
// Storage path, and records the /reports + /activity entries ATOMICALLY. Both
// entry points share this:
//   - the generateReport CALLABLE (admin/auditor, on demand), which wraps this in
//     App Check + auth + rate-limit gating; and
//   - the onAssessmentStageChange TRIGGER, which calls it automatically the moment
//     an assessment reaches `released` (the report is the released artefact).
//
// It performs no auth of its own - callers gate access. The single hard failure
// is a missing assessment (assembleReport throws); everything else degrades to a
// placeholder in the document (brief 18.3).
// ============================================================================

import { randomUUID } from 'crypto';
import { db, storage } from '../admin';
import type { EnvPaths } from '../lib/paths';
import type { Logger } from '../lib/logging';
import type { ActivityEntry, Report } from '../shared/types';
import { assembleReport } from './assemble';
import { renderReportPdf } from './render';
import { tenantStoragePrefix } from '../lib/validate';

export interface GenerateAndStoreArgs {
  /** Env-scoped path builders (test or live) - resolved by the caller. */
  paths: EnvPaths;
  orgId: string;
  assessmentId: string;
  /** Who to attribute the generation to in the /activity trail. */
  actorUid: string;
  /** Optional report recipients (the callable may pass these; the trigger does not). */
  emailTo?: string[];
  logger: Logger;
}

export interface GenerateAndStoreResult {
  reportId: string;
  pdfPath: string;
}

/**
 * Assemble → render → upload → record. Returns the created report id and its
 * Storage path. Throws only when the assessment is missing (the caller maps that
 * to a not-found); a partially-written state is never left behind because the
 * PDF upload precedes the atomic multi-location database write.
 */
export async function generateAndStoreReport(
  args: GenerateAndStoreArgs,
): Promise<GenerateAndStoreResult> {
  const { paths, orgId, assessmentId, actorUid, emailTo = [], logger } = args;

  // 1. Assemble the model (defensive against missing fields; throws only if the
  // assessment itself is absent).
  const model = await assembleReport(paths, orgId, assessmentId, logger);

  // 2. The template's certificate, if it has one, is loaded BEFORE the render:
  // it becomes page 2 of the finished document, so the renderer has to know how
  // many pages it will contribute to print page numbers the reader can follow.
  // The module (and the pdf-lib dependency behind it) is lazy-imported only when
  // a certificate actually exists, so a report without one pays no load cost -
  // the same discipline onAssessmentStageChange applies to this report core.
  // Neither call throws: an unreadable certificate costs the insert, never the
  // release.
  const certificate = model.certificate
    ? await (await import('./certificate')).loadCertificate(
        model.certificate,
        tenantStoragePrefix(paths.env, orgId),
        logger,
      )
    : undefined;

  // 3. Render the PDF (pure, in-memory).
  let pdf = await renderReportPdf(model, {
    insertedPagesAfterCover: certificate?.pageCount ?? 0,
  });

  // 3b. Splice the certificate in behind the cover. pdfkit cannot import
  // existing PDF pages, so this is a post-process on the rendered buffer.
  if (certificate) {
    const { mergeCertificate } = await import('./certificate');
    pdf = await mergeCertificate(pdf, certificate, logger);
  }

  // 3. Upload to the tenant + env-scoped Storage path. A random UUID keeps
  // concurrent generations from colliding and makes each report independently
  // addressable; the path builder applies the env + org scope.
  const reportId = randomUUID();
  const pdfPath = paths.storage.report(orgId, reportId);
  // The owning customer, recorded on the object as custom metadata. This is NO
  // LONGER what admits a portal reader - getReportDownloadUrl re-derives
  // ownership from live database state on every request, precisely because a
  // value written here once cannot follow a building that changes hands or an
  // access that is withdrawn. It is kept as provenance and defence in depth: the
  // object itself says which customer it was rendered for, which is what makes
  // an orphaned or mis-filed PDF diagnosable in the bucket, and it is the signal
  // scripts/backfillReportMetadata.ts audits. Derived the same way the callable
  // does, so the two never tell different stories about one report.
  const buildingId = model.overview.buildingId;
  const indexedCustomerId = (
    await db.ref(paths.db.buildingCustomer(orgId, buildingId)).get()
  ).val() as string | null;
  const customerId = indexedCustomerId || model.ownerCustomerId || '';
  if (!customerId) {
    // Still logged loudly: an unresolvable owner no longer costs the customer
    // their download (the callable re-derives it, and would fail the same way
    // for a genuinely ownerless building), but it means the index AND the
    // building record disagree with reality, which is worth a look before the
    // next release depends on it. Releasing is the right outcome regardless -
    // withholding a legal document over a stale index would be worse.
    logger.error('Report generated with no resolvable owning customer', {
      orgId,
      assessmentId,
      buildingId,
      pdfPath,
    });
  }
  await storage
    .bucket()
    .file(pdfPath)
    .save(pdf, {
      contentType: 'application/pdf',
      resumable: false,
      metadata: {
        // Cache disabled so a re-generated report is never served stale.
        cacheControl: 'private, no-cache, max-age=0',
        // The owning customer, as provenance on the object itself (FR-E22) -
        // the path carries no customer segment. Not an access grant: see above.
        metadata: {
          customerId,
        },
      },
    });

  // 4. Record the /reports entry and the /activity entry atomically. The PDF is
  // already in Storage; recording it must succeed as one unit so the database
  // never references a report it has not recorded, and vice versa.
  const now = Date.now();
  const reportRecord: Report = {
    pdfPath,
    generatedAt: now,
    assessmentId,
    ...(emailTo.length > 0 ? { emailedTo: emailTo } : {}),
  };
  const activityEntry: ActivityEntry = {
    actorUid,
    action: 'report.generated',
    target: assessmentId,
    at: now,
  };

  // Reports are scoped by building (the natural unit a customer reads).
  const reportRef = db.ref(paths.db.reports(orgId, 'building', buildingId)).push();
  const generatedReportId = reportRef.key as string;
  const activityRef = db.ref(paths.db.activity(orgId)).push();

  const update: Record<string, unknown> = {
    [`${paths.db.reports(orgId, 'building', buildingId)}/${generatedReportId}`]:
      reportRecord,
    [`${paths.db.activity(orgId)}/${activityRef.key}`]: activityEntry,
  };
  if (!indexedCustomerId && customerId) {
    // Repair the index we just had to work around. The SAME missing entry also
    // denies the portal's RTDB reads of this building's reports and actions
    // (database.rules keys on it), so leaving it would hide the report record
    // as well as the file; and without this the next release repeats the fault.
    // Only ever written from the building's own customerId, which is what
    // backfillBuildingCustomerIndex derives it from too.
    update[paths.db.buildingCustomer(orgId, buildingId)] = customerId;
    logger.warn('Repaired a missing building->customer index entry', {
      orgId,
      buildingId,
    });
  }
  await db.ref().update(update);

  logger.info('Report generated', {
    assessmentId,
    reportId: generatedReportId,
    buildingId,
    actionCount: model.actions.length,
    recipientCount: emailTo.length,
  });

  return { reportId: generatedReportId, pdfPath };
}
