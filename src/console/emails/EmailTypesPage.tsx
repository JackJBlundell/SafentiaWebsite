// ============================================================================
// EmailTypesPage - the per-kind email matrix (section 6b). Every email the
// platform can send on the organisation's behalf, grouped by who receives it,
// with the two per-kind choices an admin owns: whether the kind sends at all,
// and which template dresses it (an org-authored one, or the built-in copy).
//
// Storage model, mirrored from the types contract: settings live one node per
// kind at /{env}/emailSettings/{orgId}/kinds/{kindId}, and an ABSENT node
// means "enabled, built-in default" - so nothing is seeded, and every write
// here computes the MERGED object from the live settings snapshot (never a
// blind single-field write, which would drop the other choice) and removes
// the node entirely when both choices are back at their defaults.
//
// 'invitation' is a security email: its toggle renders locked with a padlock
// and an explanation, and no disable can be written. Template assignment on
// it stays open - reworded copy is the org's business, not sending at all.
//
// Preview opens the EFFECTIVE template (assigned org template when set and
// still existing, else the catalogue default) rendered through the mirrored
// engine with the kind's example values and the org's own brand, inside a
// fully sandboxed iframe - exactly what the recipient would get.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { ref, set } from 'firebase/database';
import { firebase } from '../../firebase';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { EmailKindId, EmailKindSettings, EmailTemplate } from '../../types';
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
// Preview scaffolding - example values so the rendered email reads real.
// ----------------------------------------------------------------------------

/** Representative rows for kinds whose detail card is send-site supplied; the
 *  preview needs SOMETHING in the slot or the card silently vanishes. */
const SAMPLE_KIND_ROWS = [
  { label: 'Building', value: 'Rose Court' },
  { label: 'Scheduled', value: 'Tuesday, 11 August 2026, 09:00–11:00' },
];

/** A stand-in for the kind's canonical per-recipient link, so the preview's
 *  button renders. */
const SAMPLE_KIND_LINK = 'https://safentia.co.uk/app';

/** The full HTML document a kind's preview shows: the effective template
 *  rendered with the kind's example values under the org's brand. */
function previewHtml(
  kind: EmailKindDefinition,
  effective: EmailTemplateShape,
  brand: { name: string; accent: string },
): string {
  const variables: Record<string, string> = {};
  for (const spec of kind.variables) {
    variables[spec.name] = spec.example;
  }
  const rendered = renderTemplate(
    effective,
    variables,
    'preview',
    kind.hasKindRows ? SAMPLE_KIND_ROWS : undefined,
    kind.hasKindLink ? SAMPLE_KIND_LINK : undefined,
  );
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

  /** Write the MERGED settings node for one kind. Defaults are expressed by
   *  ABSENCE (RTDB drops empty objects anyway), so a kind back on the built-in
   *  template and enabled is removed rather than stored as `{}`. */
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
    if (next.templateId !== undefined && next.templateId !== '') {
      // An assignment to a since-deleted template is DROPPED, not re-written:
      // the rules' template-existence check would reject the whole write (so a
      // toggle flip would fail), and the matrix already presents the stale
      // assignment as 'Built-in default'. When the template list could not be
      // loaded we keep the id rather than destructively clearing a possibly
      // valid assignment.
      if (templates.isError || templates.data?.[next.templateId] !== undefined) {
        payload.templateId = next.templateId;
      }
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
                  const locked = !kind.toggleAllowed;
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
                          <span
                            className={styles.lockedToggle}
                            title="Security emails always send and cannot be turned off."
                          >
                            <input
                              type="checkbox"
                              checked
                              disabled
                              aria-label={`${kind.label} always sends: security emails cannot be turned off`}
                            />
                            <span aria-hidden="true">🔒</span>
                            <span>Always sends</span>
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
// ----------------------------------------------------------------------------

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
  // The EFFECTIVE template: the assigned org template when it still exists,
  // else the built-in default - the same resolution the send path applies.
  const assigned =
    settings.templateId !== undefined
      ? templates?.[settings.templateId]
      : undefined;
  const effective: EmailTemplateShape = assigned ?? kind.defaultTemplate;
  const usingDefault = assigned === undefined;

  const variables = useMemo(() => {
    const map: Record<string, string> = {};
    for (const spec of kind.variables) {
      map[spec.name] = spec.example;
    }
    return map;
  }, [kind]);
  const subject = renderTemplate(effective, variables, 'preview').subject;
  const html = useMemo(
    () => previewHtml(kind, effective, brand),
    [kind, effective, brand],
  );

  return (
    <EmailsDialog
      title={`Preview: ${kind.label}`}
      titleId="email-kind-preview-title"
      wide
      onClose={onClose}
    >
      <p className={styles.previewMeta}>
        {usingDefault
          ? 'Showing the built-in default template, with example values in place of the real ones.'
          : `Showing the assigned template '${assigned.name}', with example values in place of the real ones.`}
      </p>
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
