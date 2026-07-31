// ============================================================================
// PortalReport - one released report, behind its acceptance gate.
//
// This is where the released-report email lands (its "Accept & Sign Off" button
// deep-links straight here). Until the report record carries an `acceptance`,
// the contact sees a short form asking them to type their name, NOT a download
// link; once it is recorded, the screen offers the PDF.
//
// The acceptance prompt is a REAL gate now, not presentation. The PDF is no
// longer fetched from Storage with the reader's own token: this screen asks the
// getReportDownloadUrl callable, which re-derives the building's owning
// customer, the reader's live portal standing and their acceptance on every
// single request before it mints a 15-minute signed URL. Hiding the link used to
// be the whole of the gate (the object admitted a portal token on a customerId
// stamped into its metadata at generation time, and Storage rules cannot read
// RTDB to ask anything better); the object now admits a portal token to nothing.
// The prompt still produces the artefact the organisation needs either way: a
// named, timestamped, server-attributed sign-off in the audit trail.
//
// The route nests under the existing building URL, so the breadcrumb walks back
// the way the reader came. onAssessmentStageChange builds the same URL for the
// email CTA (it resolves the siteId while locating the building), which is why
// the two must move together.
// ============================================================================

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  AcceptReportInput,
  AcceptReportResult,
  GetReportDownloadUrlInput,
  GetReportDownloadUrlResult,
  Report,
} from '../../types';
import { Button } from '../../components/Button';
import { Card, CardHeader } from '../ui/Card';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { LoadingNote, formatDate } from '../customers/shared';
import { usePortalScope, portalUrls, portalReadStatus } from './shared';
import { DownloadIcon } from '../ui/DownloadIcon';
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

/** Shown when the browser refused to open the tab we asked for - the usual
 *  culprit is a pop-up blocker, because the URL is minted asynchronously and the
 *  open therefore lands outside the click's own gesture. The link rendered
 *  alongside this is a plain anchor the reader clicks themselves, which no
 *  blocker interferes with, so a blocked download is a one-click recovery
 *  rather than a dead end. */
const DOWNLOAD_BLOCKED =
  'Your browser blocked the report from opening in a new tab. Use the link below to open it.';

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
  const status = portalReadStatus(reports);

  if (status === 'failed') {
    return (
      <ErrorNotice message="This report could not be loaded. Please try again." />
    );
  }
  if (status === 'loading') {
    return <LoadingNote>Loading report</LoadingNote>;
  }
  if (!report) {
    return (
      <EmptyState
        title="This report is not available"
        body="It may have been withdrawn, or the link may be out of date. Your other reports are on your buildings page."
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
        back={{ label: 'this building', to: portalUrls.building(siteId, buildingId) }}
        crumbs={[
          { label: 'Your buildings', to: portalUrls.home },
          { label: 'Building', to: portalUrls.building(siteId, buildingId) },
          { label: 'Report' },
        ]}
      />
      {report.acceptance ? (
        <AcceptedCard
          report={report}
          buildingId={buildingId}
          reportId={reportId}
        />
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
function AcceptedCard({
  report,
  buildingId,
  reportId,
}: {
  report: Report;
  buildingId: string;
  reportId: string;
}) {
  // Only ever set when the browser refused the tab we opened. Deliberately NOT
  // a cached URL to reuse: it expires, and offering an expired link back to the
  // reader would be exactly the dead end this design removes. Every click asks
  // the server again, so what the reader gets is always freshly authorised.
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const acceptance = report.acceptance;
  const mintUrl = useCallable<
    GetReportDownloadUrlInput,
    GetReportDownloadUrlResult
  >('getReportDownloadUrl');

  const download = async () => {
    setBlockedUrl(null);
    // Resolves null on failure with the server's own calm copy on `error`, so
    // an access that has since been withdrawn, an unaccepted report and a
    // transport wobble each say the right thing without a branch here.
    const minted = await mintUrl.call({ buildingId, reportId });
    if (!minted) {
      return;
    }
    const opened = window.open(minted.url, '_blank', 'noopener');
    if (!opened) {
      setBlockedUrl(minted.url);
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
      {mintUrl.error && <ErrorNotice message={mintUrl.error} />}
      {blockedUrl && (
        <>
          <ErrorNotice message={DOWNLOAD_BLOCKED} />
          <a
            className={styles.fallbackLink}
            href={blockedUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the report PDF
          </a>
        </>
      )}
      <div className={styles.formActions}>
        {/* Icon AND words here, unlike the table rows. This is the primary
            action of a customer-facing page - the one thing a responsible person
            came to do - and an icon-only primary CTA asks them to guess. The
            icon repeated down a column was noise; here it is reinforcement. */}
        <Button onClick={() => void download()} disabled={mintUrl.pending}>
          <DownloadIcon className={styles.buttonIcon} />
          {mintUrl.pending ? 'Preparing' : 'Download PDF'}
        </Button>
      </div>
    </Card>
  );
}
