// ============================================================================
// EmailTypesPage - the per-kind email matrix (section 6b). Every email the
// platform can send on the organisation's behalf, grouped by who receives it,
// with the per-kind choices an admin owns: whether the kind sends at all, and
// which template dresses it (an org-authored one, or the built-in copy) in
// each of its two forms - the ordinary single email, and the daily bundle.
//
// Storage model, mirrored from the types contract: settings live one node per
// kind at /{env}/emailSettings/{orgId}/kinds/{kindId}, and an ABSENT node
// means "enabled, built-in defaults" - so nothing is seeded, and every write
// here computes the MERGED object from the live settings snapshot (never a
// blind single-field write, which would drop the other choices) and removes
// the node entirely when every choice is back at its default.
//
// 'invitation' is a security email: its toggle renders locked with a padlock
// and an explanation, and no disable can be written. Template assignment on
// it stays open - reworded copy is the org's business, not sending at all.
//
// DELIVERY (the bundling seam, EMAIL_BUNDLING_PLAN.md §2-3). Each kind carries
// a fixed `delivery` policy in the catalogue: 'immediate' sends as it happens,
// 'collapse' sends the first of the day and bundles the rest, 'digest' always
// bundles. That policy is a property of what the email IS - a payment failure
// cannot wait for the morning, a review sweep is a daily batch by nature - so
// it is NOT stored per org and NOT editable here. The Delivery cell is
// therefore presentation, rendered in the same read-only register as the
// invitation padlock beside it: a statement of fact, not a control.
//
// DIGEST TEMPLATE. An org's ordinary template is written in the singular
// ("the review for Rose Court is due in 60 days") and cannot be reused for
// forty buildings, nor may it be rewritten under them - so bundleable kinds
// (those the catalogue gives a `digest` block) get a SECOND template slot,
// `digestTemplateId`, rather than a second EmailKindId that would double this
// matrix. Kinds with no `digest` block show no digest select at all.
//
// Preview opens the EFFECTIVE template (assigned org template when set and
// still existing, else the catalogue default) rendered through the mirrored
// engine with the kind's example values and the org's own brand, inside a
// fully sandboxed iframe - exactly what the recipient would get. For a
// bundleable kind the dialog also offers the BUNDLED form, rendered through
// the same engine with the uniform digest vocabulary, because an admin who
// may author that copy must be able to see it.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { ref, set } from 'firebase/database';
import { firebase } from '../../firebase';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  EmailDeliveryPolicy,
  EmailKindId,
  EmailKindSettings,
  EmailTemplate,
} from '../../types';
import { useEntitlements } from '../billing/useEntitlements';
import { UpsellNotice } from '../billing/UpsellNotice';
import { Card, CardHeader } from '../ui/Card';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { sortByName, toEntries, useOrgScope } from '../customers/shared';
import {
  CONFIGURABLE_EMAIL_KIND_IDS,
  EMAIL_KINDS,
  type EmailKindDefinition,
} from './emailKindCatalogue';
import { renderTemplate, type EmailTemplateShape } from './emailVariableEngine';
import { renderBrandedEmail } from './emailHtml';
import { EmailsDialog } from './EmailsDialog';
import { useOrgEmailBrand } from './useOrgEmailBrand';
import styles from './EmailTypesPage.module.css';

// ----------------------------------------------------------------------------
// Grouping - the catalogue's audience field, in the order an admin thinks in.
// ----------------------------------------------------------------------------

const GROUPS = [
  {
    audience: 'org-member',
    title: 'Your team',
    hint: 'Sent to assessors, auditors and administrators at your organisation.',
  },
  {
    audience: 'customer-contact',
    title: 'Customer contacts',
    hint: 'Sent to the people your customers have named against their buildings.',
  },
  {
    audience: 'invitee',
    title: 'Invitations',
    hint: 'Sent to email addresses invited to join your organisation.',
  },
] as const;

// ----------------------------------------------------------------------------
// Delivery - how a kind reaches its recipient.
//
// The policy is declared per kind in the catalogue and is the same for every
// organisation, so there is nothing to choose here and nothing to save. The
// copy below is customer-facing and signed off: 'collapse' and 'digest' are
// mechanically different (one sends the day's first message as it happens, the
// other never does) but an admin only needs to know what will land in the
// inbox, so both are described as bundled daily and only the hint separates
// them. Do not reword either without the same sign-off.
// ----------------------------------------------------------------------------

const DELIVERY_COPY: Record<
  EmailDeliveryPolicy,
  { label: string; hint: string }
> = {
  immediate: {
    label: 'Sends immediately',
    hint: 'Sent as it happens.',
  },
  collapse: {
    label: 'Bundled daily',
    hint: 'The first each day is sent as it happens; the rest arrive in one summary the next morning.',
  },
  digest: {
    label: 'Bundled daily',
    hint: 'Everything from the day arrives in one summary each morning.',
  },
};

// ----------------------------------------------------------------------------
// Preview scaffolding - example values so the rendered email reads real.
// ----------------------------------------------------------------------------

/** The origin the previews' links are written against. Only ever a stand-in:
 *  the real per-recipient URL is built by the send site, and the digest's
 *  list-level URL by the flush, which owns WEB_ORIGIN. */
const SAMPLE_ORIGIN = 'https://safentia.co.uk';

/** Representative rows for kinds whose detail card is send-site supplied; the
 *  preview needs SOMETHING in the slot or the card silently vanishes. */
const SAMPLE_KIND_ROWS = [
  { label: 'Building', value: 'Rose Court' },
  { label: 'Scheduled', value: 'Tuesday, 11 August 2026, 09:00–11:00' },
];

/** The same idea one layer up: a digest's rows are one line PER BUNDLED ITEM,
 *  not one line per field, so the preview needs a short list rather than a
 *  detail card or the bundled copy reads like a single email that happens to
 *  say 'four'. Four entries, matching the count phrase below, with the last
 *  one overdue so the list shows the variety a real morning has in it. */
const SAMPLE_DIGEST_ROWS = [
  { label: 'Rose Court', value: 'Due 5 October 2026 (60 days)' },
  { label: 'Alder House', value: 'Due 12 October 2026 (67 days)' },
  { label: 'Beckett Court', value: 'Due 19 October 2026 (74 days)' },
  { label: 'Priory Gardens', value: 'Overdue by 4 days' },
];

/** A stand-in for the kind's canonical per-recipient link, so the preview's
 *  button renders. */
const SAMPLE_KIND_LINK = `${SAMPLE_ORIGIN}/app`;

/** The full HTML document a preview shows: a template rendered with example
 *  values under the org's brand. Both forms - the single email and the daily
 *  bundle - go through this one function, and therefore through the one
 *  mirrored engine and the one branded renderer, because a preview that
 *  rendered by a second route could disagree with what is actually sent. */
function previewHtml(
  effective: EmailTemplateShape,
  variables: Record<string, string>,
  brand: { name: string; accent: string },
  kindRows: Array<{ label: string; value: string }> | undefined,
  kindLink: string | undefined,
): string {
  const rendered = renderTemplate(effective, variables, 'preview', kindRows, kindLink);
  return renderBrandedEmail({
    brand,
    preheader: rendered.preheader,
    heading: rendered.heading,
    paragraphs: rendered.paragraphs,
    detailRows: rendered.detailRows,
    cta: rendered.cta,
    footerNote: rendered.footerNote ?? '',
  });
}

/** The example values behind a SINGLE email's preview: whatever the kind's
 *  send site supplies, as declared in the catalogue. */
function singleVariables(kind: EmailKindDefinition): Record<string, string> {
  const map: Record<string, string> = {};
  for (const spec of kind.variables) {
    map[spec.name] = spec.example;
  }
  return map;
}

/** The example values behind a BUNDLE's preview. Unlike the single form this
 *  vocabulary is uniform across every bundleable kind - count, count phrase,
 *  the capped-items note and the org's name - which is the whole point: an
 *  admin writing digest copy has one small set of variables to learn.
 *  `digest.moreNote` is deliberately empty, the ordinary case, so the preview
 *  also demonstrates that its paragraph omits itself when nothing was capped. */
function digestVariables(
  kind: EmailKindDefinition,
  brand: { name: string },
): Record<string, string> {
  const count = SAMPLE_DIGEST_ROWS.length;
  const plural = kind.digest?.noun[1] ?? 'items';
  return {
    'org.name': brand.name,
    'digest.count': String(count),
    'digest.countPhrase': `${count} ${plural}`,
    'digest.moreNote': '',
  };
}

// ----------------------------------------------------------------------------
// The page.
// ----------------------------------------------------------------------------

export default function EmailTypesPage() {
  const { ready, orgId, db } = useOrgScope();
  const brand = useOrgEmailBrand();

  // Entitlement gate (§6.3 visible-but-locked): without the emailTemplates
  // feature the assigned-template selects render DISABLED behind one notice -
  // assignments are kept, the server's template resolution just falls back to
  // the built-in copy meanwhile. The enable/disable toggles stay usable:
  // choosing WHICH kinds send is not a template feature.
  const billing = useEntitlements();
  const templatesLocked =
    !billing.loading && !billing.entitlements.features.emailTemplates;

  const settings = useRtdbQuery<Record<string, EmailKindSettings> | null>({
    key: keys.emailKindSettings(orgId),
    path: db?.emailKindSettings(orgId) ?? '',
    enabled: ready,
  });
  const templates = useRtdbQuery<Record<string, EmailTemplate> | null>({
    key: keys.emailTemplates(orgId),
    path: db?.emailTemplates(orgId) ?? '',
    enabled: ready,
  });

  const templateOptions = useMemo(
    () => sortByName(toEntries(templates.data)),
    [templates.data],
  );

  // One save/error status for the whole matrix: writes are single small sets,
  // and the announced outcome names the kind so the admin knows what landed.
  const [saved, setSaved] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<EmailKindId | null>(null);

  // The 'Saved' note is transient by design - it confirms, then leaves.
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(savedTimer.current), []);
  const announceSaved = (label: string) => {
    setSaved(`${label} saved.`);
    clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), 4000);
  };

  /** An assignment to a since-deleted template is DROPPED, not re-written: the
   *  rules' template-existence check would reject the whole write (so a toggle
   *  flip would fail), and the matrix already presents the stale assignment as
   *  'Built-in default'. When the template list could not be loaded we keep the
   *  id rather than destructively clearing a possibly valid assignment.
   *
   *  Both template slots run through this one predicate so the two can never
   *  drift apart - the rules validate them identically, and a digest
   *  assignment left dangling would fail the same whole write. */
  const assignmentSurvives = (templateId: string | undefined): boolean =>
    templateId !== undefined &&
    templateId !== '' &&
    (templates.isError || templates.data?.[templateId] !== undefined);

  /** Write the MERGED settings node for one kind. Defaults are expressed by
   *  ABSENCE (RTDB drops empty objects anyway), so a kind that is enabled and
   *  back on the built-in copy in BOTH template slots is removed rather than
   *  stored as `{}`. Every control on the row calls this with the whole
   *  spread-in current node, never a single field, so no choice can be lost by
   *  changing its neighbour. */
  const writeSetting = async (
    kind: EmailKindDefinition,
    next: EmailKindSettings,
  ) => {
    if (!db) {
      return;
    }
    const payload: EmailKindSettings = {};
    if (next.enabled === false) {
      payload.enabled = false;
    }
    if (assignmentSurvives(next.templateId)) {
      payload.templateId = next.templateId;
    }
    // The digest slot is carried through the same merge even for a kind whose
    // catalogue entry has no `digest` block and therefore shows no digest
    // select: an id already in the node is preserved rather than silently
    // destroyed by an unrelated toggle flip, exactly as a template assignment
    // is preserved while the plan's entitlement has it locked. The server
    // simply never reaches for it.
    if (assignmentSurvives(next.digestTemplateId)) {
      payload.digestTemplateId = next.digestTemplateId;
    }
    setWriteError(null);
    try {
      await set(
        ref(firebase.db(), db.emailKindSetting(orgId, kind.id)),
        Object.keys(payload).length === 0 ? null : payload,
      );
      announceSaved(kind.label);
    } catch {
      setSaved(null);
      setWriteError(
        'The change could not be saved. Check your connection and try again.',
      );
    }
  };

  const kinds = CONFIGURABLE_EMAIL_KIND_IDS.map((id) => EMAIL_KINDS[id]);
  const loading = settings.isLoading || templates.isLoading;

  return (
    <div className={styles.root}>
      <PageHeader
        title="Email types"
        lede="Every email Safentia sends on your organisation's behalf. Choose which types send, and which template each one uses."
      />

      {/* The guarantee behind the Delivery column, said once at the top so the
          per-row hints are a detail rather than a surprise. */}
      <p className={styles.guarantee}>
        Nobody receives more than one email of each type per day: anything
        further that day arrives in a single summary the next morning.
      </p>

      {templatesLocked && (
        <UpsellNotice
          message="Email templates aren't included in your plan, so every email type uses the built-in default. Your template assignments are kept and will apply again when your plan includes them."
          isAdmin={billing.isAdmin}
        />
      )}

      {(settings.isError || templates.isError) && (
        <ErrorNotice message="The email settings could not be loaded. They may still be syncing - try again shortly." />
      )}
      {writeError && <ErrorNotice message={writeError} />}
      <p role="status" className={styles.saveStatus}>
        {saved ?? ''}
      </p>

      {loading ? (
        <Card>
          <div className={styles.skeletonWrap}>
            <SkeletonRows rows={6} label="Loading email types" />
          </div>
        </Card>
      ) : (
        GROUPS.map((group) => {
          const members = kinds.filter((kind) => kind.audience === group.audience);
          if (members.length === 0) {
            return null;
          }
          return (
            <Card key={group.audience}>
              <CardHeader title={group.title} hint={group.hint} />
              <ul className={styles.kindList}>
                {members.map((kind) => {
                  const current = settings.data?.[kind.id] ?? {};
                  const enabled = current.enabled !== false;
                  // An assignment to a since-deleted template is shown as the
                  // built-in default - which is exactly what the server sends.
                  const assigned =
                    current.templateId !== undefined &&
                    templates.data?.[current.templateId] !== undefined
                      ? current.templateId
                      : '';
                  const assignedDigest =
                    current.digestTemplateId !== undefined &&
                    templates.data?.[current.digestTemplateId] !== undefined
                      ? current.digestTemplateId
                      : '';
                  const locked = !kind.toggleAllowed;
                  const delivery = DELIVERY_COPY[kind.delivery];
                  // Locked AND immediate: the padlock says both, so the
                  // separate delivery cell would only repeat it.
                  const deliveryFolded = locked && kind.delivery === 'immediate';
                  return (
                    <li key={kind.id} className={styles.kindRow}>
                      <div className={styles.kindText}>
                        <span className={styles.kindLabel}>{kind.label}</span>
                        <span className={styles.kindDescription}>
                          {kind.description}
                        </span>
                      </div>
                      <div className={styles.kindControls}>
                        {locked ? (
                          // ====
                          // A kind that is BOTH locked and 'immediate' would
                          // otherwise read "Always sends" beside "Sends
                          // immediately" - two true statements that sound like
                          // one said twice. Folded into a single sentence, and
                          // the delivery cell below is suppressed for it.
                          // ====
                          <span
                            className={styles.lockedToggle}
                            title={
                              deliveryFolded
                                ? 'Security emails always send, as they happen, and cannot be turned off.'
                                : 'Security emails always send and cannot be turned off.'
                            }
                          >
                            <input
                              type="checkbox"
                              checked
                              disabled
                              aria-label={`${kind.label} ${deliveryFolded ? 'always sends immediately' : 'always sends'}: security emails cannot be turned off`}
                            />
                            <span aria-hidden="true">🔒</span>
                            <span>
                              {deliveryFolded
                                ? 'Always sends immediately'
                                : 'Always sends'}
                            </span>
                          </span>
                        ) : (
                          <label className={styles.toggle}>
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(event) =>
                                void writeSetting(kind, {
                                  ...current,
                                  enabled: event.target.checked,
                                })
                              }
                            />
                            <span>Enabled</span>
                          </label>
                        )}
                        {/* Delivery: fixed in the catalogue, identical for
                            every organisation, so it is stated rather than
                            offered - the same read-only register as the
                            padlock above. The hint is on `title` for a mouse
                            and repeated visually-hidden for a screen reader,
                            because a bare `title` on a <span> is announced by
                            almost nothing. */}
                        {!deliveryFolded && (
                          <span className={styles.delivery} title={delivery.hint}>
                            <span className={styles.deliveryLabel}>
                              {delivery.label}
                            </span>
                            <span className={styles.srOnly}>
                              {` — ${delivery.hint}`}
                            </span>
                          </span>
                        )}
                        <label className={styles.templateField}>
                          <span className={styles.templateLabel}>Template</span>
                          <select
                            className={styles.templateSelect}
                            disabled={templatesLocked}
                            value={assigned}
                            onChange={(event) =>
                              void writeSetting(kind, {
                                ...current,
                                templateId: event.target.value || undefined,
                              })
                            }
                          >
                            <option value="">Built-in default</option>
                            {templateOptions.map(([id, template]) => (
                              <option key={id} value={id}>
                                {template.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        {/* Only a kind the catalogue gives a `digest` block can
                            ever be bundled, so only those get a second slot -
                            an unbundleable kind would offer a template that
                            nothing could ever render. Same entitlement gate as
                            its neighbour: the digest copy is a template
                            feature exactly as the single copy is. */}
                        {kind.digest !== undefined && (
                          <label className={styles.templateField}>
                            <span className={styles.templateLabel}>
                              Digest template
                            </span>
                            <select
                              className={styles.templateSelect}
                              disabled={templatesLocked}
                              value={assignedDigest}
                              onChange={(event) =>
                                void writeSetting(kind, {
                                  ...current,
                                  digestTemplateId:
                                    event.target.value || undefined,
                                })
                              }
                            >
                              <option value="">Built-in default</option>
                              {templateOptions.map(([id, template]) => (
                                <option key={id} value={id}>
                                  {template.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <Button
                          variant="ghost"
                          onClick={() => setPreviewKind(kind.id)}
                        >
                          Preview
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          );
        })
      )}

      {previewKind !== null && (
        <KindPreviewDialog
          kind={EMAIL_KINDS[previewKind]}
          settings={settings.data?.[previewKind] ?? {}}
          templates={templates.data ?? null}
          brand={brand}
          onClose={() => setPreviewKind(null)}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// The preview dialog - the effective template, rendered as the email itself.
//
// A bundleable kind has TWO effective templates, and the second is the one an
// admin is least able to picture: it is only ever sent on a day busy enough to
// have collapsed, which may be no day this month. So the dialog carries a form
// switch rather than making the bundled copy previewable only by waiting for a
// heavy morning. It is a two-option radio group in the page's own control
// idiom, not a new one, and it disappears entirely for kinds that never bundle.
// ----------------------------------------------------------------------------

type PreviewForm = 'single' | 'digest';

function KindPreviewDialog({
  kind,
  settings,
  templates,
  brand,
  onClose,
}: {
  kind: EmailKindDefinition;
  settings: EmailKindSettings;
  templates: Record<string, EmailTemplate> | null;
  brand: { name: string; accent: string };
  onClose: () => void;
}) {
  const bundleable = kind.digest !== undefined;
  const [form, setForm] = useState<PreviewForm>('single');
  // Guard the state against a kind that cannot bundle: the switch is not
  // rendered for those, so 'digest' could only be reached by a stale state,
  // and falling through to `kind.digest` would be a crash rather than a blank.
  const showingDigest = form === 'digest' && kind.digest !== undefined;

  // The EFFECTIVE template for whichever form is on show: the assigned org
  // template when it still exists, else the built-in default - the same
  // resolution the send path applies, applied slot for slot.
  const assignedId = showingDigest ? settings.digestTemplateId : settings.templateId;
  const assigned = assignedId !== undefined ? templates?.[assignedId] : undefined;
  const builtIn: EmailTemplateShape = showingDigest
    ? // Narrowed by `showingDigest`; the fallback keeps the type total.
      kind.digest?.defaultTemplate ?? kind.defaultTemplate
    : kind.defaultTemplate;
  const effective: EmailTemplateShape = assigned ?? builtIn;
  const usingDefault = assigned === undefined;

  // The bundled form's rows and link are ALWAYS supplied, regardless of the
  // kind's own hasKindRows/hasKindLink: those two flags describe the single
  // email's send site, whereas every digest template in the catalogue is built
  // from a rows block and a list-level CTA by construction.
  const variables = useMemo(
    () => (showingDigest ? digestVariables(kind, brand) : singleVariables(kind)),
    [kind, brand, showingDigest],
  );
  const kindRows = showingDigest
    ? SAMPLE_DIGEST_ROWS
    : kind.hasKindRows
      ? SAMPLE_KIND_ROWS
      : undefined;
  // Memoised only so the rendered-HTML memo below keeps a stable dependency:
  // the digest branch builds a fresh string every render otherwise.
  const kindLink = useMemo(
    () =>
      showingDigest
        ? `${SAMPLE_ORIGIN}${kind.digest?.ctaPath ?? '/app'}`
        : kind.hasKindLink
          ? SAMPLE_KIND_LINK
          : undefined,
    [kind, showingDigest],
  );

  const subject = renderTemplate(effective, variables, 'preview').subject;
  const html = useMemo(
    () => previewHtml(effective, variables, brand, kindRows, kindLink),
    [effective, variables, brand, kindRows, kindLink],
  );

  const meta = showingDigest
    ? usingDefault
      ? 'Showing the built-in digest template, with example values in place of the real ones. This is the form sent when two or more of these emails collapse into one daily summary.'
      : `Showing the assigned digest template '${assigned.name}', with example values in place of the real ones. This is the form sent when two or more of these emails collapse into one daily summary.`
    : usingDefault
      ? 'Showing the built-in default template, with example values in place of the real ones.'
      : `Showing the assigned template '${assigned.name}', with example values in place of the real ones.`;

  return (
    <EmailsDialog
      title={`Preview: ${kind.label}`}
      titleId="email-kind-preview-title"
      wide
      onClose={onClose}
    >
      {bundleable && (
        // A div with role="radiogroup" rather than a fieldset/legend: a legend
        // is laid out specially and does not participate in its fieldset's
        // flex flow, which would put the label on its own line for no reason.
        // The radios are native and share a `name`, so the grouping is real
        // either way; the role only carries the group's name.
        <div
          className={styles.formChoice}
          role="radiogroup"
          aria-label="Preview form"
        >
          <span className={styles.formChoiceLegend} aria-hidden="true">
            Show
          </span>
          <label className={styles.formChoiceOption}>
            <input
              type="radio"
              name="email-preview-form"
              checked={!showingDigest}
              onChange={() => setForm('single')}
            />
            <span>Single email</span>
          </label>
          <label className={styles.formChoiceOption}>
            <input
              type="radio"
              name="email-preview-form"
              checked={showingDigest}
              onChange={() => setForm('digest')}
            />
            <span>Bundled daily</span>
          </label>
        </div>
      )}
      <p className={styles.previewMeta}>{meta}</p>
      <p className={styles.previewSubject}>
        <span className={styles.previewSubjectLabel}>Subject</span> {subject}
      </p>
      <iframe
        className={styles.previewFrame}
        title={`Rendered preview of the ${kind.label} email`}
        sandbox=""
        srcDoc={html}
      />
      <div className={styles.previewFooter}>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </EmailsDialog>
  );
}
