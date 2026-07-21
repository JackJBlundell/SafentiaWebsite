// ============================================================================
// QuestionEditor - one question row in the template builder. Collapsed it is a
// single scannable line (text, type chip, required marker); expanded it edits
// everything the schema allows: text, type, options (choice types), the answer
// toggles, guidance, and the standardised-finding group (observation,
// recommendation, standard-paragraph reference) the client's question metadata
// requirement asks for. All edits flow up as a whole next-question object; the
// builder owns the draft and the autosave.
// ============================================================================

import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import type {
  QuestionType,
  StandardParagraph,
  TemplateQuestion,
} from '../../types';
import { QUESTION_TYPES } from '../../types';
import {
  hasOptions,
  QUESTION_TYPE_LABELS,
  questionAnchor,
} from './builderModel';
import styles from './TemplateBuilder.module.css';

// ----------------------------------------------------------------------------
// InlineConfirm - the house two-step destructive control: the first press
// swaps the button for a short prompt with Confirm/Cancel, so a slip of the
// mouse can never delete authored content. Shared by question and section
// removal.
// ----------------------------------------------------------------------------

export function InlineConfirm({
  actionLabel,
  prompt,
  onConfirm,
}: {
  actionLabel: string;
  prompt: string;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        {actionLabel}
      </Button>
    );
  }
  return (
    <span className={styles.confirmGroup}>
      <span className={styles.confirmPrompt}>{prompt}</span>
      <Button
        variant="secondary"
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        Confirm
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

// ----------------------------------------------------------------------------
// ParagraphPicker - a searchable select over the org's Standard Paragraphs
// library, by reference and title. 'None' is a first-class choice; the chosen
// paragraph's body renders as a muted preview so the author sees exactly what
// wording the question will feed into the AI summary of findings.
// ----------------------------------------------------------------------------

function ParagraphPicker({
  idBase,
  value,
  paragraphs,
  onChange,
}: {
  idBase: string;
  value: string | undefined;
  paragraphs: Record<string, StandardParagraph> | null;
  onChange: (paragraphId: string | undefined) => void;
}) {
  const [search, setSearch] = useState('');

  const entries = Object.entries(paragraphs ?? {}).sort((a, b) =>
    a[1].reference.localeCompare(b[1].reference, 'en-GB', { numeric: true }),
  );
  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? entries.filter(
        ([paragraphId, paragraph]) =>
          // The current choice always stays listed, or filtering would appear
          // to deselect it.
          paragraphId === value ||
          paragraph.reference.toLowerCase().includes(needle) ||
          (paragraph.title ?? '').toLowerCase().includes(needle),
      )
    : entries;

  const chosen = value ? (paragraphs?.[value] ?? null) : null;

  return (
    <>
      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${idBase}-paragraph-search`}>
            Search the paragraph library
          </label>
          <input
            id={`${idBase}-paragraph-search`}
            className={styles.input}
            type="search"
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${idBase}-paragraph`}>
            Standard paragraph
          </label>
          <select
            id={`${idBase}-paragraph`}
            className={styles.select}
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value || undefined)}
          >
            <option value="">None</option>
            {filtered.map(([paragraphId, paragraph]) => (
              <option key={paragraphId} value={paragraphId}>
                {paragraph.title
                  ? `${paragraph.reference} ${paragraph.title}`
                  : paragraph.reference}
              </option>
            ))}
          </select>
        </div>
      </div>
      {value && !chosen && (
        <p role="alert" className={styles.hint}>
          The referenced paragraph is no longer in the library. Choose another,
          or None.
        </p>
      )}
      {chosen && (
        <blockquote className={styles.paragraphPreview}>
          <span className={styles.paragraphPreviewTitle}>
            {chosen.title
              ? `${chosen.reference} ${chosen.title}`
              : chosen.reference}
          </span>
          {chosen.body}
        </blockquote>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------
// The question row.
// ----------------------------------------------------------------------------

export interface QuestionEditorProps {
  question: TemplateQuestion;
  /** Position within the section, for the move buttons. */
  index: number;
  /** Question count in the section. */
  count: number;
  /** The other sections this question could move to. */
  otherSections: Array<{ id: string; label: string }>;
  paragraphs: Record<string, StandardParagraph> | null;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: TemplateQuestion) => void;
  onMove: (direction: -1 | 1) => void;
  onMoveToSection: (targetSectionId: string) => void;
  onRemove: () => void;
}

export function QuestionEditor({
  question,
  index,
  count,
  otherSections,
  paragraphs,
  expanded,
  onToggle,
  onChange,
  onMove,
  onMoveToSection,
  onRemove,
}: QuestionEditorProps) {
  const idBase = useId();

  const patch = (changes: Partial<TemplateQuestion>) =>
    onChange({ ...question, ...changes });

  const setType = (type: QuestionType) => {
    const next: TemplateQuestion = { ...question, type };
    if (hasOptions(type) && !next.options) {
      next.options = [];
    }
    onChange(next);
  };

  const options = question.options ?? [];
  const summaryText = question.text.trim();

  return (
    <li id={questionAnchor(question.id)} className={styles.questionItem}>
      <button
        type="button"
        className={styles.questionSummary}
        aria-expanded={expanded}
        aria-controls={`${idBase}-editor`}
        onClick={onToggle}
      >
        {summaryText ? (
          <span className={styles.questionText}>{summaryText}</span>
        ) : (
          <span className={`${styles.questionText} ${styles.questionUntitled}`}>
            Untitled question
          </span>
        )}
        <span className={styles.typeChip}>
          {QUESTION_TYPE_LABELS[question.type]}
        </span>
        {question.required && <span className={styles.requiredMark}>Required</span>}
        <span aria-hidden="true" className={styles.chevron}>
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {expanded && (
        <div id={`${idBase}-editor`} className={styles.questionEditor}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${idBase}-text`}>
              Question text
            </label>
            <input
              id={`${idBase}-text`}
              className={styles.input}
              type="text"
              autoComplete="off"
              value={question.text}
              onChange={(event) => patch({ text: event.target.value })}
            />
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${idBase}-type`}>
                Answer type
              </label>
              <select
                id={`${idBase}-type`}
                className={styles.select}
                value={question.type}
                onChange={(event) => setType(event.target.value as QuestionType)}
              >
                {QUESTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {QUESTION_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {hasOptions(question.type) && (
            <div className={styles.field}>
              <span className={styles.label}>Options</span>
              {options.length === 0 && (
                <p className={styles.hint}>
                  A choice question needs at least one option.
                </p>
              )}
              <ul className={styles.optionList}>
                {options.map((option, optionIndex) => (
                  // Index keys are safe here: options are plain strings edited
                  // in place, and rows are only added or removed at an index.
                  <li key={optionIndex} className={styles.optionRow}>
                    <label
                      className="sr-only"
                      htmlFor={`${idBase}-option-${optionIndex}`}
                    >
                      Option {optionIndex + 1}
                    </label>
                    <input
                      id={`${idBase}-option-${optionIndex}`}
                      className={styles.input}
                      type="text"
                      autoComplete="off"
                      value={option}
                      onChange={(event) =>
                        patch({
                          options: options.map((existing, i) =>
                            i === optionIndex ? event.target.value : existing,
                          ),
                        })
                      }
                    />
                    <Button
                      variant="ghost"
                      aria-label={`Remove option ${optionIndex + 1}`}
                      onClick={() =>
                        patch({
                          options: options.filter((_, i) => i !== optionIndex),
                        })
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
              <div>
                <Button
                  variant="secondary"
                  onClick={() => patch({ options: [...options, ''] })}
                >
                  Add option
                </Button>
              </div>
            </div>
          )}

          <div className={styles.toggleRow}>
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={question.required === true}
                onChange={(event) =>
                  patch({ required: event.target.checked || undefined })
                }
              />
              Required
            </label>
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={question.allowsPhotos === true}
                onChange={(event) =>
                  patch({ allowsPhotos: event.target.checked || undefined })
                }
              />
              Allows photos
            </label>
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={question.allowsFlagLocation === true}
                onChange={(event) =>
                  patch({ allowsFlagLocation: event.target.checked || undefined })
                }
              />
              Allows flagging a location
            </label>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${idBase}-guidance`}>
              Guidance for the assessor
            </label>
            <textarea
              id={`${idBase}-guidance`}
              className={styles.textarea}
              value={question.guidance ?? ''}
              onChange={(event) =>
                patch({ guidance: event.target.value || undefined })
              }
            />
            <p className={styles.hint}>
              Shown inline in the app while the assessor answers this question.
            </p>
          </div>

          <div className={styles.findingGroup}>
            <h4 className={styles.groupTitle}>Standardised finding</h4>
            <p className={styles.hint}>
              When an assessor flags this question as a deficiency, these
              pre-fill the finding so wording stays consistent across assessors.
              The assessor can still amend on site.
            </p>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${idBase}-observation`}>
                Observation
              </label>
              <textarea
                id={`${idBase}-observation`}
                className={styles.textarea}
                value={question.observation ?? ''}
                onChange={(event) =>
                  patch({ observation: event.target.value || undefined })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${idBase}-recommendation`}>
                Recommendation
              </label>
              <textarea
                id={`${idBase}-recommendation`}
                className={styles.textarea}
                value={question.recommendation ?? ''}
                onChange={(event) =>
                  patch({ recommendation: event.target.value || undefined })
                }
              />
            </div>
            <ParagraphPicker
              idBase={idBase}
              value={question.standardParagraphRef}
              paragraphs={paragraphs}
              onChange={(paragraphId) =>
                patch({ standardParagraphRef: paragraphId })
              }
            />
          </div>

          <div className={styles.questionControls}>
            <Button
              variant="ghost"
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              Move up
            </Button>
            <Button
              variant="ghost"
              disabled={index === count - 1}
              onClick={() => onMove(1)}
            >
              Move down
            </Button>
            {otherSections.length > 0 && (
              <span className={styles.moveToField}>
                <label className={styles.label} htmlFor={`${idBase}-move-to`}>
                  Move to section
                </label>
                <select
                  id={`${idBase}-move-to`}
                  className={styles.select}
                  value=""
                  onChange={(event) => {
                    if (event.target.value) {
                      onMoveToSection(event.target.value);
                    }
                  }}
                >
                  <option value="">Choose a section</option>
                  {otherSections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.label}
                    </option>
                  ))}
                </select>
              </span>
            )}
            <InlineConfirm
              actionLabel="Remove question"
              prompt="Remove this question?"
              onConfirm={onRemove}
            />
          </div>
        </div>
      )}
    </li>
  );
}
