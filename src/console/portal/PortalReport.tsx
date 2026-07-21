// ============================================================================
// PortalReport - one released report, behind its acceptance gate.
//
// This is where the released-report email lands (its "Accept & Sign Off" button
// deep-links straight here). The gate is the point of the screen: until the
// report record carries an `acceptance`, the contact sees a short form asking
// them to type their name, NOT a download link. Only once the acceptance is
// recorded does the PDF become reachable.
//
// The gate is a courtesy, not a security boundary - the Storage rules already
// decide who may fetch the object, and a determined reader could always resolve
// the path themselves. What the gate produces is the ARTEFACT the organisation
// needs: a named, timestamped, server-attributed sign-off in the audit trail.
//
// The route nests under the existing building URL, so the breadcrumb walks back
// the way the reader came. onAssessmentStageChange builds the same URL for the
// email CTA (it resolves the siteId while locating the building), which is why
// the two must move together.
// ============================================================================

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { firebase } from '../../firebase';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  AcceptReportInput,
  AcceptReportResult,
  Report,
} from '../../types';
import { Button } from '../../components/Button';
import { Card, CardHeader } from '../ui/Card';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { LoadingNote, formatDate } from '../customers/shared';
import { usePortalScope, portalUrls } from './shared';
import styles from './PortalReport.module.css';

/** The client mirror of the callable's name check: two characters and at least
 *  one letter. Kept identical so a rejection is caught here as calm inline copy
 *  rather than surfacing as a server error. */
const MIN_NAME_LENGTH = 2;
const HAS_LETTER = /\p{L}/u;

function nameIsSignable(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= MIN_NAME_LENGTH && HAS_LETTER.test(trimmed);
}

export function PortalReport() {
  const { siteId = '', buildingId = '', reportId = '' } = useParams();
  const { ready, orgId, db } = usePortalScope();

  // Subscribed through the building's report LIST rather than the single node:
  // it is the same key PortalBuilding already holds, so arriving from that
  // screen paints from cache and the acceptance written below reflects back on
  // both screens through one listener.
  const reports = useRtdbQuery<Record<string, Report> | null>({
    key: keys.reports(orgId || 'none', 'building', buildingId),
    path: ready && db ? db.reports(orgId, 'building', buildingId) : 'none',
    enabled: ready && Boolean(buildingId),
  });

  const report = reports.data?.[reportId];

  if (reports.isError) {
    return (
      <ErrorNotice message="This report could not be loaded. Please try again." />
    );
  }
  if (reports.isLoading) {
    return <LoadingNote>Loading report</LoadingNote>;
  }
  if (!report) {
    return (
      <EmptyState
        title="Report not found"
        body="This report may have been withdrawn, or the link is out of date."
        action={
          <Button variant="secondary" to={portalUrls.home}>
            Back to your buildings
          </Button>
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Fire risk assessment report"
        lede={`Released ${formatDate(report.generatedAt)}`}
        crumbs={[
          { label: 'Your buildings', to: portalUrls.home },
          { label: 'Building', to: portalUrls.building(siteId, buildingId) },
          { label: 'Report' },
        ]}
      />
      {report.acceptance ? (
        <AcceptedCard report={report} />
      ) : (
        <AcceptanceGate buildingId={buildingId} reportId={reportId} />
      )}
    </>
  );
}

/** The gate: accept before the report opens. */
function AcceptanceGate({
  buildingId,
  reportId,
}: {
  buildingId: string;
  reportId: string;
}) {
  const [name, setName] = useState('');
  // Only shown once a submission has been attempted, so the field does not
  // scold someone who has simply not finished typing yet.
  const [touched, setTouched] = useState(false);
  const accept = useCallable<AcceptReportInput, AcceptReportResult>('acceptReport');

  const valid = nameIsSignable(name);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!valid || accept.pending) {
      return;
    }
    // No local success state: the acceptance reflects back through the live
    // listener, which swaps this gate for the accepted view (CONVENTIONS 2).
    await accept.call({ buildingId, reportId, name: name.trim() });
  };

  return (
    <Card>
      <CardHeader
        title="Accept the report"
        hint="Please confirm you have received this fire risk assessment report."
      />
      <p className={styles.copy}>
        Type your full name below to accept and sign off this report. Your name,
        and the date and time you accepted, are recorded against the report. The
        report is available to download immediately afterwards.
      </p>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <label className={styles.label} htmlFor="portal-acceptance-name">
          Your full name
        </label>
        <input
          id="portal-acceptance-name"
          className={styles.input}
          type="text"
          value={name}
          autoComplete="name"
          disabled={accept.pending}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && !valid}
          aria-describedby={touched && !valid ? 'portal-acceptance-error' : undefined}
        />
        {touched && !valid && (
          <p id="portal-acceptance-error" className={styles.fieldError}>
            Please type your full name.
          </p>
        )}
        {accept.error && <ErrorNotice message={accept.error} />}
        <div className={styles.formActions}>
          <Button type="submit" disabled={accept.pending}>
            {accept.pending ? 'Accepting' : 'Accept & sign off'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Past the gate: the recorded sign-off and the download. */
function AcceptedCard({ report }: { report: Report }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acceptance = report.acceptance;

  // The record carries the Storage object path; the download resolves it to a
  // short-lived URL at click time, so nothing durable is embedded in the page.
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await getDownloadURL(
        storageRef(firebase.storage(), report.pdfPath),
      );
      window.open(url, '_blank', 'noopener');
    } catch {
      setError(
        'The report could not be downloaded. Please try again, or contact your fire safety provider.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Report accepted"
        hint="This report has been signed off and is available to download."
      />
      {acceptance && (
        <p className={styles.copy}>
          Accepted by {acceptance.name} on {formatDate(acceptance.at)}.
        </p>
      )}
      {error && <ErrorNotice message={error} />}
      <div className={styles.formActions}>
        <Button onClick={() => void download()} disabled={busy}>
          {busy ? 'Preparing' : 'Download PDF'}
        </Button>
      </div>
    </Card>
  );
}
