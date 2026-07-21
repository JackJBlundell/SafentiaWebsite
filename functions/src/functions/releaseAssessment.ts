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
// A non-conformity's extras (responsible / dueBy / lifeProtection /
// actionRequired) live on the answer's `value` as the structured object defined
// by the app's features/assessment/data/nonConformity.ts - the documented shape
// this server-side reader mirrors.
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
  getClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireString, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import { deriveRiskLevel, RAG_CONFIG_DEFAULTS } from '../lib/ragDerivation';
import { dispatchEmail, EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { WEB_ORIGIN } from '../lib/webOrigin';
import { orgEmailBrand, renderBrandedEmail } from '../lib/emailTemplates';
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
 * ONE digest email to the building's linked responsible party summarising the
 * action plan the release just minted - never per-action (story 2047: the
 * duty-holder gets one actionable summary, not a inbox flood). Resolution is
 * strictly via the structured linkage: the building's responsibleParty must
 * carry a contactId, and that CustomerContact must have an email. A free-text
 * party (no contactId) or an email-less contact means we log the intent and
 * skip - guessing an address for a compliance email is worse than silence.
 * Best-effort throughout: the release has already landed, so nothing here may
 * throw (the dispatchEmail contract, extended to the reads around it).
 */
async function emailReleaseDigest(
  paths: EnvPaths,
  orgId: string,
  siteId: string,
  buildingId: string,
  building: Building,
  newActions: Action[],
  logger: Logger,
): Promise<void> {
  try {
    const party = building.responsibleParty;
    if (!party?.contactId) {
      logger.info(
        'Release digest skipped: building has no linked responsible party',
        { hasParty: Boolean(party) },
      );
      return;
    }
    const contactSnap = await db
      .ref(
        paths.db.customerContact(orgId, building.customerId, party.contactId),
      )
      .get();
    const contact = contactSnap.val() as CustomerContact | null;
    if (!contact?.email) {
      logger.info('Release digest skipped: linked contact has no email', {
        contactId: party.contactId,
      });
      return;
    }

    // The digest's headline facts: how bad and how soon.
    const topSeverity: Severity = newActions.some((a) => a.severity === 'H')
      ? 'H'
      : newActions.some((a) => a.severity === 'M')
        ? 'M'
        : 'L';
    const dueDates = newActions
      .map((a) => a.dueBy)
      .filter((d): d is number => typeof d === 'number');
    const earliestDue = dueDates.length > 0 ? Math.min(...dueDates) : undefined;

    const count = newActions.length;
    // The digest carries the sending organisation's own brand (name + accent),
    // falling back to the Safentia brand when the org has not set a valid one.
    const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
    const brand = orgEmailBrand(profileSnap.val() as OrgProfile | null);
    const subject = `${count} ${count === 1 ? 'action' : 'actions'} from the released assessment of ${building.name}`;
    const body = `A fire risk assessment of ${building.name} has been released with ${count} ${count === 1 ? 'action' : 'actions'} assigned to the building's action plan.`;
    const html = renderBrandedEmail({
      brand,
      preheader: body,
      heading: subject,
      paragraphs: [
        body,
        'Please review the action plan and arrange the remedial work before the due dates pass.',
      ],
      detailRows: [
        { label: 'Building', value: building.name },
        { label: 'Actions', value: String(count) },
        { label: 'Top severity', value: SEVERITY_LABELS[topSeverity] },
        ...(earliestDue !== undefined
          ? [{ label: 'Earliest due', value: formatDueDate(earliestDue) }]
          : []),
      ],
      // Straight to the building in the customer's own portal, where the new
      // action plan and the released report both live. The staff console would
      // only show this recipient a permission wall.
      cta: {
        label: 'View the action plan',
        url: `${WEB_ORIGIN}/app/sites/${siteId}/buildings/${buildingId}`,
      },
      footerNote: `You are receiving this because you are the responsible party for ${building.name} on Safentia.`,
    });
    await dispatchEmail({ to: contact.email, subject, body, html }, logger, {
      orgId,
      env: paths.env,
      category: 'release-digest',
    });
  } catch (error) {
    // The release already landed; a failed courtesy digest must not undo it.
    logger.warn('Release digest email failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The structured extras a non-conformity answer carries on its open `value`
 *  field - the same shape the app's nonConformity module writes. Read
 *  defensively: a remote answer may hold a primitive or nothing at all. */
function readNonConformityValue(answer: AssessmentAnswer): {
  actionRequired?: boolean;
  responsible?: string;
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
        const claims = getClaims(request);
        assertOrgRole(claims, ['admin', 'auditor']);
        const { paths } = envFor(claims);
        const orgId = claims.orgId;

        const input = assertObject(request.data);
        const assessmentId = requireString(
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

        // 3a. Build the action plan from the non-conformity findings. The
        // template snapshot says which questions ARE non-conformities and gives
        // each its section code and wording; the answer carries the finding. A
        // finding marked "no action required" (a settled, satisfactory outcome)
        // and an untouched non-conformity (no severity = no finding) create
        // nothing.
        const now = Date.now();
        const newActions: Action[] = [];
        const sections = Array.isArray(assessment.templateSnapshot?.sections)
          ? assessment.templateSnapshot.sections
          : [];
        for (const section of sections) {
          for (const question of section?.questions ?? []) {
            if (question?.type !== 'nonConformity') {
              continue;
            }
            const answer = answers[question.id];
            if (!answer?.severity || !SEVERITIES.includes(answer.severity)) {
              continue;
            }
            const extras = readNonConformityValue(answer);
            if (extras.actionRequired === false) {
              continue;
            }
            // The responsible party: the finding's own, else the visit's (the
            // assessment copy, itself defaulted from the building), else the
            // building's default (structured party first, legacy string last).
            const responsible =
              extras.responsible ??
              assessment.responsibleParty?.name ??
              building.responsibleParty?.name ??
              building.responsiblePerson;
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

        // 6. Story 2047: ONE digest email to the building's linked responsible
        // party, only after the payload has landed (an email about actions that
        // failed to write would be a lie) and only when the release actually
        // minted actions. Best-effort; can never fail the release.
        if (newActions.length > 0) {
          await emailReleaseDigest(
            paths,
            orgId,
            job.siteId,
            assessment.buildingId,
            building,
            newActions,
            logger,
          );
        }

        logger.info('Assessment released', {
          assessmentId,
          buildingId: assessment.buildingId,
          actionsCreated: newActions.length,
          riskLevel,
          manualOverride: manualLevel !== undefined,
        });
        return { released: true, actionsCreated: newActions.length };
      },
    ),
);
