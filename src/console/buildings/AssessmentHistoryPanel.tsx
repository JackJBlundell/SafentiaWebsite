// ============================================================================
// AssessmentHistoryPanel - one building's assessment history and its released
// reports (story 2037), mounted on the console BuildingDetail page.
//
// DATA PATH: /assessments/{orgId} carries a `buildingId` entry in its
// .indexOn, so the history is ONE honest indexed subscription -
// orderByChild('buildingId') + equalTo(buildingId) - never the whole org node
// filtered on the client. Reports live at /reports/{orgId}/building/
// {buildingId} (the builder already exists), one bounded node per building.
//
// Every assessment renders its stage with the EXACT client-facing words from
// ASSESSMENT_STAGE_LABELS, and its assessor through actorName (uid -> live
// member name, "Former staff member" once they leave). A report's Download
// resolves Report.pdfPath through getDownloadURL exactly like a document row,
// degrading to honest copy when the object is unreachable. Regenerate is
// admin/auditor only (matching the generateReport callable's own gate) and is
// two-step, because it mints a new legal document.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { equalTo, orderByChild, query } from 'firebase/database';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  ASSESSMENT_STAGE_LABELS,
  type Assessment,
  type GenerateReportInput,
  type GenerateReportResult,
  type OrgMember,
  type Report,
} from '../../types';
import { actorName } from '../lib/actorName';
import { DataTable, type Column } from '../ui/DataTable';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { formatDateShort } from '../customers/shared';
import styles from './AssessmentHistoryPanel.module.css';

/** The long British date, for PROSE - "Generated 9 July 2026", "Accepted by X
 *  on ...". Table columns use formatDateShort instead: the long form takes a
 *  column's width and wraps, which is what set the row heights. */
function formatDate(epochMillis: number): string {
  return new Date(epochMillis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

interface AssessmentRow {
  id: string;
  assessment: Assessment;
}

interface ReportRow {
  id: string;
  report: Report;
}

export function AssessmentHistoryPanel({ buildingId }: { buildingId: string }) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  // Admin or auditor: the roles that may open an assessment in validation AND
  // regenerate its report. One flag because it is genuinely one permission -
  // "may work with this building's assessments" - not two that happen to match.
  const canOpenAssessments =
    claims?.roles.admin === true || claims?.roles.auditor === true;
  const enabled = Boolean(orgId && paths && buildingId);

  // The building's assessments, via the buildingId index on the org node.
  const assessmentsQuery = useRtdbQuery<Record<string, Assessment> | null>({
    key: keys.buildingAssessments(orgId, buildingId),
    path: paths ? paths.db.assessments(orgId) : '',
    enabled,
    build: (node) =>
      query(node, orderByChild('buildingId'), equalTo(buildingId)),
  });
  const reportsQuery = useRtdbQuery<Record<string, Report> | null>({
    key: keys.reports(orgId, 'building', buildingId),
    path: paths ? paths.db.reports(orgId, 'building', buildingId) : '',
    enabled,
  });
  // The roster, so conductedBy renders as a name, never a uid.
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: Boolean(orgId && paths),
  });
  const membersLoaded = membersQuery.data !== undefined;

  const assessmentRows = useMemo<AssessmentRow[]>(
    () =>
      Object.entries(assessmentsQuery.data ?? {})
        .map(([id, assessment]) => ({ id, assessment }))
        .sort((a, b) => b.assessment.conductedAt - a.assessment.conductedAt),
    [assessmentsQuery.data],
  );
  const reportRows = useMemo<ReportRow[]>(
    () =>
      Object.entries(reportsQuery.data ?? {})
        .map(([id, report]) => ({ id, report }))
        .sort((a, b) => b.report.generatedAt - a.report.generatedAt),
    [reportsQuery.data],
  );

  const columns: Array<Column<AssessmentRow>> = [
    {
      header: 'Conducted',
      // Numeric in a column; the long form stays in prose below.
      cell: (row) => formatDateShort(row.assessment.conductedAt),
    },
    {
      header: 'Stage',
      cell: (row) => (
        <span className={styles.stageChip}>
          {ASSESSMENT_STAGE_LABELS[row.assessment.status]}
        </span>
      ),
    },
    {
      header: 'Conducted by',
      cell: (row) =>
        actorName(
          membersQuery.data,
          row.assessment.conductedBy,
          membersLoaded,
        ),
    },
  ];

  return (
    <section className={styles.panel} aria-labelledby="assessment-history-heading">
      <h2 id="assessment-history-heading" className={styles.heading}>
        Assessment history
      </h2>

      {assessmentsQuery.isError && (
        <ErrorNotice message="Could not load the assessment history. Please try again." />
      )}
      {!assessmentsQuery.isError &&
        !assessmentsQuery.isLoading &&
        (assessmentRows.length === 0 ? (
          <p className={styles.emptyNote}>
            No assessments have been conducted for this building yet.
          </p>
        ) : (
          <DataTable
            columns={columns}
            rows={assessmentRows}
            rowKey={(row) => row.id}
            label="Assessment history"
            // Through to the assessment itself - every question with its answer,
            // its photographs and its flagged floor plans. That view already
            // existed but was only reachable from the validation queue, so from a
            // BUILDING (where someone asking "what did we find here?" actually
            // starts) there was no way in and the evidence looked absent.
            //
            // Gated on the same roles the review screen gates itself on, so a row
            // never offers a link that lands on "auditor access required".
            rowHref={
              canOpenAssessments ? (row) => `/app/validation/${row.id}` : undefined
            }
          />
        ))}

      <h3 className={styles.subheading}>Released reports</h3>
      {reportsQuery.isError && (
        <ErrorNotice message="Could not load the released reports. Please try again." />
      )}
      {!reportsQuery.isError &&
        !reportsQuery.isLoading &&
        (reportRows.length === 0 ? (
          <p className={styles.emptyNote}>
            No reports have been released for this building yet. A report is
            generated when an assessment is released.
          </p>
        ) : (
          <ul className={styles.reportList}>
            {reportRows.map((row) => (
              <ReportItem
                key={row.id}
                report={row.report}
                canRegenerate={canOpenAssessments}
              />
            ))}
          </ul>
        ))}
    </section>
  );
}

// --- One released report row ----------------------------------------------------

function ReportItem({
  report,
  canRegenerate,
}: {
  report: Report;
  canRegenerate: boolean;
}) {
  const generate = useCallable<GenerateReportInput, GenerateReportResult>(
    'generateReport',
  );
  const [confirming, setConfirming] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);

  // Resolve the stored object path into a tokened download URL for the
  // signed-in member; failure degrades to honest copy, never a dead link.
  useEffect(() => {
    let cancelled = false;
    setDownloadUrl(null);
    setDownloadFailed(false);
    getDownloadURL(storageRef(firebase.storage(), report.pdfPath))
      .then((url) => {
        if (!cancelled) {
          setDownloadUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDownloadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [report.pdfPath]);

  const onRegenerate = async () => {
    if (!report.assessmentId) {
      return;
    }
    const result = await generate.call({ assessmentId: report.assessmentId });
    if (result) {
      setConfirming(false);
    }
  };

  return (
    <li className={styles.reportRow}>
      <div className={styles.reportBody}>
        <span className={styles.reportDate}>
          Generated {formatDate(report.generatedAt)}
        </span>
        <span className={styles.reportActions}>
          {downloadUrl && (
            <a
              className={styles.downloadLink}
              href={downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Download
            </a>
          )}
          {downloadFailed && (
            <span className={styles.unavailable}>
              The report file could not be reached. Please try again.
            </span>
          )}
          {/* Regeneration re-runs generateReport for the SOURCE assessment;
              a report with no assessmentId has nothing to re-run. */}
          {canRegenerate && report.assessmentId && !confirming && (
            <Button variant="ghost" onClick={() => setConfirming(true)}>
              Regenerate
            </Button>
          )}
        </span>
      </div>
      {/* The customer's sign-off. Shown on the staff side because "has the
          responsible person accepted this assessment?" is a question the office
          gets asked and previously had no way to answer without reading the
          database. The NAME is the one the contact typed at the prompt - their
          attestation - not a copy of their profile name. */}
      <p
        className={
          report.acceptance ? styles.acceptance : styles.acceptancePending
        }
      >
        {report.acceptance
          ? `Accepted by ${report.acceptance.name} on ${formatDate(
              report.acceptance.at,
            )}`
          : 'Not yet accepted by the customer'}
      </p>
      {confirming && (
        <div className={styles.confirm}>
          <p className={styles.confirmCopy}>
            Regenerate this report from its assessment? A new PDF is produced
            from the released data.
          </p>
          <div className={styles.confirmActions}>
            <Button
              variant="secondary"
              disabled={generate.pending}
              onClick={() => void onRegenerate()}
            >
              {generate.pending ? 'Regenerating' : 'Confirm regenerate'}
            </Button>
            <Button
              variant="ghost"
              disabled={generate.pending}
              onClick={() => {
                setConfirming(false);
                generate.clearError();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {generate.error && (
        <p role="alert" className={styles.inlineError}>
          {generate.error}
        </p>
      )}
    </li>
  );
}
