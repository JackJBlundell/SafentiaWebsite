// ============================================================================
// AnswerCard - one question of the assessment review, rendered read-only with
// full fidelity for every question type in the capture model (FR-E18 surface B).
//
// The question comes from the assessment's EMBEDDED templateSnapshot - never
// the live template - so the review shows exactly what the assessor was asked,
// even if the template has since changed. The answer is presented by type:
//   text/longtext  the words, whitespace preserved for longtext
//   yesno          the answer word ("Yes" / "No")
//   select         the chosen option
//   multiselect    the chosen options as a list
//   photo          a thumbnail grid, each opening full size in a new tab
//   nonConformity  a severity-chipped finding rendered from the SAME structured
//                  value releaseAssessment reads: the finding's own responsible
//                  party and due date (labelled defaults where it has none),
//                  the Life Protection marker from value.lifeProtection, and an
//                  explicit line when the assessor marked no action required
// An unanswered question says so honestly rather than rendering blank.
//
// Photos and flag composites store Storage object paths (seed data stores full
// URLs); useStorageUrl resolves either into a tokened URL for the signed-in
// member, the DocumentsPanel pattern.
//
// Flagging: while the assessment is readyForValidation the auditor can open an
// inline "Request more information" composer per question; the draft lives in
// the review's flag basket (single source), so edits here, in the basket
// aside are the same edit. In infoRequired the card instead shows the open
// InfoRequest as a read-only thread - the auditor's message, and the
// assessor's response once present.
// ============================================================================

import { useId } from 'react';
import { useStoredFileUrl as useStorageUrl } from '../lib/useStoredFileUrl';
import { Button } from '../../components/Button';
import { severityPresentation } from '../../design/rag';
import { useTheme } from '../../design/ThemeProvider';
import {
  DUE_WINDOW_DAYS,
  type AnswerFlag,
  type AnswerPhoto,
  type AssessmentAnswer,
  type MatrixAnswer,
  type ResponsibleParty,
  type Severity,
  type TemplateQuestion,
} from '../../types';
import styles from './AnswerCard.module.css';

/** One photo: a thumbnail that is a real link opening full size in a new tab. */
function PhotoThumb({ photo }: { photo: AnswerPhoto }) {
  const { url, failed } = useStorageUrl(photo.path);
  if (failed) {
    return (
      <span className={styles.photoError}>
        Photo unavailable: {photo.title || 'untitled'}
      </span>
    );
  }
  if (!url) {
    return (
      <span className={styles.photoPending} role="status">
        Loading photo: {photo.title || 'untitled'}
      </span>
    );
  }
  return (
    <a
      className={styles.photoLink}
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open photo full size in a new tab: ${photo.title || 'untitled photo'}`}
    >
      <img className={styles.photoImg} src={url} alt={photo.title || 'Assessment photo'} />
      {photo.title && <span className={styles.photoTitle}>{photo.title}</span>}
    </a>
  );
}

/** The flattened plan-plus-pins composite for a flagged location. */
function FlagComposite({ flag }: { flag: AnswerFlag }) {
  const { url, failed } = useStorageUrl(flag.flagImageUrl);
  const pinCount = flag.pins?.length ?? 0;
  const caption = `Flagged location on the floor plan (${pinCount} ${pinCount === 1 ? 'pin' : 'pins'})`;
  if (failed) {
    return (
      <span className={styles.photoError}>Flagged-location plan unavailable</span>
    );
  }
  if (!url) {
    return (
      <span className={styles.photoPending} role="status">
        Loading flagged-location plan
      </span>
    );
  }
  return (
    <a
      className={styles.photoLink}
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open the flagged-location plan full size in a new tab`}
    >
      <img className={styles.photoImg} src={url} alt={caption} />
      <span className={styles.photoTitle}>{caption}</span>
    </a>
  );
}

// ----------------------------------------------------------------------------
// Severity chip - fixed safety colour plus the word, never colour alone.
// ----------------------------------------------------------------------------

export function SeverityChip({ severity }: { severity: Severity }) {
  const { theme } = useTheme();
  const rag = severityPresentation(theme, severity);
  return (
    <span
      className={styles.severityChip}
      style={{ color: rag.color, background: rag.surface }}
    >
      <span aria-hidden="true">{rag.icon}</span>
      {rag.label}
    </span>
  );
}

// ----------------------------------------------------------------------------
// Answered / unanswered - one definition, shared with the progress summary.
// ----------------------------------------------------------------------------

/** An answer node counts as answered when it carries any captured substance.
 *  Presence of an empty node (or only an infoRequest) is not an answer. */
export function isAnswered(answer: AssessmentAnswer | undefined): boolean {
  if (!answer) {
    return false;
  }
  return (
    answer.text !== undefined ||
    answer.value !== undefined ||
    (answer.photos?.length ?? 0) > 0 ||
    answer.severity !== undefined ||
    answer.observation !== undefined
  );
}

// ----------------------------------------------------------------------------
// The typed, read-only answer body.
// ----------------------------------------------------------------------------

/** The structured non-conformity value, parsed EXACTLY as releaseAssessment's
 *  readNonConformityValue parses it server-side - the card must show what the
 *  release will actually write, so the two must never drift apart. */
export function readNonConformityValue(answer: AssessmentAnswer): {
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

/** The stored value of a matrix answer, or null when the answer predates the
 *  grid or is malformed - the card falls back to whatever text it carries
 *  rather than rendering three empty rows. */
function readMatrixValue(answer: AssessmentAnswer): MatrixAnswer | null {
  const value = answer.value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (
      typeof v.row === 'string' &&
      typeof v.column === 'string' &&
      typeof v.outcome === 'string'
    ) {
      return { row: v.row, column: v.column, outcome: v.outcome };
    }
  }
  return null;
}

/** British date for a finding's own due date: "12 June 2026". */
const dueDateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function responsiblePartyLine(party: ResponsibleParty): string {
  return party.role ? `${party.name} (${party.role})` : party.name;
}

/** Where an inherited responsible party was resolved from, so the card names
 *  the source instead of implying one: an assessment recorded before the
 *  server started stamping its own copy inherits the BUILDING's party, and an
 *  auditor reading "assessment default" for a value the assessment does not
 *  hold would be reading a lie. */
export type ResponsiblePartySource = 'assessment' | 'building';
const RESPONSIBLE_SOURCE_LABEL: Record<ResponsiblePartySource, string> = {
  assessment: 'assessment default',
  building: 'building default',
};

/** A responsible party a finding inherits when it records none of its own,
 *  paired with the level it came from. Resolved ONCE by the review (which
 *  already holds both the assessment and the building) and handed down, so the
 *  console never grows a second, drifting copy of that resolution order. */
export interface InheritedResponsibleParty {
  party: ResponsibleParty;
  source: ResponsiblePartySource;
}

function AnswerBody({
  question,
  answer,
  responsibleParty,
}: {
  question: TemplateQuestion;
  answer: AssessmentAnswer;
  responsibleParty?: InheritedResponsibleParty;
}) {
  switch (question.type) {
    case 'text':
      return <p className={styles.answerText}>{answer.text ?? String(answer.value ?? '')}</p>;
    case 'longtext':
      return (
        <p className={`${styles.answerText} ${styles.longText}`}>
          {answer.text ?? String(answer.value ?? '')}
        </p>
      );
    case 'yesno': {
      const word =
        answer.value === true ? 'Yes' : answer.value === false ? 'No' : answer.text ?? '';
      return <p className={styles.answerWord}>{word}</p>;
    }
    case 'select':
      return (
        <p className={styles.answerText}>
          {typeof answer.value === 'string' ? answer.value : answer.text ?? ''}
        </p>
      );
    case 'multiselect': {
      const chosen = Array.isArray(answer.value)
        ? (answer.value as unknown[]).map(String)
        : answer.text
          ? [answer.text]
          : [];
      return (
        <ul className={styles.optionList} aria-label={`Selected options for: ${question.text}`}>
          {chosen.map((option) => (
            <li key={option} className={styles.optionItem}>
              {option}
            </li>
          ))}
        </ul>
      );
    }
    case 'matrix': {
      // One cell was chosen, which fixed all three facts at once; the reviewer
      // needs each of them named, not just the outcome word, or the risk level
      // cannot be checked against the grid the assessor was shown.
      const chosen = readMatrixValue(answer);
      if (!chosen) {
        return <p className={styles.answerText}>{answer.text ?? ''}</p>;
      }
      return (
        <dl className={styles.findingFacts}>
          <div className={styles.findingFact}>
            <dt>{question.matrix?.rowLabel?.trim() || 'Row'}</dt>
            <dd>{chosen.row}</dd>
          </div>
          <div className={styles.findingFact}>
            <dt>{question.matrix?.columnLabel?.trim() || 'Column'}</dt>
            <dd>{chosen.column}</dd>
          </div>
          <div className={styles.findingFact}>
            <dt>Outcome</dt>
            <dd>{chosen.outcome}</dd>
          </div>
        </dl>
      );
    }
    case 'photo':
      // The photos themselves are the answer; the shared photo grid below the
      // body renders them for every type, so nothing extra is needed here.
      return null;
    case 'nonConformity': {
      // The finding's own structured value is what releaseAssessment reads;
      // the card presents THOSE fields, falling back to the labelled defaults
      // only where the finding carries none of its own.
      const extras = readNonConformityValue(answer);
      return (
        <div className={styles.finding}>
          <div className={styles.findingHead}>
            {answer.severity && <SeverityChip severity={answer.severity} />}
            {extras.lifeProtection === true && (
              <span className={styles.ltp}>
                <span aria-hidden="true">+</span> Life Protection
              </span>
            )}
          </div>
          <p className={`${styles.answerText} ${styles.longText}`}>
            {answer.observation ?? answer.text ?? ''}
          </p>
          {extras.actionRequired === false ? (
            <p className={styles.quietFact}>
              Assessor marked: no action required. Releasing will not create an
              action for this finding.
            </p>
          ) : (
            <dl className={styles.findingFacts}>
              <div className={styles.findingFact}>
                <dt>Responsible party</dt>
                <dd>
                  {extras.responsible ??
                    (responsibleParty
                      ? `${responsiblePartyLine(responsibleParty.party)} (${RESPONSIBLE_SOURCE_LABEL[responsibleParty.source]})`
                      : 'Not set on this assessment or the building')}
                </dd>
              </div>
              {extras.dueBy !== undefined ? (
                <div className={styles.findingFact}>
                  <dt>Action due</dt>
                  <dd>By {dueDateFormat.format(extras.dueBy)}</dd>
                </div>
              ) : (
                answer.severity && (
                  <div className={styles.findingFact}>
                    <dt>Action due</dt>
                    <dd>
                      Within {DUE_WINDOW_DAYS[answer.severity]} days of release
                      (severity default)
                    </dd>
                  </div>
                )
              )}
            </dl>
          )}
        </div>
      );
    }
    default:
      // A snapshot can only carry the known types, but a review must
      // never render nothing silently if a future one arrives.
      return <p className={styles.answerText}>{answer.text ?? ''}</p>;
  }
}

// ----------------------------------------------------------------------------
// The card.
// ----------------------------------------------------------------------------

export interface FlaggingHandle {
  /** The basket draft for this question; undefined when not flagged. */
  draft: string | undefined;
  onStart: () => void;
  onChange: (message: string) => void;
  onRemove: () => void;
}

export interface AnswerCardProps {
  question: TemplateQuestion;
  answer: AssessmentAnswer | undefined;
  /** The responsible party a finding inherits when it names none of its own -
   *  what release assigns to the action - and the level it was resolved from.
   *  Resolved by the review; the card only renders it. */
  responsibleParty?: InheritedResponsibleParty;
  /** Resolve a uid to a display name for info-request threads. */
  nameFor: (uid: string) => string;
  /** Present only while flagging is allowed (status readyForValidation). */
  flagging?: FlaggingHandle;
}

export function AnswerCard({
  question,
  answer,
  responsibleParty,
  nameFor,
  flagging,
}: AnswerCardProps) {
  const composerId = useId();
  const answered = isAnswered(answer);
  const request = answer?.infoRequest;
  const requestOpen = Boolean(request && request.resolvedAt === undefined);

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <div className={styles.questionBlock}>
          <h4 className={styles.questionText}>{question.text}</h4>
          {question.guidance && <p className={styles.guidance}>{question.guidance}</p>}
        </div>
        {flagging && flagging.draft === undefined && (
          <Button variant="ghost" type="button" onClick={flagging.onStart}>
            Request more information
          </Button>
        )}
      </div>

      {answered && answer ? (
        <AnswerBody question={question} answer={answer} responsibleParty={responsibleParty} />
      ) : (
        <p className={styles.unanswered}>Not answered</p>
      )}

      {answer?.photos && answer.photos.length > 0 && (
        <div className={styles.photoGrid}>
          {answer.photos.map((photo, index) => (
            <PhotoThumb key={`${photo.path}-${index}`} photo={photo} />
          ))}
        </div>
      )}

      {answer?.flags && answer.flags.length > 0 && (
        <div className={styles.photoGrid}>
          {answer.flags.map((flag, index) => (
            <FlagComposite key={`${flag.planId}-${index}`} flag={flag} />
          ))}
        </div>
      )}

      {request && (
        <div
          className={requestOpen ? styles.threadOpen : styles.threadResolved}
          aria-label={`Information request for: ${question.text}`}
        >
          <p className={styles.threadTitle}>
            {requestOpen ? 'More information requested' : 'Information request resolved'}
          </p>
          <p className={styles.threadMessage}>
            <span className={styles.threadWho}>{nameFor(request.byUid)}</span>
            {request.message}
          </p>
          {request.response ? (
            <p className={styles.threadResponse}>
              <span className={styles.threadWho}>Assessor's response</span>
              {request.response}
            </p>
          ) : (
            <p className={styles.threadAwaiting}>
              Awaiting the assessor's response. They must resubmit the assessment
              before it can be validated.
            </p>
          )}
        </div>
      )}

      {flagging && flagging.draft !== undefined && (
        <div className={styles.composer}>
          <label className={styles.composerLabel} htmlFor={composerId}>
            What more do you need from the assessor?
          </label>
          <textarea
            id={composerId}
            className={styles.composerInput}
            rows={3}
            value={flagging.draft}
            onChange={(event) => flagging.onChange(event.target.value)}
          />
          <div className={styles.composerActions}>
            <Button variant="ghost" type="button" onClick={flagging.onRemove}>
              Remove from basket
            </Button>
            <p className={styles.composerHint}>
              Added to the flag basket. This is NOT sent yet - send every request
              together from the bar at the foot of the screen.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
