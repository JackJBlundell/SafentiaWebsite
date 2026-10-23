// ============================================================================
// Certificate merging - splicing an organisation's own PDF into a report.
//
// A template may carry a Certificate (an accreditation certificate, a signed
// cover sheet). Every report rendered from that template gets its pages merged
// in as PAGE 2 - immediately behind the cover and ahead of the contents, which
// is where the industry documents this report follows carry it. That is the only
// supported position; a template authored before the move may still store `top`
// or `bottom`, and both are read as `afterCover` here rather than honoured.
//
// TWO STEPS, ON PURPOSE: loadCertificate() runs BEFORE the report is rendered,
// because the renderer has to know how many pages will be spliced in to print
// page numbers that match the finished document. mergeCertificate() then splices
// the already-downloaded bytes into the rendered buffer. A certificate that
// cannot be loaded simply yields undefined, and the report renders (and merges)
// as though the template had none.
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

/** A certificate that has been downloaded, opened and counted, ready to splice
 *  into a rendered report. */
export interface LoadedCertificate {
  /** The certificate PDF's bytes, already inside the size ceiling. */
  bytes: Buffer;
  /** How many pages it will contribute, so the renderer can number the report
   *  as the reader will see it. */
  pageCount: number;
}

/**
 * Download and validate a template's certificate, returning its bytes and page
 * count, or undefined when it cannot be used (see the failure policy in the file
 * header). Never throws: the caller treats undefined as "this report has no
 * certificate" and carries on.
 */
export async function loadCertificate(
  certificate: TemplateCertificate,
  tenant: string,
  logger: Logger,
): Promise<LoadedCertificate | undefined> {
  const objectPath = toObjectPath(certificate.url);
  if (!objectPath) {
    logger.warn('Report certificate skipped: reference is not a storage object');
    return undefined;
  }
  // The Admin SDK ignores Storage rules, and the snapshot this reference came
  // from can be client-written, so only the org's own tree is ever read.
  if (!objectPath.startsWith(tenant)) {
    logger.warn('Report certificate skipped: object is outside the tenant');
    return undefined;
  }

  try {
    const file = storage.bucket().file(objectPath);
    const [metadata] = await file.getMetadata();
    // An unreadable or absent size is treated as OVER the ceiling, not under it:
    // the point of the check is to refuse to pull an unbounded object into memory
    // beside the rendered report, and a missing figure is no assurance of size.
    const size = Number(metadata.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_CERTIFICATE_BYTES) {
      logger.warn('Report certificate skipped: object size is not within the ceiling', {
        size: metadata.size ?? null,
      });
      return undefined;
    }
    const [bytes] = await file.download();
    // The metadata is a separate read from the download, so re-check what
    // actually arrived: an object replaced between the two calls must not slip
    // past the ceiling the metadata read cleared.
    if (bytes.length > MAX_CERTIFICATE_BYTES) {
      logger.warn('Report certificate skipped: downloaded object exceeds the ceiling', {
        size: bytes.length,
      });
      return undefined;
    }

    // Lazy-loaded at first use, exactly as onAssessmentStageChange lazy-loads
    // this report core: every deployed function pays the cold-start cost of the
    // whole import graph, so pdf-lib is pulled in only when a certificate
    // actually has to be merged, never merely because a report is rendered.
    const { PDFDocument } = await import('pdf-lib');
    // ignoreEncryption lets pdf-lib open a certificate carrying an owner
    // password (the common "printing permitted, editing not" case that
    // accreditation bodies issue). A certificate needing a USER password to
    // decrypt still throws, and is caught below.
    const certificateDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
    });
    const pageCount = certificateDoc.getPageCount();
    if (pageCount === 0) {
      logger.warn('Report certificate skipped: the PDF contains no pages');
      return undefined;
    }
    return { bytes, pageCount };
  } catch (caught) {
    // The report is the statutory artefact; the certificate is a presentation
    // extra. Degrade to the report alone rather than failing the release.
    logger.warn('Report certificate skipped: the PDF could not be read', {
      reason: caught instanceof Error ? caught.message : String(caught),
    });
    return undefined;
  }
}

/**
 * Splice a loaded certificate into a rendered report as page 2, immediately
 * after the cover.
 *
 * Returns the merged PDF, or the ORIGINAL `report` buffer whenever the merge
 * cannot be completed. The caller does not branch on the outcome: it always
 * emits what comes back.
 */
export async function mergeCertificate(
  report: Buffer,
  certificate: LoadedCertificate,
  logger: Logger,
): Promise<Buffer> {
  try {
    const { PDFDocument } = await import('pdf-lib');

    const merged = await PDFDocument.create();
    const reportDoc = await PDFDocument.load(report);
    const certificateDoc = await PDFDocument.load(certificate.bytes, {
      ignoreEncryption: true,
    });

    const reportPages = await merged.copyPages(
      reportDoc,
      reportDoc.getPageIndices(),
    );
    const certificatePages = await merged.copyPages(
      certificateDoc,
      certificateDoc.getPageIndices(),
    );
    // Cover, then the certificate, then the rest of the report. A report with no
    // pages at all (impossible in practice, cheap to be right about) simply gets
    // the certificate.
    const [cover, ...rest] = reportPages;
    if (cover) {
      merged.addPage(cover);
    }
    for (const page of certificatePages) {
      merged.addPage(page);
    }
    for (const page of rest) {
      merged.addPage(page);
    }

    const output = await merged.save();
    logger.info('Report certificate merged', {
      certificatePages: certificatePages.length,
    });
    return Buffer.from(output);
  } catch (caught) {
    logger.warn('Report certificate skipped: the PDF could not be merged', {
      reason: caught instanceof Error ? caught.message : String(caught),
    });
    return report;
  }
}
