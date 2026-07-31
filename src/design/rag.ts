// ============================================================================
// RAG presentation mapping (brief 18.5, CONVENTIONS section 8).
//
// The single place that turns a RiskLevel / Severity into its FIXED colour,
// label and icon glyph. Colour is NEVER the sole carrier of meaning, so every
// consumer also renders the label and/or icon this returns. Keeping this mapping
// here means a screen can never accidentally pair the wrong word with a colour.
// ============================================================================

import type { Theme } from './theme';
import type { RiskLevel, Severity } from '../types';

export interface RagPresentation {
  /** Strong colour for text/icon/border. */
  color: string;
  /** Soft fill for a chip/background. */
  surface: string;
  /** The word a colour-blind user reads instead of the colour. */
  label: string;
  /** A simple, dependency-free glyph paired with the colour. */
  icon: string;
  /**
   * The single letter the level is shown as where there is only room for one:
   * H, M, L - and an en dash for the not-yet-assessed state, which has no
   * letter because it is not a grade.
   *
   * ONE vocabulary across the whole product. The letters read the same in a
   * console table's risk column, in a site's distribution strip and on the
   * marketing pages, so a customer who learns them in the app recognises them on
   * the website. They also carry meaning without colour, which the tinted dot
   * they sit in cannot do on its own.
   */
  initial: string;
}

/** Risk level (building/assessment roll-up). `pending` is a fourth, neutral
 *  state shown before any assessment exists - explicitly NOT green, so an
 *  un-assessed building is never mistaken for a safe one. */
export function riskPresentation(
  theme: Theme,
  level: RiskLevel,
): RagPresentation {
  switch (level) {
    case 'high':
      return {
        color: theme.rag.red,
        surface: theme.rag.redSurface,
        label: 'High risk',
        icon: '!',
        initial: 'H',
      };
    case 'medium':
      return {
        color: theme.rag.amber,
        surface: theme.rag.amberSurface,
        label: 'Medium risk',
        icon: '~',
        initial: 'M',
      };
    case 'low':
      return {
        color: theme.rag.green,
        surface: theme.rag.greenSurface,
        label: 'Low risk',
        icon: '✓',
        initial: 'L',
      };
    case 'pending':
    default:
      return {
        color: theme.colors.textMuted,
        surface: theme.colors.surfaceSunken,
        label: 'Not yet assessed',
        icon: '–',
        initial: '–',
      };
  }
}

/** Non-conformity severity (L/M/H) used on findings and action items. */
export function severityPresentation(
  theme: Theme,
  severity: Severity,
): RagPresentation {
  switch (severity) {
    case 'H':
      return {
        color: theme.rag.red,
        surface: theme.rag.redSurface,
        label: 'High',
        icon: 'H',
        initial: 'H',
      };
    case 'M':
      return {
        color: theme.rag.amber,
        surface: theme.rag.amberSurface,
        label: 'Medium',
        icon: 'M',
        initial: 'M',
      };
    case 'L':
    default:
      return {
        color: theme.rag.green,
        surface: theme.rag.greenSurface,
        label: 'Low',
        icon: 'L',
        initial: 'L',
      };
  }
}
