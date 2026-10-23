// ============================================================================
// BrandingPreview - "Where your branding appears".
//
// An admin edits the org name, brand colour and logo on OrganisationSettingsPage
// otherwise blind. This section shows, live from the CURRENT form values, the two
// surfaces the branding actually reaches: the generated PDF report and the branded
// notification emails. It is honest by construction - each mock mirrors its real
// consumer, so it only shows what those consumers actually do:
//
//   - Report: functions/src/report/render.ts. The title is fixed ink; the ORG
//     NAME line and the two dividers are painted in the brand colour (renderHeader
//     / sectionHeading), the logo sits top-right, and the footer carries the org
//     name (left) with "Page N of M" (right). render.ts hardcodes Helvetica, so
//     the report does NOT use the org font override - the page's font specimen
//     above already shows where that override truly lands (the console, app and
//     site). We mirror Helvetica here rather than invent a font the PDF never uses.
//
//   - Email: functions/src/lib/emailTemplates.ts (renderBrandedEmail). The brand
//     colour is a slim top accent bar plus the call-to-action button; the wordmark
//     is TYPESET dark text (not the accent, and never an image - the template has
//     no logo slot); then heading, body, a detail card and the footer note. Email
//     is light-only by design, so its surfaces are fixed, not themed.
//
// Both mocks are decorative and aria-hidden; each carries a short visible caption.
// The only non-token colours are the org's own brand value and logo (the whole
// point) and each consumer's OWN fixed palette, since neither surface is themed.
// The secondary brand colour is intentionally absent: neither the report nor the
// branded email consumes it (it dresses the console/app theme, not these).
// ============================================================================

import { StoredImage } from '../lib/StoredFile';
import styles from './BrandingPreview.module.css';

/** The PDF's fixed palette, mirroring COLOURS in report/render.ts. A PDF is
 *  always white paper in every console theme. */
const PAPER = {
  surface: '#FFFFFF',
  ink: '#1F2937',
  muted: '#6B7280',
  hairline: '#E5E7EB',
} as const;

/** The email's fixed light palette, mirroring COLOURS in lib/emailTemplates.ts. */
const EMAIL = {
  background: '#F7F8FA',
  surface: '#FFFFFF',
  border: '#D8DCE3',
  text: '#10141A',
  textSecondary: '#4A525E',
  textMuted: '#737C89',
} as const;

/** The email body font stack, mirroring FONT_STACK in emailTemplates.ts. */
const EMAIL_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The report font, mirroring FONT (Helvetica) in render.ts. The PDF never uses
 *  the org font override, so neither does this mock. */
const REPORT_FONT = "Helvetica, Arial, sans-serif";

/** Accept only a valid #RGB / #RRGGBB colour, else fall back - the same guard
 *  render.ts (safeColour) applies before painting with a brand value, so a
 *  half-typed hex renders honestly rather than as garbage. */
function safeColour(value: string, fallback: string): string {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
}

export interface BrandingPreviewProps {
  /** The org name as it will read on the report and in the email wordmark. */
  orgName: string;
  /** The brand primary colour (hex) from the current form values. */
  brandPrimary: string;
  /** The logo the report shows top-right, or null when none is set. */
  logoUrl: string | null;
}

export function BrandingPreview({ orgName, brandPrimary, logoUrl }: BrandingPreviewProps) {
  const brand = safeColour(brandPrimary, PAPER.ink);
  const emailAccent = safeColour(brandPrimary, EMAIL.text);
  // Example content, clearly illustrative - never real assessment data.
  const buildingExample = 'Marlowe House';

  return (
    <div className={styles.section}>
      <div className={styles.grid}>
        {/* --- Report header + footer mock (aria-hidden decoration) --- */}
        <div className={styles.panel}>
          <span className={styles.caption} id="branding-report-caption">
            How your report header will look
          </span>
          <div
            className={styles.paper}
            style={{ background: PAPER.surface, fontFamily: REPORT_FONT }}
            aria-hidden="true"
          >
            <div className={styles.paperTop}>
              <div className={styles.paperHead}>
                <div style={{ fontSize: '1.35rem', fontWeight: 700, color: PAPER.ink }}>
                  Fire Risk Assessment
                </div>
                <div
                  data-testid="branding-report-org"
                  style={{ marginTop: '0.15rem', fontSize: '0.95rem', color: brand }}
                >
                  {orgName}
                </div>
                <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: PAPER.muted }}>
                  Report generated on 15 July 2026
                </div>
                {/* Brand divider under the cover block (render.ts renderHeader). */}
                <div
                  data-testid="branding-report-rule"
                  style={{
                    marginTop: '0.6rem',
                    height: '2px',
                    background: brand,
                    borderRadius: '1px',
                  }}
                />
              </div>
              {logoUrl && (
                <StoredImage className={styles.paperLogo} reference={logoUrl} alt="" />
              )}
            </div>
            {/* Footer strip: hairline, org name left, page number right. */}
            <div
              className={styles.paperFootRule}
              style={{ height: '1px', background: PAPER.hairline }}
            />
            <div className={styles.paperFoot}>
              <span style={{ fontSize: '0.65rem', color: PAPER.muted }}>{orgName}</span>
              <span style={{ fontSize: '0.65rem', color: PAPER.muted }}>Page 1 of 8</span>
            </div>
          </div>
          <p className={styles.note}>
            Your name, brand colour and logo appear on the report cover and footer.
            The report always uses the Safentia report typeface (Helvetica).
          </p>
        </div>

        {/* --- Branded email mock (aria-hidden decoration) --- */}
        <div className={styles.panel}>
          <span className={styles.caption} id="branding-email-caption">
            How notification emails will look
          </span>
          <div
            className={styles.email}
            style={{
              background: EMAIL.surface,
              border: `1px solid ${EMAIL.border}`,
              fontFamily: EMAIL_FONT,
            }}
            aria-hidden="true"
          >
            {/* The accent top bar (renderBrandedEmail's brand-colour strip). */}
            <div
              data-testid="branding-email-accent"
              className={styles.emailAccentBar}
              style={{ background: emailAccent }}
            />
            <div className={styles.emailBody}>
              {/* Typeset wordmark: dark text, never an image (email has no logo slot). */}
              <div
                data-testid="branding-email-wordmark"
                className={styles.emailWordmark}
                style={{ color: EMAIL.text }}
              >
                {orgName}
              </div>
              <div className={styles.emailHeading} style={{ color: EMAIL.text }}>
                Your assessment for {buildingExample} has been released.
              </div>
              <p className={styles.emailPara} style={{ color: EMAIL.textSecondary }}>
                A fire risk assessment of {buildingExample} has been released with
                its action plan ready to review.
              </p>
              <p className={styles.emailPara} style={{ color: EMAIL.textSecondary }}>
                Please review the action plan and arrange the remedial work before
                the due dates pass.
              </p>
              <div
                className={styles.emailDetail}
                style={{ background: EMAIL.background, border: `1px solid ${EMAIL.border}` }}
              >
                <div className={styles.emailDetailLabel} style={{ color: EMAIL.textMuted }}>
                  Building
                </div>
                <div className={styles.emailDetailValue} style={{ color: EMAIL.text }}>
                  {buildingExample}
                </div>
              </div>
              {/* The bulletproof CTA button, painted in the accent. */}
              <span className={styles.emailCta} style={{ background: emailAccent }}>
                View assessment
              </span>
            </div>
            <div
              className={styles.emailFoot}
              style={{ borderTop: `1px solid ${EMAIL.border}`, color: EMAIL.textMuted }}
            >
              You are receiving this because you are the responsible party for{' '}
              {buildingExample} on Safentia.
            </div>
          </div>
          <p className={styles.note}>
            Notification emails lead with your name and are dressed in your brand
            colour on the accent bar and action button. This is an example, not a
            real message.
          </p>
        </div>
      </div>
    </div>
  );
}
