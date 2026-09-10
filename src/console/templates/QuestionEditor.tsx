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
  QuestionMatrix,
  QuestionType,
  StandardParagraph,
  TemplateQuestion,
} from '../../types';
import { QUESTION_TYPES } from '../../types';
import {
  allParagraphs,
  resolveParagraph,
  subjectOf,
} from '../../standardParagraphs';
import {
  defaultMatrix,
  hasMatrix,
  hasOptions,
  matrixIssues,
  MATRIX_LIMITS,
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
// ParagraphPicker - a searchable select over the WHOLE paragraph library: the
// BS 9792 bank Safentia ships (held in code) and the organisation's own (RTDB),
// as one list grouped by subject. `paragraphs` is the org node alone, so both
// the list and the resolution of the current choice go through the shared
// helpers - indexing that node directly would hide every shipped paragraph and
// report a reference to one as dangling.
//
// 'None' is a first-class choice; the chosen paragraph's body renders as a
// muted preview so the author sees the exact wording this question will print
// against a finding.
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

  const entries = allParagraphs(paragraphs);
  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? entries.filter(
        (entry) =>
          // The current choice always stays listed, or filtering would appear
          // to deselect it.
          entry.id === value ||
          entry.paragraph.reference.toLowerCase().includes(needle) ||
          (entry.paragraph.title ?? '').toLowerCase().includes(needle) ||
          (entry.paragraph.subject ?? '').toLowerCase().includes(needle) ||
          entry.paragraph.body.toLowerCase().includes(needle),
      )
    : entries;

  // Grouped for the select, in the order the library lists subjects, so a
  // 127-entry bank reads as subjects rather than as one wall of numbers.
  const grouped: Array<[string, typeof filtered]> = [];
  for (const entry of filtered) {
    const subject = subjectOf(entry);
    const last = grouped[grouped.length - 1];
    if (last && last[0] === subject) {
      last[1].push(entry);
    } else {
      grouped.push([subject, [entry]]);
    }
  }

  const chosen = value ? (resolveParagraph(value, paragraphs) ?? null) : null;

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
            {grouped.map(([subject, group]) => (
              <optgroup key={subject} label={subject}>
                {group.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.paragraph.title
                      ? `${entry.paragraph.reference} ${entry.paragraph.title}`
                      : entry.paragraph.reference}
                  </option>
                ))}
              </optgroup>
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
            {chosen.subject ? ` · ${chosen.subject}` : ''}
          </span>
          {/* The bank's wording carries its own line breaks - lists, tables of
              separation distances - and a paragraph collapsed onto one line is
              not the wording the report will print. */}
          <span className={styles.paragraphPreviewBody}>{chosen.body}</span>
        </blockquote>
      )}
    </>
  );
}

// ----------------------------------------------------------------------------
// MatrixEditor - the grid behind a `matrix` question (the BS 9792 / PAS 79
// simple risk level estimator, generalised). The assessor later answers by
// tapping ONE cell, which fixes row, column and outcome together, so what is
// authored here is the whole answer space.
//
// Every mutation rebuilds rows, columns and cells in one go: adding a column
// appends a cell to EVERY row, removing one drops that index from every row.
// A ragged grid is therefore unrepresentable through this UI rather than merely
// caught at save time. Renaming an option carries its definition across with it,
// because definitions are keyed by the label the author is editing.
// ----------------------------------------------------------------------------

/** Rebuild the definitions map when an option is renamed, so the author does
 *  not silently lose the wording attached to it. */
function moveDefinition(
  definitions: Record<string, string> | undefined,
  from: string,
  to: string,
): Record<string, string> | undefined {
  const text = definitions?.[from];
  if (!definitions || text === undefined || from === to) {
    return definitions;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(definitions)) {
    if (key !== from) {
      next[key] = value;
    }
  }
  if (to.trim()) {
    next[to] = text;
  }
  return next;
}

function MatrixEditor({
  idBase,
  matrix,
  onChange,
}: {
  idBase: string;
  matrix: QuestionMatrix;
  onChange: (next: QuestionMatrix) => void;
}) {
  const { rowLabel, columnLabel, rows, columns, cells } = matrix;
  const issues = matrixIssues(matrix);

  const renameOption = (axis: 'rows' | 'columns', index: number, value: string) => {
    const current = axis === 'rows' ? rows : columns;
    const previous = current[index];
    const nextAxis = current.map((label, i) => (i === index ? value : label));
    const definitions = moveDefinition(matrix.definitions, previous, value);
    onChange({
      ...matrix,
      [axis]: nextAxis,
      ...(definitions ? { definitions } : {}),
    });
  };

  const addRow = () =>
    onChange({
      ...matrix,
      rows: [...rows, ''],
      cells: [...cells, columns.map(() => '')],
    });

  const removeRow = (index: number) =>
    onChange({
      ...matrix,
      rows: rows.filter((_, i) => i !== index),
      cells: cells.filter((_, i) => i !== index),
    });

  const addColumn = () =>
    onChange({
      ...matrix,
      columns: [...columns, ''],
      cells: cells.map((row) => [...row, '']),
    });

  const removeColumn = (index: number) =>
    onChange({
      ...matrix,
      columns: columns.filter((_, i) => i !== index),
      cells: cells.map((row) => row.filter((_, i) => i !== index)),
    });

  const setCell = (rowIndex: number, columnIndex: number, value: string) =>
    onChange({
      ...matrix,
      cells: cells.map((row, r) =>
        r === rowIndex
          ? row.map((cell, c) => (c === columnIndex ? value : cell))
          : row,
      ),
    });

  const setDefinition = (label: string, text: string) => {
    const next: Record<string, string> = { ...(matrix.definitions ?? {}) };
    if (text.trim()) {
      next[label] = text;
    } else {
      delete next[label];
    }
    onChange({ ...matrix, definitions: next });
  };

  // One definition slot per distinct option across both axes; a label used on
  // both axes is defined once, which is what the printed estimator does too.
  const definableLabels = [...new Set([...rows, ...columns])].filter((label) =>
    label.trim(),
  );

  const atRowCeiling = rows.length >= MATRIX_LIMITS.maxAxis;
  const atColumnCeiling = columns.length >= MATRIX_LIMITS.maxAxis;

  return (
    <div className={styles.matrixGroup}>
      <h4 className={styles.groupTitle}>Grid</h4>
      <p className={styles.hint}>
        The assessor answers by choosing one cell, which records the row, the
        column and that cell&rsquo;s outcome together.
      </p>

      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${idBase}-matrix-row-label`}>
            What the rows measure
          </label>
          <input
            id={`${idBase}-matrix-row-label`}
            className={styles.input}
            type="text"
            autoComplete="off"
            value={rowLabel}
            onChange={(event) =>
              onChange({ ...matrix, rowLabel: event.target.value })
            }
          />
        </div>
        <div className={styles.field}>
          <label
            className={styles.label}
            htmlFor={`${idBase}-matrix-column-label`}
          >
            What the columns measure
          </label>
          <input
            id={`${idBase}-matrix-column-label`}
            className={styles.input}
            type="text"
            autoComplete="off"
            value={columnLabel}
            onChange={(event) =>
              onChange({ ...matrix, columnLabel: event.target.value })
            }
          />
        </div>
      </div>

      <div className={styles.matrixScroll}>
        <table className={styles.matrixTable}>
          <caption className="sr-only">
            Grid outcomes, by row and column
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.matrixCorner}>
                {rowLabel.trim() || 'Rows'} &times;{' '}
                {columnLabel.trim() || 'Columns'}
              </th>
              {columns.map((column, columnIndex) => (
                // Index keys are safe here: options are plain strings edited in
                // place, and a column is only ever added or removed at an index.
                <th scope="col" key={columnIndex} className={styles.matrixHead}>
                  <label
                    className="sr-only"
                    htmlFor={`${idBase}-matrix-column-${columnIndex}`}
                  >
                    Column {columnIndex + 1} label
                  </label>
                  <input
                    id={`${idBase}-matrix-column-${columnIndex}`}
                    className={styles.input}
                    type="text"
                    autoComplete="off"
                    value={column}
                    onChange={(event) =>
                      renameOption('columns', columnIndex, event.target.value)
                    }
                  />
                  <Button
                    variant="ghost"
                    disabled={columns.length <= MATRIX_LIMITS.minAxis}
                    aria-label={`Remove column ${columnIndex + 1}`}
                    onClick={() => removeColumn(columnIndex)}
                  >
                    Remove
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th scope="row" className={styles.matrixHead}>
                  <label
                    className="sr-only"
                    htmlFor={`${idBase}-matrix-row-${rowIndex}`}
                  >
                    Row {rowIndex + 1} label
                  </label>
                  <input
                    id={`${idBase}-matrix-row-${rowIndex}`}
                    className={styles.input}
                    type="text"
                    autoComplete="off"
                    value={row}
                    onChange={(event) =>
                      renameOption('rows', rowIndex, event.target.value)
                    }
                  />
                  <Button
                    variant="ghost"
                    disabled={rows.length <= MATRIX_LIMITS.minAxis}
                    aria-label={`Remove row ${rowIndex + 1}`}
                    onClick={() => removeRow(rowIndex)}
                  >
                    Remove
                  </Button>
                </th>
                {columns.map((column, columnIndex) => (
                  <td key={columnIndex} className={styles.matrixCell}>
                    <label
                      className="sr-only"
                      htmlFor={`${idBase}-matrix-cell-${rowIndex}-${columnIndex}`}
                    >
                      Outcome for {row.trim() || `row ${rowIndex + 1}`} and{' '}
                      {column.trim() || `column ${columnIndex + 1}`}
                    </label>
                    <input
                      id={`${idBase}-matrix-cell-${rowIndex}-${columnIndex}`}
                      className={styles.input}
                      type="text"
                      autoComplete="off"
                      value={cells[rowIndex]?.[columnIndex] ?? ''}
                      onChange={(event) =>
                        setCell(rowIndex, columnIndex, event.target.value)
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.matrixActions}>
        <Button variant="secondary" disabled={atRowCeiling} onClick={addRow}>
          Add row
        </Button>
        <Button
          variant="secondary"
          disabled={atColumnCeiling}
          onClick={addColumn}
        >
          Add column
        </Button>
        {(atRowCeiling || atColumnCeiling) && (
          <span className={styles.hint}>
            A grid may have at most {MATRIX_LIMITS.maxAxis} rows and{' '}
            {MATRIX_LIMITS.maxAxis} columns.
          </span>
        )}
      </div>

      {definableLabels.length > 0 && (
        <div className={styles.field}>
          <span className={styles.label}>Definitions (optional)</span>
          <p className={styles.hint}>
            Shown to the assessor alongside the grid, and kept with the
            assessment record. BS 9792 defines each likelihood and each harm
            level this way.
          </p>
          <ul className={styles.optionList}>
            {definableLabels.map((label) => (
              <li key={label} className={styles.definitionRow}>
                <label
                  className={styles.label}
                  htmlFor={`${idBase}-matrix-definition-${label}`}
                >
                  {label}
                </label>
                <textarea
                  id={`${idBase}-matrix-definition-${label}`}
                  className={styles.textarea}
                  value={matrix.definitions?.[label] ?? ''}
                  onChange={(event) => setDefinition(label, event.target.value)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {issues.length > 0 && (
        <ul className={styles.matrixIssues} role="alert">
          {issues.map((issue) => (
            <li key={issue}>
              {/* Sentence-cased for a standalone list; the publish checklist
                  prefixes the same wording with the question's position. */}
              {issue.charAt(0).toUpperCase()}
              {issue.slice(1)}
            </li>
          ))}
        </ul>
      )}
    </div>
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
    // A matrix question is meaningless without a grid, so it opens on the
    // smallest legal one rather than on nothing to fill in.
    if (hasMatrix(type) && !next.matrix) {
      next.matrix = defaultMatrix();
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

          {hasMatrix(question.type) && (
            <MatrixEditor
              idBase={idBase}
              matrix={question.matrix ?? defaultMatrix()}
              onChange={(matrix) => patch({ matrix })}
            />
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
