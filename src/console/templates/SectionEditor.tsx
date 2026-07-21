// ============================================================================
// SectionEditor - one section card in the template builder: code and title
// inputs, reorder/remove controls, the section's question rows and the
// add-question action. Every mutation flows up as a whole next-section object
// (or a builder-level move/remove), so the builder remains the single owner of
// the draft and the autosave.
// ============================================================================

import { useId } from 'react';
import { Button } from '../../components/Button';
import type { StandardParagraph, TemplateSection } from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { newId, sectionAnchor } from './builderModel';
import { InlineConfirm, QuestionEditor } from './QuestionEditor';
import styles from './TemplateBuilder.module.css';

export interface SectionEditorProps {
  section: TemplateSection;
  /** Position among the template's sections, for the move buttons. */
  index: number;
  /** Total section count. */
  count: number;
  /** id + label of every OTHER section (move-question targets). */
  otherSections: Array<{ id: string; label: string }>;
  paragraphs: Record<string, StandardParagraph> | null;
  /** Question rows currently expanded (owned by the builder so validation
   *  jump-links can expand a row before scrolling to it). */
  expandedQuestionIds: ReadonlySet<string>;
  onToggleQuestion: (questionId: string) => void;
  onChange: (next: TemplateSection) => void;
  onMove: (direction: -1 | 1) => void;
  /** Absent when this is the last remaining section (a template keeps >= 1). */
  onRemove?: () => void;
  onMoveQuestionToSection: (questionId: string, targetSectionId: string) => void;
}

export function SectionEditor({
  section,
  index,
  count,
  otherSections,
  paragraphs,
  expandedQuestionIds,
  onToggleQuestion,
  onChange,
  onMove,
  onRemove,
  onMoveQuestionToSection,
}: SectionEditorProps) {
  const idBase = useId();

  const moveQuestion = (questionIndex: number, direction: -1 | 1) => {
    const target = questionIndex + direction;
    const questions = [...section.questions];
    [questions[questionIndex], questions[target]] = [
      questions[target],
      questions[questionIndex],
    ];
    onChange({ ...section, questions });
  };

  const addQuestion = () => {
    onChange({
      ...section,
      questions: [
        ...section.questions,
        // A fresh unique id: question ids are answer keys (see newId).
        { id: newId('q'), text: '', type: 'text' },
      ],
    });
  };

  return (
    <div id={sectionAnchor(section.id)}>
      <Card>
        <CardHeader
          title={section.title.trim() || `Section ${index + 1}`}
          hint={`${section.questions.length} ${
            section.questions.length === 1 ? 'question' : 'questions'
          }`}
          action={
            <span className={styles.sectionControls}>
              <Button
                variant="ghost"
                disabled={index === 0}
                aria-label={`Move section ${index + 1} up`}
                onClick={() => onMove(-1)}
              >
                Move up
              </Button>
              <Button
                variant="ghost"
                disabled={index === count - 1}
                aria-label={`Move section ${index + 1} down`}
                onClick={() => onMove(1)}
              >
                Move down
              </Button>
              {onRemove && (
                <InlineConfirm
                  actionLabel="Remove section"
                  prompt="Remove this section and its questions?"
                  onConfirm={onRemove}
                />
              )}
            </span>
          }
        />
        <div className={styles.sectionBody}>
          <div className={styles.fieldRow}>
            <div className={`${styles.field} ${styles.fieldNarrow}`}>
              <label className={styles.label} htmlFor={`${idBase}-code`}>
                Section code
              </label>
              <input
                id={`${idBase}-code`}
                className={styles.input}
                type="text"
                autoComplete="off"
                value={section.code}
                onChange={(event) =>
                  onChange({ ...section, code: event.target.value })
                }
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${idBase}-title`}>
                Section title
              </label>
              <input
                id={`${idBase}-title`}
                className={styles.input}
                type="text"
                autoComplete="off"
                value={section.title}
                onChange={(event) =>
                  onChange({ ...section, title: event.target.value })
                }
              />
            </div>
          </div>

          {section.questions.length === 0 ? (
            <p className={styles.hint}>
              No questions yet. A section needs at least one question before the
              template can be published.
            </p>
          ) : (
            <ul className={styles.questionList}>
              {section.questions.map((question, questionIndex) => (
                <QuestionEditor
                  key={question.id}
                  question={question}
                  index={questionIndex}
                  count={section.questions.length}
                  otherSections={otherSections}
                  paragraphs={paragraphs}
                  expanded={expandedQuestionIds.has(question.id)}
                  onToggle={() => onToggleQuestion(question.id)}
                  onChange={(next) =>
                    onChange({
                      ...section,
                      questions: section.questions.map((existing) =>
                        existing.id === question.id ? next : existing,
                      ),
                    })
                  }
                  onMove={(direction) => moveQuestion(questionIndex, direction)}
                  onMoveToSection={(targetSectionId) =>
                    onMoveQuestionToSection(question.id, targetSectionId)
                  }
                  onRemove={() =>
                    onChange({
                      ...section,
                      questions: section.questions.filter(
                        (existing) => existing.id !== question.id,
                      ),
                    })
                  }
                />
              ))}
            </ul>
          )}

          <div>
            <Button variant="secondary" onClick={addQuestion}>
              Add question
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
