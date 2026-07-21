// ============================================================================
// Certificate merging - splicing an organisation's own PDF into a report.
//
// A template may carry a Certificate (an accreditation certificate, a signed
// cover sheet). Every report rendered from that template gets its pages merged
// in, before the report (`top`) or after it (`bottom`).
//
// WHY A POST-PROCESS: pdfkit, which renders the report itself, can only compose
// NEW content - it cannot import the pages of an existing PDF. So the report is
// rendered exactly as it always was, and the finished buffer is then re-opened
// with pdf-lib, which CAN copy pages between documents. The certificate pages
// are copied verbatim, so accreditation artwork, signatures and any embedded
// fonts survive byte-for-byte; nothing here re-lays-out or re-encodes them.
//
// FAILURE POLICY: reports auto-generate the moment an assessment is released, so
// a certificate that cannot be read must NEVER block a release. Every failure
// path here logs the reason and returns the ORIGINAL report buffer. A corrupt,
// encrypted, oversized or missing certificate costs the insert, not the report.
// ============================================================================

import { storage } from '../admin';
import type { Logger } from '../lib/logging';
import type { TemplateCertificate } from '../shared/types';

/** The ceiling a certificate is loaded under, matching the Storage rules'
 *  25MB document ceiling. A larger object means the rules were bypassed or the
 *  reference is stale, and pulling it into memory alongside the rendered report
 *  risks the function's memory limit. */
const MAX_CERTIFICATE_BYTES = 25 * 1024 * 1024;

/**
 * Resolve a stored-file reference (a raw object path, a gs:// URI or a Firebase
 * download URL) to the bucket object path. Certificates are recorded through
 * requireTenantStorageRef, which accepts either a tenant object path or a
 * download URL, so both forms have to resolve here.
 */
function toObjectPath(urlOrPath: string): string | undefined {
  const value = urlOrPath.trim();
  if (!value) {
    return undefined;
  }
  if (value.startsWith('gs://')) {
    const withoutScheme = value.slice('gs://'.length);
    const slash = withoutScheme.indexOf('/');
    return slash >= 0 ? withoutScheme.slice(slash + 1) : undefined;
  }
  const oIndex = value.indexOf('/o/');
  if (oIndex >= 0) {
    const after = value.slice(oIndex + '/o/'.length);
    const queryIndex = after.indexOf('?');
    const encoded = queryIndex >= 0 ? after.slice(0, queryIndex) : after;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }
  return value.includes('://') ? undefined : value;
}

/**
 * Merge a template's certificate into a rendered report.
 *
 * Returns the merged PDF, or the ORIGINAL `report` buffer whenever the
 * certificate cannot be used (see the failure policy in the file header). The
 * caller does not branch on the outcome: it always emits what comes back.
 */
export async function mergeCertificate(
  report: Buffer,
  certificate: TemplateCertificate,
  logger: Logger,
): Promise<Buffer> {
  const objectPath = toObjectPath(certificate.url);
  if (!objectPath) {
    logger.warn('Report certificate skipped: reference is not a storage object');
    return report;
  }

  try {
    const file = storage.bucket().file(objectPath);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size ?? 0);
    if (size > MAX_CERTIFICATE_BYTES) {
      logger.warn('Report certificate skipped: object exceeds the size ceiling', {
        size,
      });
      return report;
    }
    const [bytes] = await file.download();

    // Lazy-loaded at first use, exactly as onAssessmentStageChange lazy-loads
    // this report core: every deployed function pays the cold-start cost of the
    // whole import graph, so pdf-lib is pulled in only when a certificate
    // actually has to be merged, never merely because a report is rendered.
    const { PDFDocument } = await import('pdf-lib');

    const merged = await PDFDocument.create();
    const reportDoc = await PDFDocument.load(report);
    // ignoreEncryption lets pdf-lib open a certificate carrying an owner
    // password (the common "printing permitted, editing not" case that
    // accreditation bodies issue). A certificate needing a USER password to
    // decrypt still throws, and is caught below.
    const certificateDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
    });

    if (certificateDoc.getPageCount() === 0) {
      logger.warn('Report certificate skipped: the PDF contains no pages');
      return report;
    }

    // Copy in the order the position demands. Pages are copied, not redrawn, so
    // the certificate's own content stream is preserved intact.
    const order =
      certificate.position === 'top'
        ? ([certificateDoc, reportDoc] as const)
        : ([reportDoc, certificateDoc] as const);
    for (const source of order) {
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) {
        merged.addPage(page);
      }
    }

    const output = await merged.save();
    logger.info('Report certificate merged', {
      position: certificate.position,
      certificatePages: certificateDoc.getPageCount(),
    });
    return Buffer.from(output);
  } catch (caught) {
    // The report is the statutory artefact; the certificate is a presentation
    // extra. Degrade to the report alone rather than failing the release.
    logger.warn('Report certificate skipped: the PDF could not be merged', {
      reason: caught instanceof Error ? caught.message : String(caught),
    });
    return report;
  }
}
