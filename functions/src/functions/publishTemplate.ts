// ============================================================================
// publishTemplate (callable, admin-only) - FR-E21, the template builder's
// publish gate (story 2052).
//
// Drafts are edited by admins directly under /templateDrafts (rules allow it -
// autosave-friendly, no callable round-trip per keystroke). Publishing is the
// auditable, atomic moment, and it is the VALIDATION GATE: a draft is untrusted
// client-shaped data, and a structurally broken template must never become the
// thing an assessor answers on site (story 2052 AC4). So this callable:
//   (a) deep-validates the draft (shape, enums, limits, id uniqueness, and that
//       every standardParagraphRef points at a REAL library paragraph),
//       rebuilding the promoted object from the validated fields only - an
//       unknown key smuggled into the draft is dropped from the published
//       record, never persisted;
//   (b) bumps the version (live version + 1, or 1 on first publish);
//   (c) CLAIMS the publish via a transaction on the /templateVersions archive
//       slot for that version (see step 4 - this is what serialises two admins
//       publishing the same template concurrently);
//   (d) in ONE multi-location update promotes the content to the live
//       /templates node, freezes the same object into the archive slot
//       (story 2053 history), clears the draft and writes the /activity entry.
//
// The live /templates/{orgId}/{templateId} node is entirely CLIENT-immutable
// (rules set .write false on the whole node - clients only ever write the
// draft); the Admin SDK bypasses rules, which is precisely how this Function -
// and only this Function - can write each published version.
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
import {
  assertObject,
  requireString,
  requireTenantStorageRef,
  TEXT_LIMITS,
} from '../lib/validate';
import { assertRateLimit } from '../lib/rateLimit';
import { activityUpdate } from '../lib/events';
import {
  CERTIFICATE_POSITIONS,
  QUESTION_TYPES,
  REPORT_STANDARDS,
} from '../shared/types';
import type {
  CertificatePosition,
  TemplateCertificate,
  Keyed,
  PublishTemplateInput,
  PublishTemplateResult,
  QuestionType,
  ReportStandard,
  StandardParagraph,
  Template,
  TemplateQuestion,
  TemplateSection,
} from '../shared/types';

/** How old an archive-slot claim placeholder must be before another publish
 *  may retake it (see step 4). */
const CLAIM_STALE_MS = 5 * 60 * 1000;

// ----------------------------------------------------------------------------
// Draft validators. The generic lib/validate helpers read CALLABLE INPUT; these
// read the DRAFT (client-authored RTDB data), so their errors carry a `where`
// locator (section/question position) instead of a request field name - the
// builder UI points the admin at the exact broken node. Same discipline
// throughout: reject bad data, never coerce it (brief 18.4).
// ----------------------------------------------------------------------------

type Where = Record<string, unknown>;

/** A required, non-empty, bounded string somewhere in the draft; trims it. */
function draftString(
  value: unknown,
  label: string,
  max: number,
  where: Where,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fail.invalidArgument(`The draft's ${label} is missing or empty.`, {
      ...where,
      field: label,
    });
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw fail.invalidArgument(`The draft's ${label} is too long.`, {
      ...where,
      field: label,
      max,
    });
  }
  return trimmed;
}

/** An optional bounded string: absent/null/empty return undefined; anything
 *  present must be a string within the ceiling. */
function optionalDraftString(
  value: unknown,
  label: string,
  max: number,
  where: Where,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw fail.invalidArgument(`The draft's ${label} must be text.`, {
      ...where,
      field: label,
    });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > max) {
    throw fail.invalidArgument(`The draft's ${label} is too long.`, {
      ...where,
      field: label,
      max,
    });
  }
  return trimmed;
}

/** An optional flag: absent returns undefined; anything present must be a
 *  literal boolean (a "true" string is rejected, not coerced). */
function optionalDraftBoolean(
  value: unknown,
  label: string,
  where: Where,
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw fail.invalidArgument(`The draft's ${label} must be true or false.`, {
      ...where,
      field: label,
    });
  }
  return value;
}

/**
 * Validate one draft question and rebuild it from the validated fields only.
 * Collects its standardParagraphRef into `paragraphRefs` for the single
 * library-existence pass in the caller.
 */
function validateQuestion(
  raw: unknown,
  where: Where,
  paragraphRefs: Map<string, Where>,
): TemplateQuestion {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail.invalidArgument('A draft question is malformed.', where);
  }
  const q = raw as Record<string, unknown>;
  const id = draftString(q.id, 'question id', TEXT_LIMITS.shortText, where);
  const at = { ...where, questionId: id };
  const text = draftString(q.text, 'question text', TEXT_LIMITS.freeText, at);
  const type = q.type;
  if (
    typeof type !== 'string' ||
    !QUESTION_TYPES.includes(type as QuestionType)
  ) {
    throw fail.invalidArgument('A draft question has an unknown type.', {
      ...at,
      allowed: QUESTION_TYPES,
    });
  }

  // Options are the substance of a choice question: required (non-empty, all
  // non-empty strings) for select/multiselect, meaningless - so rejected, not
  // dropped - on every other type.
  const needsOptions = type === 'select' || type === 'multiselect';
  let options: string[] | undefined;
  if (needsOptions) {
    if (!Array.isArray(q.options) || q.options.length === 0) {
      throw fail.invalidArgument(
        'A choice question must offer at least one option.',
        at,
      );
    }
    options = q.options.map((option, index) =>
      draftString(option, `option ${index + 1}`, TEXT_LIMITS.shortText, at),
    );
  } else if (q.options !== undefined && q.options !== null) {
    throw fail.invalidArgument(
      'Only select and multiselect questions may carry options.',
      at,
    );
  }

  const allowsFlagLocation = optionalDraftBoolean(
    q.allowsFlagLocation,
    'allowsFlagLocation flag',
    at,
  );
  const allowsPhotos = optionalDraftBoolean(
    q.allowsPhotos,
    'allowsPhotos flag',
    at,
  );
  const required = optionalDraftBoolean(q.required, 'required flag', at);
  const guidance = optionalDraftString(
    q.guidance,
    'guidance',
    TEXT_LIMITS.freeText,
    at,
  );
  const observation = optionalDraftString(
    q.observation,
    'observation',
    TEXT_LIMITS.freeText,
    at,
  );
  const recommendation = optionalDraftString(
    q.recommendation,
    'recommendation',
    TEXT_LIMITS.freeText,
    at,
  );
  const standardParagraphRef = optionalDraftString(
    q.standardParagraphRef,
    'standard paragraph reference',
    TEXT_LIMITS.shortText,
    at,
  );
  if (standardParagraphRef !== undefined) {
    // Remember WHERE the ref was used so the existence failure can point at it.
    if (!paragraphRefs.has(standardParagraphRef)) {
      paragraphRefs.set(standardParagraphRef, at);
    }
  }

  // RTDB rejects undefined, so optional fields are spread in only when present.
  return {
    id,
    text,
    type: type as QuestionType,
    ...(options !== undefined ? { options } : {}),
    ...(allowsFlagLocation !== undefined ? { allowsFlagLocation } : {}),
    ...(allowsPhotos !== undefined ? { allowsPhotos } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    ...(observation !== undefined ? { observation } : {}),
    ...(recommendation !== undefined ? { recommendation } : {}),
    ...(standardParagraphRef !== undefined ? { standardParagraphRef } : {}),
  };
}

export const publishTemplate = onCall<PublishTemplateInput>(
  callableOptions,
  (request) =>
    runCallable<PublishTemplateResult>(
      createLogger({ fn: 'publishTemplate' }),
      async () => {
        // 1. Attestation, identity, authorisation. Template authoring is an
        // admin capability throughout (drafts, paragraphs, publishing).
        assertAppCheck(request);
        const { uid } = assertAuth(request);
        await assertRateLimit(uid, 'publishTemplate');
        const claims = getClaims(request);
        assertOrgRole(claims, 'admin');
        const { env, paths } = envFor(claims);
        const orgId = claims.orgId;

        const input = assertObject(request.data);
        const templateId = requireString(
          input,
          'templateId',
          TEXT_LIMITS.shortText,
        );

        // 2. Load the draft. Only a draft can be published - there is nothing
        // to promote without one.
        const draftSnap = await db
          .ref(paths.db.templateDraft(orgId, templateId))
          .get();
        if (!draftSnap.exists()) {
          throw fail.notFound('There is no draft to publish for this template.');
        }
        const raw = draftSnap.val() as unknown;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw fail.invalidArgument('The draft is malformed.');
        }
        const draft = raw as Record<string, unknown>;

        // 3. Deep-validate the draft and rebuild the publishable content from
        // the validated fields only (the publish gate, story 2052 AC4).
        const name = draftString(draft.name, 'name', TEXT_LIMITS.shortText, {});
        let standard: ReportStandard | undefined;
        if (draft.standard !== undefined && draft.standard !== null) {
          if (
            typeof draft.standard !== 'string' ||
            !REPORT_STANDARDS.includes(draft.standard as ReportStandard)
          ) {
            throw fail.invalidArgument(
              'The draft names an unknown report standard.',
              { allowed: REPORT_STANDARDS },
            );
          }
          standard = draft.standard as ReportStandard;
        }

        // The template's PDF certificate, merged into every report rendered
        // from this version. Rebuilt field by field like everything else here:
        // the url gets the SAME tenant-boundary check as the org logo, so a
        // published template can never point a report at another tenant's
        // object or at an external host.
        let certificate: TemplateCertificate | undefined;
        if (draft.certificate !== undefined && draft.certificate !== null) {
          if (
            typeof draft.certificate !== 'object' ||
            Array.isArray(draft.certificate)
          ) {
            throw fail.invalidArgument('The draft certificate is malformed.', {
              field: 'certificate',
            });
          }
          const raw = draft.certificate as Record<string, unknown>;
          const url = requireTenantStorageRef(
            draftString(raw.url, 'certificate file', 2048, {}),
            'certificate',
            env,
            orgId,
          );
          const certificateName = draftString(
            raw.name,
            'certificate name',
            TEXT_LIMITS.shortText,
            {},
          );
          if (
            typeof raw.position !== 'string' ||
            !CERTIFICATE_POSITIONS.includes(raw.position as CertificatePosition)
          ) {
            throw fail.invalidArgument(
              'The draft certificate has an unknown position.',
              { field: 'certificate.position', allowed: CERTIFICATE_POSITIONS },
            );
          }
          certificate = {
            url,
            name: certificateName,
            position: raw.position as CertificatePosition,
            // Server-stamped, like every other provenance timestamp: the client
            // does not get to date its own upload.
            uploadedAt:
              typeof raw.uploadedAt === 'number' && Number.isFinite(raw.uploadedAt)
                ? raw.uploadedAt
                : Date.now(),
          };
        }

        if (!Array.isArray(draft.sections) || draft.sections.length === 0) {
          throw fail.invalidArgument(
            'A template must have at least one section.',
          );
        }

        // Ids must be unique: section ids across the template, and question ids
        // GLOBALLY across the template - answers are keyed by question id
        // (/assessmentAnswers/{qid}), so a duplicate would make two questions
        // silently share one answer and corrupt every assessment run against
        // the version.
        const sectionIds = new Set<string>();
        const questionIds = new Set<string>();
        // Every standardParagraphRef used, mapped to where it FIRST appeared,
        // validated in one pass against one library read below.
        const paragraphRefs = new Map<string, Where>();

        const sections: TemplateSection[] = draft.sections.map(
          (rawSection, index) => {
            const where: Where = { sectionIndex: index };
            if (
              rawSection === null ||
              typeof rawSection !== 'object' ||
              Array.isArray(rawSection)
            ) {
              throw fail.invalidArgument('A draft section is malformed.', where);
            }
            const s = rawSection as Record<string, unknown>;
            const id = draftString(
              s.id,
              'section id',
              TEXT_LIMITS.shortText,
              where,
            );
            const at = { ...where, sectionId: id };
            if (sectionIds.has(id)) {
              throw fail.invalidArgument('Two sections share the same id.', at);
            }
            sectionIds.add(id);
            const code = draftString(
              s.code,
              'section code',
              TEXT_LIMITS.shortText,
              at,
            );
            const title = draftString(
              s.title,
              'section title',
              TEXT_LIMITS.shortText,
              at,
            );
            // An empty section is unanswerable dead weight on site - the
            // assessor would face a heading with nothing under it - so it is a
            // publish blocker, not a tolerated oddity.
            if (!Array.isArray(s.questions) || s.questions.length === 0) {
              throw fail.invalidArgument(
                'Every section must contain at least one question.',
                at,
              );
            }
            const questions = s.questions.map((rawQuestion, qIndex) => {
              const question = validateQuestion(
                rawQuestion,
                { ...at, questionIndex: qIndex },
                paragraphRefs,
              );
              if (questionIds.has(question.id)) {
                throw fail.invalidArgument(
                  'Two questions share the same id.',
                  { ...at, questionId: question.id },
                );
              }
              questionIds.add(question.id);
              return question;
            });
            return { id, code, title, questions };
          },
        );

        // 3b. Every standardParagraphRef must point at a REAL entry in the
        // org's Standard Paragraphs library - the AI summary and the report
        // resolve these refs later, and a dangling one would surface as a hole
        // in a released report. One library read validates all of them.
        if (paragraphRefs.size > 0) {
          const librarySnap = await db
            .ref(paths.db.standardParagraphs(orgId))
            .get();
          const library =
            (librarySnap.val() as Keyed<StandardParagraph> | null) ?? {};
          for (const [ref, at] of paragraphRefs) {
            if (!library[ref]) {
              throw fail.invalidArgument(
                'A question references a standard paragraph that does not exist.',
                { ...at, standardParagraphRef: ref },
              );
            }
          }
        }

        // 4. Version and claim. The next version is live + 1 (a brand-new
        // template has no live node yet - first publish is v1). The live node
        // cannot serialise concurrent publishes (pre-existence there is nothing
        // to transact on, and it must stay untouched until the payload), so the
        // claim is a transaction on the ARCHIVE slot for nextVersion instead:
        // it either does not exist (we take it with a placeholder) or it does
        // (a concurrent publish - or one that just completed and bumped the
        // live version after our read - already owns it; abort). Two admins
        // publishing the same template race for the same slot and exactly one
        // wins; the loser gets a clean retryable error.
        const liveRef = db.ref(paths.db.template(orgId, templateId));
        const liveSnap = await liveRef.get();
        const live = liveSnap.val() as Template | null;
        const nextVersion = (live?.version ?? 0) + 1;

        const archiveRef = db.ref(
          paths.db.templateVersion(orgId, templateId, nextVersion),
        );
        const claim = await archiveRef.transaction((current: unknown) => {
          if (current === null) {
            return { publishing: true, claimedAt: Date.now() };
          }
          // A crashed publish (claim landed, payload never did, cleanup also
          // failed) must not brick this version slot forever. A real frozen
          // version always has a sections child; a sections-less value whose
          // claim is older than five minutes is an abandoned placeholder and
          // may be retaken.
          const value = current as Record<string, unknown>;
          const stale =
            typeof current === 'object' &&
            !Array.isArray(value.sections) &&
            typeof value.claimedAt === 'number' &&
            Date.now() - value.claimedAt > CLAIM_STALE_MS;
          return stale
            ? { publishing: true, claimedAt: Date.now() }
            : undefined;
        });
        if (!claim.committed) {
          throw fail.alreadyExists(
            'This template is being published by someone else. Please try again in a moment.',
            { version: nextVersion },
          );
        }

        // 4b. The claim serialises concurrent publishes of the SAME version,
        // but two publishers can both capture the draft before either clears
        // it (the second would re-publish identical content as another
        // version). Re-read the draft post-claim: the content was already
        // deep-validated pre-claim, so only its continued EXISTENCE needs
        // re-checking here - if it is gone, the other publish won.
        const recheckSnap = await db
          .ref(paths.db.templateDraft(orgId, templateId))
          .get();
        if (!recheckSnap.exists()) {
          await archiveRef.remove().catch(() => undefined);
          throw fail.failedPrecondition('This draft has just been published.');
        }

        // 5. ONE multi-location payload update: promote to the live node (the
        // Admin SDK writing over the client-immutable published record - the
        // one place that is allowed to happen), replace the archive placeholder
        // with the same frozen content, clear the draft, append the audit
        // entry. The frozen archive copy IS the live object, so history renders
        // identically to what assessors saw (story 2053).
        const published: Template = {
          name,
          version: nextVersion,
          status: 'published',
          // Stamped on the live node AND the frozen copy: the version history
          // page renders publish dates from this field.
          publishedAt: Date.now(),
          ...(standard !== undefined ? { standard } : {}),
          ...(certificate !== undefined ? { certificate } : {}),
          sections,
        };
        const update: Record<string, unknown> = {
          [paths.db.template(orgId, templateId)]: published,
          [paths.db.templateVersion(orgId, templateId, nextVersion)]: published,
          [paths.db.templateDraft(orgId, templateId)]: null,
          ...activityUpdate(paths, orgId, {
            actorUid: uid,
            action: `template.published (v${nextVersion})`,
            target: templateId,
          }),
        };
        try {
          await db.ref().update(update);
        } catch (error) {
          // The claim landed but the payload did not: best-effort release of
          // the placeholder so a retry can claim the same version, and the
          // original failure is what surfaces (releaseAssessment posture).
          await archiveRef.remove().catch(() => undefined);
          throw error;
        }

        // Counts only - template content (question wording, client references)
        // never enters the logs.
        const questionCount = sections.reduce(
          (total, section) => total + section.questions.length,
          0,
        );
        const logger = createLogger({ fn: 'publishTemplate', orgId });
        logger.info('Template published', {
          templateId,
          version: nextVersion,
          sections: sections.length,
          questions: questionCount,
          paragraphRefs: paragraphRefs.size,
        });
        return { version: nextVersion };
      },
    ),
);
