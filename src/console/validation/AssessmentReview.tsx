// ============================================================================
// AssessmentReview - the auditor's full-fidelity review of one submitted
// assessment (FR-E18 surface B), at /app/validation/:assessmentId.
//
// Everything renders from the assessment's EMBEDDED templateSnapshot plus the
// live answers node - never the live template. The snapshot is the contract:
// it is the exact set of sections and questions the assessor was asked, pinned
// at start time, so the review cannot drift even if the template has since
// been edited or republished.
//
// Lifecycle actions all go through the frozen callable contract, server-side:
//   requestInfo        flag questions with messages -> status infoRequired
//   acceptAssessment   readyForValidation -> readyForRelease
//   releaseAssessment  readyForRelease -> released (creates the action plan
//                      and triggers report generation)
// The screen never writes status itself; the live listeners reflect each
// transition back, so the UI state after a call is whatever the server says.
//
// Flag basket: drafts live here (question id -> message) as the single source;
// the inline composer on each AnswerCard, the editable basket in the aside and
// the send bar all edit the same entry. "Send to assessor" submits every request
// in ONE requestInfo call - the contract takes the batch so the assessor is
// notified once, not per question.
//
// WHY THE SEND BAR IS FIXED TO THE VIEWPORT. The basket and its send button used
// to live only in the aside, which above 1024px is its own scroll container
// capped to the viewport (see ui/Grid.module.css) - so behind the Facts and
// Progress cards the send button could sit below the fold inside a nested
// scroller with no visible scrollbar, and below 1024px the aside is not "on the
// right" at all but under every section card. An auditor wrote a message on
// every unanswered question, never found the button, and reported that they did
// not know how to send the assessment back. The bar makes the action impossible
// to lose: the moment a first question is flagged it appears at the foot of the
// screen with the count and the send button, at every width.
//
// Leaving with a full basket is a THREE-way choice (send / keep editing /
// discard), not a window.confirm. The old OK/Cancel prompt read like a generic
// "are you sure you want to leave", and clicking through it silently destroyed
// the auditor's written messages - which is how that same review ended up
// accepted with the questions still unanswered.
// ============================================================================

import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { urls } from '../customers/shared';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  ASSESSMENT_STAGE_LABELS,
  INFO_REQUEST_DUE_DAYS,
  SERVICE_SCHEDULE_KEYS,
  type AcceptAssessmentInput,
  type AcceptAssessmentResult,
  type Assessment,
  type AssessmentAnswer,
  type AssessmentNarrative,
  type Building,
  type Customer,
  type Job,
  type OrgMember,
  type ReleaseAssessmentInput,
  type ReleaseAssessmentResult,
  type Report,
  type RequestInfoInput,
  type RequestInfoResult,
  type ServiceScheduleKey,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DescriptionList, PageGrid } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import {
  AnswerCard,
  isAnswered,
  type InheritedResponsibleParty,
} from './AnswerCard';
import { actorName } from '../lib/actorName';
import { useReportDownload } from './releaseShared';
import { StoredFileLink } from '../lib/StoredFile';
import { ValidationGuide } from './ValidationGuide';
import { hasSeenValidationGuide, rememberValidationGuideSeen } from './guideSeen';
import styles from './AssessmentReview.module.css';

/** The message a bulk flag pre-fills, so "flag every unanswered question" is one
 *  click that still leaves the auditor an editable sentence rather than an empty
 *  box per question. */
const UNANSWERED_PROMPT =
  'This question was not answered. Please complete it and resubmit.';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A deadline further ahead than this is a typo, not a working date. Mirrors
 *  the ceiling requestInfo enforces server-side, so the UI refuses exactly what
 *  the server would refuse rather than bouncing off it. */
const MAX_DUE_AHEAD_MS = 365 * DAY_MS;

/** Epoch millis -> the yyyy-mm-dd a native date input takes. Built from the
 *  LOCAL date parts, so the box shows the auditor the day they are looking at. */
function toDateInputValue(millis: number): string {
  const date = new Date(millis);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** yyyy-mm-dd -> epoch millis at the END of that local day. "Due by the 28th"
 *  means the assessor has all of the 28th, not until midnight starting it.
 *  Returns null for an empty or unparseable value (the box can be cleared). */
function fromDateInputValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const millis = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    59,
    999,
  ).getTime();
  return Number.isFinite(millis) ? millis : null;
}

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** Human labels for the narrative fields the Assessment record carries. */
const NARRATIVE_LABELS: Record<keyof AssessmentNarrative, string> = {
  summary: 'Summary',
  buildingDescription: 'Building description',
  premisesCovered: 'Premises covered',
  incidentHistory: 'Incident history',
  riskOpinion: 'Risk opinion',
};
const NARRATIVE_ORDER = Object.keys(NARRATIVE_LABELS) as Array<keyof AssessmentNarrative>;

/** Human labels for the statutory service-schedule keys. */
const SERVICE_LABELS: Record<ServiceScheduleKey, string> = {
  fireAlarmService: 'Fire alarm service',
  fireMarshalTraining: 'Fire marshal training',
  fireSafetyTraining: 'Fire safety training',
  fireDrill: 'Fire drill',
  pat: 'Portable appliance testing',
  extinguisherMaintenance: 'Extinguisher maintenance',
  fraReview: 'Fire risk assessment review',
};

/** The stage badge: the EXACT contractual stage words, toned by stage. */
function StageBadge({ status }: { status: Assessment['status'] }) {
  const toneClass: Record<Assessment['status'], string> = {
    inProgress: styles.stageNeutral,
    readyForValidation: styles.stageInfo,
    infoRequired: styles.stageWarning,
    readyForRelease: styles.stageSuccess,
    released: styles.stageNeutral,
  };
  return (
    <span className={`${styles.stageBadge} ${toneClass[status]}`}>
      {ASSESSMENT_STAGE_LABELS[status]}
    </span>
  );
}

/** The released report's download affordance. Resolves Report.pdfPath to a
 *  tokened URL for the signed-in user (the AssessmentHistoryPanel resolution),
 *  degrading to honest copy while resolving, when the object is unreachable, or
 *  when the report record has not been written yet - generation trails release
 *  by moments, so the released assessment can briefly have no report node. */
function ReportDownload({ report }: { report: Report | null }) {
  // The shared resolution the released surfaces use, so a Storage refusal is
  // reported the same way wherever a report is offered.
  const download = useReportDownload(report?.pdfPath);

  if (!report) {
    return (
      <p role="status" className={styles.decisionHint}>
        The report is being generated. It will appear here shortly.
      </p>
    );
  }
  if (download.state === 'unreachable') {
    return (
      <p className={styles.decisionHint}>
        The report file could not be reached. Please try again shortly.
      </p>
    );
  }
  if (download.state === 'resolving') {
    return (
      <p role="status" className={styles.decisionHint}>
        Preparing the report for download
      </p>
    );
  }
  return (
    <StoredFileLink
      className={styles.reportDownload}
      errorClassName={styles.decisionHint}
      reference={download.path}
    >
      Download report
    </StoredFileLink>
  );
}

export function AssessmentReview() {
  const { assessmentId = '' } = useParams();
  const { claims, paths, user } = useAuth();
  const orgId = claims?.orgId ?? '';
  const uid = user?.uid;
  const enabled = Boolean(orgId && paths && assessmentId);

  // --- Live reads -----------------------------------------------------------
  const assessmentQuery = useRtdbQuery<Assessment | null>({
    key: keys.assessment(orgId, assessmentId),
    path: paths ? paths.db.assessment(orgId, assessmentId) : '',
    enabled,
  });
  const assessment = assessmentQuery.data ?? null;

  const answersQuery = useRtdbQuery<Record<string, AssessmentAnswer> | null>({
    key: keys.assessmentAnswers(orgId, assessmentId),
    path: paths ? paths.db.assessmentAnswers(orgId, assessmentId) : '',
    enabled,
  });
  const answers = answersQuery.data ?? {};

  // Gated members read (the ActivityPage pattern) to resolve uids to names.
  const canReadMembers =
    claims?.roles.admin === true ||
    claims?.roles.assessor === true ||
    claims?.roles.auditor === true;
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: Boolean(orgId && paths) && canReadMembers,
  });
  const nameFor = (uid: string): string =>
    actorName(membersQuery.data, uid, membersQuery.data !== undefined);

  // Job -> siteId -> building (name + the service schedule the reports read),
  // and the customer for the header. All single-node cached reads.
  const jobId = assessment?.jobId ?? '';
  const jobQuery = useRtdbQuery<Job | null>({
    key: keys.job(orgId, jobId),
    path: paths && jobId ? paths.db.job(orgId, jobId) : '',
    enabled: Boolean(orgId && paths && jobId),
  });
  const siteId = jobQuery.data?.siteId ?? '';
  const buildingId = assessment?.buildingId ?? '';
  const buildingQuery = useRtdbQuery<Building | null>({
    key: keys.building(orgId, siteId, buildingId),
    path: paths && siteId ? paths.db.building(orgId, siteId, buildingId) : '',
    enabled: Boolean(orgId && paths && siteId && buildingId),
  });
  const building = buildingQuery.data ?? null;

  // The responsible party this review answers with, resolved ONCE here for both
  // the aside fact and every finding card: the assessment's own copy first,
  // then the building's default. That is the server's order, deliberately - the
  // value an auditor reads has to be the value release will stamp on the
  // actions.
  //
  // The fallback exists because the assessment's copy is only stamped from the
  // assessor's app at capture time; every assessment recorded before that
  // stamping landed holds nothing, and a blank "Responsible party" sent
  // auditors off to look the name up (or, worse, invent one). The building is
  // already loaded above for the header and the service-schedule card, so this
  // costs no extra read. Once the backfill has run the first branch simply
  // wins everywhere and the rest goes quiet on its own.
  const responsibleParty = useMemo<InheritedResponsibleParty | undefined>(() => {
    if (assessment?.responsibleParty?.name) {
      return { party: assessment.responsibleParty, source: 'assessment' };
    }
    if (building?.responsibleParty?.name) {
      return { party: building.responsibleParty, source: 'building' };
    }
    return undefined;
  }, [assessment?.responsibleParty, building]);

  // Released reports for this building. Only read once the assessment is
  // released - that is the only state that surfaces a download, and the node is
  // scoped by buildingId alone (no siteId needed). The report for THIS
  // assessment is preferred by assessmentId; older reports predate that field,
  // so we fall back to the newest report for the building.
  const isReleased = assessment?.status === 'released';
  const reportsQuery = useRtdbQuery<Record<string, Report> | null>({
    key: keys.reports(orgId, 'building', buildingId),
    path: paths && buildingId ? paths.db.reports(orgId, 'building', buildingId) : '',
    enabled: Boolean(orgId && paths && buildingId) && isReleased,
  });
  const reportForAssessment = useMemo<Report | null>(() => {
    const reports = Object.values(reportsQuery.data ?? {});
    if (reports.length === 0) {
      return null;
    }
    const matched = reports.find((report) => report.assessmentId === assessmentId);
    if (matched) {
      return matched;
    }
    return reports.reduce((newest, report) =>
      report.generatedAt > newest.generatedAt ? report : newest,
    );
  }, [reportsQuery.data, assessmentId]);

  const customerId = assessment?.customerId ?? '';
  const customerQuery = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId, customerId),
    path: paths && customerId ? paths.db.customer(orgId, customerId) : '',
    enabled: Boolean(orgId && paths && customerId),
  });

  // --- Flag basket ----------------------------------------------------------
  // question id -> draft message. Insertion order is presentation order.
  const [basket, setBasket] = useState<Record<string, string>>({});
  const basketIds = Object.keys(basket);
  // The aside's basket card, so "Review basket" on the send bar can bring it
  // into view inside its own scroll container rather than describing where it is.
  const basketCardRef = useRef<HTMLDivElement | null>(null);
  // ONE deadline for the whole batch: a round of questions is one conversation,
  // so the assessor works to a single date rather than a per-question spread.
  // Held as the date input's yyyy-mm-dd string (its native value) and converted
  // to epoch millis only at the callable boundary, which is what the contract
  // takes. Defaulted to INFO_REQUEST_DUE_DAYS ahead; the server re-derives and
  // re-validates the same default, so a tampered client changes nothing.
  const [dueByDate, setDueByDate] = useState<string>(() =>
    toDateInputValue(Date.now() + INFO_REQUEST_DUE_DAYS * DAY_MS),
  );
  const dueByMillis = fromDateInputValue(dueByDate);
  // The same three rejections the server applies, phrased for a person. A date
  // in the past would arrive already overdue; one years out is not a deadline.
  const dueByError =
    dueByMillis === null
      ? 'Enter a response deadline as a date.'
      : dueByMillis <= Date.now()
        ? 'The response deadline must be in the future.'
        : dueByMillis > Date.now() + MAX_DUE_AHEAD_MS
          ? 'The response deadline cannot be more than a year ahead.'
          : null;
  const dueByValid = dueByError === null;
  const status = assessment?.status;
  const canFlag = status === 'readyForValidation';

  // Unsaved-drafts guard: a non-empty basket is real, unsent work, so leaving
  // the page cannot discard it silently. The beforeunload listener covers the
  // tab closing or reloading; in-app navigation is confirmed at the link click
  // (see guardNavigation on the page root).
  const basketDirty = basketIds.length > 0;
  useEffect(() => {
    if (!basketDirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome still requires returnValue to be set for the prompt to show.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [basketDirty]);

  /** Where an in-app link wanted to go, held while we ask what to do with the
   *  unsent basket. Null when nothing is pending. */
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);

  /** Intercept any in-app link (the crumb back to the queue included) that would
   *  discard a non-empty basket, and ask properly. New-tab links (photos) are
   *  never blocked.
   *
   *  Deliberately NOT window.confirm: its only choices are OK and Cancel, so the
   *  auditor's real intent - "actually, send these" - was not on offer, and the
   *  prompt read like a routine leave warning. Clicking through it destroyed
   *  written work silently. */
  const guardNavigation = (event: MouseEvent<HTMLElement>) => {
    if (!basketDirty) {
      return;
    }
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor || anchor.target === '_blank') {
      return;
    }
    const href = anchor.getAttribute('href');
    event.preventDefault();
    event.stopPropagation();
    setPendingLeave(href && href.startsWith('/') ? href : '/app/validation');
  };

  const navigate = useNavigate();

  // The explainer introduces itself to an auditor who has not dismissed it on
  // this device, and collapses to a "How validation works" button afterwards.
  const [guideOpen, setGuideOpen] = useState(() =>
    uid ? !hasSeenValidationGuide(uid) : false,
  );
  const dismissGuide = () => {
    setGuideOpen(false);
    if (uid) {
      rememberValidationGuideSeen(uid);
    }
  };

  // --- Lifecycle callables (frozen contract, invoked by name) ---------------
  const requestInfo = useCallable<RequestInfoInput, RequestInfoResult>('requestInfo');
  const acceptAssessment = useCallable<AcceptAssessmentInput, AcceptAssessmentResult>(
    'acceptAssessment',
  );
  const releaseAssessment = useCallable<ReleaseAssessmentInput, ReleaseAssessmentResult>(
    'releaseAssessment',
  );
  const [confirming, setConfirming] = useState<null | 'accept' | 'release'>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Accepting with unanswered questions is allowed but never accidental: the
  // confirm step lists them and waits for an explicit tick (see the panel below).
  const [acceptAcknowledged, setAcceptAcknowledged] = useState(false);
  const anyPending =
    requestInfo.pending || acceptAssessment.pending || releaseAssessment.pending;

  const sendBasket = async () => {
    const requests = basketIds.map((questionId) => ({
      questionId,
      message: basket[questionId].trim(),
    }));
    // dueBy is only sent when the auditor's date is genuinely usable; omitting
    // it lets the server apply the same default, which is the safer fallback.
    const result = await requestInfo.call({
      assessmentId,
      requests,
      ...(dueByValid && dueByMillis !== null ? { dueBy: dueByMillis } : {}),
    });
    if (result) {
      setBasket({});
      // Back to a fresh default window, so a second round is not silently
      // measured from the first round's date.
      setDueByDate(toDateInputValue(Date.now() + INFO_REQUEST_DUE_DAYS * DAY_MS));
      setNotice(
        `Sent to the assessor. They have been notified of ${requests.length === 1 ? 'the flagged question' : `all ${requests.length} flagged questions`}, are due to respond by ${dateFormat.format(dueByMillis ?? Date.now())}, and must resubmit before this assessment can be validated.`,
      );
    }
  };

  /** Put every unanswered question in the basket at once, pre-filled with an
   *  editable sentence. This is the job the auditor was doing by hand, one
   *  question at a time, when they lost the lot. Existing drafts are kept. */
  const flagAllUnanswered = () => {
    setConfirming(null);
    setBasket((prev) => {
      const next = { ...prev };
      for (const question of unansweredQuestions) {
        if (next[question.id] === undefined) {
          next[question.id] = UNANSWERED_PROMPT;
        }
      }
      return next;
    });
  };

  const confirmAccept = async () => {
    setConfirming(null);
    setAcceptAcknowledged(false);
    const result = await acceptAssessment.call({ assessmentId });
    if (result) {
      setNotice(`Accepted. The assessment is now '${ASSESSMENT_STAGE_LABELS.readyForRelease}'.`);
    }
  };

  const confirmRelease = async () => {
    setConfirming(null);
    const result = await releaseAssessment.call({ assessmentId });
    if (result) {
      setNotice(
        `Released. ${result.actionsCreated} ${result.actionsCreated === 1 ? 'action was' : 'actions were'} created for the building's action plan, and the report is being generated.`,
      );
    }
  };

  // --- Derived presentation --------------------------------------------------
  const snapshot = assessment?.templateSnapshot;
  const sectionProgress = useMemo(
    () =>
      (snapshot?.sections ?? []).map((section) => ({
        id: section.id,
        title: section.title,
        answered: section.questions.filter((question) => isAnswered(answers[question.id]))
          .length,
        total: section.questions.length,
      })),
    [snapshot, answers],
  );
  const answeredTotal = sectionProgress.reduce((sum, s) => sum + s.answered, 0);
  const questionTotal = sectionProgress.reduce((sum, s) => sum + s.total, 0);

  /** Every question the assessor left blank, with enough context to name it in
   *  the accept warning and to flag the lot in one action. Accepting asserts
   *  there is nothing outstanding, so these have to be said out loud rather than
   *  left as a count in a side panel nobody has to read. */
  const unansweredQuestions = useMemo(
    () =>
      (snapshot?.sections ?? []).flatMap((section) =>
        section.questions
          .filter((question) => !isAnswered(answers[question.id]))
          .map((question) => ({
            id: question.id,
            text: question.text,
            sectionTitle: section.title,
          })),
      ),
    [snapshot, answers],
  );

  /** Question lookup for the basket aside (text + section, from the snapshot). */
  const questionIndex = useMemo(() => {
    const index = new Map<string, { text: string; sectionTitle: string }>();
    for (const section of snapshot?.sections ?? []) {
      for (const question of section.questions) {
        index.set(question.id, { text: question.text, sectionTitle: section.title });
      }
    }
    return index;
  }, [snapshot]);

  // --- Early states -----------------------------------------------------------
  if (assessmentQuery.isError) {
    return (
      <ErrorNotice message="Could not load this assessment. Please try again." />
    );
  }
  if (assessmentQuery.isLoading && !assessment) {
    return (
      <p role="status" className={styles.loading}>
        Loading the assessment
      </p>
    );
  }
  if (!assessment || !snapshot) {
    return (
      <EmptyState
        title="Assessment not found"
        body="This assessment does not exist or is not part of your organisation. Return to the validation queue to see what is waiting."
      />
    );
  }

  const buildingName = building?.name ?? 'Building';
  const customerName = customerQuery.data?.name ?? '';
  const submittedAt = assessment.workflow?.submittedAt;
  const narrative = assessment.narrative;
  const narrativePresent = NARRATIVE_ORDER.filter((field) => narrative?.[field]);
  const serviceSchedule = building?.serviceSchedule;
  const basketComplete =
    basketIds.length > 0 &&
    basketIds.every((id) => basket[id].trim().length > 0) &&
    dueByValid;
  // An information request is OPEN until the assessor has responded - the same
  // response-presence test acceptAssessment applies server-side, so the button
  // disables for exactly the reason the server would refuse.
  const openRequestCount = Object.values(answers).filter(
    (answer) => answer.infoRequest && !answer.infoRequest.response,
  ).length;
  const acceptEnabled =
    canFlag && basketIds.length === 0 && openRequestCount === 0 && !anyPending;
  const releaseEnabled = status === 'readyForRelease' && !anyPending;

  return (
    <div className={styles.root} onClickCapture={guardNavigation}>
      <PageHeader
        crumbs={[
          { label: 'Validation', to: '/app/validation' },
          { label: buildingName },
        ]}
        title={buildingName}
        lede={[customerName, `${snapshot.name} (version ${snapshot.version})`]
          .filter(Boolean)
          .join(' | ')}
        action={
          <span className={styles.headerBadges}>
            {/* An assessment submitted against a since-cancelled job is still
                reviewable; the auditor just needs that context up front. */}
            {jobQuery.data?.status === 'cancelled' && (
              <span className={`${styles.stageBadge} ${styles.stageWarning}`}>
                Job cancelled
              </span>
            )}
            <StageBadge status={assessment.status} />
          </span>
        }
      />

      <PageGrid
        aside={
          <div className={styles.aside}>
            <Card>
              <CardHeader title="Assessment" as="h2" />
              <DescriptionList
                items={[
                  { label: 'Assessor', value: nameFor(assessment.conductedBy) },
                  {
                    label: 'Submitted',
                    value: submittedAt ? dateTimeFormat.format(submittedAt) : 'Not recorded',
                  },
                  { label: 'Conducted', value: dateFormat.format(assessment.conductedAt) },
                  {
                    label: 'Responsible party',
                    // Named as the building's when that is where it came from,
                    // so the auditor can see this assessment carries no party
                    // of its own rather than assuming the assessor chose it.
                    value: responsibleParty
                      ? `${
                          responsibleParty.party.role
                            ? `${responsibleParty.party.name} (${responsibleParty.party.role})`
                            : responsibleParty.party.name
                        }${responsibleParty.source === 'building' ? ' (building default)' : ''}`
                      : undefined,
                  },
                  {
                    label: 'Overall risk (set by assessor)',
                    value: assessment.manualRiskLevel
                      ? `${assessment.manualRiskLevel.level.charAt(0).toUpperCase()}${assessment.manualRiskLevel.level.slice(1)}`
                      : undefined,
                  },
                ]}
              />
            </Card>

            <Card>
              <CardHeader
                title="Progress"
                as="h2"
                hint={`${answeredTotal} of ${questionTotal} questions answered`}
              />
              <ul className={styles.progressList} aria-label="Answered questions per section">
                {sectionProgress.map((section) => (
                  <li key={section.id} className={styles.progressRow}>
                    <span className={styles.progressTitle}>{section.title}</span>
                    <span className={styles.progressCount}>
                      {section.answered} of {section.total}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            {canFlag && basketIds.length > 0 && (
              <div ref={basketCardRef}>
              <Card>
                <CardHeader
                  title="Flag basket"
                  as="h2"
                  hint="Every request is sent to the assessor together."
                />
                <ul className={styles.basketList} aria-label="Flagged questions">
                  {basketIds.map((questionId) => {
                    const meta = questionIndex.get(questionId);
                    return (
                      <li key={questionId} className={styles.basketItem}>
                        <p className={styles.basketSection}>{meta?.sectionTitle}</p>
                        <p className={styles.basketQuestion}>{meta?.text ?? questionId}</p>
                        <label
                          className={styles.basketLabel}
                          htmlFor={`basket-${questionId}`}
                        >
                          Message to the assessor
                        </label>
                        <textarea
                          id={`basket-${questionId}`}
                          className={styles.basketInput}
                          rows={2}
                          value={basket[questionId]}
                          onChange={(event) =>
                            setBasket((prev) => ({
                              ...prev,
                              [questionId]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() =>
                            setBasket((prev) => {
                              const next = { ...prev };
                              delete next[questionId];
                              return next;
                            })
                          }
                        >
                          Remove
                        </Button>
                      </li>
                    );
                  })}
                </ul>
                {/* One deadline for the whole batch, defaulted a week out and
                    editable. It sits below the questions and above the send
                    button, so it is the last thing read before sending. */}
                <div className={styles.basketDeadline}>
                  <label className={styles.basketLabel} htmlFor="basket-due-by">
                    Response due by
                  </label>
                  <input
                    id="basket-due-by"
                    type="date"
                    className={styles.basketInput}
                    value={dueByDate}
                    min={toDateInputValue(Date.now() + DAY_MS)}
                    max={toDateInputValue(Date.now() + MAX_DUE_AHEAD_MS)}
                    aria-invalid={dueByError !== null}
                    aria-describedby="basket-due-by-hint"
                    onChange={(event) => setDueByDate(event.target.value)}
                  />
                  <p id="basket-due-by-hint" className={styles.decisionHint}>
                    {dueByError ??
                      `The assessor is reminded as this date approaches. Defaults to ${INFO_REQUEST_DUE_DAYS} days.`}
                  </p>
                </div>
                {!basketComplete && (
                  <p className={styles.decisionHint}>
                    {dueByValid
                      ? 'Every flagged question needs a message before sending.'
                      : 'Set a valid response deadline before sending.'}
                  </p>
                )}
              </Card>
              </div>
            )}

            <Card>
              <CardHeader title="Decisions" as="h2" />
              {notice && (
                <p role="status" className={styles.notice}>
                  {notice}
                </p>
              )}
              {status === 'infoRequired' && (
                <p className={styles.decisionHint}>
                  Waiting on the assessor. They must respond to every request and
                  resubmit before this assessment can be validated.
                </p>
              )}
              {acceptAssessment.error && <ErrorNotice message={acceptAssessment.error} />}
              {releaseAssessment.error && <ErrorNotice message={releaseAssessment.error} />}

              <div className={styles.decisionStack}>
                <Button
                  type="button"
                  block
                  disabled={!acceptEnabled}
                  onClick={() => setConfirming('accept')}
                >
                  Accept - ready for release
                </Button>
                {canFlag && basketIds.length > 0 && (
                  <p className={styles.decisionHint}>
                    Send or clear the flag basket first: accepting asserts there is
                    nothing outstanding.
                  </p>
                )}
                {canFlag && openRequestCount > 0 && (
                  <p className={styles.decisionHint}>
                    {openRequestCount === 1
                      ? '1 flagged question is'
                      : `${openRequestCount} flagged questions are`}{' '}
                    awaiting the assessor. It cannot be accepted until they
                    respond.
                  </p>
                )}
                {confirming === 'accept' && (
                  <div className={styles.confirmPanel}>
                    <p className={styles.confirmCopy}>
                      Accept this assessment? It will move to '
                      {ASSESSMENT_STAGE_LABELS.readyForRelease}'.
                    </p>
                    {/* Accepting asserts there is nothing outstanding, so a gap
                        the assessor left has to be met head on. Neither this
                        screen nor acceptAssessment blocked it, and an auditor
                        accepted two assessments with questions still blank
                        believing the flow had handled it. Named, listed, and
                        ticked - or flagged back in one action. */}
                    {unansweredQuestions.length > 0 && (
                      <div className={styles.unansweredWarning}>
                        <p className={styles.unansweredTitle}>
                          {unansweredQuestions.length === 1
                            ? '1 question was not answered by the assessor.'
                            : `${unansweredQuestions.length} questions were not answered by the assessor.`}
                        </p>
                        <ul className={styles.unansweredList}>
                          {unansweredQuestions.map((question) => (
                            <li key={question.id} className={styles.unansweredItem}>
                              <span className={styles.unansweredSection}>
                                {question.sectionTitle}
                              </span>
                              {question.text}
                            </li>
                          ))}
                        </ul>
                        <Button
                          variant="secondary"
                          type="button"
                          block
                          onClick={flagAllUnanswered}
                        >
                          {unansweredQuestions.length === 1
                            ? 'Flag it for the assessor instead'
                            : `Flag all ${unansweredQuestions.length} for the assessor instead`}
                        </Button>
                        <label className={styles.acknowledge}>
                          <input
                            type="checkbox"
                            checked={acceptAcknowledged}
                            onChange={(event) =>
                              setAcceptAcknowledged(event.target.checked)
                            }
                          />
                          <span>
                            I have reviewed these and am accepting the assessment
                            with them unanswered.
                          </span>
                        </label>
                      </div>
                    )}
                    <div className={styles.confirmActions}>
                      <Button
                        type="button"
                        disabled={
                          unansweredQuestions.length > 0 && !acceptAcknowledged
                        }
                        onClick={confirmAccept}
                      >
                        Confirm accept
                      </Button>
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() => {
                          setConfirming(null);
                          setAcceptAcknowledged(false);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                <Button
                  variant="secondary"
                  type="button"
                  block
                  disabled={!releaseEnabled}
                  onClick={() => setConfirming('release')}
                >
                  Release
                </Button>
                {confirming === 'release' && (
                  <div className={styles.confirmPanel}>
                    <p className={styles.confirmCopy}>
                      Releasing creates the action plan and generates the report.
                      The customer's building record updates the moment it
                      completes.
                    </p>
                    <div className={styles.confirmActions}>
                      <Button type="button" onClick={confirmRelease}>
                        Confirm release
                      </Button>
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {status === 'released' && (
                  <>
                    <p className={styles.decisionHint}>
                      This assessment has been released. The action plan and
                      report are with the customer.
                    </p>
                    <ReportDownload report={reportForAssessment} />
                  </>
                )}

                {/* Jump from this single assessment to the building's complete
                    record: every past assessment and every released report PDF,
                    all downloadable, live on the building's detail page. */}
                {customerId && siteId && buildingId && (
                  <Link
                    className={styles.historyLink}
                    to={urls.building(customerId, siteId, buildingId)}
                  >
                    View this building's full assessment history and reports
                  </Link>
                )}
              </div>
            </Card>
          </div>
        }
      >
        {answersQuery.isError && (
          <ErrorNotice message="Could not load the assessment's answers. Please try again." />
        )}

        {canFlag && (
          <ValidationGuide
            open={guideOpen}
            onOpen={() => setGuideOpen(true)}
            onDismiss={dismissGuide}
          />
        )}

        {narrativePresent.length > 0 && (
          <Card>
            <CardHeader
              title="Assessor's narrative"
              hint="Free-text context the assessor recorded alongside the questionnaire."
            />
            <dl className={styles.narrativeList}>
              {narrativePresent.map((field) => (
                <div key={field} className={styles.narrativeRow}>
                  <dt className={styles.narrativeLabel}>{NARRATIVE_LABELS[field]}</dt>
                  <dd className={styles.narrativeValue}>{narrative?.[field]}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Service schedule"
            hint="Next-due dates for the building's statutory services."
          />
          {serviceSchedule ? (
            <dl className={styles.narrativeList}>
              {SERVICE_SCHEDULE_KEYS.map((key) => (
                <div key={key} className={styles.serviceRow}>
                  <dt className={styles.narrativeLabel}>{SERVICE_LABELS[key]}</dt>
                  <dd className={styles.narrativeValue}>
                    {serviceSchedule[key]?.nextDue
                      ? dateFormat.format(serviceSchedule[key].nextDue)
                      : 'Not set'}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className={styles.quietNote}>
              No service schedule is recorded for this building yet.
            </p>
          )}
        </Card>

        {snapshot.sections.map((section) => (
          <Card key={section.id}>
            <CardHeader title={section.title} hint={`Section ${section.code}`} />
            <div className={styles.questions}>
              {section.questions.map((question) => (
                <AnswerCard
                  key={question.id}
                  question={question}
                  answer={answers[question.id]}
                  responsibleParty={responsibleParty}
                  nameFor={nameFor}
                  flagging={
                    canFlag
                      ? {
                          draft: basket[question.id],
                          onStart: () =>
                            setBasket((prev) => ({ ...prev, [question.id]: '' })),
                          onChange: (message) =>
                            setBasket((prev) => ({ ...prev, [question.id]: message })),
                          onRemove: () =>
                            setBasket((prev) => {
                              const next = { ...prev };
                              delete next[question.id];
                              return next;
                            }),
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </Card>
        ))}
      </PageGrid>

      {/* The send bar. Fixed to the viewport so the one action that moves work
          back to the assessor can never be below the fold, at any width. It
          mirrors the aside basket exactly - same completeness test, same call -
          rather than being a second way to send. */}
      {canFlag && basketIds.length > 0 && (
        <div className={styles.sendBar} role="region" aria-label="Flag basket">
          <div className={styles.sendBarInner}>
            <p className={styles.sendBarCount}>
              <strong>
                {basketIds.length === 1
                  ? '1 question flagged'
                  : `${basketIds.length} questions flagged`}
              </strong>
              <span className={styles.sendBarNote}>
                {requestInfo.error
                  ? requestInfo.error
                  : basketComplete
                    ? 'Not sent yet. The assessor is notified once, for all of them.'
                    : 'Open the basket to finish them: each needs a message and a deadline.'}
              </span>
            </p>
            <div className={styles.sendBarActions}>
              <Button
                variant="secondary"
                type="button"
                onClick={() =>
                  basketCardRef.current?.scrollIntoView({ block: 'nearest' })
                }
              >
                Review basket
              </Button>
              <Button
                type="button"
                disabled={!basketComplete || anyPending}
                onClick={sendBasket}
              >
                {requestInfo.pending ? 'Sending' : 'Send to assessor'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Leaving with unsent messages: three real choices, because "discard" was
          never the only thing the auditor might have meant. */}
      {pendingLeave !== null && (
        <div className={styles.leaveOverlay} role="presentation">
          <div
            className={styles.leaveDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-title"
          >
            <h2 id="leave-title" className={styles.leaveTitle}>
              You have unsent messages
            </h2>
            <p className={styles.leaveCopy}>
              {basketIds.length === 1
                ? 'One flagged question has a message the assessor has not been sent.'
                : `${basketIds.length} flagged questions have messages the assessor has not been sent.`}{' '}
              Leaving now discards them.
            </p>
            <div className={styles.leaveActions}>
              <Button
                type="button"
                disabled={!basketComplete || anyPending}
                onClick={async () => {
                  const target = pendingLeave;
                  setPendingLeave(null);
                  await sendBasket();
                  if (target) {
                    navigate(target);
                  }
                }}
              >
                Send, then leave
              </Button>
              <Button
                variant="secondary"
                type="button"
                onClick={() => setPendingLeave(null)}
              >
                Keep editing
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  const target = pendingLeave;
                  setBasket({});
                  setPendingLeave(null);
                  if (target) {
                    navigate(target);
                  }
                }}
              >
                Discard and leave
              </Button>
            </div>
            {!basketComplete && (
              <p className={styles.leaveHint}>
                {dueByValid
                  ? 'Every flagged question needs a message before it can be sent.'
                  : 'Set a valid response deadline before it can be sent.'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
