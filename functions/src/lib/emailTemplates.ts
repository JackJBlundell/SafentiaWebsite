// ============================================================================
// Branded HTML email rendering.
//
// Every email the platform sends is a styled, branded document, never bare
// text (the plain-text body still travels alongside as the multipart fallback,
// which is also what keeps spam scores healthy). The rendering here obeys the
// rules of email clients rather than browsers, which is why it looks nothing
// like the site's CSS:
//   - table layout and inline styles only (Gmail strips <style> in many cases,
//     Outlook renders with Word's engine);
//   - no external assets at all - no hosted images, no webfonts - so the email
//     renders complete offline and nothing pings a third party when opened
//     (the same no-external-hosts stance as the site);
//   - the wordmark is typeset, not an image, so it can never appear broken.
//
// Branding is a parameter: platform emails use the Safentia default below, and
// the FR-E23 notification emails pass the organisation's own name and accent
// colour from its profile. Colours mirror the design system's light palette
// (tokens/palette.ts) - email is rendered light-only on purpose, since dark
// mode handling across clients is unreliable.
//
// EVERY dynamic value is HTML-escaped here, at the boundary. Lead fields are
// attacker-controlled public input; an unescaped value would be stored XSS in
// the recipient's mail client.
// ============================================================================

import type { OrgProfile } from '../shared/types';
import { readableTextOn } from './contrast';

/** The brand an email is dressed in. Defaults to the Safentia platform brand;
 *  org-branded emails pass the organisation's profile values. */
export interface EmailBrand {
  name: string;
  /** Accent colour (hex). Used for the header bar and the action button. */
  accent: string;
}

export const SAFENTIA_BRAND: EmailBrand = {
  name: 'Safentia',
  // DEFAULT_BRAND.primary from the design system's palette.
  accent: '#D9C554',
};

/** Exactly #RRGGBB. Mirrors the guard updateOrgProfile enforces on write and the
 *  report renderer applies on read, so a malformed stored colour can never reach
 *  the template (an unguarded value would poison the header bar / button style). */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/**
 * Build the EmailBrand an org-scoped email should carry from the sending
 * organisation's profile: its OWN name and accent when both are set to valid
 * values, falling back per-field to the Safentia platform brand when the org
 * has not set a valid one. `profile` is whatever the RTDB read returned, so it
 * is read defensively (a remote record may be null or partial).
 */
export function orgEmailBrand(profile: OrgProfile | null | undefined): EmailBrand {
  const primary = profile?.brand?.primary;
  const name = profile?.name;
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name : SAFENTIA_BRAND.name,
    accent:
      typeof primary === 'string' && HEX_COLOUR.test(primary)
        ? primary
        : SAFENTIA_BRAND.accent,
  };
}

/** Neutral shades, mirroring NEUTRALS.light in tokens/palette.ts. */
const COLOURS = {
  background: '#F7F8FA',
  surface: '#FFFFFF',
  border: '#D8DCE3',
  text: '#10141A',
  textSecondary: '#4A525E',
  textMuted: '#737C89',
} as const;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Escape a value for interpolation into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape, then turn newlines into <br> so a multi-line message keeps its
 *  shape. Order matters: escaping after the replacement would eat the tags. */
function escapeMultiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/** A label/value pair rendered as a row of the detail card. */
export interface EmailDetailRow {
  label: string;
  value: string;
}

/** A call-to-action button. `url` is escaped but otherwise trusted: callers
 *  only pass URLs they constructed themselves, never user input. */
export interface EmailCta {
  label: string;
  url: string;
}

export interface BrandedEmailOptions {
  brand?: EmailBrand;
  /** Hidden preview line shown by inboxes next to the subject. */
  preheader?: string;
  heading: string;
  /** Body copy, one string per paragraph. Plain text; escaped here. */
  paragraphs: string[];
  /** Optional label/value card (e.g. the lead's details). */
  detailRows?: EmailDetailRow[];
  cta?: EmailCta;
  /** The "why you are receiving this" line in the footer. */
  footerNote: string;
}

/**
 * Render the full HTML document for a branded email. Layout: a soft page
 * background, one centred 560px card with a brand-colour top bar, the typeset
 * wordmark, heading, paragraphs, optional detail card, optional button, and a
 * muted footer.
 */
export function renderBrandedEmail(options: BrandedEmailOptions): string {
  const brand = options.brand ?? SAFENTIA_BRAND;
  const brandName = escapeHtml(brand.name);
  const accent = escapeHtml(brand.accent);
  // The CTA label sits ON the accent, so its colour cannot be assumed. Safentia's
  // own gold is 1.74:1 under white and 10.6:1 under near-black, and a tenant may
  // set anything at all, so the readable side is chosen per accent rather than
  // hard-coded. Escaped for the same reason the accent is: it lands in a style
  // attribute, and a returned literal is no excuse to skip the guard.
  const ctaLabelColour = escapeHtml(readableTextOn(brand.accent));

  const preheader = options.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(
        options.preheader,
      )}</div>`
    : '';

  const paragraphs = options.paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:${COLOURS.textSecondary};">${escapeMultiline(
          text,
        )}</p>`,
    )
    .join('\n');

  const detailCard = options.detailRows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px 0;border:1px solid ${COLOURS.border};border-radius:10px;background:${COLOURS.background};">
${options.detailRows
  .map(
    (row) => `        <tr>
          <td style="padding:10px 16px 2px 16px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${COLOURS.textMuted};font-family:${FONT_STACK};">${escapeHtml(
            row.label,
          )}</td>
        </tr>
        <tr>
          <td style="padding:0 16px 10px 16px;font-size:15px;line-height:1.5;color:${COLOURS.text};font-family:${FONT_STACK};">${escapeMultiline(
            row.value,
          )}</td>
        </tr>`,
  )
  .join('\n')}
      </table>`
    : '';

  // The bulletproof button: a table cell painted with the accent, not a styled
  // <a> alone, so Outlook renders it as a button rather than a bare link.
  const cta = options.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 24px 0;">
        <tr>
          <td style="background:${accent};border-radius:10px;">
            <a href="${escapeHtml(options.cta.url)}" style="display:inline-block;padding:12px 28px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:${ctaLabelColour};text-decoration:none;">${escapeHtml(
              options.cta.label,
            )}</a>
          </td>
        </tr>
      </table>`
    : '';

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${COLOURS.background};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOURS.background};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:${COLOURS.surface};border:1px solid ${COLOURS.border};border-radius:14px;overflow:hidden;">
        <tr>
          <td style="height:4px;background:${accent};font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:28px 32px 0 32px;font-family:${FONT_STACK};">
            <span style="font-size:19px;font-weight:700;letter-spacing:-0.02em;color:${COLOURS.text};">${brandName}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 0 32px;font-family:${FONT_STACK};">
            <h1 style="margin:0 0 16px 0;font-size:22px;line-height:1.3;letter-spacing:-0.01em;color:${COLOURS.text};">${escapeHtml(
              options.heading,
            )}</h1>
${paragraphs}
${detailCard}
${cta}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 28px 32px;border-top:1px solid ${COLOURS.border};font-family:${FONT_STACK};">
            <p style="margin:0;font-size:12px;line-height:1.6;color:${COLOURS.textMuted};">${escapeHtml(
              options.footerNote,
            )}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
