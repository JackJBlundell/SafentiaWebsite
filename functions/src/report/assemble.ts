// ============================================================================
// Report data assembly - gather the complete report model from RTDB + Storage
// (brief 11, stories 1071-1076). The renderer (render.ts) is given a single,
// fully-resolved model so it does no I/O of its own and stays focused on layout.
//
// Defensiveness is a first-class requirement here (brief 18.3): the data this
// report replaces is inconsistent, and seeded/real records have gaps. Every field
// access is guarded; a missing optional renders as a clearly-marked placeholder
// ("Not recorded") rather than crashing the document or printing "undefined".
// The only HARD precondition is that the assessment itself exists - without it
// there is nothing to report, so the caller surfaces a not-found error.
//
// Images (the building photo, action photos and the flag-location composites)
// are downloaded from Storage HERE into in-memory buffers so the renderer can
// embed them synchronously. A failed download degrades to "image unavailable"
// rather than failing the whole report - one broken object must not block a
// legally-significant document.
// ============================================================================

import { db, storage } from '../admin';
import type { EnvPaths } from '../lib/paths';
import type { Logger } from '../lib/logging';
import { applyBrandingEntitlement, resolvePlanContext } from '../lib/planContext';
import { resolveResponsibleParty } from '../lib/responsibleParty';
import { isEffectiveNotApplicable } from '../lib/assessmentChecks';
import { SEVERITIES } from '../shared/types';
import type {
  Action,
  AnswerFlag,
  Assessment,
  AssessmentAnswer,
  Building,
  Customer,
  FloorPlan,
  Job,
  Keyed,
  MatrixAnswer,
  OrgMember,
  OrgProfile,
  QuestionMatrix,
  QuestionType,
  ReportStandard,
  Severity,
  TemplateCertificate,
  TemplateSection,
} from '../shared/types';

// ----------------------------------------------------------------------------
// The resolved model the renderer consumes. Every field is either a concrete
// value or has a defined "missing" representation, so the renderer never has to
// reason about absence.
// ----------------------------------------------------------------------------

/** An image resolved to bytes for embedding, with its display title. `data` is
 *  undefined when the object could not be fetched, so the renderer shows a clear
 *  "image unavailable" note in its place rather than a blank gap. */
export interface ResolvedImage {
  title: string;
  data?: Buffer;
  /** Retained for diagnostics / the "unavailable" caption; never a raw error. */
  available: boolean;
}

/** One question row in a Section 2 subject table. */
export interface ReportQuestionRow {
  questionText: string;
  /** The answer rendered as display text, or a standardised "not answered" /
   *  "not applicable" string (1073 AC2). */
  answerText: string;
  observation?: string;
  /** Severity letter when the answer is a non-conformity, for styling. */
  severity?: Severity;
  /** The assessor explicitly judged this item NOT APPLICABLE to these premises.
   *
   *  Carried as its own flag rather than inferred from `answerText` because the
   *  two facts it separates are the point of the feature: an item that reads
   *  "Not answered" was never reached, while this one was CONSIDERED and
   *  dismissed on the assessor's judgement. That distinction is what defends the
   *  assessment when the record is examined - an assessor who is asked why a
   *  subject carries no finding can point at a positive decision instead of a
   *  gap - so the renderer marks it rather than leaving it to look like silence.
   *
   *  Never set together with `severity`: a graded answer is a finding and is
   *  rendered as one whatever flag accompanies it (see lib/assessmentChecks). */
  notApplicable?: boolean;
  /** The template's declared question type, so the renderer can present the
   *  answer richly (Yes/No emphasis, choices against options, photo strip) and
   *  fall back to plain text for any unknown/custom type. */
  questionType?: QuestionType;
  /** For select / multiselect: the choices the template offered, so the report
   *  can show the answer in the context of what was available. */
  options?: string[];
  /** For a `matrix` question: the grid the template defined, validated as a
   *  complete rectangle here so the renderer can draw it without re-checking.
   *  Absent when the question is not a matrix or its grid is malformed. */
  matrix?: QuestionMatrix;
  /** The cell the assessor chose, so the renderer can mark it inside the grid.
   *  Absent when the question was not answered or the stored value is malformed;
   *  `answerText` still carries the standard "Not answered" phrase in that case. */
  matrixAnswer?: MatrixAnswer;
  /** Optional guidance the template attached to the question (shown muted). */
  guidance?: string;
  /** Answer photographs, resolved to embeddable bytes (a failed download is
   *  dropped, never fatal - brief 18.3). Rendered as a titled strip under the row. */
  photos?: ResolvedImage[];
  /** The floor-plan composites the assessor pinned against THIS question, one
   *  per plan, in the order they were recorded.
   *
   *  A location can be pinned on ANY question whose template sets
   *  `allowsFlagLocation`, not only on a non-conformity, and only findings ever
   *  became actions - so before this existed a location pinned on a yes/no,
   *  select or photo question was captured, shown in the app, and then silently
   *  absent from the released report. The evidence belongs with the question it
   *  evidences, so it travels on the row.
   *
   *  Unlike `photos`, an UNAVAILABLE composite is kept rather than dropped: the
   *  assessor recorded a location, and a marked "image unavailable" slot tells
   *  the reader that honestly, where silence would not. */
  flagImages?: ResolvedImage[];
}

/** One template subject as its own table (story 1073). The report renders one of
 *  these per section the template declares, in the template's authored order. */
export interface ReportSection {
  code: string;
  title: string;
  rows: ReportQuestionRow[];
}

/** One action in the Section 3 action plan (stories 1057, 1074). */
export interface ReportAction {
  severity: Severity;
  sectionCode: string;
  question: string;
  observation: string;
  responsible: string;
  dueBy?: number;
  lifeProtection: boolean;
  /** EVERY flag-location composite for this finding, embedded at legible size
   *  (1057 / 1074 AC2). A plural list because a building routinely has several
   *  floor plans and one finding can be pinned on more than one of them; the
   *  action record itself only ever cached the first, so these are resolved from
   *  the answer the finding came from wherever that answer is in scope. */
  flagImages: ResolvedImage[];
  /** Other titled images attached to the action (1074 AC2). */
  images: ResolvedImage[];
}

export interface ReportOverview {
  /** The building's own name, printed as "Site" on the cover. */
  siteName: string;
  address: string;
  /** The customer the building belongs to, printed as "Client" on the cover.
   *  Read from the customer record the building points at; the standardised
   *  placeholder when the building, its customer or that record is missing. */
  clientName: string;
  /** The responsible party as one rendered line ("Name (Role)"). Named for what
   *  it holds; the PDF prints it under the statutory heading "Responsible
   *  person" (Regulatory Reform (Fire Safety) Order 2005), which is a legal
   *  term of art and NOT a reference to any stored field. */
  responsiblePartyLine: string;
  article53Persons: string[];
  /** The assessing organisation's contact (from the org profile). */
  orgContactName: string;
  orgContactEmail: string;
  orgContactPhone: string;
  buildingId: string;
  assessmentId: string;
  dateCarriedOut?: number;
  riskLevel: string;
  buildingDetailLines: string[];
  assessmentDetailLines: string[];
}

/** Sign-off provenance from the workflow record (story 1075). */
export interface ReportSignOff {
  conductedBy: string;
  validatedBy: string;
  releasedOn?: number;
  reviewByDate?: number;
}

export interface ReportModel {
  orgProfile: OrgProfile;
  /** The industry standard the assessment's template follows (from the pinned
   *  snapshot), selecting the report profile. Undefined → the generic profile. */
  standard?: ReportStandard;
  /** The organisation's PDF certificate for this template, taken from the PINNED
   *  snapshot so a report always carries the certificate that was attached when
   *  the assessment ran, not whatever the template holds today. Merged into the
   *  rendered document as a post-process (see report/certificate.ts), never
   *  drawn by the renderer. */
  certificate?: TemplateCertificate;
  /** Org logo bytes for the document header, if a logo is set and fetchable. */
  logo?: ResolvedImage;
  /** The organisation's own decorative cover image (OrgProfile.coverImageUrl),
   *  for the cover's top-left panel. Absent is a first-class state: the renderer
   *  paints that panel from the brand colours instead of shipping a stock
   *  photograph. */
  coverImage?: ResolvedImage;
  /** The customer that owns the building, read straight off the building record.
   *  Nothing renders it: it travels with the model so generateAndStore can stamp
   *  the Storage object's customerId metadata - the ONLY grant a portal user has
   *  on the PDF (storage.rules, reports match) - even when the
   *  buildingCustomerIndex entry the stamp normally comes from is missing.
   *  Absent only when the building itself could not be addressed. */
  ownerCustomerId?: string;
  overview: ReportOverview;
  /** The building photo for the overview, if present. */
  buildingPhoto?: ResolvedImage;
  riskDistribution: Building['ragDistribution'];
  riskOpinion?: string;
  narrative: {
    summary?: string;
    buildingDescription?: string;
    premisesCovered?: string;
    incidentHistory?: string;
    riskOpinion?: string;
  };
  sections: ReportSection[];
  actions: ReportAction[];
  signOff: ReportSignOff;
  generatedAt: number;
}

// ----------------------------------------------------------------------------
// Small, defensive formatting helpers. Kept here (not in the renderer) so the
// "what does a missing field look like" decision lives with data assembly.
// ----------------------------------------------------------------------------

/** Standardised placeholder for an absent value - one phrase everywhere. */
const NOT_RECORDED = 'Not recorded';

/** Standardised phrase for an item the assessor judged not applicable. One
 *  phrase everywhere, and deliberately NOT the "Not answered" placeholder: the
 *  report must never present a considered judgement as an unanswered question. */
const NOT_APPLICABLE = 'Not applicable';

/** Trim a string and return undefined if it is empty, so callers can coalesce. */
function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A string field with the standardised placeholder when missing. */
function orNotRecorded(value: unknown): string {
  return clean(value) ?? NOT_RECORDED;
}

/**
 * A uid rendered as the person's name. The workflow stores uids because they are
 * immutable and survive a rename; a REPORT is read by a duty-holder, an insurer
 * or an enforcing authority, so it must carry names.
 *
 * A uid absent from the directory means the member has since been removed from
 * the organisation - their recorded work remains, so it is attributed honestly
 * rather than printed as an opaque identifier or, worse, silently blanked.
 */
function memberName(
  uid: unknown,
  members: Keyed<OrgMember> | null,
): string {
  const id = clean(uid);
  if (!id) {
    return NOT_RECORDED;
  }
  return clean(members?.[id]?.name) ?? 'Former staff member';
}

/** The responsible party as one display line: the party that actually governs
 *  THIS assessment (the visit's own copy when the assessor switched it, else the
 *  building's default), with the role appended when recorded.
 *
 *  Taking the assessment into account is not cosmetic: the whole point of the
 *  assessment-level copy is that a visit can name a different party without
 *  editing the building, and a report that printed the building's party would
 *  silently discard that choice - in the one document that is the legal record
 *  of who was told. The precedence itself is lib/responsibleParty's, shared with
 *  the release pipeline that stamps the same name onto every action. */
function responsiblePartyLine(
  assessment: Assessment,
  building: Building | undefined,
): string | undefined {
  const party = resolveResponsibleParty(assessment, building);
  if (!party) {
    return undefined;
  }
  return party.role ? `${party.name} (${party.role})` : party.name;
}

/**
 * Narrow an answer `value` to a MatrixAnswer. The contract types `value` as
 * `unknown` because one field carries every question type's stored shape, so a
 * matrix answer is shape-checked at runtime rather than trusted: drifted or
 * partially-written data must degrade to "not answered", never print a
 * stringified object into a legally-significant document (brief 18.3).
 */
function asMatrixAnswer(value: unknown): MatrixAnswer | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as { row?: unknown; column?: unknown; outcome?: unknown };
  const row = clean(candidate.row);
  const column = clean(candidate.column);
  const outcome = clean(candidate.outcome);
  if (!row || !column || !outcome) {
    return undefined;
  }
  return { row, column, outcome };
}

/**
 * Accept a template's grid definition only when it is a COMPLETE rectangle:
 * every axis option a non-empty string, and one outcome per row per column. The
 * renderer draws a fixed grid of cells and would otherwise have to reason about
 * ragged data mid-layout, so the shape decision is made once, here, and a
 * malformed grid simply degrades to the answer's display text alone.
 */
function asQuestionMatrix(value: unknown): QuestionMatrix | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<QuestionMatrix>;
  const isLabelList = (list: unknown): list is string[] =>
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((entry) => Boolean(clean(entry)));
  if (!isLabelList(candidate.rows) || !isLabelList(candidate.columns)) {
    return undefined;
  }
  const rows = candidate.rows.map((r) => r.trim());
  const columns = candidate.columns.map((c) => c.trim());
  const rawCells = candidate.cells;
  if (!Array.isArray(rawCells) || rawCells.length !== rows.length) {
    return undefined;
  }
  const cells: string[][] = [];
  for (const rawRow of rawCells) {
    if (!Array.isArray(rawRow) || rawRow.length !== columns.length) {
      return undefined;
    }
    // A blank outcome is tolerated as an empty cell; a non-string is not, since
    // it would print as "[object Object]" inside the grid.
    if (!rawRow.every((cell) => typeof cell === 'string')) {
      return undefined;
    }
    cells.push(rawRow.map((cell) => cell.trim()));
  }

  // Definitions are optional and free-form; keep only string entries so the
  // renderer never has to guard the values it prints.
  const definitions: Record<string, string> = {};
  const rawDefinitions = candidate.definitions;
  if (typeof rawDefinitions === 'object' && rawDefinitions !== null) {
    for (const [term, meaning] of Object.entries(rawDefinitions)) {
      const cleanTerm = clean(term);
      const cleanMeaning = clean(meaning);
      if (cleanTerm && cleanMeaning) {
        definitions[cleanTerm] = cleanMeaning;
      }
    }
  }

  return {
    rowLabel: orNotRecorded(candidate.rowLabel),
    columnLabel: orNotRecorded(candidate.columnLabel),
    rows,
    columns,
    cells,
    ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
  };
}

/**
 * Render a typed answer value as human-readable display text. The answer's
 * `value` is deliberately `unknown` in the contract (callers narrow by question
 * type); here we narrow by JS shape, which covers every question type's stored
 * form without needing the template type for each question. The template's grid
 * is passed for matrix questions only, so the sentence can name the two axes the
 * assessor actually chose between.
 */
function answerToText(
  answer: AssessmentAnswer | undefined,
  matrix?: QuestionMatrix,
): string {
  if (!answer) {
    // Distinct from "not applicable": the assessor did not record an answer.
    return 'Not answered';
  }
  const text = clean(answer.text);
  if (text) {
    return text;
  }
  // "Not applicable" is a RECORDED answer, so it is resolved before the typed
  // value is inspected. It has to be: a non-conformity stores its extras
  // (responsible party, due date, life-protection flag) on `value` as an object,
  // and an object falls through every branch below to "Not answered" - which is
  // the one thing an item the assessor deliberately dismissed must never read
  // as. Literal answer text still wins over it (above), so a recorded answer is
  // never hidden behind the flag.
  if (isEffectiveNotApplicable(answer)) {
    return NOT_APPLICABLE;
  }
  const value = answer.value;
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'string') {
    return clean(value) ?? 'Not answered';
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => String(v)).filter((s) => s.length > 0);
    return items.length > 0 ? items.join(', ') : 'Not answered';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  // A matrix answer is an object, so without this branch it fell through to
  // "Not answered" and the recorded risk level vanished from the report.
  const chosen = asMatrixAnswer(value);
  if (chosen) {
    return matrix
      ? `${chosen.outcome} (${matrix.rowLabel}: ${chosen.row}; ${matrix.columnLabel}: ${chosen.column})`
      : `${chosen.outcome} (${chosen.row} / ${chosen.column})`;
  }
  return 'Not answered';
}

// ----------------------------------------------------------------------------
// Storage download. The admin Storage SDK reads any object regardless of rules
// (it is the trusted server), so the report can embed tenant images the client
// could not list. A failure is caught and degraded, never rethrown.
// ----------------------------------------------------------------------------

/**
 * Download one Storage object to a buffer for embedding. Returns a ResolvedImage
 * whose `data` is set on success and absent on any failure (missing object,
 * permissions, transient error), so one broken image never fails the report
 * (brief 18.3). The path comes from the data model, which itself came from the
 * tenant-scoped path builders, so we never address outside the tenant.
 */
async function resolveImage(
  storagePath: string | undefined,
  title: string,
  logger: Logger,
): Promise<ResolvedImage | undefined> {
  const path = clean(storagePath);
  if (!path) {
    return undefined;
  }
  try {
    const [data] = await storage.bucket().file(path).download();
    return { title, data, available: true };
  } catch (caught) {
    // Degrade, do not fail. The renderer prints "image unavailable" in its place.
    logger.warn('Report image could not be downloaded; degrading gracefully', {
      reason: caught instanceof Error ? caught.message : String(caught),
    });
    return { title, available: false };
  }
}

/**
 * A flag composite is stored against an answer/action as a download URL or a
 * Storage path. The action contract carries `locationFlagUrl`; we accept either
 * a gs:// path, an https download URL, or a bare object path and reduce it to the
 * object path the admin SDK downloads. Anything we cannot parse degrades to "no
 * image", consistent with the rest of assembly.
 */
function toObjectPath(urlOrPath: string | undefined): string | undefined {
  const value = clean(urlOrPath);
  if (!value) {
    return undefined;
  }
  // gs://bucket/object/path -> object/path
  if (value.startsWith('gs://')) {
    const withoutScheme = value.slice('gs://'.length);
    const slash = withoutScheme.indexOf('/');
    return slash >= 0 ? withoutScheme.slice(slash + 1) : undefined;
  }
  // Firebase download URL: .../o/<url-encoded-path>?... -> decoded path
  const oMarker = '/o/';
  const oIndex = value.indexOf(oMarker);
  if (oIndex >= 0) {
    const after = value.slice(oIndex + oMarker.length);
    const queryIndex = after.indexOf('?');
    const encoded = queryIndex >= 0 ? after.slice(0, queryIndex) : after;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  }
  // Otherwise treat it as a bare object path already.
  return value;
}

// ----------------------------------------------------------------------------
// Flagged locations. `answer.flags` is the SOURCE OF TRUTH for where an assessor
// pinned something: one entry per floor plan, each carrying the flattened
// plan-plus-pins composite. An action's `locationFlagUrl` is a denormalised copy
// of the first of them, so the report reads the flags themselves wherever it can
// and falls back to that copy only for actions whose answer is out of scope.
// ----------------------------------------------------------------------------

/**
 * Caption one composite so a reader can tell the plans apart. The plan's own
 * name is used when the building still declares that plan; a plan since deleted
 * (or a flag written before the plan was named) falls back to its position, so
 * the caption is always meaningful and never prints a raw id.
 *
 * `prefix` says what kind of evidence this is, because the caption is the only
 * thing distinguishing a pinned plan from a photograph in the same strip.
 */
function flagCaption(
  planName: string | undefined,
  prefix: string,
  index: number,
  total: number,
): string {
  const position = total > 1 ? ` (${index + 1} of ${total})` : '';
  return planName ? `${prefix}: ${planName}${position}` : `${prefix}${position}`;
}

/**
 * Resolve every composite on an answer's flags to embeddable bytes, in the order
 * recorded. Flags with no composite at all (a pin set saved before the flatten
 * finished, or a PDF plan the app annotates without flattening) are skipped -
 * there is nothing to draw for them - but a composite that FAILS to download is
 * kept as an unavailable image, so the report says the location was recorded and
 * the picture could not be attached rather than saying nothing.
 */
async function resolveFlagImages(
  flags: AnswerFlag[] | undefined,
  planNames: Map<string, string>,
  prefix: string,
  logger: Logger,
): Promise<ResolvedImage[]> {
  const usable = (Array.isArray(flags) ? flags : []).filter(
    (flag): flag is AnswerFlag => Boolean(toObjectPath(flag?.flagImageUrl)),
  );
  return Promise.all(
    usable.map(async (flag, index) => {
      const caption = flagCaption(
        clean(planNames.get(clean(flag.planId) ?? '')),
        prefix,
        index,
        usable.length,
      );
      // resolveImage only returns undefined for an empty path, which the filter
      // above has already excluded; the coalesce is belt and braces so the
      // caller never has to reason about a hole in the list.
      return (
        (await resolveImage(toObjectPath(flag.flagImageUrl), caption, logger)) ?? {
          title: caption,
          available: false,
        }
      );
    }),
  );
}

/** The building's floor plans as planId -> display name, for flag captions. An
 *  unaddressable building or an absent /floorPlans node simply yields an empty
 *  map and every caption falls back to its position. */
function planNameIndex(plans: Keyed<FloorPlan> | null): Map<string, string> {
  const index = new Map<string, string>();
  for (const [planId, plan] of Object.entries(plans ?? {})) {
    const name = clean(plan?.name);
    if (name) {
      index.set(planId, name);
    }
  }
  return index;
}

// ----------------------------------------------------------------------------
// Section 2 assembly: the template's OWN subjects, in authored order, each a
// table of its questions.
// ----------------------------------------------------------------------------

/**
 * Build the ordered subject tables from the assessment's pinned template snapshot
 * and the captured answers. Templates are fully customisable (PAS 79 = 12 subjects
 * '01'..'12'; BS 9792 Housing = ~30; custom = any codes, any count), so we iterate
 * the template's OWN sections in their AUTHORED order and render exactly those -
 * never a fixed global 01..12 set. Authored order is the source of truth (the base
 * templates already declare their sections in report order); we do not reorder or
 * synthesize "not included" subjects. For PAS 79, whose snapshot lists all 12
 * sections in order '01'..'12' with titles, this produces output identical to the
 * previous SECTION_CODES-driven pass. Within a section we render the template's
 * questions in their authored order, pairing each with its answer (or the standard
 * "not answered" placeholder).
 */
async function buildSections(
  templateSections: TemplateSection[] | undefined,
  answers: Keyed<AssessmentAnswer>,
  planNames: Map<string, string>,
  logger: Logger,
): Promise<ReportSection[]> {
  const sections = Array.isArray(templateSections) ? templateSections : [];

  const result: ReportSection[] = [];
  for (const section of sections) {
    if (!section || typeof section.code !== 'string') {
      // Skip a malformed section entry rather than crash the document (18.3).
      continue;
    }

    const questions = Array.isArray(section.questions) ? section.questions : [];
    const rows: ReportQuestionRow[] = await Promise.all(
      questions.map(async (question) => {
        const answer = question?.id ? answers[question.id] : undefined;
        // The grid belongs to a matrix question only; validating it up front lets
        // both the answer sentence and the drawn grid share one checked shape.
        const matrix =
          question?.type === 'matrix' ? asQuestionMatrix(question.matrix) : undefined;
        const row: ReportQuestionRow = {
          questionText: orNotRecorded(question?.text),
          answerText: answerToText(answer, matrix),
        };
        if (matrix) {
          row.matrix = matrix;
          const chosen = asMatrixAnswer(answer?.value);
          if (chosen) {
            row.matrixAnswer = chosen;
          }
        }
        // Carry the template's declared type + options so the renderer can present
        // the answer richly; unknown/absent types fall back to the plain text above.
        if (question?.type) {
          row.questionType = question.type;
        }
        if (Array.isArray(question?.options) && question.options.length > 0) {
          row.options = question.options.filter(
            (o): o is string => typeof o === 'string',
          );
        }
        const guidance = clean(question?.guidance);
        if (guidance) {
          row.guidance = guidance;
        }
        const observation = clean(answer?.observation);
        if (observation) {
          row.observation = observation;
        }
        if (answer?.severity && SEVERITIES.includes(answer.severity)) {
          row.severity = answer.severity;
        }
        // Mutually exclusive with the severity above by the same precedence the
        // rest of the pipeline applies: a graded answer is a finding and is
        // styled as one, so the N/A mark is only carried when there is no grade.
        if (isEffectiveNotApplicable(answer)) {
          row.notApplicable = true;
        }
        // Resolve any answer photographs to embeddable bytes. Each download
        // degrades independently; an unavailable photo is simply dropped here so
        // the row still renders (brief 18.3).
        const rawPhotos = Array.isArray(answer?.photos) ? answer.photos : [];
        if (rawPhotos.length > 0) {
          const resolved = await Promise.all(
            // Reduce to an object path first: like action images, a stored photo
            // may be a gs:// path, an https download URL, or a bare object path.
            rawPhotos.map((p) =>
              resolveImage(toObjectPath(p?.path), orNotRecorded(p?.title), logger),
            ),
          );
          const usable = resolved.filter(
            (r): r is ResolvedImage => Boolean(r) && r!.available,
          );
          if (usable.length > 0) {
            row.photos = usable;
          }
        }
        // Every location the assessor pinned against this question, whatever its
        // type. Findings ALSO carry theirs into the action plan; see
        // renderActionCard for why that repetition is deliberate.
        const flagImages = await resolveFlagImages(
          answer?.flags,
          planNames,
          'Flagged location',
          logger,
        );
        if (flagImages.length > 0) {
          row.flagImages = flagImages;
        }
        return row;
      }),
    );

    result.push({
      code: section.code,
      title: orNotRecorded(section.title) === NOT_RECORDED
        ? subjectTitleFallback(section.code)
        : section.title,
      rows:
        rows.length > 0
          ? rows
          : [
              {
                questionText: 'No questions were recorded for this subject.',
                answerText: 'Not applicable',
              },
            ],
    });
  }
  return result;
}

/** Canonical PAS 79 subject titles, used when a template omits a section title so
 *  the report still reads to industry standard (brief 10.1). */
function subjectTitleFallback(code: string): string {
  const titles: Record<string, string> = {
    '01': 'Persons at Risk',
    '02': 'Sources of Ignition',
    '03': 'Sources of Fuel',
    '04': 'Construction',
    '05': 'Means of Escape',
    '06': 'Fire-fighting Equipment',
    '07': 'Fire Detection and Warning',
    '08': 'Emergency Lighting',
    '09': "Firefighters' Provisions",
    '10': 'Management',
    '11': 'Signs and Signals',
    '12': 'Effects on the Environment',
  };
  return titles[code] ?? `Subject ${code}`;
}

// ----------------------------------------------------------------------------
// Section 3 assembly: actions ordered high -> low severity, with images resolved.
// ----------------------------------------------------------------------------

/** Sort weight so High sorts before Medium before Low (story 1074 AC1). */
const SEVERITY_RANK: Record<Severity, number> = { H: 0, M: 1, L: 2 };

/**
 * Index the pinned template snapshot so an action can be traced back to the
 * answer it was raised from, and therefore to ALL the locations pinned on that
 * finding rather than the single one the action cached.
 *
 * An action records the section code and the question TEXT, both copied verbatim
 * from this same snapshot when the assessment was released, so the pair
 * addresses the question exactly. A pair that is NOT unique within the snapshot
 * (two questions in one section worded identically) maps to `null`: an ambiguous
 * match would attach one finding's locations to another's, and in this document
 * a wrong location is worse than a missing one, so the join declines instead.
 */
function findingKey(sectionCode: string, questionText: string): string {
  // A NUL separator cannot occur in either half, so no code/text pair can
  // collide with a different pair by concatenation alone.
  return `${sectionCode}\u0000${questionText}`;
}

function buildFindingIndex(
  templateSections: TemplateSection[] | undefined,
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const section of Array.isArray(templateSections) ? templateSections : []) {
    const code = clean(section?.code);
    if (!code) {
      continue;
    }
    for (const question of Array.isArray(section?.questions) ? section.questions : []) {
      const text = clean(question?.text);
      const id = clean(question?.id);
      if (!text || !id) {
        continue;
      }
      const key = findingKey(code, text);
      index.set(key, index.has(key) ? null : id);
    }
  }
  return index;
}

/** The answer an action was raised from, or undefined when it cannot be traced
 *  unambiguously. Actions on a building span every assessment ever run against
 *  it, so an action from a DIFFERENT assessment is never joined: its answers are
 *  not loaded here, and matching on question text alone would cross visits. */
function answerForAction(
  action: Action,
  assessmentId: string,
  findingIndex: Map<string, string | null>,
  answers: Keyed<AssessmentAnswer>,
): AssessmentAnswer | undefined {
  if (clean(action.assessmentId) !== assessmentId) {
    return undefined;
  }
  const code = clean(action.sectionCode);
  const text = clean(action.question);
  if (!code || !text) {
    return undefined;
  }
  const questionId = findingIndex.get(findingKey(code, text));
  return questionId ? answers[questionId] : undefined;
}

async function buildActions(
  actionsMap: Keyed<Action>,
  assessmentId: string,
  answers: Keyed<AssessmentAnswer>,
  templateSections: TemplateSection[] | undefined,
  planNames: Map<string, string>,
  logger: Logger,
): Promise<ReportAction[]> {
  const findingIndex = buildFindingIndex(templateSections);

  const entries = Object.values(actionsMap).filter(
    // An archived action is no longer part of the live remedial plan; open and
    // signed-off both belong in the report (signed-off shows progress).
    (action): action is Action => Boolean(action) && action.status !== 'archived',
  );

  // Order high -> low. Within equal severity, keep a stable, deterministic order
  // by section code so the same data always renders identically (brief 18.2).
  // Defensive ranks: an action whose severity is not L/M/H (custom/drifted data,
  // brief 18.3) still sorts deterministically (after the known severities) rather
  // than producing a NaN comparison.
  const rankOf = (s: Severity): number => SEVERITY_RANK[s] ?? 3;
  entries.sort((a, b) => {
    const bySeverity = rankOf(a.severity) - rankOf(b.severity);
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return String(a.sectionCode).localeCompare(String(b.sectionCode));
  });

  // Resolve every action's images. We do this concurrently per action but await
  // the lot, so the renderer receives fully-resolved buffers and stays sync.
  return Promise.all(
    entries.map(async (action) => {
      // Prefer the answer's own flags: they carry EVERY plan the finding was
      // pinned on, whereas `locationFlagUrl` is a cache of the first one. The
      // cached url is the fallback for an action this report cannot trace back
      // to an answer (raised in an earlier assessment of the same building, or
      // added to the plan by hand), where it is the only location on record.
      const answer = answerForAction(action, assessmentId, findingIndex, answers);
      const fromAnswer = await resolveFlagImages(
        answer?.flags,
        planNames,
        'Location of finding',
        logger,
      );
      const flagImages =
        fromAnswer.length > 0
          ? fromAnswer
          : await resolveFlagImages(
              [{ planId: '', pins: [], flagImageUrl: action.locationFlagUrl ?? '' }],
              planNames,
              'Location of finding',
              logger,
            );

      const images: ResolvedImage[] = [];
      const rawImages = Array.isArray(action.images) ? action.images : [];
      for (const image of rawImages) {
        const resolved = await resolveImage(
          image?.path,
          orNotRecorded(image?.title),
          logger,
        );
        if (resolved) {
          images.push(resolved);
        }
      }

      const reportAction: ReportAction = {
        severity: action.severity,
        sectionCode: orNotRecorded(action.sectionCode),
        question: orNotRecorded(action.question),
        observation: orNotRecorded(action.observation),
        responsible: orNotRecorded(action.responsible),
        lifeProtection: action.lifeProtection === true,
        flagImages,
        images,
      };
      if (typeof action.dueBy === 'number' && Number.isFinite(action.dueBy)) {
        reportAction.dueBy = action.dueBy;
      }
      return reportAction;
    }),
  );
}

// ----------------------------------------------------------------------------
// Top-level assembly.
// ----------------------------------------------------------------------------

/** Read a node and return its typed value or null - one guarded read everywhere. */
async function readValue<T>(path: string): Promise<T | null> {
  const snap = await db.ref(path).get();
  return snap.exists() ? (snap.val() as T) : null;
}

/**
 * Assemble the full report model for an assessment. Throws only when the
 * assessment is missing (the single hard precondition); every other gap is
 * tolerated and rendered as a marked placeholder.
 */
export async function assembleReport(
  paths: EnvPaths,
  orgId: string,
  assessmentId: string,
  logger: Logger,
): Promise<ReportModel> {
  // 1. The assessment is mandatory.
  const assessment = await readValue<Assessment>(
    paths.db.assessment(orgId, assessmentId),
  );
  if (!assessment) {
    // Caller maps this to a structured not-found; assembly does not import errors
    // so it stays a pure-ish data module. A plain Error is enough as a signal.
    throw new Error(`Assessment not found: ${assessmentId}`);
  }

  // 2. The job carries the building's siteId (buildings are keyed by site), so we
  // need it to address the building. Tolerate its absence.
  const job = assessment.jobId
    ? await readValue<Job>(paths.db.job(orgId, assessment.jobId))
    : null;

  // 3. Building (under its site). Without the job's siteId we cannot address it,
  // so we degrade the building-derived fields to placeholders.
  const building =
    job?.siteId && assessment.buildingId
      ? await readValue<Building>(
          paths.db.building(orgId, job.siteId, assessment.buildingId),
        )
      : null;

  // 4. Answers, actions, floor plans, org profile - each read defensively,
  // defaulting to empty.
  const [answers, actionsMap, floorPlans, orgProfile, orgMembers] = await Promise.all([
    readValue<Keyed<AssessmentAnswer>>(
      paths.db.assessmentAnswers(orgId, assessmentId),
    ),
    assessment.buildingId
      ? readValue<Keyed<Action>>(paths.db.actions(orgId, assessment.buildingId))
      : Promise.resolve(null),
    // The plans exist only to NAME the flag composites in their captions, so an
    // absent node costs nothing beyond a positional caption.
    assessment.buildingId
      ? readValue<Keyed<FloorPlan>>(
          paths.db.floorPlans(orgId, assessment.buildingId),
        )
      : Promise.resolve(null),
    readValue<OrgProfile>(paths.db.orgProfile(orgId)),
    // The staff directory, so the sign-off block can print the PEOPLE who
    // conducted, checked and validated the assessment. The workflow records
    // uids (immutable, and they survive a rename); a report that prints those
    // is unreadable to the duty-holder it is written for.
    readValue<Keyed<OrgMember>>(paths.db.orgMembers(orgId)),
  ]);

  // The org profile drives branding; if it is somehow missing we still produce a
  // report under a neutral default rather than failing (brief 18.3).
  const storedProfile: OrgProfile = orgProfile ?? {
    name: 'Fire Risk Assessment',
    brand: { primary: '#1F2937', secondary: '#6B7280' },
  };

  // Branding is a plan feature (Phase 3 §6): without it the stored logo,
  // colours, cover image and font are retained in RTDB but NOT applied
  // (§6.3), so the report renders under the platform defaults - the same
  // single choke point the email path applies in lib/templatedEmail. Resolved
  // here, before the image fetches below, so a gated logo/cover is never even
  // downloaded. A failed billing read degrades to the profile as stored (the
  // grandfather posture): a report must never lose its branding over a
  // billing-node hiccup.
  let profile = storedProfile;
  try {
    const { entitlements } = await resolvePlanContext(paths, orgId);
    profile = applyBrandingEntitlement(storedProfile, entitlements);
  } catch (error) {
    logger.warn('Plan context read failed; report renders the stored branding', {
      orgId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 5. Resolve embedded images (logo, cover image, building photo) and the
  // owning customer concurrently. Every one of them degrades to a placeholder:
  // the cover is designed around each being absent.
  const [logo, coverImage, buildingPhoto, customer] = await Promise.all([
    resolveImage(toObjectPath(profile.logoUrl), profile.name, logger),
    resolveImage(toObjectPath(profile.coverImageUrl), profile.name, logger),
    resolveImage(toObjectPath(building?.photoUrl), 'Building', logger),
    clean(building?.customerId)
      ? readValue<Customer>(paths.db.customer(orgId, building!.customerId))
      : Promise.resolve(null),
  ]);

  // 6. Build the overview from the schema only - nothing hand-entered at render
  // time (1071 AC1).
  const overview = buildOverview(
    assessment,
    building,
    profile,
    assessmentId,
    customer,
  );

  // 7. Sections + actions. Both caption their flag composites from the same plan
  // index, so one plan reads identically wherever it appears in the document.
  const planNames = planNameIndex(floorPlans);
  const sections = await buildSections(
    assessment.templateSnapshot?.sections,
    answers ?? {},
    planNames,
    logger,
  );
  const actions = await buildActions(
    actionsMap ?? {},
    assessmentId,
    answers ?? {},
    assessment.templateSnapshot?.sections,
    planNames,
    logger,
  );

  // 8. Sign-off provenance from the workflow record (story 1075).
  const signOff = buildSignOff(assessment, building, orgMembers);

  return {
    orgProfile: profile,
    ...(assessment.templateSnapshot?.standard
      ? { standard: assessment.templateSnapshot.standard }
      : {}),
    ...(assessment.templateSnapshot?.certificate
      ? { certificate: assessment.templateSnapshot.certificate }
      : {}),
    ...(logo ? { logo } : {}),
    ...(coverImage ? { coverImage } : {}),
    ...(clean(building?.customerId)
      ? { ownerCustomerId: clean(building?.customerId) }
      : {}),
    overview,
    ...(buildingPhoto ? { buildingPhoto } : {}),
    riskDistribution: building?.ragDistribution,
    ...(clean(assessment.narrative?.riskOpinion)
      ? { riskOpinion: clean(assessment.narrative?.riskOpinion) }
      : {}),
    narrative: {
      summary: clean(assessment.narrative?.summary),
      buildingDescription: clean(assessment.narrative?.buildingDescription),
      premisesCovered: clean(assessment.narrative?.premisesCovered),
      incidentHistory: clean(assessment.narrative?.incidentHistory),
      riskOpinion: clean(assessment.narrative?.riskOpinion),
    },
    sections,
    actions,
    signOff,
    generatedAt: Date.now(),
  };
}

/** Build the overview block from schema fields, with placeholders for gaps. */
function buildOverview(
  assessment: Assessment,
  building: Building | null,
  profile: OrgProfile,
  assessmentId: string,
  customer: Customer | null,
): ReportOverview {
  const article53 = Array.isArray(building?.article53Persons)
    ? building!.article53Persons.map((p) => clean(p)).filter((p): p is string => Boolean(p))
    : [];

  // Building detail lines, each omitted when its source field is absent so the
  // overview never prints "Floors: Not recorded" noise for fields the org leaves
  // blank; only present facts are listed.
  const detailLines: string[] = [];
  const details = building?.details;
  if (details) {
    if (typeof details.area === 'number') {
      detailLines.push(`Approximate floor area: ${details.area} m2`);
    }
    if (typeof details.floors === 'number') {
      detailLines.push(`Number of floors: ${details.floors}`);
    }
    if (typeof details.occupiedFloors === 'number') {
      detailLines.push(`Occupied floors: ${details.occupiedFloors}`);
    }
    if (typeof details.occupants === 'number') {
      detailLines.push(`Typical number of occupants: ${details.occupants}`);
    }
    if (typeof details.isLandlord === 'boolean') {
      detailLines.push(
        `Landlord responsibility: ${details.isLandlord ? 'Yes' : 'No'}`,
      );
    }
    if (clean(details.alarmType)) {
      detailLines.push(`Fire alarm type: ${clean(details.alarmType)}`);
    }
    if (clean(details.alarmCategory)) {
      detailLines.push(`Fire alarm category: ${clean(details.alarmCategory)}`);
    }
  }

  // Assessment detail lines.
  const assessmentLines: string[] = [];
  assessmentLines.push(`Assessment status: ${orNotRecorded(assessment.status)}`);
  if (assessment.templateSnapshot?.name) {
    assessmentLines.push(
      `Methodology: ${orNotRecorded(assessment.templateSnapshot.name)} (version ${
        assessment.templateSnapshot.version ?? 'unknown'
      })`,
    );
  }

  return {
    siteName: orNotRecorded(building?.name),
    address: orNotRecorded(building?.address),
    clientName: orNotRecorded(customer?.name),
    // A missing building degrades to "not recorded"; null (RTDB absent) and
    // undefined mean the same thing to the line builder.
    responsiblePartyLine: orNotRecorded(
      responsiblePartyLine(assessment, building ?? undefined),
    ),
    article53Persons: article53,
    orgContactName: orNotRecorded(profile.contact?.name),
    orgContactEmail: orNotRecorded(profile.contact?.email),
    orgContactPhone: orNotRecorded(profile.contact?.phone),
    buildingId: orNotRecorded(assessment.buildingId),
    assessmentId,
    ...(typeof assessment.conductedAt === 'number'
      ? { dateCarriedOut: assessment.conductedAt }
      : {}),
    riskLevel: orNotRecorded(building?.riskLevel),
    buildingDetailLines: detailLines,
    assessmentDetailLines: assessmentLines,
  };
}

/**
 * Build the sign-off block. The review-by date is the building's statutory FRA
 * review next-due where recorded (the industry-standard "review by" date); we
 * read it from the service schedule rather than inventing a window, so the date
 * is sourced from the schema (story 1075 AC2).
 */
function buildSignOff(
  assessment: Assessment,
  building: Building | null,
  members: Keyed<OrgMember> | null,
): ReportSignOff {
  const workflow = assessment.workflow;
  const reviewBy = building?.serviceSchedule?.fraReview?.nextDue;
  return {
    conductedBy: memberName(assessment.conductedBy, members),
    validatedBy: memberName(workflow?.validatedBy, members),
    ...(typeof workflow?.releasedAt === 'number'
      ? { releasedOn: workflow.releasedAt }
      : {}),
    ...(typeof reviewBy === 'number' ? { reviewByDate: reviewBy } : {}),
  };
}
