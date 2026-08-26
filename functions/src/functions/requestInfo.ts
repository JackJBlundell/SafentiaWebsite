// ============================================================================
// requestInfo (callable, auditor) - FR-E18 auditor lifecycle, story 1050.
//
// An auditor reviewing a submitted assessment flags specific questions that need
// more information from the assessor. Each flagged answer gains an InfoRequest
// (who asked, what they asked), the assessment drops to `infoRequired`, and the
// job + /assessorJobs index mirror the status the way submitAssessment does -
// all in ONE multi-location update with the /activity entry. The assessor's
// notification is NOT sent here: onAssessmentStageChange already notifies the
// assigned assessor on the transition to `infoRequired` (its STAGE_AUDIENCE
// table), so a second send here would double-notify.
//
// The answer's single `infoRequest` slot holds the CURRENT round: a new request
// on a question replaces the previous, resolved one (the schema keeps one live
// thread per question; each round is also permanently recorded in /activity).
//
// DEADLINE: the batch carries one `dueBy` stamped onto every InfoRequest in it -
// one round of questions is one conversation, so one date for the assessor to
// work to. The auditor may set it; absent, it defaults to INFO_REQUEST_DUE_DAYS
// ahead of the SERVER clock (never the client's, which is not trusted).
//
// EMAIL: the assessor's in-app notification still comes from
// onAssessmentStageChange, but the EMAIL is sent here. That split is deliberate.
// The stage bus knows only "the status became infoRequired"; it has no idea how
// many questions were flagged or when the answers are wanted, and recovering
// either would mean re-reading and diffing the whole answers node against a
// previous state it does not have. This callable already holds both facts, so
// the email that must state them is authored where they are known. The in-app
// notification stays on the bus so every stage transition keeps producing one,
// whatever drove it.
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
import { EMAIL_PROVIDER_SECRETS } from '../lib/email';
import { orgEmailBrand } from '../lib/emailTemplates';
import { deliverKindEmail } from '../lib/emailDigest';
import { WEB_ORIGIN } from '../lib/webOrigin';
import type {
  RequestInfoInput,
  RequestInfoResult,
  Assessment,
  AssessmentAnswer,
  AssessmentStatus,
  Building,
  InfoRequest,
  Job,
  Keyed,
  OrgMember,
  OrgProfile,
} from '../shared/types';
import { INFO_REQUEST_DUE_DAYS } from '../shared/types';
import type { EnvPaths } from '../lib/paths';
import type { Logger } from '../lib/logging';

/** More flags than any real template has questions is a malformed request. */
const MAX_REQUESTS = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A deadline further out than this is not a working date, it is a typo or a
 *  client with a broken clock. A year of slack is far beyond any real query
 *  round and still rejects the 1970/2999 class of nonsense outright. */
const MAX_DUE_AHEAD_MS = 365 * DAY_MS;

/** A due date rendered for email copy, UK-local so it names the day the
 *  assessor's own working calendar shows. */
function formatDueDate(millis: number): string {
  return new Date(millis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/London',
  });
}

/**
 * Tell the assessor by email that a round of questions is waiting, and by when.
 * Best-effort throughout (the deliverKindEmail contract, extended to the reads
 * around it): the requests have already landed, so nothing here may throw and
 * undo a completed validation act.
 *
 * Delivered through lib/emailDigest, so an auditor working a queue does not put
 * six separate emails into one assessor's morning: the first round of questions
 * arrives at once and the rest of the day's bundle into a single list of what is
 * waiting, one line per building.
 */
async function sendInfoRequestedEmail(
  paths: EnvPaths,
  orgId: string,
  assessment: Assessment,
  assessorUid: string,
  flagged: number,
  dueBy: number,
  logger: Logger,
): Promise<void> {
  try {
    const memberSnap = await db.ref(paths.db.orgMember(orgId, assessorUid)).get();
    const member = memberSnap.val() as OrgMember | null;
    // ABSENT means on: only an explicit false quietens the category.
    if (!member?.email || member.emailPreferences?.infoRequested === false) {
      return;
    }

    // The building names the work in the subject line; the assessment does not
    // carry the siteId, so the bounded org-estate walk is the honest lookup
    // (the onAssessmentStageChange precedent).
    const estateSnap = await db.ref(paths.db.buildingsRoot(orgId)).get();
    const estate =
      (estateSnap.val() as Record<string, Record<string, Building>> | null) ?? {};
    let buildingName = 'a building';
    for (const site of Object.values(estate)) {
      const found = site?.[assessment.buildingId];
      if (found) {
        buildingName = found.name;
        break;
      }
    }

    const profileSnap = await db.ref(paths.db.orgProfile(orgId)).get();
    const brand = orgEmailBrand(profileSnap.val() as OrgProfile | null);
    const flaggedPhrase = `${flagged} ${flagged === 1 ? 'question' : 'questions'}`;
    const dueDate = formatDueDate(dueBy);
    // The copy lives in the 'info-requested' catalogue entry (or the org's own
    // saved template); this site supplies only the values it computes.
    await deliverKindEmail(
      {
        kind: 'info-requested',
        env: paths.env,
        orgId,
        to: member.email,
        variables: {
          'building.name': buildingName,
          'info.flaggedPhrase': flaggedPhrase,
          'info.dueDate': dueDate,
        },
        brand,
        // The job is the assessor's own view of this work in the console
        // (/app/validation is the auditors' queue, which an assessor has no
        // business landing in). On a phone the app deep link is the better
        // route, but a web CTA works on every device the email opens on.
        kindLink: `${WEB_ORIGIN}/app/jobs/${assessment.jobId}`,
        // An auditor working through a queue can send an assessor several
        // rounds of questions in a morning; the digest gives each building one
        // line carrying the two facts that decide what to answer first - how
        // much is waiting on them, and by when.
        digestRow: {
          label: buildingName,
          value: `${flaggedPhrase} to answer by ${dueDate}`,
        },
      },
      logger,
    );
  } catch (error) {
    logger.warn('Information-requested email failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export const requestInfo = onCall<RequestInfoInput>(
  { ...callableOptions, secrets: EMAIL_PROVIDER_SECRETS },
  (request) =>
  runCallable<RequestInfoResult>(
    createLogger({ fn: 'requestInfo' }),
    async () => {
      // 1. Attestation, identity, authorisation. Validation may be performed by
      // an auditor OR an admin: an admin holds oversight of the whole workflow,
      // and releaseAssessment already allows both, so the three validation
      // actions (request info / accept / release) are kept consistent. Where
      // independence of review matters, that is a per-assessment concern (the
      // reviewer should not be the submitting assessor), not this role gate.
      assertAppCheck(request);
      const { uid } = assertAuth(request);
      await assertRateLimit(uid, 'requestInfo');
      const claims = getClaims(request);
      assertOrgRole(claims, ['admin', 'auditor']);
      const { paths } = envFor(claims);
      const orgId = claims.orgId;

      // 2. Validate input: at least one {questionId, message} pair, each shaped
      // and bounded, with no duplicate question.
      const input = assertObject(request.data);
      const assessmentId = requireString(input, 'assessmentId', TEXT_LIMITS.shortText);
      const rawRequests = input.requests;
      if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
        throw fail.invalidArgument('Flag at least one question.', {
          field: 'requests',
        });
      }
      if (rawRequests.length > MAX_REQUESTS) {
        throw fail.invalidArgument('Too many questions flagged in one request.', {
          field: 'requests',
          max: MAX_REQUESTS,
        });
      }
      const seen = new Set<string>();
      const requests = rawRequests.map((entry) => {
        const item = assertObject(entry);
        const questionId = requireString(item, 'questionId', TEXT_LIMITS.shortText);
        const message = requireString(item, 'message', TEXT_LIMITS.freeText);
        if (seen.has(questionId)) {
          throw fail.invalidArgument('A question can only be flagged once.', {
            field: 'requests',
            questionId,
          });
        }
        seen.add(questionId);
        return { questionId, message };
      });

      // 2b. The batch deadline. Optional: absent means the default window ahead
      // of the SERVER clock, which is also the only clock trusted to decide
      // whether a supplied date is still in the future. A date already past
      // would arrive overdue, and one years out is not a working date - both
      // are rejected rather than coerced (brief 18.4).
      const now = Date.now();
      const rawDueBy = input.dueBy;
      let dueBy: number;
      if (rawDueBy === undefined || rawDueBy === null) {
        dueBy = now + INFO_REQUEST_DUE_DAYS * DAY_MS;
      } else {
        if (typeof rawDueBy !== 'number' || !Number.isFinite(rawDueBy)) {
          throw fail.invalidArgument('The response deadline is not a valid date.', {
            field: 'dueBy',
          });
        }
        if (rawDueBy <= now) {
          throw fail.invalidArgument('The response deadline must be in the future.', {
            field: 'dueBy',
          });
        }
        if (rawDueBy > now + MAX_DUE_AHEAD_MS) {
          throw fail.invalidArgument('The response deadline is too far ahead.', {
            field: 'dueBy',
          });
        }
        dueBy = Math.round(rawDueBy);
      }

      // 3. The assessment must exist in the caller's org and be sitting with
      // the auditors - only a submitted assessment can be queried.
      const assessmentSnap = await db
        .ref(paths.db.assessment(orgId, assessmentId))
        .get();
      if (!assessmentSnap.exists()) {
        throw fail.notFound('This assessment could not be found.');
      }
      const assessment = assessmentSnap.val() as Assessment;
      if (assessment.status !== 'readyForValidation') {
        throw fail.failedPrecondition(
          'Only an assessment awaiting validation can be queried.',
          { status: assessment.status },
        );
      }

      // 3b. Every flagged question must have an answer record to hang the
      // request on - a flag against a question the assessor never answered (or
      // a fabricated id) is rejected naming the offender.
      const answersSnap = await db
        .ref(paths.db.assessmentAnswers(orgId, assessmentId))
        .get();
      const answers = (answersSnap.val() as Keyed<AssessmentAnswer> | null) ?? {};
      for (const { questionId } of requests) {
        if (!answers[questionId]) {
          throw fail.invalidArgument(
            'A flagged question has no answer on this assessment.',
            { field: 'requests', questionId },
          );
        }
      }

      // The job carries the assessor whose index entry must mirror the status
      // (the same mirror discipline as submitAssessment).
      const jobSnap = await db.ref(paths.db.job(orgId, assessment.jobId)).get();
      if (!jobSnap.exists()) {
        throw fail.failedPrecondition('The originating job is missing.');
      }
      const job = jobSnap.val() as Job;

      // 4. CLAIM the status drop transactionally: readyForValidation ->
      // infoRequired, aborting on anything else. The step-3 status check is a
      // fast-path courtesy - a concurrent accept (or another query round) may
      // have moved the status since, and a plain update would stamp over it
      // (the updateMember/acceptInvitation posture).
      const statusRef = db.ref(paths.db.assessmentStatus(orgId, assessmentId));
      const claim = await statusRef.transaction(
        // See acceptAssessment: the Admin SDK runs this against a null local
        // cache first in a listener-less function instance, and returning
        // undefined there aborts before the server value is read. Treat the
        // uncached null as "proceed" so the SDK re-runs against the real server
        // value (already confirmed readyForValidation above); a genuine
        // concurrent status change still aborts.
        (current: AssessmentStatus | null) =>
          current === null || current === 'readyForValidation'
            ? ('infoRequired' as const)
            : undefined,
      );
      if (!claim.committed) {
        throw fail.failedPrecondition(
          'Only an assessment awaiting validation can be queried.',
          { status: (claim.snapshot?.val() as string | null) ?? 'unknown' },
        );
      }

      // 5. The payload update (the status is already claimed above, so it is
      // NOT repeated here): every InfoRequest, the workflow attribution, the
      // job/index mirrors and the audit entry together.
      const update: Record<string, unknown> = {
        [`${paths.db.assessment(orgId, assessmentId)}/workflow/checkedBy`]: uid,
        [`${paths.db.job(orgId, assessment.jobId)}/status`]: 'infoRequired',
        [paths.db.assessorJob(orgId, job.assessorUid, assessment.jobId)]:
          'infoRequired',
        ...activityUpdate(paths, orgId, {
          actorUid: uid,
          action: `assessment.infoRequested (${requests.length})`,
          target: assessmentId,
        }),
      };
      for (const { questionId, message } of requests) {
        // One deadline across the batch: the round is one conversation, and the
        // reminder sweep reads this field off every request in it.
        const infoRequest: InfoRequest = { byUid: uid, message, dueBy };
        update[
          `${paths.db.assessmentAnswer(orgId, assessmentId, questionId)}/infoRequest`
        ] = infoRequest;
      }
      try {
        await db.ref().update(update);
      } catch (error) {
        // The claim landed but the payload did not: put the status back so the
        // query round can be retried, rather than stranding an infoRequired
        // assessment with no requests behind it. Best-effort (acceptInvitation
        // posture).
        await statusRef.set('readyForValidation').catch(() => undefined);
        throw error;
      }

      // The assessor's IN-APP notification fires from onAssessmentStageChange on
      // this transition; the email is sent here, where the count and deadline
      // are known (see header).
      const logger = createLogger({ fn: 'requestInfo', orgId });
      await sendInfoRequestedEmail(
        paths,
        orgId,
        assessment,
        job.assessorUid,
        requests.length,
        dueBy,
        logger,
      );
      logger.info('Information requested', {
        assessmentId,
        flagged: requests.length,
      });
      return { flagged: requests.length };
    },
  ),
);
