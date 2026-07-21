// ============================================================================
// WCAG contrast utilities.
//
// Why this lives in the design layer: brand colours arrive per-organisation at
// runtime (brief 9.1) and may NOT meet AA against the surface we intend to place
// them on. Rather than ship an illegible accent, the theme adjusts it (brief
// 18.5: "brand colours that fail contrast must be adjusted or overlaid, not
// shipped"). The same maths verifies our own RAG tokens at build/test time so a
// safety colour can never silently regress below AA in either mode.
// ============================================================================

/** Parsed sRGB channels, each 0..255. */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse a `#RGB` or `#RRGGBB` hex string. Throws on malformed input rather than
 * guessing: a bad brand colour from the database is a data problem we want to
 * surface, not paper over with a silent default.
 */
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
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** AA threshold for normal-size text and meaningful UI components. */
export const AA_NORMAL = 4.5;
/** AA threshold for large text (>= 18.66px bold or 24px regular). */
export const AA_LARGE = 3;

/**
 * Pick whichever of two text colours (typically a near-black and a near-white)
 * reads better on the given background. Used to choose readable text ON a brand
 * accent fill without the caller having to know the brand colour's lightness.
 */
export function readableTextOn(
  background: string,
  light: string,
  dark: string,
): string {
  return contrastRatio(light, background) >= contrastRatio(dark, background)
    ? light
    : dark;
}

/**
 * Nudge a colour towards black or white in small steps until it meets the AA
 * ratio against `background`, or until it cannot improve further. Returns the
 * best achievable colour. We darken or lighten depending on which direction the
 * background needs, so a too-light brand on a light surface is darkened (and
 * vice versa) rather than inverted into a different hue.
 */
export function adjustToMeetAA(
  colour: string,
  background: string,
  large = false,
): string {
  const target = large ? AA_LARGE : AA_NORMAL;
  if (contrastRatio(colour, background) >= target) {
    return colour;
  }

  // Decide direction: if the background is light we darken the colour, if dark
  // we lighten it - the direction that increases separation fastest.
  const bgLum = relativeLuminance(hexToRgb(background));
  const towards: Rgb = bgLum > 0.5 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const start = hexToRgb(colour);

  let best = colour;
  for (let step = 0; step <= 20; step += 1) {
    const t = step / 20;
    const candidate: Rgb = {
      r: start.r + (towards.r - start.r) * t,
      g: start.g + (towards.g - start.g) * t,
      b: start.b + (towards.b - start.b) * t,
    };
    const candidateHex = rgbToHex(candidate);
    best = candidateHex;
    if (contrastRatio(candidateHex, background) >= target) {
      break;
    }
  }
  return best;
}
