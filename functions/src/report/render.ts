// ============================================================================
// PDF renderer - the three-section industry-standard fire risk assessment report
// (brief 11, stories 1071-1075). Pure presentation: it takes a fully-resolved
// ReportModel (assemble.ts has already read RTDB and downloaded every image) and
// produces a PDF Buffer. No I/O here, so the layout logic is testable in
// isolation and the Function (generateReport.ts) owns all the side effects.
//
// Typography and layout follow a small, deliberate system (brief 18.8): one
// serif-free hierarchy, consistent spacing rhythm, the org's brand colour for
// section accents (never for RAG, which keeps its safety semantics - brief 9.1 /
// 18.5), and a footer on every page. The standardised notes and disclaimers
// mirror legacy industry wording (1071 AC2) and contain no em dashes (client
// rule), British English throughout.
// ============================================================================

import PDFDocument from 'pdfkit';
import { computeRagMeter, type RagBand } from './ragMeter';
import type {
  ReportAction,
  ReportModel,
  ReportSection,
  ResolvedImage,
} from './assemble';
import { selectProfile, type ReportProfile } from './profiles';
import type { Severity } from '../shared/types';

// ----------------------------------------------------------------------------
// Design tokens. Stated once so the whole document is consistent (brief 18.8).
// ----------------------------------------------------------------------------

const PAGE_MARGIN = 50;
const COLOURS = {
  ink: '#1F2937', // primary text
  muted: '#6B7280', // secondary text, captions
  hairline: '#E5E7EB', // table rules, dividers
  panel: '#F9FAFB', // light panel backgrounds
  white: '#FFFFFF',
  // RAG is a SAFETY semantic - fixed, never overridden by brand (brief 9.1).
  rag: {
    low: '#2E7D32', // green
    medium: '#ED8B00', // amber
    high: '#C62828', // red
  } as Record<RagBand, string>,
} as const;

const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  oblique: 'Helvetica-Oblique',
} as const;

const SIZE = {
  title: 22,
  sectionHeading: 15,
  subHeading: 12,
  body: 10,
  small: 9,
  caption: 8,
} as const;

/** Human label + colour for each severity, so colour is never the sole carrier
 *  of meaning (brief 18.5). */
const SEVERITY_META: Record<Severity, { label: string; colour: string }> = {
  H: { label: 'High', colour: COLOURS.rag.high },
  M: { label: 'Medium', colour: COLOURS.rag.medium },
  L: { label: 'Low', colour: COLOURS.rag.low },
};

/** Look up severity presentation, NEVER throwing on an unexpected value. The
 *  assessment data is custom and can drift (brief 18.3): an action or row whose
 *  severity is not exactly L/M/H must degrade to a labelled fallback, not crash
 *  the whole report. Assembly normalises severities too; this is belt-and-braces. */
function severityMeta(severity: unknown): { label: string; colour: string } {
  if (severity === 'H' || severity === 'M' || severity === 'L') {
    return SEVERITY_META[severity];
  }
  return { label: 'Unspecified', colour: COLOURS.muted };
}

/**
 * Validate a brand colour before we paint with it. A malformed brand value (the
 * org profile is client-managed in Phase 2) must never crash rendering or, worse,
 * produce an illegible accent; we fall back to the ink colour. Only #RGB / #RRGGBB
 * are accepted.
 */
function safeColour(value: string | undefined, fallback: string): string {
  if (typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
    return value;
  }
  return fallback;
}

/** Format an epoch-millis date as a British long date, or a placeholder. */
function formatDate(epoch: number | undefined): string {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) {
    return 'Not recorded';
  }
  // Force en-GB + UTC so the rendered date is deterministic regardless of the
  // server's locale or timezone (brief 18.2 determinism).
  return new Date(epoch).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ----------------------------------------------------------------------------
// The standardised notes and disclaimers (1071 AC2) now live PER STANDARD on the
// report profile (report/profiles), so a report only ever claims conformity to
// the standard its template actually follows. British English, no em dashes.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// A thin layout helper around the PDFKit document. It owns the running cursor and
// the page chrome (header band, footer) so the section builders only describe
// content, not pagination plumbing.
// ----------------------------------------------------------------------------

class Layout {
  readonly doc: PDFKit.PDFDocument;
  readonly contentWidth: number;
  private readonly brand: string;
  private readonly orgName: string;
  /** Buffered index (0-based) of the reserved Table of Contents page, or -1 when
   *  no ToC page has been reserved. finalise() paints the contents here. */
  private tocPageIndex = -1;
  /** Major sections in document order, with the page each starts on. Populated
   *  by sectionHeading() as the report is emitted; consumed by finalise() to
   *  fill the reserved ToC page once every start page (and the total) is known. */
  private readonly tocEntries: Array<{ label: string; page: number }> = [];

  constructor(doc: PDFKit.PDFDocument, brand: string, orgName: string) {
    this.doc = doc;
    this.brand = brand;
    this.orgName = orgName;
    this.contentWidth =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;
  }

  /** The current page's 1-based number. bufferedPageRange().count is the number
   *  of pages added so far, and the page being written is the last of them, so
   *  its human page number equals that count. */
  currentPageNumber(): number {
    return this.doc.bufferedPageRange().count;
  }

  /** Reserve a blank page for the Table of Contents immediately after the cover.
   *  It is left empty during the main render and painted by finalise() once the
   *  section start pages are known, mirroring how the 'Page N of M' stamp is
   *  deferred. Reserving it now means every later page number already accounts
   *  for it, so no numbers shift when the ToC is filled in. */
  reserveTocPage(): void {
    this.newPage();
    this.tocPageIndex = this.doc.bufferedPageRange().count - 1;
  }

  /** The current bottom limit before the footer area. */
  private get bottomLimit(): number {
    return this.doc.page.height - this.doc.page.margins.bottom - 24;
  }

  /** Vertical points still available on this page before the footer area. */
  get remaining(): number {
    return this.bottomLimit - this.doc.y;
  }

  /** The full content height of a fresh page (top margin to footer area). */
  get fullPageContentHeight(): number {
    return (
      this.doc.page.height -
      this.doc.page.margins.top -
      this.doc.page.margins.bottom -
      24
    );
  }

  /** Ensure `needed` vertical points are available; start a new page if not. */
  ensureSpace(needed: number): void {
    if (this.doc.y + needed > this.bottomLimit) {
      this.newPage();
    }
  }

  /** Add a page and paint its footer immediately so every page carries it. */
  newPage(): void {
    this.doc.addPage();
    this.paintFooter();
    this.doc.y = this.doc.page.margins.top;
  }

  /** Begin the document's first page chrome (footer) without adding a page. */
  beginFirstPage(): void {
    this.paintFooter();
    this.doc.y = this.doc.page.margins.top;
  }

  /** Footer: hairline rule + org name (left). The page number is NOT painted
   *  here: 'Page N of M' needs the final page count, so finalise() stamps it on
   *  every buffered page once the document's content is complete. */
  private paintFooter(): void {
    const { doc } = this;
    // Zero the bottom margin while painting inside the footer strip. The strip
    // sits BELOW the margin line, and a width-constrained text() there goes
    // through PDFKit's line wrapper, whose overflow check would otherwise
    // auto-add a page - leaving the just-added page blank and stamping the org
    // name on TOP of the next page's content (visually proven, 2026-07-15).
    // Same guard finalise() uses for the page-number pass.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - savedBottom + 6;
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(COLOURS.hairline)
      .moveTo(doc.page.margins.left, y - 6)
      .lineTo(doc.page.width - doc.page.margins.right, y - 6)
      .stroke();
    doc
      .font(FONT.regular)
      .fontSize(SIZE.caption)
      .fillColor(COLOURS.muted)
      .text(this.orgName, doc.page.margins.left, y, {
        lineBreak: false,
        width: this.contentWidth / 2,
      });
    doc.restore();
    doc.page.margins.bottom = savedBottom;
  }

  /**
   * Final pass over every buffered page (bufferPages: true): stamp
   * 'Page N of M' bottom-right, now that M is known. Call exactly once, after
   * all content and before doc.end().
   */
  finalise(): void {
    const { doc } = this;
    // Fill the reserved contents page first, now that every section start page
    // is recorded. This uses switchToPage exactly as the page-number pass does.
    this.paintToc();
    const range = doc.bufferedPageRange();
    const total = range.start + range.count;
    for (let i = range.start; i < total; i += 1) {
      doc.switchToPage(i);
      // Zero the bottom margin while writing in the footer strip: text placed
      // below the margin line would otherwise trigger PDFKit's automatic page
      // break and spawn a phantom page at the end of the document.
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - savedBottom + 6;
      doc
        .font(FONT.regular)
        .fontSize(SIZE.caption)
        .fillColor(COLOURS.muted)
        .text(
          `Page ${i + 1} of ${total}`,
          doc.page.margins.left + this.contentWidth / 2,
          y,
          { width: this.contentWidth / 2, align: 'right', lineBreak: false },
        );
      doc.page.margins.bottom = savedBottom;
    }
  }

  /**
   * Paint the Table of Contents onto the page reserved by reserveTocPage(). Runs
   * in the buffered pass (from finalise), so the page numbers listed are final.
   * Every position is absolute and every text() draws with lineBreak: false, so
   * this pass can never trip PDFKit's line wrapper into spawning an extra page.
   * The entry list is short and fixed (the major sections + sign-off), so it
   * always fits comfortably on the single reserved page.
   */
  private paintToc(): void {
    if (this.tocPageIndex < 0 || this.tocEntries.length === 0) {
      return;
    }
    const { doc } = this;
    doc.switchToPage(this.tocPageIndex);
    const left = doc.page.margins.left;

    // Heading with the brand accent rule beneath it, exactly as sectionHeading.
    // lineBreak: false keeps this buffered pass from ever spawning a page, but it
    // also means doc.y is NOT advanced past the text, so the rule is placed below
    // the measured heading height (heading y + text height + the same 4pt gap
    // sectionHeading uses) rather than at doc.y, which would strike through it.
    let y = doc.page.margins.top;
    doc
      .font(FONT.bold)
      .fontSize(SIZE.sectionHeading)
      .fillColor(COLOURS.ink)
      .text('Contents', left, y, { lineBreak: false });
    const headingHeight = doc.heightOfString('Contents', {
      width: this.contentWidth,
    });
    const ruleY = y + headingHeight + 4;
    doc
      .save()
      .lineWidth(2)
      .strokeColor(this.brand)
      .moveTo(left, ruleY)
      .lineTo(left + 90, ruleY)
      .stroke()
      .restore();

    // One right-aligned page number per section, in the report's reading colour.
    const numberWidth = 48;
    const labelWidth = this.contentWidth - numberWidth - 10;
    y = ruleY + 22;
    for (const entry of this.tocEntries) {
      doc
        .font(FONT.regular)
        .fontSize(SIZE.body)
        .fillColor(COLOURS.ink)
        .text(entry.label, left, y, { width: labelWidth, lineBreak: false });
      doc
        .font(FONT.regular)
        .fontSize(SIZE.body)
        .fillColor(COLOURS.muted)
        .text(String(entry.page), left + this.contentWidth - numberWidth, y, {
          width: numberWidth,
          align: 'right',
          lineBreak: false,
        });
      y += SIZE.body + 12;
    }
  }

  /** A major section heading with a brand accent rule beneath it. When a
   *  `tocLabel` is given, the section is recorded for the Table of Contents at
   *  the page it actually lands on (captured AFTER ensureSpace, so a heading
   *  pushed to a fresh page is listed on that fresh page, never the old one). */
  sectionHeading(label: string, tocLabel?: string): void {
    this.ensureSpace(48);
    if (tocLabel) {
      this.tocEntries.push({ label: tocLabel, page: this.currentPageNumber() });
    }
    const { doc } = this;
    doc
      .font(FONT.bold)
      .fontSize(SIZE.sectionHeading)
      .fillColor(COLOURS.ink)
      .text(label, doc.page.margins.left, doc.y);
    const ruleY = doc.y + 4;
    doc
      .save()
      .lineWidth(2)
      .strokeColor(this.brand)
      .moveTo(doc.page.margins.left, ruleY)
      .lineTo(doc.page.margins.left + 90, ruleY)
      .stroke()
      .restore();
    doc.moveDown(0.8);
  }

  /** A minor heading within a section. */
  subHeading(label: string): void {
    this.ensureSpace(28);
    this.doc
      .font(FONT.bold)
      .fontSize(SIZE.subHeading)
      .fillColor(COLOURS.ink)
      .text(label, this.doc.page.margins.left, this.doc.y);
    this.doc.moveDown(0.4);
  }

  /** A justified body paragraph in the muted-ink reading colour. */
  paragraph(text: string, options: { italic?: boolean } = {}): void {
    this.ensureSpace(SIZE.body * 2);
    this.doc
      .font(options.italic ? FONT.oblique : FONT.regular)
      .fontSize(SIZE.body)
      .fillColor(COLOURS.ink)
      .text(text, this.doc.page.margins.left, this.doc.y, {
        width: this.contentWidth,
        align: 'justify',
        lineGap: 2,
      });
    this.doc.moveDown(0.6);
  }
}

// ----------------------------------------------------------------------------
// Header / cover block (brand + title + provenance) - story 1075.
// ----------------------------------------------------------------------------

function renderHeader(
  layout: Layout,
  model: ReportModel,
  brand: string,
  profile: ReportProfile,
): void {
  const { doc } = layout;
  const left = doc.page.margins.left;
  const top = doc.y;

  // Org logo top-right where available; degrade silently if not fetchable so the
  // header never shows a broken-image gap.
  if (model.logo?.available && model.logo.data) {
    try {
      doc.image(model.logo.data, doc.page.width - doc.page.margins.right - 120, top, {
        fit: [120, 60],
        align: 'right',
      });
    } catch {
      // A corrupt logo image must not stop the report; we simply omit it.
    }
  }

  doc
    .font(FONT.bold)
    .fontSize(SIZE.title)
    .fillColor(COLOURS.ink)
    .text(profile.documentTitle, left, top, { width: layout.contentWidth - 130 });
  doc
    .font(FONT.regular)
    .fontSize(SIZE.subHeading)
    .fillColor(brand)
    .text(model.orgProfile.name, left, doc.y + 2);

  doc.moveDown(0.5);
  doc
    .font(FONT.regular)
    .fontSize(SIZE.small)
    .fillColor(COLOURS.muted)
    .text(
      `Report generated on ${formatDate(model.generatedAt)}`,
      left,
      doc.y,
    );

  // Brand divider under the cover block.
  const ruleY = doc.y + 8;
  doc
    .save()
    .lineWidth(1.5)
    .strokeColor(brand)
    .moveTo(left, ruleY)
    .lineTo(doc.page.width - doc.page.margins.right, ruleY)
    .stroke()
    .restore();
  doc.y = ruleY + 14;
}

// ----------------------------------------------------------------------------
// Section 1 - Overview (story 1071).
// ----------------------------------------------------------------------------

/** A two-column key/value grid for the overview facts. */
function renderKeyValueGrid(
  layout: Layout,
  rows: Array<[string, string]>,
): void {
  const { doc } = layout;
  const labelWidth = 150;
  const left = doc.page.margins.left;
  const valueX = left + labelWidth + 10;
  const valueWidth = layout.contentWidth - labelWidth - 10;

  for (const [label, value] of rows) {
    // Measure the taller of the two columns so the row never overlaps the next.
    const valueHeight = doc
      .font(FONT.regular)
      .fontSize(SIZE.body)
      .heightOfString(value, { width: valueWidth });
    const rowHeight = Math.max(valueHeight, SIZE.body + 4) + 6;
    layout.ensureSpace(rowHeight);

    const y = doc.y;
    doc
      .font(FONT.bold)
      .fontSize(SIZE.body)
      .fillColor(COLOURS.muted)
      .text(label, left, y, { width: labelWidth });
    doc
      .font(FONT.regular)
      .fontSize(SIZE.body)
      .fillColor(COLOURS.ink)
      .text(value, valueX, y, { width: valueWidth });
    doc.y = y + rowHeight;
  }
  doc.moveDown(0.3);
}

function renderOverview(
  layout: Layout,
  model: ReportModel,
  brand: string,
  profile: ReportProfile,
): void {
  const { doc } = layout;
  layout.sectionHeading('Section 1 - Overview', 'Section 1: Overview');

  const o = model.overview;
  const article53 =
    o.article53Persons.length > 0
      ? o.article53Persons.join(', ')
      : 'None recorded';

  // Base facts, then any standard-specific rows the profile contributes. The
  // profile hook is pure and defensive; it returns [] when it adds nothing.
  const overviewRows: Array<[string, string]> = [
    ['Premises address', o.address],
    ['Responsible person', o.responsiblePerson],
    ['Article 5(3) persons', article53],
    ['Assessing organisation', model.orgProfile.name],
    ['Contact name', o.orgContactName],
    ['Contact email', o.orgContactEmail],
    ['Contact telephone', o.orgContactPhone],
    ['Building reference', o.buildingId],
    ['Assessment reference', o.assessmentId],
    ['Date carried out', formatDate(o.dateCarriedOut)],
    ['Overall risk level', titleCase(o.riskLevel)],
    ...profile.overviewExtraRows(model),
  ];
  renderKeyValueGrid(layout, overviewRows);

  // Building photo, if available, at a legible but contained size.
  if (model.buildingPhoto?.available && model.buildingPhoto.data) {
    layout.ensureSpace(170);
    try {
      doc.image(model.buildingPhoto.data, doc.page.margins.left, doc.y, {
        fit: [220, 150],
      });
      doc.y += 156;
      doc
        .font(FONT.oblique)
        .fontSize(SIZE.caption)
        .fillColor(COLOURS.muted)
        .text('General view of the premises', doc.page.margins.left, doc.y);
      doc.moveDown(0.6);
    } catch {
      // Omit a corrupt photo rather than fail the document.
    }
  }

  // Building details.
  if (model.overview.buildingDetailLines.length > 0) {
    layout.subHeading('Building details');
    renderBulletedLines(layout, model.overview.buildingDetailLines);
  }

  // Assessment details.
  layout.subHeading('Assessment details');
  renderBulletedLines(layout, model.overview.assessmentDetailLines);

  // The proportional RAG meter (story 1072) with the assessor risk opinion.
  layout.subHeading('Risk profile');
  renderRagMeter(layout, model);

  // The assessor's STYLED narrative summary (1071 AC3).
  if (model.narrative.summary || model.narrative.riskOpinion) {
    layout.subHeading('Assessor summary');
    if (model.narrative.summary) {
      layout.paragraph(model.narrative.summary);
    }
    renderNarrativeBlocks(layout, model);
  }

  // Standardised notes and disclaimers (1071 AC2), scoped to the report standard.
  layout.subHeading('Assessment notes and disclaimers');
  for (const note of profile.standardNotes) {
    layout.paragraph(note);
  }

  // Suppress an unused-parameter warning while keeping the signature uniform with
  // the other section renderers (they all receive brand for consistency).
  void brand;
}

/** Render plain lines as a tidy bulleted list. */
function renderBulletedLines(layout: Layout, lines: string[]): void {
  const { doc } = layout;
  for (const line of lines) {
    layout.ensureSpace(SIZE.body + 6);
    const y = doc.y;
    doc
      .font(FONT.regular)
      .fontSize(SIZE.body)
      .fillColor(COLOURS.muted)
      .text('-', doc.page.margins.left, y, { width: 12 });
    doc
      .fillColor(COLOURS.ink)
      .text(line, doc.page.margins.left + 14, y, {
        width: layout.contentWidth - 14,
      });
    doc.y = Math.max(doc.y, y + SIZE.body + 4);
  }
  doc.moveDown(0.4);
}

/** Render the remaining narrative blocks (each a titled paragraph) when present. */
function renderNarrativeBlocks(layout: Layout, model: ReportModel): void {
  const blocks: Array<[string, string | undefined]> = [
    ['Description of the building', model.narrative.buildingDescription],
    ['Premises covered by this assessment', model.narrative.premisesCovered],
    ['History of incidents', model.narrative.incidentHistory],
    ['Assessor risk opinion', model.narrative.riskOpinion],
  ];
  for (const [title, text] of blocks) {
    if (!text) {
      continue;
    }
    layout.doc
      .font(FONT.bold)
      .fontSize(SIZE.small)
      .fillColor(COLOURS.ink)
      .text(title, layout.doc.page.margins.left, layout.doc.y);
    layout.doc.moveDown(0.2);
    layout.paragraph(text);
  }
}

// ----------------------------------------------------------------------------
// The proportional RAG meter (story 1072). The width of each band is EXACTLY its
// share of total findings; the assessor opinion is shown alongside but does not
// rewrite the geometry (1072 AC3).
// ----------------------------------------------------------------------------

function renderRagMeter(layout: Layout, model: ReportModel): void {
  const { doc } = layout;
  const meter = computeRagMeter(model.riskDistribution);

  const barX = doc.page.margins.left;
  const barWidth = layout.contentWidth;
  const barHeight = 26;
  layout.ensureSpace(barHeight + 60);
  const barY = doc.y;

  doc.save();

  if (meter.isEmpty) {
    // Honest neutral bar: no findings to be proportional to.
    doc
      .rect(barX, barY, barWidth, barHeight)
      .fillColor(COLOURS.panel)
      .fill();
    doc
      .lineWidth(0.5)
      .strokeColor(COLOURS.hairline)
      .rect(barX, barY, barWidth, barHeight)
      .stroke();
    doc.restore();
    doc.y = barY + barHeight + 6;
    doc
      .font(FONT.oblique)
      .fontSize(SIZE.small)
      .fillColor(COLOURS.muted)
      .text(
        'No findings have been recorded against this building, so no risk distribution is shown.',
        barX,
        doc.y,
        { width: barWidth },
      );
    doc.moveDown(0.6);
  } else {
    // Draw contiguous proportional segments left to right (low -> medium -> high).
    let cursorX = barX;
    for (const segment of meter.segments) {
      const segWidth = barWidth * segment.fraction;
      doc
        .rect(cursorX, barY, segWidth, barHeight)
        .fillColor(COLOURS.rag[segment.band])
        .fill();
      // Label inside the segment when it is wide enough to read; otherwise the
      // legend below carries the count, so the meaning is never lost.
      if (segWidth > 38) {
        doc
          .font(FONT.bold)
          .fontSize(SIZE.caption)
          .fillColor(COLOURS.white)
          .text(`${segment.percent}%`, cursorX + 4, barY + barHeight / 2 - 4, {
            width: segWidth - 8,
            lineBreak: false,
          });
      }
      cursorX += segWidth;
    }
    doc
      .lineWidth(0.5)
      .strokeColor(COLOURS.hairline)
      .rect(barX, barY, barWidth, barHeight)
      .stroke();
    doc.restore();

    doc.y = barY + barHeight + 8;

    // Legend: colour swatch + label + count for every band present, so colour is
    // never the sole carrier of meaning (brief 18.5).
    let legendX = barX;
    for (const segment of meter.segments) {
      const text = `${segment.label} severity: ${segment.count}`;
      const swatch = 9;
      doc
        .save()
        .rect(legendX, doc.y + 1, swatch, swatch)
        .fillColor(COLOURS.rag[segment.band])
        .fill()
        .restore();
      doc
        .font(FONT.regular)
        .fontSize(SIZE.small)
        .fillColor(COLOURS.ink)
        .text(text, legendX + swatch + 4, doc.y, { lineBreak: false });
      legendX +=
        swatch + 8 + doc.widthOfString(text) + 18;
    }
    doc.moveDown(1.2);
    doc
      .font(FONT.regular)
      .fontSize(SIZE.small)
      .fillColor(COLOURS.muted)
      .text(
        `Total findings recorded: ${meter.total}. The meter above is drawn in exact proportion to these counts.`,
        barX,
        doc.y,
        { width: barWidth },
      );
    doc.moveDown(0.6);
  }

  // The assessor risk opinion sits alongside the meter, never silently overriding
  // it (1072 AC3). If there is no opinion, we say so rather than leaving a gap.
  doc
    .font(FONT.bold)
    .fontSize(SIZE.small)
    .fillColor(COLOURS.ink)
    .text('Assessor risk opinion', barX, doc.y);
  doc.moveDown(0.2);
  layout.paragraph(
    model.narrative.riskOpinion ??
      'The assessor did not record a separate risk opinion. Please refer to the findings and action plan below.',
  );
}

// ----------------------------------------------------------------------------
// Section 2 - the template's subjects, each its own question/answer/observation
// table (story 1073). The subjects rendered are exactly those the assessment's
// template declares, in the template's authored order (assemble.ts).
// ----------------------------------------------------------------------------

function renderRiskAssessment(
  layout: Layout,
  model: ReportModel,
  profile: ReportProfile,
): void {
  layout.sectionHeading('Section 2 - Risk Assessment', 'Section 2: Risk Assessment');
  layout.paragraph(profile.riskAssessmentIntro);
  for (const section of model.sections) {
    renderSubjectTable(layout, section);
  }
}

// One styled block of a table cell (a question, its guidance, an answer, an
// observation, a severity tag). Rows are painted as ordered segment lists so a
// row taller than the space left on a page can be SPLIT at a word boundary and
// continued on the next page, instead of overflowing into the footer.
interface CellSegment {
  text: string;
  font: string;
  size: number;
  colour: string;
}

/** Height one segment needs at the given cell width. */
function segmentHeight(
  doc: PDFKit.PDFDocument,
  seg: CellSegment,
  width: number,
): number {
  return doc.font(seg.font).fontSize(seg.size).heightOfString(seg.text, { width });
}

/** Total height an ordered segment list needs at the given cell width. */
function segmentsHeight(
  doc: PDFKit.PDFDocument,
  segs: CellSegment[],
  width: number,
): number {
  return segs.reduce((sum, seg) => sum + segmentHeight(doc, seg, width), 0);
}

/**
 * Split one segment so the head fits within maxHeight at the cell width. Splits
 * at word boundaries (binary search over the token prefix); when not even one
 * word fits it falls back to a character split, so a pathological unbroken
 * string can never stall pagination. Returns an absent head when nothing fits.
 */
function splitSegmentToFit(
  doc: PDFKit.PDFDocument,
  seg: CellSegment,
  width: number,
  maxHeight: number,
): { head?: CellSegment; tail?: CellSegment } {
  const fits = (text: string): boolean =>
    segmentHeight(doc, { ...seg, text }, width) <= maxHeight;

  const splitBy = (tokens: string[]): number => {
    // Largest prefix (token count) that fits, by binary search.
    let lo = 0;
    let hi = tokens.length;
    while (lo < hi) {
      const probe = Math.floor((lo + hi + 1) / 2);
      if (fits(tokens.slice(0, probe).join(''))) {
        lo = probe;
      } else {
        hi = probe - 1;
      }
    }
    return lo;
  };

  // Word-boundary tokens (each keeps its trailing whitespace so joins rebuild
  // the original text exactly).
  let tokens = seg.text.split(/(?<=\s)/);
  let cut = splitBy(tokens);
  if (cut === 0) {
    // Not one word fits: character fallback (see doc comment).
    tokens = seg.text.split('');
    cut = splitBy(tokens);
  }
  const head = tokens.slice(0, cut).join('').trimEnd();
  const tail = tokens.slice(cut).join('').trimStart();
  return {
    ...(head.length > 0 ? { head: { ...seg, text: head } } : {}),
    ...(tail.length > 0 ? { tail: { ...seg, text: tail } } : {}),
  };
}

/**
 * Paint as much of a cell's segment list as fits within maxHeight, starting at
 * (x, y). Returns the segments still unpainted (empty when done) and the height
 * actually used, so the row loop can draw matching borders and continue the
 * remainder after a page break.
 */
function paintCellChunk(
  doc: PDFKit.PDFDocument,
  segs: CellSegment[],
  x: number,
  y: number,
  width: number,
  maxHeight: number,
): { rest: CellSegment[]; height: number } {
  let used = 0;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    const h = segmentHeight(doc, seg, width);
    if (h <= maxHeight - used) {
      doc
        .font(seg.font)
        .fontSize(seg.size)
        .fillColor(seg.colour)
        .text(seg.text, x, y + used, { width });
      used += h;
      continue;
    }
    // This segment does not fit whole: paint the fitting head, carry the tail.
    const { head, tail } = splitSegmentToFit(doc, seg, width, maxHeight - used);
    if (head) {
      doc
        .font(head.font)
        .fontSize(head.size)
        .fillColor(head.colour)
        .text(head.text, x, y + used, { width });
      used += segmentHeight(doc, head, width);
    }
    const rest = tail ? [tail, ...segs.slice(i + 1)] : segs.slice(i + 1);
    return { rest, height: used };
  }
  return { rest: [], height: used };
}

/** The Question / Answer header band. Painted at the top of each subject table
 *  AND repeated after every page break within the table, so a continued row is
 *  never orphaned from its column meanings. */
const QA_HEADER_HEIGHT = 18;
function paintQaHeader(
  layout: Layout,
  left: number,
  qWidth: number,
  aX: number,
  aWidth: number,
): void {
  const { doc } = layout;
  const y = doc.y;
  doc
    .save()
    .rect(left, y, layout.contentWidth, QA_HEADER_HEIGHT)
    .fillColor(COLOURS.panel)
    .fill()
    .restore();
  doc
    .font(FONT.bold)
    .fontSize(SIZE.small)
    .fillColor(COLOURS.ink)
    .text('Question', left + 4, y + 4, { width: qWidth - 8 })
    .text('Answer and observations', aX + 4, y + 4, { width: aWidth - 8 });
  doc.y = y + QA_HEADER_HEIGHT;
}

/** Below this many points of usable space we page-break rather than paint a
 *  sliver of a row chunk (roughly two lines of small text plus padding). */
const MIN_ROW_CHUNK = 36;

function renderSubjectTable(layout: Layout, section: ReportSection): void {
  const { doc } = layout;
  layout.subHeading(`${section.code}  ${section.title}`);

  const left = doc.page.margins.left;
  const qWidth = layout.contentWidth * 0.46;
  const aWidth = layout.contentWidth * 0.54;
  const aX = left + qWidth;

  // Header row (repeated after every page break inside the table).
  layout.ensureSpace(QA_HEADER_HEIGHT + 4);
  paintQaHeader(layout, left, qWidth, aX, aWidth);

  for (const row of section.rows) {
    // A yesno answer is a compliance signal, so it reads in bold; every other
    // type renders as regular text. Unknown/custom types fall through to regular.
    const answerBold = row.questionType === 'yesno';

    // The question cell: the question and, when the template attached it, a
    // muted guidance line beneath - the same context the assessor saw (10.1).
    const qSegs: CellSegment[] = [
      {
        text: row.questionText,
        font: FONT.regular,
        size: SIZE.small,
        colour: COLOURS.ink,
      },
      ...(row.guidance
        ? [
            {
              text: row.guidance,
              font: FONT.oblique,
              size: SIZE.caption,
              colour: COLOURS.muted,
            },
          ]
        : []),
    ];
    // The answer cell: answer (bold for yesno), observation, severity tag.
    const aSegs: CellSegment[] = [
      {
        text: row.answerText,
        font: answerBold ? FONT.bold : FONT.regular,
        size: SIZE.small,
        colour: COLOURS.ink,
      },
      ...(row.observation
        ? [
            {
              text: `Observation: ${row.observation}`,
              font: FONT.regular,
              size: SIZE.small,
              colour: COLOURS.muted,
            },
          ]
        : []),
      ...(row.severity
        ? [
            {
              text: `Severity: ${severityMeta(row.severity).label}`,
              font: FONT.bold,
              size: SIZE.small,
              colour: severityMeta(row.severity).colour,
            },
          ]
        : []),
    ];

    // A row that fits on ONE page is kept whole: if it does not fit the space
    // left here but would fit a fresh page, break first. Only a row taller
    // than a full page is ever split across pages (with the header repeated).
    const rowHeight =
      Math.max(
        segmentsHeight(doc, qSegs, qWidth - 8),
        segmentsHeight(doc, aSegs, aWidth - 8),
      ) + 10;
    const fitsWholePage =
      rowHeight <= layout.fullPageContentHeight - QA_HEADER_HEIGHT;
    if (rowHeight > layout.remaining && fitsWholePage) {
      layout.newPage();
      paintQaHeader(layout, left, qWidth, aX, aWidth);
    }

    // Paint the row in one or more chunks, each bounded by the space remaining
    // above the footer; the header band is repainted after every break.
    let qRem = qSegs;
    let aRem = aSegs;
    do {
      if (layout.remaining < MIN_ROW_CHUNK) {
        layout.newPage();
        paintQaHeader(layout, left, qWidth, aX, aWidth);
      }
      const available = layout.remaining - 10; // top+bottom cell padding
      const y = doc.y;
      const q = paintCellChunk(doc, qRem, left + 4, y + 5, qWidth - 8, available);
      const a = paintCellChunk(doc, aRem, aX + 4, y + 5, aWidth - 8, available);
      qRem = q.rest;
      aRem = a.rest;
      const chunkHeight = Math.max(q.height, a.height) + 10;

      // Cell borders around exactly what this page carries of the row.
      doc
        .save()
        .lineWidth(0.5)
        .strokeColor(COLOURS.hairline)
        .rect(left, y, qWidth, chunkHeight)
        .stroke()
        .rect(aX, y, aWidth, chunkHeight)
        .stroke()
        .restore();
      doc.y = y + chunkHeight;

      if (qRem.length > 0 || aRem.length > 0) {
        layout.newPage();
        paintQaHeader(layout, left, qWidth, aX, aWidth);
      }
    } while (qRem.length > 0 || aRem.length > 0);

    // Answer photographs, embedded as a compact titled strip beneath the row so
    // the evidence sits with its question. Assembly has already resolved these to
    // bytes and dropped any that failed to download (brief 18.3).
    if (row.photos && row.photos.length > 0) {
      renderAnswerPhotos(layout, row.photos);
    }
  }
  doc.moveDown(0.8);
}

// ----------------------------------------------------------------------------
// Section 3 - the action plan, high to low severity, with titled images
// including the flag-location composite (stories 1057, 1074).
// ----------------------------------------------------------------------------

function renderActionPlan(layout: Layout, model: ReportModel): void {
  layout.sectionHeading('Section 3 - Action Plan', 'Section 3: Action Plan');

  if (model.actions.length === 0) {
    layout.paragraph(
      'No remedial actions were recorded for this building at the time of assessment. This does not remove the responsible person\'s ongoing duty to keep fire safety arrangements under review.',
    );
    return;
  }

  layout.paragraph(
    'The remedial actions below are ordered by severity, highest first. Actions marked Life Protection address measures that directly protect the safety of people and should be prioritised accordingly.',
  );

  let index = 0;
  for (const action of model.actions) {
    index += 1;
    renderActionCard(layout, action, index);
  }
}

function renderActionCard(
  layout: Layout,
  action: ReportAction,
  index: number,
): void {
  const { doc } = layout;
  const left = doc.page.margins.left;
  const meta = severityMeta(action.severity);

  // Estimate space for the card head + body so it does not split awkwardly across
  // a page break at the heading.
  layout.ensureSpace(90);
  const y = doc.y;

  // Severity flag strip down the left edge, plus a header line.
  doc
    .save()
    .rect(left, y, 5, 18)
    .fillColor(meta.colour)
    .fill()
    .restore();

  doc
    .font(FONT.bold)
    .fontSize(SIZE.subHeading)
    .fillColor(COLOURS.ink)
    .text(`Action ${index}`, left + 12, y, { continued: true })
    .font(FONT.bold)
    .fillColor(meta.colour)
    .text(`   ${meta.label} severity`, { continued: false });

  if (action.lifeProtection) {
    // The "LTP" marker, spelled out so its meaning is explicit (brief 18.5).
    doc
      .font(FONT.bold)
      .fontSize(SIZE.small)
      .fillColor(COLOURS.rag.high)
      .text('Life Protection (LTP)', left + 12, doc.y + 2);
  }
  doc.moveDown(0.4);

  const detailRows: Array<[string, string]> = [
    ['Subject', action.sectionCode],
    ['Finding', action.question],
    ['Recommendation and observation', action.observation],
    ['Responsible party', action.responsible],
    ['Due by', formatDate(action.dueBy)],
  ];
  renderKeyValueGrid(layout, detailRows);

  // Images: the flag-location composite first (the legacy "Location" column
  // parity, 1057 AC2), then any other titled images (1074 AC2), each at a
  // legible size with its title beneath.
  const images: ResolvedImage[] = [];
  if (action.flagImage) {
    images.push(action.flagImage);
  }
  images.push(...action.images);

  if (images.length > 0) {
    renderActionImages(layout, images);
  }

  // Divider between actions.
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(COLOURS.hairline)
    .moveTo(left, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .stroke()
    .restore();
  doc.moveDown(0.8);
}

/** Action-plan images: a generous box so the flag location is legible (1074 AC2). */
function renderActionImages(layout: Layout, images: ResolvedImage[]): void {
  renderImageStrip(layout, images, 200, 150);
}

/** Section 2 answer photographs: a compact thumbnail strip beneath the question
 *  row, so evidence sits with its subject without dominating the table. */
function renderAnswerPhotos(layout: Layout, images: ResolvedImage[]): void {
  layout.doc.moveDown(0.2);
  renderImageStrip(layout, images, 120, 90);
}

/** Render a row of titled images at the given box size, wrapping to the next line
 *  as needed. Shared by the action plan and the Section 2 answer photos. */
function renderImageStrip(
  layout: Layout,
  images: ResolvedImage[],
  imgWidth: number,
  imgHeight: number,
): void {
  const { doc } = layout;
  const left = doc.page.margins.left;
  const gap = 16;

  layout.ensureSpace(imgHeight + 30);
  let x = left;
  let rowTop = doc.y;
  let rowMaxBottom = rowTop;

  for (const image of images) {
    // Wrap to a new row when the next image would overflow the content width.
    if (x + imgWidth > left + layout.contentWidth) {
      x = left;
      rowTop = rowMaxBottom + 10;
      doc.y = rowTop;
      layout.ensureSpace(imgHeight + 30);
      rowTop = doc.y;
      rowMaxBottom = rowTop;
    }

    if (image.available && image.data) {
      try {
        doc.image(image.data, x, rowTop, { fit: [imgWidth, imgHeight] });
      } catch {
        renderImagePlaceholder(layout, x, rowTop, imgWidth, imgHeight);
      }
    } else {
      renderImagePlaceholder(layout, x, rowTop, imgWidth, imgHeight);
    }

    // Title beneath the image.
    doc
      .font(FONT.oblique)
      .fontSize(SIZE.caption)
      .fillColor(COLOURS.muted)
      .text(image.title, x, rowTop + imgHeight + 2, { width: imgWidth });

    rowMaxBottom = Math.max(rowMaxBottom, rowTop + imgHeight + 16);
    x += imgWidth + gap;
  }

  doc.y = rowMaxBottom + 6;
}

/** A bordered "image unavailable" box, so a failed download leaves an honest,
 *  laid-out placeholder rather than a blank or a crash (brief 18.3). */
function renderImagePlaceholder(
  layout: Layout,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const { doc } = layout;
  doc
    .save()
    .rect(x, y, w, h)
    .fillColor(COLOURS.panel)
    .fill()
    .lineWidth(0.5)
    .strokeColor(COLOURS.hairline)
    .rect(x, y, w, h)
    .stroke()
    .restore();
  doc
    .font(FONT.oblique)
    .fontSize(SIZE.small)
    .fillColor(COLOURS.muted)
    .text('Image unavailable', x, y + h / 2 - 6, { width: w, align: 'center' });
}

// ----------------------------------------------------------------------------
// Sign-off block (story 1075): Conducted by / Checked by / Validated by /
// Released on, plus the review-by date.
// ----------------------------------------------------------------------------

function renderSignOff(
  layout: Layout,
  model: ReportModel,
  profile: ReportProfile,
): void {
  layout.sectionHeading('Sign-off and review', 'Sign-off and review');
  const s = model.signOff;
  renderKeyValueGrid(layout, [
    ['Conducted by', s.conductedBy],
    ['Checked by', s.checkedBy],
    ['Validated by', s.validatedBy],
    ['Released on', formatDate(s.releasedOn)],
    ['Review by', formatDate(s.reviewByDate)],
  ]);
  layout.paragraph(
    'This assessment should be reviewed by the review-by date shown above, or sooner if there is a significant change to the premises, its use, or the persons at risk.',
  );
  // Any standard-specific review conventions the profile adds.
  for (const note of profile.signOffNotes) {
    layout.paragraph(note);
  }
}

// ----------------------------------------------------------------------------
// Misc helpers.
// ----------------------------------------------------------------------------

/** Title-case a single lower-case token (e.g. risk level "high" -> "High"). */
function titleCase(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ----------------------------------------------------------------------------
// Public entry point: render the model to a PDF Buffer.
// ----------------------------------------------------------------------------

/**
 * Render the full three-section report to a single PDF Buffer. Resolves once the
 * document is fully written, so the Function can upload the bytes directly. The
 * model carries every value and image already; this function performs no I/O.
 */
export function renderReportPdf(model: ReportModel): Promise<Buffer> {
  // Brand accent, validated so a malformed org colour cannot break the document.
  const brand = safeColour(model.orgProfile.brand?.primary, COLOURS.ink);
  // The standard-specific profile. Untagged/custom templates get the generic one.
  const profile = selectProfile(model.standard);

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: PAGE_MARGIN,
          bottom: PAGE_MARGIN,
          left: PAGE_MARGIN,
          right: PAGE_MARGIN,
        },
        info: {
          Title: `${profile.documentTitle} - ${model.overview.address}`,
          Author: model.orgProfile.name,
          Subject: `${profile.documentTitle} Report`,
        },
        // Pages are buffered so the footer's 'Page N of M' can be stamped in a
        // final pass (Layout.finalise) once the total page count is known.
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const layout = new Layout(doc, brand, model.orgProfile.name);
      layout.beginFirstPage();

      renderHeader(layout, model, brand, profile);

      // Reserve a contents page right after the cover; filled in finalise() once
      // each section's start page is known. Reserving it here keeps every later
      // page number stable when the ToC text is painted in the buffered pass.
      layout.reserveTocPage();

      layout.newPage();
      renderOverview(layout, model, brand, profile);

      layout.newPage();
      renderRiskAssessment(layout, model, profile);

      layout.newPage();
      renderActionPlan(layout, model);
      renderSignOff(layout, model, profile);

      // Stamp 'Page N of M' on every buffered page, then flush the document.
      layout.finalise();
      doc.end();
    } catch (caught) {
      reject(caught instanceof Error ? caught : new Error(String(caught)));
    }
  });
}
