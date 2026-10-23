// ============================================================================
// generateAssessmentDraft (callable, assessor-on-this-job only).
//
// An on-site aid that drafts the assessment's narrative + the issues to address,
// for the assessor to review and EDIT (nothing here is written to the assessment;
// the result is returned and the app pre-fills the editable fields, brief 11).
//
// METHOD (deliberate split - the AI does as little as possible):
//   - Issues to address          -> DETERMINISTIC. The recorded non-conformities,
//                                    each tied to a REAL UK regulation via the
//                                    curated table (fireSafetyRegulations.ts). No
//                                    model, so no hallucinated findings or cites.
//   - Building description /      -> DETERMINISTIC. Drafted from the building,
//     premises / incident /          customer and site records (assessmentDraft.ts).
//     risk opinion blocks
//   - SUMMARY block               -> AI (the only model call). Synthesises the
//                                    deterministic findings into prose, grounded in
//                                    the ADMIN-EDITABLE regulatory context stored at
//                                    /platform/aiContext. If the model is offline or
//                                    the key is unset, a deterministic fallback
//                                    summary is used instead - drafting never hard-
//                                    depends on the model.
//
// The summary prompt also carries the ORGANISATION's own house guidance
// (OrgSettings.aiGuidance, edited by its admins in the console's settings area):
// the regulations this firm always cites, the features it always calls out, its
// tone. It is layered LAST, below the platform's regulatory grounding and strict
// rules, and is sanitised like every other free-text value that reaches the
// prompt - see buildSummarySystemPrompt for why the order is the safeguard.
//
// Trust nothing from the client (brief 18.4): the caller passes only the
// assessmentId; the server loads the authoritative answers, building, customer and
// site itself, and authorises against the originating job's assessor.
//
// The OpenAI API key is a Firebase SECRET (OPENAI_API_KEY); set it with
//   firebase functions:secrets:set OPENAI_API_KEY
// ============================================================================

import { onCall } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { db } from '../admin';
import { platform } from '../shared/paths';
import { callableOptions } from '../lib/callable';
import { createLogger } from '../lib/logging';
import { fail, runCallable } from '../lib/errors';
import {
  assertAppCheck,
  assertAuth,
  assertAssessorOnJob,
  getLiveClaims,
  envFor,
} from '../lib/guards';
import { assertObject, requireDbKey, TEXT_LIMITS } from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { ops } from '../lib/paths';
import { utcDayKey } from '../lib/manualEmailLimits';
import {
  extractIssues,
  ragDistribution,
  draftNarrativeBlocks,
  fallbackSummary,
} from '../lib/assessmentDraft';
import {
  buildSummarySystemPrompt,
  buildSummaryPrompt,
} from '../lib/fireSafetyContext';
import type {
  GenerateAssessmentDraftInput,
  GenerateAssessmentDraftResult,
  AiContext,
  Assessment,
  AssessmentAnswer,
  Building,
  Customer,
  Job,
  OrgSettings,
  Site,
  Keyed,
  Environment,
} from '../shared/types';

/** The OpenAI API key, injected at runtime from Secret Manager (never in the
 *  repo). Set it with `firebase functions:secrets:set OPENAI_API_KEY`. */
const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');

/** A cost-conscious model: strong enough for regulatory prose. Swap to
 *  `gpt-4o-mini` to cut cost further. */
const MODEL = 'gpt-4o';

/**
 * How much of the organisation's own AI guidance reaches the prompt. Mirrors the
 * ceiling updateOrgSettings stores against (AI_GUIDANCE_MAX_LENGTH), so a value
 * that got past validation is never silently truncated here; it is a second
 * bound, not a second policy, and exists so that guidance written before any
 * future ceiling change still cannot swamp the system prompt.
 */
const AI_GUIDANCE_PROMPT_LIMIT = 1500;

/**
 * At most this many MODEL-BACKED drafts per organisation per UTC day - the
 * OpenAI cost ceiling. The per-user rate limit (lib/rateLimit) only slows one
 * caller down; an org with many assessors (or one compromised account rotated
 * across sessions) could still run the paid model all day. A real field day is
 * a handful of drafts per assessor, so a busy org fits comfortably under 200;
 * a scripted loop does not. Only calls that would actually reach the model are
 * charged (no key configured = deterministic fallback = no cost, no charge).
 */
const AI_DRAFT_DAILY_CAP = 200;

/**
 * Charge one model-backed draft against the org's daily allowance, or reject.
 * Mirrors chargeManualEmailQuota (lib/manualEmailLimits): the counter lives
 * under the server-only ops namespace keyed by UTC calendar day
 * (`ops/aiDraftCounts/{env}/{orgId}/{yyyyMmDd}`), so rules default-deny it, no
 * client can read or reset it, and a new day is simply a new key. One atomic
 * transaction reads and advances the total, so concurrent drafts cannot race
 * past the cap, and an over-cap charge ABORTS (no write) and is rejected with
 * the structured `resource-exhausted` error the client already maps.
 */
async function chargeAiDraftQuota(
  env: Environment,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const ref = db.ref(ops.aiDraftCount(env, orgId, utcDayKey(nowMs)));
  const tx = await ref.transaction((current: number | null) => {
    const next = (current ?? 0) + 1;
    // Over the cap: abort (undefined) so nothing is written and `committed`
    // comes back false - the day's total only counts drafts cleared to run.
    return next > AI_DRAFT_DAILY_CAP ? undefined : next;
  });
  if (!tx.committed) {
    throw fail.resourceExhausted(
      `Your organisation has reached its daily limit of ${AI_DRAFT_DAILY_CAP} AI drafts. ` +
        'The limit resets at midnight UTC - please try again then.',
      { limit: AI_DRAFT_DAILY_CAP },
    );
  }
}

/**
 * Sanitise a free-text value before it is interpolated into the LLM prompt. The
 * building name is assessor-controlled, so we (a) strip control characters and
 * newlines that could be used for prompt injection ("\n\nIgnore previous
 * instructions..."), (b) collapse whitespace, and (c) cap the length so a long
 * value cannot dominate or overflow the prompt. This is defence-in-depth on top
 * of the strong system-prompt guardrails (use ONLY the findings provided).
 *
 * `maxLength` defaults to the building name's 120 characters. The organisation's
 * house AI guidance runs through this SAME function - it is admin-controlled
 * free text reaching the same prompt, and stripping its newlines is exactly the
 * point, since a guidance block that could open a new line could forge a new
 * prompt section - but it is a paragraph rather than a name, so it passes its
 * own ceiling instead of being cut off mid-sentence at 120.
 */
function sanitizeForPrompt(value: string, maxLength = 120): string {
  return value
    // Strip ASCII control characters (incl. newlines/tabs) and DEL.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // Collapse any remaining whitespace runs to single spaces.
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export const generateAssessmentDraft = onCall<GenerateAssessmentDraftInput>(
  { ...callableOptions, secrets: [OPENAI_API_KEY] },
  (request) =>
    runCallable<GenerateAssessmentDraftResult>(
      createLogger({ fn: 'generateAssessmentDraft' }),
      async () => {
        // 1. Attestation + identity + a tight rate limit (this may call a paid model).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'generateAssessmentDraft');
        const claims = await getLiveClaims(request);
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        const input = assertObject(request.data);
        const assessmentId = requireDbKey(
          input,
          'assessmentId',
          TEXT_LIMITS.shortText,
        );

        // 2. Load the assessment and authorise against the originating job's
        //    assessor (holding the role is not enough - it must be this work).
        const assessmentSnap = await db
          .ref(paths.db.assessment(orgId, assessmentId))
          .get();
        if (!assessmentSnap.exists()) {
          throw fail.notFound('This assessment could not be found.');
        }
        const assessment = assessmentSnap.val() as Assessment;

        const jobSnap = await db
          .ref(paths.db.job(orgId, assessment.jobId))
          .get();
        if (!jobSnap.exists()) {
          throw fail.failedPrecondition('The originating job is missing.');
        }
        const job = jobSnap.val() as Job;
        assertAssessorOnJob(claims, uid, job.assessorUid);

        // Drafting is a pre-submission aid; once submitted the assessment is the
        // auditor's, so we only draft while it is still being worked on.
        if (
          assessment.status !== 'inProgress' &&
          assessment.status !== 'infoRequired'
        ) {
          throw fail.failedPrecondition(
            'A draft can only be generated while the assessment is in progress.',
            { status: assessment.status },
          );
        }

        // 3. Load the authoritative context (answers + building/customer/site +
        //    the admin-editable AI regulatory context + this organisation's own
        //    settings, which carry its house guidance for the summary writer).
        const [
          answersSnap,
          buildingSnap,
          customerSnap,
          siteSnap,
          aiCtxSnap,
          orgSettingsSnap,
        ] = await Promise.all([
          db.ref(paths.db.assessmentAnswers(orgId, assessmentId)).get(),
          db
            .ref(paths.db.building(orgId, job.siteId, assessment.buildingId))
            .get(),
          db.ref(paths.db.customer(orgId, assessment.customerId)).get(),
          db.ref(paths.db.site(orgId, job.customerId, job.siteId)).get(),
          db.ref(platform.aiContext()).get(),
          db.ref(paths.db.orgSettings(orgId)).get(),
        ]);
        const answers = (answersSnap.val() as Keyed<AssessmentAnswer> | null) ?? {};
        const building = buildingSnap.val() as Building | null;
        const customer = customerSnap.val() as Customer | null;
        const site = siteSnap.val() as Site | null;
        const aiContext = (aiCtxSnap.val() as AiContext | null) ?? {};
        const orgSettings = (orgSettingsSnap.val() as OrgSettings | null) ?? {};

        const logger = createLogger({ fn: 'generateAssessmentDraft', orgId });

        // 4. DETERMINISTIC: issues (with real regulation citations), the building's
        //    proportional RAG, and the four factual narrative blocks.
        const issues = extractIssues(assessment.templateSnapshot, answers);
        const dist = ragDistribution(answers);
        const blocks = draftNarrativeBlocks(building, customer, site);

        // 5. SUMMARY: the only AI step. Grounded in the admin-editable regulatory
        //    context and the deterministic findings; deterministic fallback when
        //    the model is unavailable so the draft is always usable.
        const buildingName = sanitizeForPrompt(building?.name ?? 'this building');
        // The organisation's own steer, sanitised exactly like every other piece
        // of free text that reaches the prompt: control characters and newlines
        // out (a guidance block must not be able to forge a prompt section),
        // whitespace collapsed, length bounded. Empty guidance sanitises to an
        // empty string, which the prompt builder simply omits, so an org that
        // has never opened the settings page gets the prompt it always got.
        const orgGuidance = sanitizeForPrompt(
          orgSettings.aiGuidance ?? '',
          AI_GUIDANCE_PROMPT_LIMIT,
        );
        let summary = fallbackSummary(issues, dist);
        const apiKey = OPENAI_API_KEY.value();
        if (apiKey) {
          // The org-wide cost ceiling, charged only now that the model is about
          // to be called, and OUTSIDE the try below: an over-cap rejection must
          // reach the caller, not be swallowed into the deterministic fallback
          // (that would silently hand back a lesser draft with no explanation).
          await chargeAiDraftQuota(env, orgId);
          try {
            // Lazy-load the OpenAI SDK at first use: every deployed function
            // loads the whole barrel graph at cold start, so a static import
            // here would make EVERY function pay for the openai dependency.
            const { default: OpenAI } = await import('openai');
            const client = new OpenAI({ apiKey });
            // OpenAI takes the system prompt as a `system`-role message (there is
            // no top-level `system` param), so the regulatory grounding leads the
            // messages array and the findings follow as the user turn.
            const response = await client.chat.completions.create({
              model: MODEL,
              max_tokens: 1500,
              messages: [
                {
                  role: 'system',
                  content: buildSummarySystemPrompt(
                    aiContext.regulatoryContext,
                    aiContext.additionalGuidance,
                    orgGuidance,
                  ),
                },
                {
                  role: 'user',
                  content: buildSummaryPrompt(buildingName, issues, dist),
                },
              ],
            });
            const text = (response.choices[0]?.message.content ?? '').trim();
            if (text.length > 0) {
              summary = text;
            } else {
              logger.warn('AI summary empty; using deterministic fallback', {
                assessmentId,
              });
            }
          } catch (caught) {
            // Non-fatal: keep the deterministic fallback summary.
            logger.warn('AI summary failed; using deterministic fallback', {
              assessmentId,
              errorMessage:
                caught instanceof Error ? caught.message : String(caught),
            });
          }
        } else {
          logger.info('OPENAI_API_KEY not set; using deterministic summary', {
            assessmentId,
          });
        }

        logger.info('Assessment draft generated', {
          assessmentId,
          issues: issues.length,
          aiSummary: Boolean(apiKey),
        });

        return {
          narrative: {
            summary,
            buildingDescription: blocks.buildingDescription,
            premisesCovered: blocks.premisesCovered,
            incidentHistory: blocks.incidentHistory,
            riskOpinion: blocks.riskOpinion,
          },
          issues,
        };
      },
    ),
);
