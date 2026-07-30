// ============================================================================
// PortalBuilding (story 2058): one building, for its owning customer - its risk
// status at a glance, the building facts, the released reports, and the action
// plan in severity order with status, due date and the Life Protection marker.
//
// The plan is the one place a customer ACTS rather than reads. The remedial work
// is theirs to arrange, so they can tell their provider it is in hand or done
// (respondToAction) - and that is the whole of it. They cannot close an action:
// the provider verifies the claim and signs it off, which the copy on this
// screen says in as many words. The database rules still deny every portal
// write, so the response goes through the callable, which re-derives the
// caller's right to make it. Everything else here remains read-only.
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

import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { firebase } from '../../firebase';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Action,
  ActionCustomerResponse,
  ActionResponseState,
  Building,
  CustomerRole,
  CustomerRoleSet,
  Report,
  RespondToActionInput,
  RespondToActionResult,
  SafentiaDocument,
  Severity,
} from '../../types';
import { PageHeader, EmptyState, ErrorNotice } from '../ui/Page';
import { Card, CardHeader } from '../ui/Card';
import { ComplianceGlance } from '../ui/ComplianceGlance';
import { DescriptionList, PageGrid, type DescriptionItem } from '../ui/Grid';
import { Button } from '../../components/Button';
import { useCallable } from '../ui/useCallable';
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

/** What a customer can say about their own work, in their words. Neither wording
 *  claims a closure: "completed" is explicitly a claim awaiting the provider. */
const RESPONSE_LABELS: Record<ActionResponseState, string> = {
  inHand: 'Work is in hand',
  completed: 'Work is completed, awaiting verification',
};

/**
 * WHICH PORTAL ROLES SEE THE RESPOND CONTROL. The SERVER decides - see
 * PORTAL_ROLE_MAY_RESPOND in functions/src/functions/respondToAction.ts, which
 * re-reads the caller's live /customerMembers roles and refuses regardless of
 * what this screen renders. This mirror exists only so a viewer is never shown
 * a button that would be turned away; change the two together.
 */
const ROLE_MAY_RESPOND: Record<CustomerRole, boolean> = {
  admin: true,
  finance: true,
  viewer: false,
};

/** A session carrying no role flags is judged the least-privileged seat, exactly
 *  as the server judges it, so an empty role set is never a way past the table. */
function mayRespond(roles: CustomerRoleSet): boolean {
  const held = (Object.keys(ROLE_MAY_RESPOND) as CustomerRole[]).filter(
    (role) => roles[role] === true,
  );
  return held.length > 0 && held.some((role) => ROLE_MAY_RESPOND[role]);
}

/** The lifecycle states a customer can still report progress against: work that
 *  is live. A signed-off or archived action is settled, and the server refuses
 *  a response to either. */
function isLiveAction(action: Action): boolean {
  return action.status === 'open' || action.status === 'inProgress';
}

/**
 * The supporting document attached when an action was signed off - the proof
 * the remedial work actually happened.
 *
 * The record holds a Storage object PATH, so the link is minted here for the
 * signed-in portal user. manageAction stamps the owning customer onto that
 * object at sign-off and the Storage rule scopes the read to exactly that
 * customer, so the grant is the same one that lets this contact download their
 * own reports. A refused or missing object degrades to the file's name in muted
 * copy: the fact that evidence exists still belongs on the record, and a dead
 * link would be worse than an honest one.
 */
function EvidenceLink({ document }: { document: SafentiaDocument }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    getDownloadURL(storageRef(firebase.storage(), document.storagePath))
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [document.storagePath]);

  return (
    <p className={styles.actionEvidence}>
      Evidence:{' '}
      {url && !failed ? (
        <a
          className={styles.actionEvidenceLink}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {document.fileName}
        </a>
      ) : (
        <span className={styles.actionEvidenceMuted}>
          {failed ? `${document.fileName} (unavailable)` : document.fileName}
        </span>
      )}
    </p>
  );
}

export function PortalBuilding() {
  const { siteId = '', buildingId = '' } = useParams();
  const { ready, orgId, db } = usePortalScope();
  // The respond control is role-gated. Read straight from the resolved session
  // rather than through usePortalScope's `isAdmin`, because this decision is a
  // ROLE TABLE (finance may respond too), not the admin flag.
  const { claims } = useAuth();
  const canRespond =
    claims?.kind === 'portal' ? mayRespond(claims.customerRoles) : false;

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
          buildingId={buildingId}
          canRespond={canRespond}
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
      label: 'Responsible party',
      value: building.responsibleParty?.name,
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

/** The action plan: severity order (high first), then due date. The subscription
 *  belongs to the page, so this component only presents it - and, for a role
 *  that holds it, offers the one write the portal has on this screen. */
function ActionPlanCard({
  buildingId,
  canRespond,
  status,
  data,
  neverAssessed,
}: {
  buildingId: string;
  /** Whether this session's portal role may record progress. Presentation only:
   *  respondToAction re-derives the same decision from live state. */
  canRespond: boolean;
  status: PortalReadStatus;
  data: Record<string, Action> | null | undefined;
  /** Shapes the empty copy: no actions because no assessment has happened, as
   *  opposed to an assessment that raised none. */
  neverAssessed: boolean;
}) {
  // The action whose respond form is open. One at a time: two half-written
  // updates on one screen is a way to send the wrong note against the wrong job.
  const [responding, setResponding] = useState<string | null>(null);

  const rows = toEntries(data).sort((a, b) => {
    const bySeverity =
      SEVERITY_RANK[a[1].severity] - SEVERITY_RANK[b[1].severity];
    if (bySeverity !== 0) return bySeverity;
    return (a[1].dueBy ?? Number.MAX_SAFE_INTEGER) -
      (b[1].dueBy ?? Number.MAX_SAFE_INTEGER);
  });
  const hasLiveActions = rows.some(([, action]) => isLiveAction(action));

  return (
    <Card>
      <CardHeader
        title="Action plan"
        hint="Remedial actions from the latest assessment, most serious first. The work is yours to arrange; tell us how it is going and your fire safety provider verifies it and signs it off."
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
      {/* A viewer is told WHY there is no button rather than left wondering -
          the fix is a conversation with their own portal administrator. */}
      {!canRespond && hasLiveActions && (
        <p className={styles.actionRoleNote}>
          Your account can read this action plan but cannot record progress on
          it. Ask one of your portal administrators to update your provider.
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
              {action.customerResponse && (
                <CustomerResponseNote
                  response={action.customerResponse}
                  signedOff={action.status === 'signedOff'}
                />
              )}
              {action.completionNote && (
                <p className={styles.actionResponsible}>
                  Signed off by your provider: {action.completionNote}
                </p>
              )}
              {action.completionEvidence && (
                <EvidenceLink document={action.completionEvidence} />
              )}
              {canRespond && isLiveAction(action) && (
                responding === actionId ? (
                  <RespondForm
                    buildingId={buildingId}
                    actionId={actionId}
                    current={action.customerResponse}
                    onDone={() => setResponding(null)}
                  />
                ) : (
                  <div className={styles.actionActions}>
                    <Button
                      variant="secondary"
                      onClick={() => setResponding(actionId)}
                    >
                      {action.customerResponse
                        ? 'Update your provider'
                        : 'Tell your provider'}
                    </Button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** What this customer last told their provider about the action, and what
 *  happens next. The "awaiting verification" half is the important half: the
 *  record must never let a customer's own claim read as a closure. */
function CustomerResponseNote({
  response,
  signedOff,
}: {
  response: ActionCustomerResponse;
  /** True once the provider has verified and closed it, so the line stops
   *  promising a verification that has already happened. */
  signedOff: boolean;
}) {
  return (
    <div className={styles.responseNote}>
      <p className={styles.responseState}>
        You told us on {formatDate(response.at)}:{' '}
        {response.state === 'completed'
          ? signedOff
            ? 'the work was completed.'
            : 'the work is completed. Your provider will verify it and sign it off.'
          : 'the work is in hand.'}
      </p>
      {response.note && <p className={styles.responseBody}>{response.note}</p>}
    </div>
  );
}

/**
 * The one write on this screen: the duty-holder's own account of progress.
 *
 * No local success state - the response reflects back through the page's live
 * listener and renders as the note above (CONVENTIONS 2), so the form simply
 * closes. The note box starts EMPTY even when a response already exists,
 * because each response is a dated entry in the action's trail rather than an
 * edit of the last one.
 */
function RespondForm({
  buildingId,
  actionId,
  current,
  onDone,
}: {
  buildingId: string;
  actionId: string;
  current: ActionCustomerResponse | undefined;
  onDone: () => void;
}) {
  const [state, setState] = useState<ActionResponseState>(
    current?.state ?? 'inHand',
  );
  const [note, setNote] = useState('');
  const respond = useCallable<RespondToActionInput, RespondToActionResult>(
    'respondToAction',
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = note.trim();
    const result = await respond.call({
      buildingId,
      actionId,
      state,
      ...(trimmed ? { note: trimmed } : {}),
    });
    if (result) {
      onDone();
    }
  };

  const fieldId = `respond-${actionId}`;
  return (
    <form className={styles.respondForm} onSubmit={(event) => void submit(event)}>
      <fieldset className={styles.respondFieldset} disabled={respond.pending}>
        <legend className={styles.respondLegend}>Where has this got to?</legend>
        {(Object.keys(RESPONSE_LABELS) as ActionResponseState[]).map((value) => (
          <label key={value} className={styles.respondChoice}>
            <input
              type="radio"
              name={fieldId}
              value={value}
              checked={state === value}
              onChange={() => setState(value)}
            />
            <span>{RESPONSE_LABELS[value]}</span>
          </label>
        ))}
      </fieldset>
      <label className={styles.respondField} htmlFor={`${fieldId}-note`}>
        <span className={styles.respondLabel}>
          Anything your provider should know (optional)
        </span>
        <textarea
          id={`${fieldId}-note`}
          className={styles.respondTextarea}
          rows={3}
          value={note}
          disabled={respond.pending}
          maxLength={5000}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <p className={styles.respondFootnote}>
        This records what you have told your provider, dated and against your
        name. It does not close the action: they verify the work and sign it off.
      </p>
      {respond.error && <ErrorNotice message={respond.error} />}
      <div className={styles.actionActions}>
        <Button type="submit" disabled={respond.pending}>
          {respond.pending ? 'Sending' : 'Send to your provider'}
        </Button>
        <Button
          variant="secondary"
          type="button"
          disabled={respond.pending}
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
