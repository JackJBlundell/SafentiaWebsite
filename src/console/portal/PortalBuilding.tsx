// ============================================================================
// PortalBuilding (story 2058): one building, for its owning customer - the
// building facts, the released reports with download links, and the read-only
// action plan in severity order with status, due date and the Life Protection
// marker. NO mutations anywhere on this screen: a customer reads their fire
// safety position, they never edit it (the rules deny writes regardless).
//
// Reads ride the portal rules: the building via its site's ownership grant,
// reports via /reports/{orgId}/building/{buildingId} and actions via
// /actions/{orgId}/{buildingId}, both scoped through /buildingCustomerIndex.
//
// Reports LINK to PortalReport rather than downloading here: a report has to be
// accepted before its PDF is offered, and that gate lives on its own screen.
// ============================================================================

import { useParams } from 'react-router-dom';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { Action, Building, Report, Severity } from '../../types';
import { PageHeader, EmptyState, ErrorNotice } from '../ui/Page';
import { Card, CardHeader } from '../ui/Card';
import { Button } from '../../components/Button';
import { RagChip, LoadingNote, formatDate, toEntries } from '../customers/shared';
import { usePortalScope, portalUrls, SeverityChip } from './shared';
import styles from './PortalBuilding.module.css';

const ACTION_STATUS_LABELS: Record<Action['status'], string> = {
  open: 'Open',
  signedOff: 'Signed off',
  archived: 'Archived',
};

/** Severity sort rank: high first - the order a duty-holder must read them. */
const SEVERITY_RANK: Record<Severity, number> = { H: 0, M: 1, L: 2 };

export function PortalBuilding() {
  const { siteId = '', buildingId = '' } = useParams();
  const { ready, orgId, db } = usePortalScope();

  const building = useRtdbQuery<Building | null>({
    key: keys.building(orgId || 'none', siteId, buildingId),
    path: ready && db ? db.building(orgId, siteId, buildingId) : 'none',
    enabled: ready && Boolean(siteId && buildingId),
  });

  if (building.isError) {
    return (
      <ErrorNotice message="This building could not be loaded. Please try again." />
    );
  }
  if (building.isLoading) {
    return <LoadingNote>Loading building</LoadingNote>;
  }
  if (!building.data) {
    return (
      <EmptyState
        title="Building not found"
        body="This building may have been removed, or the link is out of date."
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
        title={building.data.name}
        lede={building.data.address}
        crumbs={[
          { label: 'Your buildings', to: portalUrls.home },
          { label: building.data.name },
        ]}
      />
      <div className={styles.stack}>
        <FactsCard building={building.data} />
        <ReportsCard siteId={siteId} buildingId={buildingId} />
        <ActionPlanCard buildingId={buildingId} />
      </div>
    </>
  );
}

/** The building's standing facts. Facts with no value simply do not render -
 *  no placeholder rows. */
function FactsCard({ building }: { building: Building }) {
  const details = building.details;
  const facts: Array<[string, string]> = [];
  if (building.address) facts.push(['Address', building.address]);
  if (details?.floors !== undefined) {
    facts.push(['Floors', String(details.floors)]);
  }
  if (details?.occupants !== undefined) {
    facts.push(['Occupants', String(details.occupants)]);
  }
  if (details?.alarmType) facts.push(['Alarm type', details.alarmType]);
  if (details?.alarmCategory) {
    facts.push(['Alarm category', details.alarmCategory]);
  }
  if (building.responsibleParty?.name) {
    facts.push(['Responsible party', building.responsibleParty.name]);
  } else if (building.responsiblePerson) {
    facts.push(['Responsible person', building.responsiblePerson]);
  }
  if (building.lastAssessedAt) {
    facts.push(['Last assessed', formatDate(building.lastAssessedAt)]);
  }
  const nextDue = building.serviceSchedule?.fraReview?.nextDue;
  facts.push(['Next review', nextDue ? formatDate(nextDue) : 'Not scheduled']);

  return (
    <Card>
      <CardHeader
        title="Fire safety status"
        action={<RagChip level={building.riskLevel} />}
      />
      <dl className={styles.facts}>
        {facts.map(([label, value]) => (
          <div key={label} className={styles.fact}>
            <dt className={styles.factLabel}>{label}</dt>
            <dd className={styles.factValue}>{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Released reports for this building, newest first. Each opens its own screen:
 *  the PDF sits behind an acceptance gate until the contact has signed it off,
 *  so the row links rather than downloading straight from here. */
function ReportsCard({
  siteId,
  buildingId,
}: {
  siteId: string;
  buildingId: string;
}) {
  const { ready, orgId, db } = usePortalScope();
  const reports = useRtdbQuery<Record<string, Report> | null>({
    key: keys.reports(orgId || 'none', 'building', buildingId),
    path: ready && db ? db.reports(orgId, 'building', buildingId) : 'none',
    enabled: ready && Boolean(buildingId),
  });

  const rows = toEntries(reports.data).sort(
    (a, b) => b[1].generatedAt - a[1].generatedAt,
  );

  return (
    <Card>
      <CardHeader
        title="Reports"
        hint="Fire risk assessment reports released for this building."
      />
      {reports.isError && (
        <ErrorNotice message="Reports could not be loaded. Please try again." />
      )}
      {!reports.isError && reports.isLoading && (
        <LoadingNote>Loading reports</LoadingNote>
      )}
      {!reports.isError && !reports.isLoading && rows.length === 0 && (
        <p className={styles.emptyLine}>No reports have been released yet.</p>
      )}
      {rows.length > 0 && (
        <ul className={styles.reportList}>
          {rows.map(([reportId, report]) => (
            <ReportRow
              key={reportId}
              siteId={siteId}
              buildingId={buildingId}
              reportId={reportId}
              report={report}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ReportRow({
  siteId,
  buildingId,
  reportId,
  report,
}: {
  siteId: string;
  buildingId: string;
  reportId: string;
  report: Report;
}) {
  const accepted = Boolean(report.acceptance);
  return (
    <li className={styles.reportRow}>
      <span className={styles.reportIdentity}>
        <span className={styles.reportName}>Fire risk assessment report</span>
        <span className={styles.reportDate}>
          Released {formatDate(report.generatedAt)}
          {accepted ? ' - accepted' : ' - awaiting your acceptance'}
        </span>
      </span>
      <Button
        variant="secondary"
        to={portalUrls.report(siteId, buildingId, reportId)}
      >
        {accepted ? 'Open report' : 'Accept & sign off'}
      </Button>
    </li>
  );
}

/** The read-only action plan: severity order (high first), then due date. */
function ActionPlanCard({ buildingId }: { buildingId: string }) {
  const { ready, orgId, db } = usePortalScope();
  const actions = useRtdbQuery<Record<string, Action> | null>({
    key: keys.actions(orgId || 'none', buildingId),
    path: ready && db ? db.actions(orgId, buildingId) : 'none',
    enabled: ready && Boolean(buildingId),
  });

  const rows = toEntries(actions.data).sort((a, b) => {
    const bySeverity =
      SEVERITY_RANK[a[1].severity] - SEVERITY_RANK[b[1].severity];
    if (bySeverity !== 0) return bySeverity;
    return (a[1].dueBy ?? Number.MAX_SAFE_INTEGER) -
      (b[1].dueBy ?? Number.MAX_SAFE_INTEGER);
  });

  return (
    <Card>
      <CardHeader
        title="Action plan"
        hint="Remedial actions from the latest assessment. Your fire safety provider manages sign-off."
      />
      {actions.isError && (
        <ErrorNotice message="The action plan could not be loaded. Please try again." />
      )}
      {!actions.isError && actions.isLoading && (
        <LoadingNote>Loading the action plan</LoadingNote>
      )}
      {!actions.isError && !actions.isLoading && rows.length === 0 && (
        <p className={styles.emptyLine}>
          There are no remedial actions for this building.
        </p>
      )}
      {rows.length > 0 && (
        <ul className={styles.actionList}>
          {rows.map(([actionId, action]) => (
            <li key={actionId} className={styles.actionRow}>
              <div className={styles.actionMeta}>
                <SeverityChip severity={action.severity} />
                {action.lifeProtection && (
                  <span className={styles.ltpMarker}>Life Protection</span>
                )}
                <span className={styles.actionStatus}>
                  {ACTION_STATUS_LABELS[action.status]}
                </span>
                {action.dueBy && (
                  <span className={styles.actionDue}>
                    Due by {formatDate(action.dueBy)}
                  </span>
                )}
              </div>
              <p className={styles.actionQuestion}>{action.question}</p>
              <p className={styles.actionObservation}>{action.observation}</p>
              {action.responsible && (
                <p className={styles.actionResponsible}>
                  Responsible: {action.responsible}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
