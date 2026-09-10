// ============================================================================
// ReportProfile - the standard-specific layer over the shared report engine.
//
// The engine (assemble.ts + render.ts) is generic: it reads any assessment and
// renders the three-section report from whatever template sections it has. A
// ReportProfile supplies the pieces that legitimately DIFFER between standards -
// the document title, the methodology framing, the standard notes/disclaimers,
// the sign-off conventions, and any standard-specific overview facts. It is NOT a
// second pipeline: it is a small bag of copy + a couple of pure hooks the shared
// renderer consults.
//
// A profile is selected from the assessment's pinned `templateSnapshot.standard`
// (see ./index.ts `selectProfile`). An untagged or custom template resolves to
// the generic `defaultProfile`, so "custom just does its best from its sections"
// costs nothing - it is the baseline every other profile layers onto.
// ============================================================================

import type { ReportModel } from '../assemble';
import type { ReportStandard } from '../../shared/types';

export interface ReportProfile {
  /** Which standard this profile serves; matches the template's `standard`. */
  readonly standard: ReportStandard;
  /** The report's headline title (header block + PDF metadata Title/Subject). */
  readonly documentTitle: string;
  /** Short human label for the methodology, used where the standard is named in
   *  running copy (e.g. the overview methodology line fallback). */
  readonly methodologyLabel: string;
  /** Intro paragraph rendered under the "Section 2 - Risk Assessment" heading. */
  readonly riskAssessmentIntro: string;
  /**
   * Explains what a "Not applicable" answer means in this report, printed under
   * the Section 2 intro ONLY when the assessment actually contains one.
   *
   * It is profile copy rather than a fixed sentence in the renderer because the
   * reason an item does not apply is standard-specific: under PAS 79 it is
   * typically a provision the premises does not have, while under BS 9792 it is
   * as often a matter that belongs to the individual dwellings rather than the
   * communal parts being assessed.
   *
   * It is stated ONCE, here, rather than repeated against every row, for the
   * reason a professional report defines its conventions in one place: the
   * reader needs to know that "Not applicable" is a recorded decision by the
   * assessor and not an unanswered question, and a boilerplate line under every
   * such row would cost pages of a long housing report to say the same thing.
   * Suppressed when no item is marked not applicable, so a report never explains
   * a convention it does not use.
   */
  readonly notApplicableNote: string;
  /** Standardised notes and disclaimers shown at the foot of the Overview
   *  (brief 1071 AC2). Standard-specific so a report never claims conformity to a
   *  standard it did not follow. */
  readonly standardNotes: string[];
  /** Optional extra copy under the sign-off block (review conventions etc.);
   *  empty when the standard adds nothing beyond the shared sign-off. */
  readonly signOffNotes: string[];
  /** Standard-specific key/value rows appended after the shared Overview grid.
   *  A PURE function of the already-assembled model - it must never do I/O and
   *  must return `[]` (not throw) when nothing applies. */
  overviewExtraRows(model: ReportModel): Array<[string, string]>;
}
