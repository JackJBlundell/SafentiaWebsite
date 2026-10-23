// ============================================================================
// releaseAssessment (callable, admin or auditor) - FR-E18, THE release pipeline.
//
// Releasing a validated assessment is the moment its findings become the
// building's live truth. In ONE multi-location update we:
//   (a) create an /actions entry from every non-conformity finding (the action
//       plan the customer works through);
//   (b) compute the TRUE finding distribution (RagDistribution) from the answers;
//   (c) derive the building's riskLevel with the SHARED lib/ragDerivation model
//       (org-configurable RagConfig, RAG_CONFIG_DEFAULTS fallback), fed by the
//       open action-plan state;
//   (d) stamp building.lastAssessedAt + building.ragDistribution;
//   (e) move the assessment to `released` (workflow.releasedAt/releasedBy) with
//       the job + /assessorJobs mirrors and the /activity entries.
// The status transition itself is CLAIMED first via a transaction on the status
// child (readyForRelease -> released, abort otherwise - the updateMember /
// acceptInvitation posture), so two concurrent releases can never both mint an
// action plan; the payload update follows immediately and reverts the status on
// failure. onAssessmentStageChange fires on the status commit and assembles the
// released PDF from the building and action plan; it performs several reads
// (assessment, activity, log book) before rendering, and the payload lands
// right behind the claim in the same invocation. That trigger also owns the
// log-book entry, the PDF generation and the assessor notification: none of
// that is duplicated here.
//
// A non-conformity's extras (responsible / responsibleContactId / dueBy /
// lifeProtection / actionRequired) live on the answer's `value` as the
// structured object defined by the app's features/assessment/data/
// nonConformity.ts - the documented shape this server-side reader mirrors.
//
// THE RESPONSIBLE PARTY IS A CONTACT, NOT A NAME. Every action minted here
// carries `responsibleContactId`, and the release digest is addressed through
// it. The customer's contact directory is read ONCE for the whole release and
// serves both: it supplies each action's recorded name from the LIVE contact
// record (the truth at the moment the action is raised) and the address the
// digest is sent to, so neither costs a read per finding.
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { db } from '../admin';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertOrgRole,
  getLiveClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { deriveRiskLevel, RAG_CONFIG_DEFAULTS } from '../lib/ragDerivation';
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { WEB_ORIGIN } from '../lib/webOrigin';
import { orgEmailBrand } from '../lib/emailTemplates';
import { loadKindConfig } from '../lib/templatedEmail';
import { deliverKindEmail } from '../lib/emailDigest';
import { resolveResponsibleAssignment } from '../lib/responsibleParty';
import { isEffectiveNotApplicable } from '../lib/assessmentChecks';
import { SEVERITIES } from '../shared/types';
import type { EnvPaths } from '../shared/paths';
import type { Logger } from '../lib/logging';
import type {
  ReleaseAssessmentInput,
  ReleaseAssessmentResult,
  Action,
  Assessment,
  AssessmentAnswer,
  AssessmentStatus,
  Building,
  CustomerContact,
  Job,
  Keyed,
  OrgProfile,
  OrgSettings,
  RagDistribution,
  Severity,
} from '../shared/types';

/** The next FRA review lands 12 months after release - the PAS 79 annual-
 *  review convention. Per-org configurability of this interval is recorded in
 *  FUTURE_WORK.md section 8. */
const REVIEW_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

/** Human severity wording for customer-facing copy. */
const SEVERITY_LABELS: Record<Severity, string> = {
  L: 'Low',
  M: 'Medium',
  H: 'High',
};

/** A due date rendered for email, in UTC so it names the stored day. */
function formatDueDate(millis: number): string {
  return new Date(millis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * ONE digest email per responsible CONTACT summarising the actions the release
 * just assigned to them - never per action (story 2047: a duty-holder gets one
 * actionable summary, not an inbox flood), and never one shared digest to the
 * building's party covering work recorded against somebody else.
 *
 * That summary covers ONE release. A contact responsible for several buildings
 * released the same day would still have had one email per release, so the send
 * goes through lib/emailDigest: the first is theirs immediately, and the rest of
 * the day's bundle into one email per contact the following morning, a line per
 * building (EMAIL_BUNDLING_PLAN.md §2).
 *
 * Resolution is strictly through `Action.responsibleContactId`, matched against
 * the customer's contact directory read once by the caller. An action with no
 * contact id (a legacy or imported party that is only a name) and a contact with
 * no email are both DEAD ENDS, and each is logged with the reason: "nobody was
 * emailed" has to be diagnosable, and guessing an address for a statutory
 * compliance message is worse than silence.
 *
 * DELIBERATELY NOT gated by `CustomerContact.receivesReports`. That flag says
 * whether somebody wants a copy of the whole fire risk assessment report; this
 * digest is not the report, it is the list of remedial actions THIS person has
 * been recorded responsible for. The two answer different questions, and the
 * digest's own is answered by the per-finding `responsibleContactId` an assessor
 * set on purpose. Silencing it off the back of a report-distribution preference
 * would mean a duty-holder is never told about work that is legally theirs
 * because somebody once trimmed the report mailing list - so the opt-out stops
 * at the report, exactly as review reminders and visit notices do.
 *
 * Best-effort throughout: the release has already landed, so nothing here may
 * throw (the deliverKindEmail contract, extended to the reads around it).
 */
async function emailReleaseDigests(
  paths: EnvPaths,
  orgId: string,
  siteId: string,
  buildingId: string,
  building: Building,
  newActions: Action[],
  directory: Keyed<CustomerContact>,
  logger: Logger,
): Promise<void> {
  try {
    // Group the release's actions by the person who owes them.
    const byContact = new Map<string, Action[]>();
    let unlinked = 0;
    for (const action of newActions) {
      if (!action.responsibleContactId) {
        unlinked += 1;
        continue;
      }
      const existing = byContact.get(action.responsibleContactId);
      if (existing) {
        existing.push(action);
      } else {
        byContact.set(action.responsibleContactId, [action]);
      }
    }
    if (unlinked > 0) {
      logger.info(
        'Release digest not sent for some actions: no responsible contact is linked to them, so there is no address to send to',
        { buildingId, actions: unlinked },
      );
    }
    if (byContact.size === 0) {
      return;
    }

    // The sending organisation's own brand (name + accent), read once for the
    // whole fan-out; falls back to the Safentia brand when the org has not set
    // a valid one.
    const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
    const brand = orgEmailBrand(profileSnap.val() as OrgProfile | null);

    // The seam owns the rendering now; the org's kind config is loaded once
    // and reused across every contact in the fan-out.
    const digestConfig = await loadKindConfig(
      paths.env,
      orgId,
      'release-digest',
      logger,
    );

    for (const [contactId, actions] of byContact) {
      const contact = directory[contactId];
      if (!contact) {
        logger.warn(
          'Release digest skipped: the responsible contact is no longer in the customer’s contact list',
          { buildingId, contactId, actions: actions.length },
        );
        continue;
      }
      if (!contact.email) {
        logger.info(
          'Release digest skipped: the responsible contact has no email address on record',
          { buildingId, contactId, actions: actions.length },
        );
        continue;
      }

      // The digest's headline facts: how bad and how soon, for THIS recipient.
      const topSeverity: Severity = actions.some((a) => a.severity === 'H')
        ? 'H'
        : actions.some((a) => a.severity === 'M')
          ? 'M'
          : 'L';
      const dueDates = actions
        .map((a) => a.dueBy)
        .filter((d): d is number => typeof d === 'number');
      const earliestDue =
        dueDates.length > 0 ? Math.min(...dueDates) : undefined;

      const count = actions.length;
      const countPhrase = `${count} ${count === 1 ? 'action' : 'actions'}`;
      await deliverKindEmail(
        {
          kind: 'release-digest',
          env: paths.env,
          orgId,
          to: contact.email,
          variables: {
            'building.name': building.name,
            'actions.countPhrase': countPhrase,
          },
          brand,
          // Straight to the building in the customer's own portal, where the new
          // action plan and the released report both live. The staff console
          // would only show this recipient a permission wall.
          kindLink: `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${buildingId}`,
          kindRows: [
            { label: 'Building', value: building.name },
            { label: 'Actions', value: String(count) },
            { label: 'Top severity', value: SEVERITY_LABELS[topSeverity] },
            ...(earliestDue !== undefined
              ? [{ label: 'Earliest due', value: formatDueDate(earliestDue) }]
              : []),
          ],
          config: digestConfig,
          // A line per building when several releases land on one contact in a
          // day: how much work this building has just handed them. The severity
          // and the dates stay in the per-release detail card - a digest row is
          // a scan, and the count is what tells one building from another.
          digestRow: { label: building.name, value: countPhrase },
        },
        logger,
      );
    }
  } catch (error) {
    // The release already landed; a failed courtesy digest must not undo it.
    logger.warn('Release digest email failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The structured extras a non-conformity answer carries on its open `value`
 *  field - the same shape the app's nonConformity module writes. Read
 *  defensively: a remote answer may hold a primitive or nothing at all.
 *
 *  `responsibleContactId` is the per-finding override that MATTERS: it is what
 *  lets an assessor hold a different real person accountable for one item and
 *  still have them told about it. The `responsible` name travels beside it as
 *  the app recorded it, and is only used when no contact record answers. */
function readNonConformityValue(answer: AssessmentAnswer): {
  actionRequired?: boolean;
  responsible?: string;
  responsibleContactId?: string;
  dueBy?: number;
  lifeProtection?: boolean;
} {
  const value = answer.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    return {
      actionRequired:
        typeof v.actionRequired === 'boolean' ? v.actionRequired : undefined,
      responsible: typeof v.responsible === 'string' ? v.responsible : undefined,
      responsibleContactId:
        typeof v.responsibleContactId === 'string'
          ? v.responsibleContactId
          : undefined,
      dueBy: typeof v.dueBy === 'number' ? v.dueBy : undefined,
      lifeProtection: v.lifeProtection === true,
    };
  }
  return {};
}

export const releaseAssessment = onCall<ReleaseAssessmentInput>(
  // The release digest email needs the provider key mounted (lib/email: a v2
  // Function only sees a secret listed in its own options).
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
    runCallable<ReleaseAssessmentResult>(
      createLogger({ fn: 'releaseAssessment' }),
      async () => {
        // 1. Attestation, identity, authorisation. The auditor drives
        // validation day to day; an admin may also release (union model).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'releaseAssessment');
        const claims = await getLiveClaims(request);
        assertOrgRole(claims, ['admin', 'auditor']);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        const input = assertObject(request.data);
        const assessmentId = requireDbKey(
          input,
          'assessmentId',
          TEXT_LIMITS.shortText,
        );

        // 2. The assessment must exist in the caller's org and be cleared for
        // release - acceptance (acceptAssessment) is the only door to this state.
        const assessmentSnap = await db
          .ref(paths.db.assessment(orgId, assessmentId))
          .get();
        if (!assessmentSnap.exists()) {
          throw fail.notFound('This assessment could not be found.');
        }
        const assessment = assessmentSnap.val() as Assessment;
        if (assessment.status !== 'readyForRelease') {
          throw fail.failedPrecondition(
            'Only an accepted assessment can be released.',
            { status: assessment.status },
          );
        }

        // 2b. Context: the job (assessor index + the building's site), the
        // building (responsible-party default; the record being stamped), the
        // answers (findings), the org's RAG thresholds and the building's
        // EXISTING action plan (an open High action from a previous assessment
        // still holds the building at high risk - the derivation must see it).
        const jobSnap = await db
          .ref(paths.db.job(orgId, assessment.jobId))
          .get();
        if (!jobSnap.exists()) {
          throw fail.failedPrecondition('The originating job is missing.');
        }
        const job = jobSnap.val() as Job;

        const buildingPath = paths.db.building(
          orgId,
          job.siteId,
          assessment.buildingId,
        );
        const buildingSnap = await db.ref(buildingPath).get();
        if (!buildingSnap.exists()) {
          throw fail.failedPrecondition('The assessed building is missing.');
        }
        const building = buildingSnap.val() as Building;

        const answersSnap = await db
          .ref(paths.db.assessmentAnswers(orgId, assessmentId))
          .get();
        const answers =
          (answersSnap.val() as Keyed<AssessmentAnswer> | null) ?? {};

        const settingsSnap = await db.ref(paths.db.orgSettings(orgId)).get();
        const settings = (settingsSnap.val() as OrgSettings | null) ?? {};
        const ragConfig = settings.ragConfig ?? RAG_CONFIG_DEFAULTS;

        const existingActionsSnap = await db
          .ref(paths.db.actions(orgId, assessment.buildingId))
          .get();
        const existingActions =
          (existingActionsSnap.val() as Keyed<Action> | null) ?? {};

        // The customer's contact directory, read ONCE for the whole release.
        // Every action's responsible party is one of these people, so this
        // single read replaces a per-finding lookup twice over: it names each
        // action's party from the live record, and it addresses the digests.
        const contactsSnap = await db
          .ref(paths.db.customerContacts(orgId, building.customerId))
          .get();
        const contacts = (contactsSnap.val() as Keyed<CustomerContact> | null) ?? {};

        // 3a. Build the action plan from the non-conformity findings. The
        // template snapshot says which questions ARE non-conformities and gives
        // each its section code and wording; the answer carries the finding. A
        // finding marked "no action required" (a settled, satisfactory outcome)
        // and an untouched non-conformity (no severity = no finding) create
        // nothing.
        const now = Date.now();
        const newActions: Action[] = [];
        // Diagnostics for the release log: an action nobody can be emailed
        // about is not an error, but it must never be invisible.
        let actionsWithoutContact = 0;
        let actionsWithMissingContact = 0;
        const sections = Array.isArray(assessment.templateSnapshot?.sections)
          ? assessment.templateSnapshot.sections
          : [];
        for (const section of sections) {
          for (const question of section?.questions ?? []) {
            if (question?.type !== 'nonConformity') {
              continue;
            }
            const answer = answers[question.id];
            // An item the assessor judged NOT APPLICABLE to these premises is
            // not a finding, so it can never become an action. The severity
            // test below already excludes it (the contract makes `severity` and
            // `notApplicable` mutually exclusive, so an N/A answer carries no
            // severity, and an action built from one would be malformed: no
            // grade, hence no due window, hence a nonsense deadline). This is
            // stated explicitly all the same, so that the exclusion survives any
            // future loosening of the severity test rather than depending on it.
            // It is `isEffectiveNotApplicable`, not the bare flag: a
            // contract-violating answer that somehow carries BOTH a grade and
            // the flag keeps its action - see the precedence note in
            // lib/assessmentChecks.
            if (isEffectiveNotApplicable(answer)) {
              continue;
            }
            if (!answer?.severity || !SEVERITIES.includes(answer.severity)) {
              continue;
            }
            const extras = readNonConformityValue(answer);
            if (extras.actionRequired === false) {
              continue;
            }
            // The responsible party: the finding's own, else the visit's (the
            // assessment copy, itself defaulted from the building), else the
            // building's default. The chain itself lives in lib/responsibleParty
            // so the release pipeline, the manual action plan and the report
            // cannot drift in who they hold accountable - and it carries the
            // CONTACT ID, which is what the digest below is addressed through.
            const assignment = resolveResponsibleAssignment(
              extras,
              assessment,
              building,
            );
            // The name is taken from the LIVE contact record where there is
            // one: `responsible` is the name as recorded when the action was
            // raised, and at this instant the directory IS that record. It also
            // means a party stored as a bare link still lands with a name on it.
            const linkedContact = assignment.contactId
              ? contacts[assignment.contactId]
              : undefined;
            const responsible = linkedContact?.name ?? assignment.name;
            if (!assignment.contactId) {
              actionsWithoutContact += 1;
            } else if (!linkedContact) {
              // The id is KEPT rather than dropped: it is the recorded intent,
              // and a dangling link a reader can see and repair beats a silent
              // deletion that leaves only the puzzle of the missing email.
              actionsWithMissingContact += 1;
            }
            // The flag composite: the first plan flag that has one (brief 8).
            const locationFlagUrl = (answer.flags ?? []).find(
              (flag) => typeof flag?.flagImageUrl === 'string',
            )?.flagImageUrl;
            const photos = Array.isArray(answer.photos) ? answer.photos : [];

            // RTDB rejects undefined, so optional fields are spread in only
            // when present.
            newActions.push({
              assessmentId,
              sectionCode: section.code,
              question: question.text,
              observation: answer.observation ?? '',
              severity: answer.severity,
              ...(locationFlagUrl !== undefined ? { locationFlagUrl } : {}),
              ...(photos.length > 0 ? { images: photos } : {}),
              ...(responsible !== undefined ? { responsible } : {}),
              ...(assignment.contactId !== undefined
                ? { responsibleContactId: assignment.contactId }
                : {}),
              ...(extras.dueBy !== undefined ? { dueBy: extras.dueBy } : {}),
              lifeProtection: extras.lifeProtection === true,
              status: 'open',
            });
          }
        }

        // 3b. The TRUE finding distribution: count EVERY answered finding by
        // severity (the same "any answer with a valid severity is a finding"
        // reading the report's Section 2 uses), including no-action-required
        // findings that produced no action - the meter reflects what was FOUND.
        //
        // A not-applicable answer contributes NOTHING here, and must not: it is
        // not a finding of any grade, so counting it would inflate the
        // denominator of the RAG shares and make a building with many N/A items
        // read as safer than one where the same items were genuinely assessed as
        // low risk. Counting by severity alone already achieves that (an N/A
        // answer has none), which is why there is no extra test below.
        const distribution: RagDistribution = { low: 0, medium: 0, high: 0 };
        const bucketOf: Record<Severity, keyof RagDistribution> = {
          L: 'low',
          M: 'medium',
          H: 'high',
        };
        for (const answer of Object.values(answers)) {
          if (answer?.severity && SEVERITIES.includes(answer.severity)) {
            distribution[bucketOf[answer.severity]] += 1;
          }
        }

        // 3c. Derive the building's risk level with the SHARED model. The open
        // action-plan state feeding it is the building's existing OPEN actions
        // plus the ones being created right now (they are open by definition).
        const openActions = [
          ...Object.values(existingActions).filter(
            (action) => action?.status === 'open',
          ),
          ...newActions,
        ];
        const hasOpenHighAction = openActions.some(
          (action) => action.severity === 'H' || action.lifeProtection === true,
        );
        const hasOverdueAction = openActions.some(
          (action) => typeof action.dueBy === 'number' && action.dueBy < now,
        );
        const derivedRiskLevel = deriveRiskLevel(
          { distribution, hasOpenHighAction, hasOverdueAction },
          ragConfig,
        );

        // 3d. Headline-risk precedence: the assessor's manual overall-risk
        // override (assessment.manualRiskLevel - who set it and when are on the
        // record) DRIVES building.riskLevel when present, the documented
        // contract; the derived level applies only in its absence.
        // ragDistribution stays the computed truth either way so the gauge
        // renders what was actually found, and the released report reads
        // building.riskLevel, so it follows the override automatically.
        const manualLevel = assessment.manualRiskLevel?.level;
        const riskLevel = manualLevel ?? derivedRiskLevel;

        // 4. CLAIM the release transactionally: readyForRelease -> released,
        // aborting on anything else. The step-2 status check is a fast-path
        // courtesy - two concurrent releases both pass it, and each would then
        // mint its own action plan; the transaction lets exactly one through
        // (the updateMember/acceptInvitation posture). The commit fires
        // onAssessmentStageChange; the payload update below lands immediately
        // behind it (see header).
        const statusRef = db.ref(paths.db.assessmentStatus(orgId, assessmentId));
        const claim = await statusRef.transaction(
          // See acceptAssessment: a listener-less function instance runs this
          // against a null local cache first, and returning undefined there
          // aborts before the server value is read. Treat the uncached null as
          // "proceed" so the SDK re-runs against the real server value (already
          // confirmed readyForRelease above); two concurrent releases still let
          // exactly one commit.
          (current: AssessmentStatus | null) =>
            current === null || current === 'readyForRelease'
              ? ('released' as const)
              : undefined,
        );
        if (!claim.committed) {
          throw fail.failedPrecondition(
            'Only an accepted assessment can be released.',
            { status: (claim.snapshot?.val() as string | null) ?? 'unknown' },
          );
        }

        // 5. ONE multi-location payload update (the status is already claimed
        // above, so it is NOT repeated here): actions, building roll-up,
        // workflow attribution, job/index mirrors, audit entries.
        // Story 2033 AC3: releasing rolls the FRA review-by date forward to 12
        // months after release (UTC epoch arithmetic; REVIEW_INTERVAL_MS is the
        // PAS 79 annual-review convention - per-org configurability is recorded
        // in FUTURE_WORK.md section 8). UNLESS the building already carries a
        // LATER nextDue: that is the assessor's confirmed review date, and their
        // explicit call wins over the default roll.
        const currentReviewDue = building.serviceSchedule?.fraReview?.nextDue;
        const rollReviewDate = !(
          typeof currentReviewDue === 'number' && currentReviewDue > now
        );

        const actionsPath = paths.db.actions(orgId, assessment.buildingId);
        const update: Record<string, unknown> = {
          [`${buildingPath}/riskLevel`]: riskLevel,
          [`${buildingPath}/ragDistribution`]: distribution,
          [`${buildingPath}/lastAssessedAt`]: now,
          ...(rollReviewDate
            ? {
                [`${buildingPath}/serviceSchedule/fraReview/nextDue`]:
                  now + REVIEW_INTERVAL_MS,
              }
            : {}),
          [`${paths.db.assessment(orgId, assessmentId)}/workflow/releasedAt`]: now,
          [`${paths.db.assessment(orgId, assessmentId)}/workflow/releasedBy`]:
            uid,
          [`${paths.db.job(orgId, assessment.jobId)}/status`]: 'released',
          [paths.db.assessorJob(orgId, job.assessorUid, assessment.jobId)]:
            'released',
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            // The manual override's application is part of the audit story: the
            // entry says when the headline risk was the assessor's call.
            action: manualLevel
              ? `assessment.released (manual risk: ${manualLevel})`
              : 'assessment.released',
            target: assessmentId,
          }),
          ...(newActions.length > 0
            ? activityUpdate(paths, orgId, {
                actorUid: uid,
                action: `actions.created (${newActions.length})`,
                target: assessment.buildingId,
              })
            : {}),
        };
        for (const action of newActions) {
          // push() mints the key locally (no I/O); sequential calls are unique.
          const actionId = db.ref(actionsPath).push().key as string;
          update[paths.db.action(orgId, assessment.buildingId, actionId)] =
            action;
        }
        try {
          await db.ref().update(update);
        } catch (error) {
          // The claim landed but the payload did not: put the status back so
          // the release can be retried, rather than stranding a "released"
          // assessment with no action plan behind it. Best-effort, and the
          // original failure is what surfaces (acceptInvitation posture).
          await statusRef.set('readyForRelease').catch(() => undefined);
          throw error;
        }

        const logger = createLogger({ fn: 'releaseAssessment', orgId });

        // Why an action may never reach anybody, said plainly and once per
        // release rather than per finding: a party with no contact link, or a
        // link pointing at a contact that has since been removed.
        if (actionsWithoutContact > 0) {
          logger.info(
            'Some released actions carry no responsible contact, so no email can be addressed for them (an unlinked legacy or imported party)',
            { assessmentId, actions: actionsWithoutContact },
          );
        }
        if (actionsWithMissingContact > 0) {
          logger.warn(
            'Some released actions name a responsible contact that is no longer in the customer’s contact list',
            { assessmentId, actions: actionsWithMissingContact },
          );
        }

        // 6. Story 2047: ONE digest email per responsible contact, only after
        // the payload has landed (an email about actions that failed to write
        // would be a lie) and only when the release actually minted actions.
        // Best-effort; can never fail the release.
        if (newActions.length > 0) {
          await emailReleaseDigests(
            paths,
            orgId,
            job.siteId,
            assessment.buildingId,
            building,
            newActions,
            contacts,
            logger,
          );
        }

        logger.info('Assessment released', {
          assessmentId,
          buildingId: assessment.buildingId,
          actionsCreated: newActions.length,
          actionsWithoutContact,
          riskLevel,
          manualOverride: manualLevel !== undefined,
        });
        return { released: true, actionsCreated: newActions.length };
      },
    ),
);
