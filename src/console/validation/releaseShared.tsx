// ============================================================================
// Shared pieces for the two surfaces that present released work: the dashboard's
// "Recent releases" card and the full ReleasedList at /app/validation/released.
//
// Both answer the same question - which BUILDING went out, for which CUSTOMER,
// under which TEMPLATE, when, by whom, and where is the PDF - so the resolution
// lives here once rather than twice. Everything is resolved by CACHED
// single-node reads under the shared query keys, so two rows for the same
// building (or the same row on both surfaces) cost one listener, not two.
//
// Every resolver degrades to the raw id rather than a blank or broken cell: a
// dangling job, building or customer record is a data problem, not a reason for
// a row to disappear.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { useAuth } from '../../auth/AuthProvider';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Assessment,
  Building,
  Customer,
  Job,
  Report,
  Template,
} from '../../types';
import { STANDARD_LABELS } from '../jobs/shared';
import styles from './releaseShared.module.css';

/** The best available release timestamp. releaseAssessment stamps releasedAt,
 *  so it is present on everything released since; acceptedAt (the immediately
 *  prior transition) and finally the conducted date cover older records, so a
 *  row always sorts and dates against a real, recorded moment. */
export function releasedAt(assessment: Assessment): number {
  return (
    assessment.workflow?.releasedAt ??
    assessment.workflow?.acceptedAt ??
    assessment.conductedAt
  );
}

/** The template the assessment was actually answered against, read from its
 *  pinned snapshot rather than the live template - a template published twice
 *  since must not rewrite what this release was carried out under. The standard
 *  is appended only where the template declares one, because an untagged
 *  template genuinely has no lineage to state. */
export function templateLabel(snapshot: Template | undefined): string {
  if (!snapshot?.name) {
    return 'Template not recorded';
  }
  const version = typeof snapshot.version === 'number' ? ` v${snapshot.version}` : '';
  const standard = snapshot.standard ? ` · ${STANDARD_LABELS[snapshot.standard]}` : '';
  return `${snapshot.name}${version}${standard}`;
}

/** Job -> siteId -> building: two cached single-node reads that the review page
 *  and every other row for the same building re-use for free. The siteId comes
 *  back with it because the console's building route is keyed by customer, site
 *  and building, and without it there is no honest link to offer. */
export function useReleaseBuilding(
  jobId: string,
  buildingId: string,
): { building: Building | null; siteId: string } {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const jobQuery = useRtdbQuery<Job | null>({
    key: keys.job(orgId, jobId),
    path: paths && jobId ? paths.db.job(orgId, jobId) : '',
    enabled: Boolean(orgId && paths && jobId),
  });
  const siteId = jobQuery.data?.siteId ?? '';
  const buildingQuery = useRtdbQuery<Building | null>({
    key: keys.building(orgId, siteId, buildingId),
    path: paths && siteId ? paths.db.building(orgId, siteId, buildingId) : '',
    enabled: Boolean(orgId && paths && siteId && buildingId),
  });
  return { building: buildingQuery.data ?? null, siteId };
}

/** The customer's name from a cached single-node read, degrading to the raw
 *  customer id when the record is dangling. */
export function useCustomerName(customerId: string): string {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const customerQuery = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId, customerId),
    path: paths && customerId ? paths.db.customer(orgId, customerId) : '',
    enabled: Boolean(orgId && paths && customerId),
  });
  return customerQuery.data?.name ?? customerId;
}

/**
 * How firmly a report is tied to the assessment it is being shown against.
 * `assessment` - the report names this assessment. `unattributed` - the report
 * names NO assessment (it predates `Report.assessmentId`), so it belongs to
 * this building but to no provable assessment, and the surface must say so.
 */
export type ReportAttribution = 'assessment' | 'unattributed';

export interface AttributedReport {
  report: Report;
  attribution: ReportAttribution;
}

/**
 * The report generated FOR one released assessment, from the building-scoped
 * reports node (one bounded node per building, shared by every row for that
 * building through `keys.reports`).
 *
 * Matching is on `assessmentId` FIRST and never crosses to a report naming a
 * DIFFERENT assessment: AssessmentReview can afford to fall back to the
 * building's newest report because it is showing one assessment in full
 * context; a list cannot, because offering the wrong building-mate's PDF
 * against a named row is worse than saying the report is not ready.
 *
 * A report carrying NO assessmentId is the one honest exception. It predates
 * the field, so it cannot be attributed to this assessment - but neither can it
 * be attributed to another one, and the building's own page (AssessmentHistory
 * Panel) already lists and downloads it. Withholding it here produced the exact
 * contradiction this hook now removes: the dashboard saying "Report not ready"
 * about a report the building page hands over. It is returned flagged
 * `unattributed` so the caller offers it with that caveat visible, rather than
 * silently passing it off as this assessment's.
 *
 * Returns `undefined` while the node is still attaching, `null` when no report
 * exists for this assessment yet - generation is asynchronous and trails the
 * release by moments, so that is a normal state, not an error.
 */
export function useAssessmentReport(
  buildingId: string,
  assessmentId: string,
): AttributedReport | null | undefined {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const reportsQuery = useRtdbQuery<Record<string, Report> | null>({
    key: keys.reports(orgId, 'building', buildingId),
    path: paths && buildingId ? paths.db.reports(orgId, 'building', buildingId) : '',
    enabled: Boolean(orgId && paths && buildingId),
  });
  return useMemo<AttributedReport | null | undefined>(() => {
    if (reportsQuery.data === undefined) {
      return undefined;
    }
    const reports = Object.values(reportsQuery.data ?? {});
    // Newest wins within a band: a regenerated report supersedes the one it
    // replaced.
    const newest = (candidates: Report[]): Report =>
      candidates.reduce((best, report) =>
        report.generatedAt > best.generatedAt ? report : best,
      );

    const named = reports.filter((report) => report.assessmentId === assessmentId);
    if (named.length > 0) {
      return { report: newest(named), attribution: 'assessment' };
    }
    const unattributed = reports.filter((report) => !report.assessmentId);
    if (unattributed.length > 0) {
      return { report: newest(unattributed), attribution: 'unattributed' };
    }
    return null;
  }, [reportsQuery.data, assessmentId]);
}

export type DownloadState =
  | { state: 'resolving' }
  | { state: 'ready'; url: string }
  | { state: 'unreachable' };

/** Resolves a stored PDF object path into a tokened download URL for the
 *  signed-in member. Storage rules are the real gate on the object, so a
 *  refusal is expected rather than exceptional and is reported as such - the
 *  row must never offer a link it cannot honour. */
export function useReportDownload(pdfPath: string | undefined): DownloadState {
  const [state, setState] = useState<DownloadState>({ state: 'resolving' });

  useEffect(() => {
    if (!pdfPath) {
      setState({ state: 'resolving' });
      return;
    }
    let cancelled = false;
    setState({ state: 'resolving' });
    getDownloadURL(storageRef(firebase.storage(), pdfPath))
      .then((url) => {
        if (!cancelled) {
          setState({ state: 'ready', url });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ state: 'unreachable' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pdfPath]);

  return state;
}

/**
 * The inline report affordance for one released row: a real link once the PDF
 * resolves, and calm words at every other point in the lifecycle. `subject`
 * names what the link downloads (the building), because a column of identical
 * "Download" links names nothing to a screen-reader user.
 */
export function ReportLink({
  buildingId,
  assessmentId,
  subject,
}: {
  buildingId: string;
  assessmentId: string;
  subject: string;
}) {
  const match = useAssessmentReport(buildingId, assessmentId);
  const report = match?.report;
  const download = useReportDownload(report?.pdfPath);

  if (match === undefined) {
    return <span className={styles.reportNote}>Checking for the report</span>;
  }
  if (match === null) {
    return (
      <span className={styles.reportNote}>
        Report not ready
        <span className={styles.srOnly}>
          {' '}
          for {subject}. The report is generated shortly after release.
        </span>
      </span>
    );
  }
  if (download.state === 'unreachable') {
    return (
      <span className={styles.reportNote}>
        Report unavailable
        <span className={styles.srOnly}> for {subject}</span>
      </span>
    );
  }
  if (download.state === 'resolving') {
    return <span className={styles.reportNote}>Preparing the report</span>;
  }
  const link = (
    <a
      className={styles.reportLink}
      href={download.url}
      target="_blank"
      rel="noopener"
    >
      Download PDF
      <span className={styles.srOnly}> for {subject}</span>
    </a>
  );
  if (match.attribution === 'assessment') {
    return link;
  }
  // The caveat is VISIBLE, not screen-reader-only: someone downloading a report
  // to answer a question about this particular release has to know it is the
  // building's report rather than provably this assessment's.
  return (
    <span className={styles.reportGroup}>
      {link}
      <span className={styles.reportNote}>
        Not linked to this assessment
        <span className={styles.srOnly}>
          {' '}
          - this report for {subject} records no assessment, so it may cover an
          earlier one.
        </span>
      </span>
    </span>
  );
}
