// ============================================================================
// Colour palette - the raw colour values.
//
// Two tiers, deliberately separated (brief 9.1 / 18.5):
//
//   SEMANTIC tokens (RAG + error/success/warning/info): a FIXED safety language.
//   These NEVER change with brand. Red/Amber/Green carry meaning a colour-blind
//   assessor relies on, so every screen pairs them with a label or icon and we
//   verify their contrast against the surfaces they appear on in BOTH modes
//   (see contrast.test.ts).
//
//   BRAND tokens (accent/header) are applied per-organisation at runtime on top
//   of the neutral base - they are NOT defined here, they come from the org
//   profile via the ThemeProvider.
//
// The shades below were chosen so the "on*" foreground pairs clear WCAG AA.
// ============================================================================

/** Red-Amber-Green, fixed across all themes and both light/dark modes. The
 *  shades differ per mode so each clears AA against that mode's surfaces while
 *  still reading unmistakably as red, amber or green. */
export const RAG = {
  light: {
    red: '#C0271F', // high risk
    amber: '#8A5A00', // medium risk (a dark amber so text-on-surface clears AA)
    green: '#1F7A3D', // low risk
    // Soft fills for chips/backgrounds; text uses the strong shade above.
    redSurface: '#FCE9E8',
    amberSurface: '#FBF1DD',
    greenSurface: '#E6F4EC',
  },
  dark: {
    red: '#FF6B61',
    amber: '#FFC24B',
    green: '#56D98A',
    redSurface: '#3A1A18',
    amberSurface: '#3A2E12',
    greenSurface: '#12321F',
  },
} as const;

/** Functional status colours (distinct from RAG risk; e.g. a failed sync toast). */
export const STATUS = {
  light: {
    error: '#C0271F',
    onError: '#FFFFFF',
    errorSurface: '#FCE9E8',
    success: '#1F7A3D',
    onSuccess: '#FFFFFF',
    successSurface: '#E6F4EC',
    warning: '#8A5A00',
    onWarning: '#FFFFFF',
    warningSurface: '#FBF1DD',
    info: '#1A5FB4',
    onInfo: '#FFFFFF',
    infoSurface: '#E7F0FB',
  },
  dark: {
    error: '#FF6B61',
    onError: '#2A0F0D',
    errorSurface: '#3A1A18',
    success: '#56D98A',
    onSuccess: '#062012',
    successSurface: '#12321F',
    warning: '#FFC24B',
    onWarning: '#2A1F06',
    warningSurface: '#3A2E12',
    info: '#74A8E8',
    onInfo: '#0A1A2E',
    infoSurface: '#13243A',
  },
} as const;

/** Neutral ramp - backgrounds, surfaces, borders, text. The base look before
 *  brand accenting. Cool-neutral greys read crisply in bright field light. */
export const NEUTRALS = {
  light: {
    background: '#F7F8FA',
    surface: '#FFFFFF',
    surfaceAlt: '#F0F2F5',
    surfaceSunken: '#ECEEF2',
    border: '#D8DCE3',
    borderStrong: '#B9C0CB',
    text: '#10141A',
    textSecondary: '#4A525E',
    textMuted: '#737C89',
    textInverse: '#FFFFFF',
    overlay: 'rgba(16, 20, 26, 0.45)',
    skeleton: '#E4E7EC',
    skeletonHighlight: '#F2F4F7',
  },
  dark: {
    background: '#0E1217',
    surface: '#171C23',
    surfaceAlt: '#1F2630',
    surfaceSunken: '#0A0E12',
    border: '#2C333D',
    borderStrong: '#3C444F',
    text: '#F2F4F7',
    textSecondary: '#B6BEC9',
    textMuted: '#7E8794',
    textInverse: '#10141A',
    overlay: 'rgba(0, 0, 0, 0.6)',
    skeleton: '#222A33',
    skeletonHighlight: '#2C353F',
  },
} as const;

/** The default brand accent used before an org profile loads, and as the
 *  fallback when an org has not set one. A clean, confident medium blue. */
export const DEFAULT_BRAND = {
  primary: '#2563EB',
  secondary: '#1E3A8A',
} as const;

/** Near-black / near-white used by the contrast helper to choose readable text
 *  ON a brand fill. Kept here so the choice references the palette, not a magic
 *  literal at the call site. */
export const ON_FILL = {
  light: '#FFFFFF',
  dark: '#10141A',
} as const;
