// ============================================================================
// AiGuidanceSettingsPage - the organisation's own steer for the AI summary.
//
// Safentia drafts the SUMMARY block of an assessment with a model, grounded in
// the platform's regulatory context (/platform/aiContext), which only Safentia
// can edit. Until now a customer had no way to add anything of their own to
// that prompt: a firm that always cites the Welsh regulations, always calls out
// PV panels, or writes in a particular register had to correct every draft by
// hand. This page is that missing steer, stored as OrgSettings.aiGuidance and
// appended to the prompt AFTER the regulatory grounding and the strict rules
// (functions/src/lib/fireSafetyContext) - it adds emphasis, it never displaces
// the framework a safety document is written against.
//
// IT IS GUIDANCE FOR THE MODEL, NOT REPORT WORDING. The separate standard
// paragraph library (Templates -> paragraphs) holds wording that is printed into
// reports verbatim and is never shown to a model to paraphrase. The two are
// deliberately different features and the copy on this page says so, because an
// admin who pastes a legal paragraph in here would be asking a model to
// re-express text whose exact wording is the whole point of storing it.
//
// One field, one save, same shape as the reminder sections: seeded from the
// live settings snapshot once it has attached, saved through the SAME
// updateOrgSettings callable the RAG and reminder pages use, and cleared by
// sending an explicit null (which removes the key, so the prompt falls back to
// the platform framework alone).
// ============================================================================

import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  OrgSettings,
  UpdateOrgSettingsInput,
  UpdateOrgSettingsResult,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import styles from './AiGuidanceSettingsPage.module.css';

/**
 * The ceiling the updateOrgSettings callable enforces (AI_GUIDANCE_MAX_LENGTH in
 * functions/src/functions/updateOrgSettings.ts). Mirrored here only so the page
 * can count down to the same number and refuse the save before a round trip; the
 * server remains the boundary, exactly as the reminder page mirrors the schedule
 * rules rather than owning them.
 */
const MAX_LENGTH = 1500;

/** The counter turns from quiet to a warning with this much room left, so an
 *  admin writing a long house style sees the ceiling coming rather than meeting
 *  it mid-sentence. */
const NEARLY_FULL = 150;

/**
 * The slice of updateOrgSettings this page sends. Every field of that callable
 * is optional and independent - it writes only what it is given - so a settings
 * surface states its own concern rather than the union of all of them: this one
 * sends the house guidance and nothing else. `null` is the CLEAR (writing null
 * to RTDB removes the key), which is what an emptied box means.
 *
 * Derived from the shared input type rather than restated, so the field can
 * never drift from the contract the callable validates against; `Required`
 * because THIS page always sends it, where the callable takes it or leaves it.
 */
type UpdateAiGuidanceInput = Required<
  Pick<UpdateOrgSettingsInput, 'aiGuidance'>
>;

export function AiGuidanceSettingsPage() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(claims && paths);

  const settings = useRtdbQuery<OrgSettings | null>({
    key: keys.orgSettings(orgId),
    path: paths ? paths.db.orgSettings(orgId) : '',
    enabled,
  });
  // `undefined` is "the listener has not delivered yet"; `null` is a real answer
  // meaning the org has no settings node, which seeds an empty box.
  const ready = settings.data !== undefined;

  const update = useCallable<UpdateAiGuidanceInput, UpdateOrgSettingsResult>(
    'updateOrgSettings',
  );

  // Seeded ONCE from the first delivered snapshot: re-seeding on every snapshot
  // would throw away what the admin is halfway through typing the moment any
  // other setting on the record changed.
  const [seeded, setSeeded] = useState(false);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (seeded || !ready) {
      return;
    }
    setText(settings.data?.aiGuidance ?? '');
    setSeeded(true);
  }, [seeded, ready, settings.data]);

  const trimmed = text.trim();
  const stored = settings.data?.aiGuidance ?? '';
  // Length is judged on the TRIMMED value, because that is what the server
  // stores and measures; a box full of trailing newlines is not over the limit.
  const tooLong = trimmed.length > MAX_LENGTH;
  const remaining = MAX_LENGTH - trimmed.length;
  const dirty = trimmed !== stored.trim();

  const onSave = async () => {
    if (tooLong) {
      return;
    }
    setSaved(false);
    // An emptied box is a decision - "we no longer want a house steer" - not a
    // no-op, so it saves an explicit null rather than a blank string. The
    // callable folds the two together anyway; sending the null makes the intent
    // legible in the audit trail, which records a clear separately from a change.
    const result = await update.call({
      aiGuidance: trimmed.length === 0 ? null : trimmed,
    });
    if (result) {
      // Reflect what was actually stored (the trimmed value), so the box and the
      // record cannot disagree the moment after a save.
      setText(trimmed);
      setSaved(true);
    }
  };

  return (
    <div>
      <PageHeader
        title="AI guidance"
        lede="What you want Safentia's draft summaries to bear in mind - the regulations you always cite, the features you always call out, the way your firm writes."
      />

      <Card>
        <CardHeader
          title="House guidance for draft summaries"
          hint="Applies to every assessment your organisation drafts, on top of the fire safety framework Safentia maintains."
        />
        <div className={styles.cardBody}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="ai-guidance">
              Guidance for the AI
            </label>
            <p id="ai-guidance-hint" className={styles.note}>
              When an assessor asks Safentia to draft an assessment, the summary
              is written by an AI grounded in UK fire safety regulation. Anything
              you write here is given to it as well. Use it for standing
              instructions your assessors would otherwise apply by hand - "we
              work in Wales, cite the Welsh regulations where they differ",
              "always mention photovoltaic panels where they are present", "keep
              the tone plain and avoid jargon".
            </p>
            <textarea
              id="ai-guidance"
              className={styles.textarea}
              rows={8}
              value={text}
              disabled={!seeded}
              onChange={(event) => {
                setSaved(false);
                setText(event.target.value);
              }}
              aria-describedby="ai-guidance-hint ai-guidance-count"
              aria-invalid={tooLong}
              placeholder="We work mainly in Wales; where the Welsh regulations differ from the English ones, cite the Welsh. Always call out photovoltaic panels and any lithium-ion storage where the findings mention them."
            />
            <p
              id="ai-guidance-count"
              className={
                tooLong || remaining <= NEARLY_FULL
                  ? `${styles.note} ${styles.noteWarning}`
                  : styles.note
              }
            >
              {tooLong
                ? `${trimmed.length - MAX_LENGTH} characters over the limit of ${MAX_LENGTH}.`
                : `${remaining} of ${MAX_LENGTH} characters remaining.`}
            </p>
          </div>

          {/* The one thing an admin can most plausibly get wrong here, said
              plainly and next to the box rather than buried in a lede: this is
              a steer, and wording that must appear exactly as written belongs
              in the paragraph library instead. */}
          <div className={styles.field}>
            <p className={styles.note}>
              <strong>This is guidance, not report wording.</strong> The AI reads
              it and writes its own prose; it will not reproduce what you type
              here word for word. Wording that must appear exactly as written -
              your standard clauses, disclaimers and recommendations - belongs in
              your template's standard paragraphs, which are printed into the
              report as you wrote them and are never rewritten by the AI.
            </p>
            <p className={styles.note}>
              Guidance cannot override the regulatory grounding, change a
              finding, alter a severity, or add a citation the assessment does
              not support. The assessor reviews and edits every draft and remains
              the author.
            </p>
          </div>

          {tooLong && (
            <ErrorNotice
              message={`Guidance can be at most ${MAX_LENGTH} characters. Shorten it and save again.`}
            />
          )}
          {update.error && <ErrorNotice message={update.error} />}
          {saved && (
            <p role="status" className={styles.success}>
              {trimmed.length === 0
                ? 'Guidance cleared. Draft summaries now use the Safentia framework only.'
                : 'Guidance saved. It applies to the next draft summary.'}
            </p>
          )}

          <div className={styles.actions}>
            <Button
              disabled={!seeded || tooLong || !dirty || update.pending}
              onClick={() => void onSave()}
            >
              {update.pending ? 'Saving' : 'Save guidance'}
            </Button>
            <Button
              variant="ghost"
              disabled={!seeded || update.pending || trimmed.length === 0}
              onClick={() => {
                setSaved(false);
                setText('');
              }}
            >
              Clear
            </Button>
          </div>

          <p className={styles.note}>
            Clearing the box and saving removes your guidance entirely; drafts
            then use the Safentia fire safety framework on its own, exactly as
            they did before you set any.
          </p>
        </div>
      </Card>
    </div>
  );
}
