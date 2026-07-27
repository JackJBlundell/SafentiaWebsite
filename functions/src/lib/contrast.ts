// ============================================================================
// WCAG contrast utilities for server-rendered output (email HTML and the report
// PDF).
//
// Why a second copy of maths that already exists in the web app's design layer:
// the Functions package does not import from `src/`, and both surfaces face the
// same problem for the same reason. A brand colour is client-managed (an org sets
// its own in the console) and Safentia's own default is a pale gold, so neither
// an email button label nor a PDF heading can assume a dark accent. The rule is
// identical to the design system's: a brand colour is shipped as a FILL as given,
// and darkened only when it has to be read.
//
// Keep the thresholds and the algorithm in step with
// `fireritesite/src/design/tokens/contrast.ts`.
// ============================================================================

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** AA threshold for normal-size text and meaningful UI components. */
export const AA_NORMAL = 4.5;

/** Near-black and near-white, matching ON_FILL in the design palette. */
export const ON_FILL_LIGHT = '#FFFFFF';
export const ON_FILL_DARK = '#10141A';

function hexToRgb(hex: string): Rgb {
  const cleaned = hex.trim().replace(/^#/, '');
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex colour: "${hex}"`);
  }
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Relative luminance per WCAG 2.1 (sRGB gamma-expanded). */
function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, 1 (identical) .. 21 (black on white). */
export function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(hexToRgb(foreground));
  const l2 = relativeLuminance(hexToRgb(background));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Pick whichever of near-black and near-white reads better ON the given fill.
 * Used for an email CTA label, where the button face is the brand colour and the
 * label must be legible whatever colour that turns out to be. Returns near-white
 * unchanged if the colour cannot be parsed, matching the caller's own fallback
 * behaviour for a malformed stored brand.
 */
export function readableTextOn(background: string): string {
  try {
    return contrastRatio(ON_FILL_LIGHT, background) >=
      contrastRatio(ON_FILL_DARK, background)
      ? ON_FILL_LIGHT
      : ON_FILL_DARK;
  } catch {
    return ON_FILL_LIGHT;
  }
}

/**
 * Nudge a colour towards black or white in small steps until it meets AA against
 * `background`, or until it cannot improve further. Darkens against a light
 * background and lightens against a dark one, so the result stays a shade of the
 * original hue rather than becoming a different colour.
 */
export function adjustToMeetAA(colour: string, background: string): string {
  let start: Rgb;
  let bgLum: number;
  try {
    start = hexToRgb(colour);
    bgLum = relativeLuminance(hexToRgb(background));
  } catch {
    // An unparseable colour is the caller's fallback problem, not ours; hand it
    // back untouched so the caller's own validation decides what to do.
    return colour;
  }
  if (contrastRatio(colour, background) >= AA_NORMAL) {
    return colour;
  }

  const towards: Rgb =
    bgLum > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  let best = colour;
  for (let step = 0; step <= 20; step += 1) {
    const t = step / 20;
    const candidate: Rgb = {
      r: start.r + (towards.r - start.r) * t,
      g: start.g + (towards.g - start.g) * t,
      b: start.b + (towards.b - start.b) * t,
    };
    best = rgbToHex(candidate);
    if (contrastRatio(best, background) >= AA_NORMAL) {
      break;
    }
  }
  return best;
}
