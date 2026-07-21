// ============================================================================
// Typography - the web twin of FireRite/src/design/tokens/typography.ts.
//
// The default family stack and the per-organisation font resolution. The family
// defaults to Inter and can be overridden per-organisation
// (OrgProfile.fontFamily), applied once by the ThemeProvider as a CSS custom
// property.
//
// Inter is SELF-HOSTED (@fontsource-variable/inter). It is never fetched from the
// Google Fonts CDN: that request would disclose visitor IP addresses to a third
// party who is not a listed sub-processor under clause 11.4 of the Agreement.
// ============================================================================

/** The default family stack. Inter Variable first, then the platform UI font. */
export const SYSTEM_FONT_FAMILY =
  "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * Resolve an organisation's requested font family into a SAFE CSS stack.
 *
 * An org profile carries a bare family name (e.g. "Georgia"). Publishing that
 * raw would leave the console with no fallback at all: a visitor without the
 * font installed drops to the browser default serif - which is exactly the
 * "weird fonts when signed in" failure this guards against. So the platform
 * stack is ALWAYS appended, and a request for our own default family ("Inter",
 * "Inter Variable") resolves to the self-hosted stack rather than to a locally
 * installed Inter the visitor may not have.
 */
export function resolveFontStack(requested?: string): string {
  const cleaned = (requested ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!cleaned || /^inter( variable)?$/i.test(cleaned)) {
    return SYSTEM_FONT_FAMILY;
  }
  return `'${cleaned}', ${SYSTEM_FONT_FAMILY}`;
}
