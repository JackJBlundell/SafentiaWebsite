// ============================================================================
// Theme assembly.
//
// A Theme is the FULLY RESOLVED set of values a component reads: neutral
// surfaces for the active colour scheme, the FIXED safety colours (RAG +
// status), and the per-org BRAND accent already contrast-corrected for this
// scheme. Components never reach for raw tokens - they read `theme.*`, so the
// brand layer and the light/dark layer are applied in exactly one place.
//
// Brief 9.1 / 18.5: brand colours layer on top of the base system and must keep
// AA contrast; a brand colour that fails against its intended surface is
// adjusted here (not at every call site), and RAG is never touched by brand.
// ============================================================================

import type { OrgBrand } from '../types';
import { adjustToMeetAA, readableTextOn } from './tokens/contrast';
import {
  DEFAULT_BRAND,
  NEUTRALS,
  ON_FILL,
  RAG,
  STATUS,
} from './tokens/palette';
import { SYSTEM_FONT_FAMILY } from './tokens/typography';

export type ColorScheme = 'light' | 'dark';

/** Resolved brand colours plus the readable text colour to use ON each fill. */
export interface ThemeBrand {
  /** Primary accent, contrast-corrected against the page background. */
  primary: string;
  /** Text/icon colour that reads on a `primary` fill (e.g. a primary button). */
  onPrimary: string;
  /** Secondary accent, contrast-corrected against the page background. */
  secondary: string;
  onSecondary: string;
}

export interface Theme {
  scheme: ColorScheme;
  /** True when the OS asked us to minimise motion; consumers honour this. */
  reduceMotion: boolean;
  /** The org logo, if any, for header/chrome (brief 9.1). */
  logoUrl?: string;
  /** Font family applied app-wide (org override or system default). */
  fontFamily: string;
  brand: ThemeBrand;
  colors: {
    background: string;
    surface: string;
    surfaceAlt: string;
    surfaceSunken: string;
    border: string;
    borderStrong: string;
    text: string;
    textSecondary: string;
    textMuted: string;
    textInverse: string;
    overlay: string;
    skeleton: string;
    skeletonHighlight: string;
  };
  /** FIXED safety colours - identical intent in every theme, never branded. */
  rag: {
    red: string;
    amber: string;
    green: string;
    redSurface: string;
    amberSurface: string;
    greenSurface: string;
  };
  status: Record<keyof typeof STATUS.light, string>;
  /** A soft, scheme-appropriate shadow colour for the elevation helper. */
  shadowColor: string;
}

/**
 * Build a complete theme. `brand` and `fontFamily`/`logoUrl` come from the
 * signed-in org's profile; all are optional so the app renders a correct,
 * accessible default theme before any profile has loaded (no flash of unstyled
 * UI - the provider always has a valid theme to show).
 */
export function buildTheme(args: {
  scheme: ColorScheme;
  reduceMotion: boolean;
  brand?: OrgBrand;
  fontFamily?: string;
  logoUrl?: string;
}): Theme {
  const { scheme, reduceMotion, brand, fontFamily, logoUrl } = args;
  const neutral = NEUTRALS[scheme];
  const onFillLight = ON_FILL.light;
  const onFillDark = ON_FILL.dark;

  const rawPrimary = brand?.primary ?? DEFAULT_BRAND.primary;
  const rawSecondary = brand?.secondary ?? DEFAULT_BRAND.secondary;

  // Accents must read against the page background when used as text/icon tint
  // (e.g. a link or an active tab label), so we correct them to AA there. The
  // ON colour is chosen for readability when the accent is used as a FILL.
  const primary = adjustToMeetAA(rawPrimary, neutral.background);
  const secondary = adjustToMeetAA(rawSecondary, neutral.background);

  return {
    scheme,
    reduceMotion,
    logoUrl,
    fontFamily: fontFamily ?? SYSTEM_FONT_FAMILY,
    brand: {
      primary,
      onPrimary: readableTextOn(rawPrimary, onFillLight, onFillDark),
      secondary,
      onSecondary: readableTextOn(rawSecondary, onFillLight, onFillDark),
    },
    colors: { ...neutral },
    rag: { ...RAG[scheme] },
    status: { ...STATUS[scheme] },
    shadowColor: scheme === 'dark' ? '#000000' : '#0B1220',
  };
}
