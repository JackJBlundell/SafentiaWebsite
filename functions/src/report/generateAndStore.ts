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

  // 2. Render the PDF (pure, in-memory).
  let pdf = await renderReportPdf(model);

  // 2b. Splice in the template's certificate, if it has one. pdfkit cannot
  // import existing PDF pages, so this is a post-process on the rendered
  // buffer. The module (and the pdf-lib dependency behind it) is lazy-imported
  // only when a certificate actually exists, so a report without one pays no
  // load cost - the same discipline onAssessmentStageChange applies to this
  // report core. mergeCertificate never throws: an unreadable certificate
  // returns the report unchanged, because a bad upload must not block a
  // release.
  if (model.certificate) {
    const { mergeCertificate } = await import('./certificate');
    pdf = await mergeCertificate(pdf, model.certificate, logger);
  }

  // 3. Upload to the tenant + env-scoped Storage path. A random UUID keeps
  // concurrent generations from colliding and makes each report independently
  // addressable; the path builder applies the env + org scope.
  const reportId = randomUUID();
  const pdfPath = paths.storage.report(orgId, reportId);
  // The owning customer, resolved via the building->customer index so the
  // Storage rules can grant that customer's portal users read on exactly this
  // object (FR-E22). Absent index entry (pre-index data) stamps an empty
  // value, which matches no portal token.
  const customerId = (
    await db
      .ref(paths.db.buildingCustomer(orgId, model.overview.buildingId))
      .get()
  ).val() as string | null;
  await storage
    .bucket()
    .file(pdfPath)
    .save(pdf, {
      contentType: 'application/pdf',
      resumable: false,
      metadata: {
        // Cache disabled so a re-generated report is never served stale.
        cacheControl: 'private, no-cache, max-age=0',
        // The owning customer, stamped as CUSTOM metadata so the Storage rules
        // can grant the customer's portal users read on exactly their own
        // reports (FR-E22) - the object path carries no customer segment.
        metadata: {
          customerId: customerId ?? '',
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
  const buildingId = model.overview.buildingId;
  const reportRef = db.ref(paths.db.reports(orgId, 'building', buildingId)).push();
  const generatedReportId = reportRef.key as string;
  const activityRef = db.ref(paths.db.activity(orgId)).push();

  const update: Record<string, unknown> = {
    [`${paths.db.reports(orgId, 'building', buildingId)}/${generatedReportId}`]:
      reportRecord,
    [`${paths.db.activity(orgId)}/${activityRef.key}`]: activityEntry,
  };
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
