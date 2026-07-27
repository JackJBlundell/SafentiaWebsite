// ============================================================================
// PortalBuilding (story 2058): one building, for its owning customer - its risk
// status at a glance, the building facts, the released reports, and the
// read-only action plan in severity order with status, due date and the Life
// Protection marker. NO mutations anywhere on this screen: a customer reads
// their fire safety position, they never edit it (the rules deny writes
// regardless).
//
// The page is laid out the way the reader's questions arrive: how bad is it
// (the risk band), what am I being asked to do (the reports gate, then the
// action plan), and what is this building anyway (the facts, in the aside).
// The risk band is the SAME ComplianceGlance the staff building page uses in
// single mode, so the customer and their assessor look at one picture, not two
// that can disagree.
//
// Reads ride the portal rules: the building via its site's ownership grant,
// reports via /reports/{orgId}/building/{buildingId} and actions via
// /actions/{orgId}/{buildingId}, both scoped through /buildingCustomerIndex.
// The actions subscription is owned here and passed down, so the risk band and
// the action plan share one listener rather than opening two on one node.
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
import { ComplianceGlance } from '../ui/ComplianceGlance';
import { DescriptionList, PageGrid, type DescriptionItem } from '../ui/Grid';
import { Button } from '../../components/Button';
import { RagChip, LoadingNote, formatDate, toEntries } from '../customers/shared';
import {
  usePortalScope,
  portalUrls,
  SeverityChip,
  portalReadStatus,
  type PortalReadStatus,
} from './shared';
import styles from './PortalBuilding.module.css';

const ACTION_STATUS_LABELS: Record<Action['status'], string> = {
  open: 'Open',
  inProgress: 'In progress',
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

  // Owned here so the risk band above and the action plan below read one
  // listener between them (CONVENTIONS 2).
  const actions = useRtdbQuery<Record<string, Action> | null>({
    key: keys.actions(orgId || 'none', buildingId),
    path: ready && db ? db.actions(orgId, buildingId) : 'none',
    enabled: ready && Boolean(buildingId),
  });

  const buildingStatus = portalReadStatus(building);
  const actionsStatus = portalReadStatus(actions);

  if (buildingStatus === 'failed') {
    return (
      <ErrorNotice message="This building could not be loaded. Please try again." />
    );
  }
  if (buildingStatus === 'loading') {
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

  const record = building.data;
  // No release has ever stamped this building, so nothing downstream of an
  // assessment exists yet. Every empty section below says that in words rather
  // than leaving the reader with a page of blanks.
  const neverAssessed = record.lastAssessedAt === undefined;

  return (
    <>
      <PageHeader
        title={record.name}
        lede={record.address}
        badges={<RagChip level={record.riskLevel} />}
        back={{ label: 'your buildings', to: portalUrls.home }}
        crumbs={[
          { label: 'Your buildings', to: portalUrls.home },
          { label: record.name },
        ]}
      />
      <PageGrid aside={<FactsCard building={record} />}>
        {/* Single-building mode: one segment of a proportional bar would be
            meaningless, so the building's own RAG status stands in and the
            tiles read its action plan. Actions stay `undefined` only while the
            read is genuinely unresolved, which the band shows as a skeleton; an
            EMPTY action plan is a real, reportable zero and is passed as such.
            A failed read stays a skeleton rather than an invented zero, and the
            action plan below carries the retryable error. */}
        <ComplianceGlance
          single
          heading="Fire safety status"
          buildings={[{ siteId, buildingId, building: record }]}
          actions={
            actionsStatus === 'ready'
              ? Object.values(actions.data ?? {})
              : undefined
          }
        />
        {neverAssessed && (
          <Card>
            <CardHeader
              title="No fire risk assessment yet"
              hint="Your assessor has not carried out a fire risk assessment on this building yet. When they have, its report and action plan will appear here and we will email you."
            />
          </Card>
        )}
        <ReportsCard
          siteId={siteId}
          buildingId={buildingId}
          neverAssessed={neverAssessed}
        />
        <ActionPlanCard
          status={actionsStatus}
          data={actions.data}
          neverAssessed={neverAssessed}
        />
      </PageGrid>
    </>
  );
}

/** The building's standing facts, pinned beside the content. Facts with no
 *  value simply do not render - no placeholder rows. */
function FactsCard({ building }: { building: Building }) {
  const details = building.details;
  const nextDue = building.serviceSchedule?.fraReview?.nextDue;
  const items: DescriptionItem[] = [
    { label: 'Address', value: building.address },
    {
      label: 'Floors',
      value: details?.floors !== undefined ? String(details.floors) : undefined,
    },
    {
      label: 'Occupants',
      value:
        details?.occupants !== undefined ? String(details.occupants) : undefined,
    },
    { label: 'Alarm type', value: details?.alarmType },
    { label: 'Alarm category', value: details?.alarmCategory },
    {
      label: building.responsibleParty?.name
        ? 'Responsible party'
        : 'Responsible person',
      value: building.responsibleParty?.name ?? building.responsiblePerson,
    },
    {
      label: 'Last assessed',
      value: building.lastAssessedAt
        ? formatDate(building.lastAssessedAt)
        : 'Not yet assessed',
    },
    {
      label: 'Next review',
      value: nextDue ? formatDate(nextDue) : 'Not scheduled',
    },
  ];

  return (
    <Card>
      <CardHeader title="About this building" />
      <DescriptionList items={items} />
    </Card>
  );
}

/** Released reports for this building, newest first. Each opens its own screen:
 *  the PDF sits behind an acceptance gate until the contact has signed it off,
 *  so the row links rather than downloading straight from here. */
function ReportsCard({
  siteId,
  buildingId,
  neverAssessed,
}: {
  siteId: string;
  buildingId: string;
  /** Shapes the empty copy: no report because no assessment has happened, as
   *  opposed to an assessment that has not been released yet. */
  neverAssessed: boolean;
}) {
  const { ready, orgId, db } = usePortalScope();
  const reports = useRtdbQuery<Record<string, Report> | null>({
    key: keys.reports(orgId || 'none', 'building', buildingId),
    path: ready && db ? db.reports(orgId, 'building', buildingId) : 'none',
    enabled: ready && Boolean(buildingId),
  });

  const status = portalReadStatus(reports);
  const rows = toEntries(reports.data).sort(
    (a, b) => b[1].generatedAt - a[1].generatedAt,
  );
  const awaiting = rows.filter(([, report]) => !report.acceptance).length;

  return (
    <Card flush>
      <div className={styles.cardHeaderPad}>
        <CardHeader
          title="Reports"
          hint="Fire risk assessment reports released for this building."
          action={
            awaiting > 0 ? (
              <span className={styles.awaitingBadge}>
                {awaiting === 1
                  ? '1 awaiting acceptance'
                  : `${awaiting} awaiting acceptance`}
              </span>
            ) : undefined
          }
        />
      </div>
      {status === 'failed' && (
        <div className={styles.cardBodyPad}>
          <ErrorNotice message="Reports could not be loaded. Please try again." />
        </div>
      )}
      {status === 'loading' && (
        <div className={styles.cardBodyPad}>
          <LoadingNote>Loading reports</LoadingNote>
        </div>
      )}
      {status === 'ready' && rows.length === 0 && (
        <p className={styles.emptyLine}>
          {neverAssessed
            ? 'There is no report yet. Your assessor has not carried out a fire risk assessment on this building, so there is nothing for you to read or accept at the moment.'
            : 'No report has been released for this building yet. You will be emailed as soon as one is.'}
        </p>
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
  const acceptance = report.acceptance;
  return (
    <li className={styles.reportRow}>
      <span className={styles.reportIdentity}>
        <span className={styles.reportName}>Fire risk assessment report</span>
        <span className={styles.reportDate}>
          Released {formatDate(report.generatedAt)}
        </span>
        <span
          className={acceptance ? styles.reportStateDone : styles.reportStateTodo}
        >
          {acceptance
            ? `Accepted by ${acceptance.name} on ${formatDate(acceptance.at)}`
            : 'Awaiting your acceptance'}
        </span>
      </span>
      <Button
        variant={acceptance ? 'secondary' : 'primary'}
        to={portalUrls.report(siteId, buildingId, reportId)}
      >
        {acceptance ? 'Open report' : 'Accept & sign off'}
      </Button>
    </li>
  );
}

/** The read-only action plan: severity order (high first), then due date. The
 *  subscription belongs to the page, so this component only presents it. */
function ActionPlanCard({
  status,
  data,
  neverAssessed,
}: {
  status: PortalReadStatus;
  data: Record<string, Action> | null | undefined;
  /** Shapes the empty copy: no actions because no assessment has happened, as
   *  opposed to an assessment that raised none. */
  neverAssessed: boolean;
}) {
  const rows = toEntries(data).sort((a, b) => {
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
        hint="Remedial actions from the latest assessment, most serious first. Your fire safety provider manages sign-off."
      />
      {status === 'failed' && (
        <ErrorNotice message="The action plan could not be loaded. Please try again." />
      )}
      {status === 'loading' && <LoadingNote>Loading the action plan</LoadingNote>}
      {status === 'ready' && rows.length === 0 && (
        <p className={styles.emptyLine}>
          {neverAssessed
            ? 'There is no action plan yet. Your assessor has not carried out a fire risk assessment on this building, so no remedial actions have been raised.'
            : 'No remedial actions have been raised for this building. Nothing is outstanding for you to act on.'}
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
