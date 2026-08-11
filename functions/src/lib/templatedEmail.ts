// ============================================================================
// templatedEmail - the server seam every kind-based email send goes through
// (section 6b).
//
// This is where the three pure mirrored modules meet the impure world: the
// kind catalogue (default copy + category + toggle policy), the variable
// engine (rendering) and the branded HTML renderer are combined with the
// org's RTDB settings and handed to the dispatch seam. The design rule
// throughout is that A BUSINESS SEND MUST NEVER FAIL OVER CONFIGURATION:
// a missing settings node, an unreadable database, a deleted or malformed
// assigned template all degrade to "enabled, built-in default copy" - the
// exact behaviour the platform had before templating existed - with a warning
// in the runtime logs so the degradation is observable.
//
// The RTDB reads use the same lazy `await import('../admin')` pattern as
// lib/email's appendEmailLog, so jest consumers of this module never touch
// firebase-admin initialisation.
// ============================================================================

import type { EmailKindId, EmailKindSettings, Environment } from '../shared/types';
import { forEnv } from '../shared/paths';
import { EMAIL_KINDS } from './emailKindCatalogue';
import { isRenderableTemplate, renderTemplate } from './emailVariableEngine';
import type { EmailTemplateShape } from './emailVariableEngine';
import { renderBrandedEmail, SAFENTIA_BRAND } from './emailHtml';
import type { EmailBrand } from './emailHtml';
import { dispatchEmail } from './email';
import type { Logger } from './logging';

/** An org's resolved configuration for one email kind: whether it may send and
 *  which template to render. Produced by loadKindConfig; crons preload one per
 *  (org, kind) and reuse it across every recipient in the batch. */
export interface KindConfig {
  kind: EmailKindId;
  /** False only when the kind allows toggling AND the org set enabled === false. */
  enabled: boolean;
  /** The org's assigned template, already validated with isRenderableTemplate;
   *  null = use built-in default. */
  template: EmailTemplateShape | null;
  /** Set only when template is non-null. */
  templateId?: string;
  /** Whether the org's plan includes the branding feature (Phase 3 §6). False
   *  ⇒ sendKindEmail dresses the email in the Safentia accent instead of the
   *  org's stored colour. Resolved here - once per (org, kind), cached with
   *  the rest of the config across a cron batch - because this seam is the
   *  single choke point every org-branded business email passes through. */
  brandingAllowed: boolean;
}

/**
 * One settings+template read per (org, kind); crons preload and reuse across
 * recipients. An assigned templateId whose doc is missing or fails
 * isRenderableTemplate resolves to template null + logger.warn (fallback to
 * the built-in default - a business send must never fail over a bad template).
 * A failed RTDB read likewise degrades to defaults (enabled, built-in copy)
 * rather than throwing.
 */
export async function loadKindConfig(
  env: Environment,
  orgId: string,
  kind: EmailKindId,
  logger: Logger,
): Promise<KindConfig> {
  const def = EMAIL_KINDS[kind];
  try {
    // ====
    // Lazy admin import (the appendEmailLog pattern): pure-unit consumers of
    // this module must never trigger firebase-admin initialisation.
    // ====
    const { db } = await import('../admin');
    // Lazily too: planContext imports ../admin eagerly, so pulling it in at
    // module load would defeat the pattern above.
    const { resolvePlanContext } = await import('./planContext');
    const envPaths = forEnv(env);
    const paths = envPaths.db;
    const [settings, planContext] = await Promise.all([
      db
        .ref(paths.emailKindSetting(orgId, kind))
        .get()
        .then((snap) => snap.val() as EmailKindSettings | null),
      // ONE plan-context read per (org, kind) load serves BOTH Phase 3 email
      // gates (§6): emailTemplates decides whether the org's assigned template
      // may replace the built-in copy, branding decides the accent below.
      // Grandfather rule throughout: a missing subscription/plan resolves to
      // both features on.
      resolvePlanContext(envPaths, orgId),
    ]);
    const { features } = planContext.entitlements;

    // ====
    // Toggle policy: only kinds the catalogue marks toggleable can ever be
    // suppressed, whatever the settings node says - 'invitation' (a security
    // email) and 'manual' carry toggleAllowed false and always send. An
    // absent node means "enabled" by contract.
    // ====
    const enabled = !(def.toggleAllowed && settings?.enabled === false);

    let template: EmailTemplateShape | null = null;
    let templateId: string | undefined;
    if (settings?.templateId && !features.emailTemplates) {
      // ====
      // Custom email templates are a silver+ feature (Phase 3 §6): the org's
      // assignment stays stored (§6.3 - never delete) but is NOT applied, so
      // the built-in default renders exactly as it would for an org that never
      // assigned one. info, not warn: this is a plan state, not a data fault.
      // ====
      logger.info('Org email template not applied (plan lacks emailTemplates); using built-in default', {
        kind,
        orgId,
        templateId: settings.templateId,
      });
    } else if (settings?.templateId) {
      const doc: unknown = (await db.ref(paths.emailTemplate(orgId, settings.templateId)).get()).val();
      if (isRenderableTemplate(doc)) {
        template = doc;
        templateId = settings.templateId;
      } else {
        // ====
        // The assignment points at a deleted or malformed doc. Rules constrain
        // writes, but this send-boundary check is what guarantees a bad
        // template degrades to the default instead of failing the send.
        // ====
        logger.warn('Assigned email template missing or not renderable; using built-in default', {
          kind,
          orgId,
          templateId: settings.templateId,
        });
      }
    }

    return {
      kind,
      enabled,
      template,
      // RTDB-style hygiene and exact contract: templateId appears only when a
      // valid template was resolved.
      ...(templateId !== undefined ? { templateId } : {}),
      brandingAllowed: features.branding,
    };
  } catch (error) {
    // ====
    // An unreadable database must not stop a business email: degrade to the
    // pre-templating behaviour (enabled, built-in copy, org branding) and say
    // so. Branding fails OPEN here on the same grandfather posture as the
    // entitlements module: a billing-read hiccup must never strip a paying
    // org's colours off a safety email.
    // ====
    logger.warn('Email kind settings read failed; using defaults (enabled, built-in copy)', {
      kind,
      orgId,
      message: error instanceof Error ? error.message : String(error),
    });
    return { kind, enabled: true, template: null, brandingAllowed: true };
  }
}

/** Everything a send site supplies to render and dispatch one kind email. */
export interface KindSendRequest {
  kind: EmailKindId;
  env: Environment;
  orgId: string;
  to: string;
  /** Flat dotted keys matching the kind's variable catalogue (e.g. 'building.name'). */
  variables: Record<string, string>;
  brand: EmailBrand;
  /** Canonical per-recipient CTA URL; absent → any useKindLink cta is dropped
   *  by the engine. */
  kindLink?: string;
  /** Dynamic detail rows (digests, visit cards) for source:'kind' blocks. */
  kindRows?: Array<{ label: string; value: string }>;
  /** Preloaded config; when absent sendKindEmail loads it itself. */
  config?: KindConfig;
}

/**
 * Render + dispatch one kind email. Never throws. Returns whether the provider
 * accepted it. A disabled kind returns false with logger.info and writes NO
 * emailLog entry: an admin choosing silence should not flood the log with
 * suppressed rows.
 */
export async function sendKindEmail(req: KindSendRequest, logger: Logger): Promise<boolean> {
  try {
    const def = EMAIL_KINDS[req.kind];
    const config = req.config ?? (await loadKindConfig(req.env, req.orgId, req.kind, logger));

    if (!config.enabled) {
      logger.info('Email kind disabled by organisation; send suppressed', {
        kind: req.kind,
        orgId: req.orgId,
      });
      return false;
    }

    const template = config.template ?? def.defaultTemplate;
    const rendered = renderTemplate(template, req.variables, 'send', req.kindRows, req.kindLink);

    if (rendered.unknown.length > 0) {
      // ====
      // In 'send' mode unknown tokens rendered as ''. That is survivable copy
      // damage, not a reason to withhold a business email - warn and carry on.
      // ====
      logger.warn('Email template referenced unknown variables (rendered empty)', {
        kind: req.kind,
        orgId: req.orgId,
        unknown: rendered.unknown,
      });
    }

    // ====
    // Branding gate (Phase 3 §6): this seam is the ONE place every org-branded
    // business email passes through (each sender builds its brand from the org
    // profile via orgEmailBrand and hands it here), so gating the accent here
    // covers all of them without touching a single sender. The org's NAME is
    // identity, not branding - the email must still honestly say who it is
    // from - so only the accent falls back to the Safentia default.
    // ====
    const brand: EmailBrand = config.brandingAllowed
      ? req.brand
      : { name: req.brand.name, accent: SAFENTIA_BRAND.accent };

    const html = renderBrandedEmail({
      brand,
      preheader: rendered.preheader,
      heading: rendered.heading,
      paragraphs: rendered.paragraphs,
      detailRows: rendered.detailRows,
      cta: rendered.cta,
      // renderBrandedEmail requires a footerNote string; a template with no
      // footer renders an empty muted line rather than inheriting stale copy.
      footerNote: rendered.footerNote ?? '',
    });

    return await dispatchEmail(
      { to: req.to, subject: rendered.subject, body: rendered.text, html },
      logger,
      {
        orgId: req.orgId,
        env: req.env,
        category: def.category,
        kindId: req.kind,
        // Conditional spread: absent means the built-in default was rendered,
        // and RTDB rejects undefined values in the log entry.
        ...(config.templateId !== undefined ? { templateId: config.templateId } : {}),
      },
    );
  } catch (error) {
    // ====
    // Belt-and-braces for the "never throws" contract: every expected failure
    // is already absorbed above (config reads degrade, dispatch never throws),
    // so anything landing here is a programming surprise - log it loudly and
    // report the send as not delivered.
    // ====
    logger.error('Templated email send failed unexpectedly', {
      kind: req.kind,
      orgId: req.orgId,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
