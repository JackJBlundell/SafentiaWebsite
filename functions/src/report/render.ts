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
  ReportQuestionRow,
  ReportSection,
  ResolvedImage,
} from './assemble';
import { selectProfile, type ReportProfile } from './profiles';
import type { MatrixAnswer, QuestionMatrix, Severity } from '../shared/types';
import { adjustToMeetAA } from '../lib/contrast';

// ----------------------------------------------------------------------------
// Design tokens. Stated once so the whole document is consistent (brief 18.8).
// ----------------------------------------------------------------------------

const PAGE_MARGIN = 50;
/** Height of the strip kept clear at the foot of every page for the footer
 *  furniture (the registered-company line and 'Page | N' beneath it).
 *
 *  The document's bottom margin is PAGE_MARGIN + FOOTER_BAND, NOT PAGE_MARGIN,
 *  so PDFKit's own automatic page break (page.maxY()) falls on exactly the line
 *  Layout.bottomLimit stops at. Content this class paginates and content PDFKit
 *  paginates therefore end in the same place, and neither can run into the
 *  furniture. The furniture itself is drawn below the margin, from the constants
 *  here - see Layout.paintFooter. */
const FOOTER_BAND = 30;
/** Height of the strip kept clear at the head of every page (bar the cover) for
 *  the running logo. It sits ABOVE the top margin, exactly as the footer sits
 *  below the bottom one, so content never has to reason about it. */
const HEADER_LOGO_HEIGHT = 26;
/** Top of the running logo box. Its foot lands HEADER_LOGO_HEIGHT lower, which
 *  is still clear of the top margin. */
const HEADER_LOGO_TOP = 18;
/** Width the running logo is fitted into, right-aligned to the content edge. */
const HEADER_LOGO_WIDTH = 130;
/** Height of the solid brand band that introduces a numbered section. */
const SECTION_BAND_HEIGHT = 26;
/** Text inset inside a brand band or a table cell. */
const BAND_PAD = 7;
/** Vertical space a subheading occupies, including its trailing gap. */
const SUBHEADING_HEIGHT = 28;
/** Extra space a heading reserves on top of its own height, so that a heading
 *  and the opening lines of the block it introduces always share a page. Two
 *  body lines plus the gap between them. */
const ORPHAN_GUARD = 24;
const COLOURS = {
  ink: '#1F2937', // primary text
  muted: '#6B7280', // secondary text, captions
  hairline: '#E5E7EB', // dividers
  /** Table cell borders. The reference document rules its tables in a dark,
   *  clearly visible hairline rather than the near-white one used for dividers:
   *  the grid IS the structure of Section 1 and the action plan, and it has to
   *  survive photocopying. */
  rule: '#4B5563',
  panel: '#F9FAFB', // light panel backgrounds
  white: '#FFFFFF',
  // RAG is a SAFETY semantic - fixed, never overridden by brand (brief 9.1).
  rag: {
    low: '#2E7D32', // green
    medium: '#ED8B00', // amber
    high: '#C62828', // red
  } as Record<RagBand, string>,
} as const;

/** The paper the report is read on. The brand accent is corrected against this
 *  before it is painted, so a pale org colour still reads in print. */
const PAPER = COLOURS.white;

const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  oblique: 'Helvetica-Oblique',
} as const;

const SIZE = {
  title: 18,
  sectionHeading: 11,
  subHeading: 11,
  body: 10,
  small: 9,
  caption: 8,
  footer: 7.5,
} as const;

/**
 * The cover's geometry, in points on A4 (595.28 x 841.89), taken from the
 * approved reference document rather than invented: a logo band, then a 2x2
 * grid that is inset from the left and BLEEDS off the right page edge, a solid
 * brand square bleeding off the left edge beside the bottom row, a deliberately
 * empty lower third, and a full-bleed contact band above a white foot.
 *
 * Every number here is absolute. Nothing on the cover flows, so nothing on it
 * can paginate (see Layout.stamp for why that matters).
 */
const COVER = {
  /** Left edge of the 2x2 grid - roughly a fifth of the page in. */
  gridLeft: 127,
  /** Gap between the grid's two columns, and between the grid and the bleed. */
  gutter: 6,
  /** Width of the grid's left (image) column. */
  leftColWidth: 191,
  /** Top of the grid's first row. */
  row1Top: 170,
  /** Height of both grid rows. */
  rowHeight: 135,
  /** Gap between the two grid rows. */
  rowGap: 6,
  /** Foot of the logo band: the logo is bottom-aligned to this line. */
  logoBaseline: 144,
  /** Box the cover logo is fitted into (bottom-right aligned within it). */
  logoBox: [190, 48] as [number, number],
  /** Inset from the right page edge for the logo and the detail values. */
  rightInset: 27,
  /** Offset of the detail VALUE column from the detail column's left edge. */
  valueOffset: 95,
  /** Baseline pitch of the detail rows. */
  detailLineHeight: 13.4,
  /** Contact band: top edge, height, and the white foot left beneath it. */
  bandTop: 773,
  bandHeight: 38,
  /** Radius of the white circle each contact icon sits in. */
  iconRadius: 6.5,
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

/** `text` shortened with an ellipsis until it fits `maxWidth` at the document's
 *  CURRENT font and size. Page furniture is drawn without a wrap width (see
 *  Layout.stamp), so this is the only thing keeping a long organisation name or
 *  section label off its neighbour. */
function truncateToWidth(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (doc.widthOfString(text) <= maxWidth) {
    return text;
  }
  let kept = text;
  while (kept.length > 1 && doc.widthOfString(`${kept}...`) > maxWidth) {
    kept = kept.slice(0, -1);
  }
  return `${kept.trimEnd()}...`;
}

/**
 * `text` broken into lines that each fit `maxWidth` at the document's CURRENT
 * font and size.
 *
 * The cover wraps its own text rather than handing a `width` to PDFKit. That is
 * not a preference: the cover paints at absolute positions, some of them BELOW
 * the bottom margin (the contact band), and any PDFKit text() carrying a width
 * down there starts a new page (see Layout.stamp). Wrapping here and stamping
 * one line at a time keeps the cover to PDFKit's single-line path, which cannot
 * paginate. A word longer than the line is broken by character rather than
 * allowed to overhang.
 */
function wrapToWidth(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
): string[] {
  if (maxWidth <= 0) {
    return [];
  }
  const lines: string[] = [];
  let line = '';
  const push = (): void => {
    if (line.length > 0) {
      lines.push(line);
      line = '';
    }
  };
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line.length > 0 ? `${line} ${word}` : word;
    if (doc.widthOfString(candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    push();
    if (doc.widthOfString(word) <= maxWidth) {
      line = word;
      continue;
    }
    // A single unbreakable run (a long reference, a URL) - break it by
    // character so it stays inside the column instead of overhanging it.
    let chunk = '';
    for (const char of word) {
      if (doc.widthOfString(chunk + char) > maxWidth && chunk.length > 0) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    line = chunk;
  }
  push();
  return lines;
}

/** A hex colour mixed towards white. `amount` is how much of the colour is
 *  kept (1 = the colour itself, 0 = white), used to build the tonal steps the
 *  generated cover panel is painted from when an org has no cover image. */
function tint(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const channel = (offset: number): number => {
    const raw = parseInt(full.slice(offset, offset + 2), 16);
    const base = Number.isFinite(raw) ? raw : 0;
    return Math.round(255 - (255 - base) * Math.max(0, Math.min(1, amount)));
  };
  return `#${[0, 2, 4]
    .map((o) => channel(o).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Draw one run of text at an absolute position, leaving the running cursor and
 * the page count exactly as they were found.
 *
 * NEVER pass a `width` here, and NEVER drop the `lineBreak: false`. PDFKit
 * routes any text() that ends up carrying a width through its LineWrapper, and
 * LineWrapper starts a NEW PAGE whenever y + lineHeight passes the page's maxY
 * - `lineBreak: false` on its own does not stop that, it only stops
 * _initOptions defaulting `width` to the rest of the page. Page furniture and
 * the cover's contact band sit below the bottom margin by definition, so a
 * width-bearing call there paginates, and each spawned page paints another one
 * that paginates again: a 10-page report rendered as 573 pages of one line each
 * (measured 2026-07-28; the same defect was diagnosed and half-fixed on
 * 2026-07-15). With no width PDFKit takes its single-line path, which cannot
 * paginate.
 */
function stampText(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
): void {
  const cursorX = doc.x;
  const cursorY = doc.y;
  doc.text(text, x, y, { lineBreak: false });
  doc.x = cursorX;
  doc.y = cursorY;
}

// ----------------------------------------------------------------------------
// A thin layout helper around the PDFKit document. It owns the running cursor and
// the page chrome (header band, footer) so the section builders only describe
// content, not pagination plumbing.
// ----------------------------------------------------------------------------

/** One numbered section in the contents: its own title plus the numbered
 *  sub-headings emitted beneath it, listed in the same contents cell. */
interface TocSection {
  number: number;
  title: string;
  subEntries: string[];
}

/**
 * PDFKit's reusable image handle. `doc.openImage(buffer)` embeds the bytes once
 * and returns an object `doc.image()` accepts in place of a source; passing the
 * Buffer itself on every page embeds a fresh copy per page instead, which on a
 * long report multiplies the logo's bytes by the page count.
 *
 * Both are real pdfkit API (verified against pdfkit 0.15's images mixin, which
 * takes the `src.width && src.height` branch) but @types/pdfkit declares
 * neither, so they are reached through these two narrow declarations rather
 * than by widening anything to `any`.
 */
interface OpenedImage {
  readonly width: number;
  readonly height: number;
}
type ImageOpeningDocument = PDFKit.PDFDocument & {
  openImage(src: Buffer): OpenedImage;
};
/** An opened image, in the shape doc.image()'s declared parameter demands. */
function asImageSource(image: OpenedImage): Buffer {
  return image as unknown as Buffer;
}

/** The running chrome every page but the cover carries. */
interface Chrome {
  brand: string;
  orgName: string;
  /** The registered-company line printed, centred, in the footer. Composed by
   *  the caller from the org profile; empty when the org records nothing. */
  registeredLine: string;
  /** The org logo, opened ONCE (see Layout.constructor) and drawn on every page
   *  from that single embedded XObject. */
  logo?: OpenedImage;
}

class Layout {
  readonly doc: PDFKit.PDFDocument;
  readonly contentWidth: number;
  private readonly brand: string;
  private readonly chrome: Chrome;
  /** Buffered index (0-based) of the reserved Table of Contents page, or -1 when
   *  no ToC page has been reserved. finalise() paints the contents here. */
  private tocPageIndex = -1;
  /** Images opened against THIS document, memoised by the model object holding
   *  their bytes (`null` = tried and failed). doc.openImage() embeds a fresh copy
   *  of the bytes on every call, and an evidence image is opened to MEASURE its
   *  cell before it is painted - twice over for the first row of a subject, which
   *  is measured again to keep it with its heading. Without the memo a single
   *  floor plan would be embedded three times in the file. */
  private readonly openedImages = new WeakMap<ResolvedImage, OpenedImage | null>();
  /** Major sections in document order. Populated by section() as the report is
   *  emitted and by subHeading() as each one is passed; consumed by finalise()
   *  to fill the reserved contents page. */
  private readonly tocSections: TocSection[] = [];

  constructor(doc: PDFKit.PDFDocument, chrome: Chrome) {
    this.doc = doc;
    this.brand = chrome.brand;
    this.chrome = chrome;
    this.contentWidth =
      doc.page.width - doc.page.margins.left - doc.page.margins.right;
  }

  /**
   * The embedded handle for a resolved image, or undefined when there is nothing
   * to draw (never fetched, or the bytes will not decode). Callers use the
   * handle's intrinsic width/height to size a cell to the picture, so a plan is
   * fitted rather than squeezed into a fixed box.
   *
   * A decode failure is answered here, once, rather than at paint time: a cell
   * whose height was measured from an image that then refuses to draw would
   * leave a hole in a bordered table.
   */
  openImage(image: ResolvedImage): OpenedImage | undefined {
    if (!image.available || !image.data) {
      return undefined;
    }
    const cached = this.openedImages.get(image);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    let opened: OpenedImage | null = null;
    try {
      const handle = (this.doc as ImageOpeningDocument).openImage(image.data);
      if (handle && handle.width > 0 && handle.height > 0) {
        opened = handle;
      }
    } catch {
      // A corrupt or unsupported image degrades to the "unavailable" marker.
    }
    this.openedImages.set(image, opened);
    return opened ?? undefined;
  }

  /** The section currently being emitted, for sub-heading numbering. */
  private get currentSection(): TocSection | undefined {
    return this.tocSections[this.tocSections.length - 1];
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

  /** The lowest y content may reach on this page. The document's bottom margin
   *  already contains FOOTER_BAND, so this is also PDFKit's own page.maxY(): a
   *  paragraph PDFKit breaks by itself stops exactly where ensureSpace would
   *  have broken it, and neither can reach the footer furniture. */
  private get bottomLimit(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
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
      this.doc.page.margins.bottom
    );
  }

  /** Ensure `needed` vertical points are available; start a new page if not. */
  ensureSpace(needed: number): void {
    if (this.doc.y + needed > this.bottomLimit) {
      this.newPage();
    }
  }

  /** Add a page. addPage() parks the cursor at the top margin itself, and the
   *  footer is NOT painted here: all page furniture is painted in one buffered
   *  pass from finalise() - see paintFooter for why that matters. */
  newPage(): void {
    this.doc.addPage();
  }

  /** Draw one run of page furniture at an absolute position. See stampText for
   *  why furniture never carries a `width`. */
  private stamp(text: string, x: number, y: number): void {
    stampText(this.doc, text, x, y);
  }

  /** Stamp a run centred on the page, at the current font. */
  private stampCentred(text: string, y: number): void {
    const { doc } = this;
    this.stamp(text, (doc.page.width - doc.widthOfString(text)) / 2, y);
  }

  /**
   * The footer for one page: the registered-company line in the brand colour,
   * centred, with 'Page | N' beneath it - the running furniture of the approved
   * reference document.
   *
   * Painted only from the buffered pass in finalise(), never while content is
   * being laid out. Painting furniture mid-flow was the original defect: PDFKit
   * emits 'pageAdded' from INSIDE its own page break, before LineWrapper has
   * resumed, and a footer painted from that hook moved doc.y into the footer
   * strip. LineWrapper does not reset doc.y after continueOnNewPage(), so the
   * interrupted paragraph carried on at the bottom of the new page, overflowed
   * immediately, and took another page - one line per page for the rest of the
   * paragraph.
   *
   * Geometry comes from the PAGE_MARGIN constant, not from doc.page.margins:
   * PDFKit hands every page the SAME margins object (it is doc.options.margins
   * by reference, verified against pdfkit 0.15), so reading it here is fragile
   * and mutating it - as this code used to, to dodge the pagination above - is a
   * document-wide side effect that any re-entrant call then reads back as zero.
   */
  private paintFooter(pageNumber: number): void {
    const { doc } = this;
    const registeredY = doc.page.height - 55;

    if (this.chrome.registeredLine) {
      doc.font(FONT.regular).fontSize(SIZE.footer).fillColor(this.brand);
      // Nothing wraps furniture text (see stampText), so the line is trimmed to
      // the page rather than being allowed to run off it.
      this.stampCentred(
        truncateToWidth(
          doc,
          this.chrome.registeredLine,
          doc.page.width - PAGE_MARGIN * 2,
        ),
        registeredY,
      );
    }
    doc.font(FONT.regular).fontSize(SIZE.caption).fillColor(COLOURS.ink);
    this.stampCentred(`Page | ${pageNumber}`, registeredY + 10);
  }

  /** The running logo, top-right, on every page but the cover. Drawn from the
   *  ONE opened image the constructor embedded, so a twenty-page report carries
   *  a single copy of the bytes rather than twenty. */
  private paintHeaderLogo(): void {
    const { doc } = this;
    if (!this.chrome.logo) {
      return;
    }
    try {
      doc.image(
        asImageSource(this.chrome.logo),
        doc.page.width - PAGE_MARGIN - HEADER_LOGO_WIDTH,
        HEADER_LOGO_TOP,
        {
          fit: [HEADER_LOGO_WIDTH, HEADER_LOGO_HEIGHT],
          align: 'right',
          valign: 'bottom',
        },
      );
    } catch {
      // A logo that will not draw costs the mark, never the document.
    }
  }

  /**
   * Final pass over every buffered page (bufferPages: true): fill the reserved
   * contents page, then paint every page's furniture. Call exactly once, after
   * all content and before doc.end().
   *
   * The cover (page 1) is skipped: it carries its own chrome - its own logo
   * band and its own full-bleed contact band - and, like the reference
   * document, no page number.
   */
  finalise(): void {
    const { doc } = this;
    // Fill the reserved contents page first. This uses switchToPage exactly as
    // the furniture pass does.
    this.paintToc();
    const range = doc.bufferedPageRange();
    const total = range.start + range.count;
    for (let i = range.start; i < total; i += 1) {
      if (i === range.start) {
        continue;
      }
      doc.switchToPage(i);
      this.paintHeaderLogo();
      this.paintFooter(i + 1 + this.pageNumberOffset);
    }
  }

  /** Pages spliced in ahead of the report body after rendering (the template's
   *  certificate), which the printed page numbers have to account for. */
  private pageNumberOffset = 0;

  /** Tell the footer how many pages will be inserted after the cover once the
   *  document is merged, so 'Page | N' still matches the finished PDF. */
  setPageNumberOffset(pages: number): void {
    this.pageNumberOffset = Math.max(0, Math.floor(pages));
  }

  /**
   * Paint the contents onto the page reserved by reserveTocPage(): a bordered
   * table under a solid brand header row, the section number in a narrow left
   * cell and the section title, bold, beside it with its numbered sub-headings
   * listed beneath in the same cell - the reference document's contents page.
   *
   * It lists no page numbers, exactly as the reference does not. That is what
   * lets the template's certificate be spliced in afterwards without the
   * contents becoming a lie about a document it was written before.
   *
   * Runs in the buffered pass (from finalise). Every position is absolute and
   * every run goes through stamp(), so this pass cannot trip PDFKit's line
   * wrapper into spawning an extra page - which here would be appended at the
   * END of the document, far from the page being written.
   */
  private paintToc(): void {
    if (this.tocPageIndex < 0 || this.tocSections.length === 0) {
      return;
    }
    const { doc } = this;
    doc.switchToPage(this.tocPageIndex);
    const left = doc.page.margins.left;
    const numberWidth = 100;
    const titleX = left + numberWidth;
    const titleWidth = this.contentWidth - numberWidth;
    const top = doc.page.margins.top;
    const available = this.bottomLimit - top - SECTION_BAND_HEIGHT;

    // Measure first. A template with many subjects can list more sub-entries
    // than one reserved page holds, and the contents page is deliberately ONE
    // page: rather than clip arbitrarily, drop the sub-entries (the sections
    // alone always fit) so the page still reads as a finished table.
    const rowHeight = (section: TocSection, withSubs: boolean): number =>
      SIZE.body +
      10 +
      (withSubs ? section.subEntries.length * (SIZE.small + 5) : 0) +
      (withSubs && section.subEntries.length > 0 ? 6 : 0);
    const total = (withSubs: boolean): number =>
      this.tocSections.reduce((sum, s) => sum + rowHeight(s, withSubs), 0);
    const withSubs = total(true) <= available;

    // Brand header row.
    let y = top;
    doc.save().rect(left, y, this.contentWidth, SECTION_BAND_HEIGHT).fill(this.brand).restore();
    doc.font(FONT.bold).fontSize(SIZE.sectionHeading).fillColor(COLOURS.white);
    this.stamp(
      'Contents',
      left + BAND_PAD,
      y + (SECTION_BAND_HEIGHT - SIZE.sectionHeading) / 2 - 1,
    );
    y += SECTION_BAND_HEIGHT;

    for (const section of this.tocSections) {
      const height = rowHeight(section, withSubs);
      if (y + height > this.bottomLimit) {
        break;
      }
      doc
        .save()
        .lineWidth(0.75)
        .strokeColor(COLOURS.rule)
        .rect(left, y, numberWidth, height)
        .stroke()
        .rect(titleX, y, titleWidth, height)
        .stroke()
        .restore();

      doc.font(FONT.bold).fontSize(SIZE.body).fillColor(COLOURS.ink);
      this.stamp(
        truncateToWidth(doc, `Section ${section.number}`, numberWidth - BAND_PAD * 2),
        left + BAND_PAD,
        y + 5,
      );
      this.stamp(
        truncateToWidth(doc, section.title, titleWidth - BAND_PAD * 2),
        titleX + BAND_PAD,
        y + 5,
      );

      if (withSubs) {
        let subY = y + SIZE.body + 12;
        doc.font(FONT.regular).fontSize(SIZE.small).fillColor(COLOURS.ink);
        for (const sub of section.subEntries) {
          this.stamp(
            truncateToWidth(doc, sub, titleWidth - BAND_PAD * 2),
            titleX + BAND_PAD,
            subY,
          );
          subY += SIZE.small + 5;
        }
      }
      y += height;
    }
  }

  /**
   * Open a numbered section: a full-width solid brand band carrying the section
   * title in white, as every section page of the reference document does. The
   * section is numbered automatically in document order and recorded for the
   * contents page, and its number then prefixes every sub-heading beneath it.
   */
  section(title: string): void {
    this.ensureSpace(SECTION_BAND_HEIGHT + 14 + ORPHAN_GUARD);
    const number = this.tocSections.length + 1;
    this.tocSections.push({ number, title, subEntries: [] });

    const { doc } = this;
    const left = doc.page.margins.left;
    const y = doc.y;
    doc
      .save()
      .rect(left, y, this.contentWidth, SECTION_BAND_HEIGHT)
      .fill(this.brand)
      .restore();
    // The band's label is a single line by construction, so it is stamped
    // rather than flowed: a section title long enough to wrap would otherwise
    // push text out of the band it is painted on.
    doc.font(FONT.bold).fontSize(SIZE.sectionHeading).fillColor(COLOURS.white);
    this.stamp(
      truncateToWidth(
        doc,
        `Section ${number} - ${title}`,
        this.contentWidth - BAND_PAD * 2,
      ),
      left + BAND_PAD,
      y + (SECTION_BAND_HEIGHT - SIZE.sectionHeading) / 2 - 1,
    );
    doc.y = y + SECTION_BAND_HEIGHT + 14;
  }

  /** A minor heading within a section, numbered `N.M` in the section's sequence
   *  and listed under that section on the contents page. Reserves room for the
   *  first couple of lines of whatever follows as well as the heading itself, so
   *  a heading is never left stranded at the foot of a page above its own
   *  content. Callers whose block is bigger than that (a subject table) reserve
   *  their own. */
  subHeading(label: string): string {
    this.ensureSpace(SUBHEADING_HEIGHT + ORPHAN_GUARD);
    const section = this.currentSection;
    const numbered = section
      ? `${section.number}.${section.subEntries.length + 1} ${label}`
      : label;
    section?.subEntries.push(numbered);
    this.doc
      .font(FONT.bold)
      .fontSize(SIZE.subHeading)
      .fillColor(COLOURS.ink)
      .text(numbered, this.doc.page.margins.left, this.doc.y);
    this.doc.moveDown(0.5);
    return numbered;
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
// The cover (story 1075), rebuilt to the approved reference document.
//
// The whole page is painted at ABSOLUTE positions and nothing on it flows: no
// call here may leave the running cursor somewhere the rest of the document
// would inherit, and every run below the bottom margin (the contact band) goes
// through stampText. See Layout.stamp for what a width-bearing text() costs
// down there.
//
// Every asset on the cover is optional. A missing logo becomes the org name set
// as a wordmark; a missing cover image becomes a panel painted from the brand
// colours (deliberately NOT a stock photograph - see OrgProfile.coverImageUrl);
// a missing building photograph becomes a second solid brand block, which reads
// as part of the composition rather than as a hole in it.
// ----------------------------------------------------------------------------

/** Draw an image so it FILLS `w` x `h`, cropped and centred, never letterboxed.
 *  Returns false when the image could not be drawn, so the caller can paint its
 *  fallback instead of leaving a gap. */
function paintCoverImage(
  doc: PDFKit.PDFDocument,
  data: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  try {
    doc.save().rect(x, y, w, h).clip();
    doc.image(data, x, y, {
      cover: [w, h],
      align: 'center',
      valign: 'center',
    });
    doc.restore();
    return true;
  } catch {
    doc.restore();
    return false;
  }
}

/**
 * The generated stand-in for an absent cover image: concentric quarter-discs
 * rippling out of the panel's bottom-left corner, in steps of the org's own
 * brand colour from a pale wash to the full accent. It is composed from the
 * brand alone, so it belongs to whichever organisation is printing.
 */
function paintBrandPanel(
  doc: PDFKit.PDFDocument,
  brand: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  doc.save().rect(x, y, w, h).clip();
  doc.rect(x, y, w, h).fill(tint(brand, 0.07));
  const cx = x;
  const cy = y + h;
  const steps: Array<[number, number]> = [
    [1.15, 0.16],
    [0.9, 0.28],
    [0.65, 0.45],
    [0.4, 0.72],
    [0.17, 1],
  ];
  for (const [radius, strength] of steps) {
    doc.circle(cx, cy, w * radius).fill(tint(brand, strength));
  }
  doc.restore();
}

/** One contact item in the cover's bottom band: an icon in a white disc and the
 *  value beside it. The icon is a ZapfDingbats glyph where one exists (a
 *  telephone, an envelope) and a tiny "www" wordmark for the website, exactly as
 *  the reference document does it. */
interface ContactItem {
  text: string;
  /** A ZapfDingbats character, or undefined for the "www" wordmark. */
  dingbat?: string;
  /** Optical correction, in points, for a glyph that does not sit centred in
   *  its own em box - ZapfDingbats' telephone rides noticeably high. */
  nudge?: number;
}

function coverContactItems(model: ReportModel): ContactItem[] {
  const contact = model.orgProfile.contact;
  const items: ContactItem[] = [];
  const add = (value: string | undefined, dingbat?: string, nudge = 0): void => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length > 0) {
      items.push(dingbat ? { text: trimmed, dingbat, nudge } : { text: trimmed });
    }
  };
  // ZapfDingbats a5 (0x25) is the telephone, a9 (0x29) the envelope.
  add(contact?.phone, '%', 1.5);
  add(contact?.email, ')');
  add(contact?.website);
  return items;
}

/** The cover's full-bleed contact band. Whatever the org actually records is
 *  spread evenly across the band; a missing phone, email or website costs its
 *  item, never a gap where one used to be. */
function paintContactBand(
  doc: PDFKit.PDFDocument,
  brand: string,
  items: ContactItem[],
): void {
  const bandY = COVER.bandTop;
  doc
    .save()
    .rect(0, bandY, doc.page.width, COVER.bandHeight)
    .fill(brand)
    .restore();
  if (items.length === 0) {
    return;
  }

  const iconGap = 6;
  const iconWidth = COVER.iconRadius * 2;
  // Measure at the font each run is painted in, then centre the whole group
  // with equal gaps between items.
  doc.font(FONT.regular).fontSize(SIZE.small);
  const widths = items.map(
    (item) => iconWidth + iconGap + doc.widthOfString(item.text),
  );
  const totalItems = widths.reduce((sum, w) => sum + w, 0);
  const gaps = items.length > 1 ? items.length - 1 : 0;
  const spare = doc.page.width - PAGE_MARGIN * 2 - totalItems;
  const gap = gaps > 0 ? Math.max(24, spare / gaps) : 0;
  let x = Math.max(
    PAGE_MARGIN / 2,
    (doc.page.width - (totalItems + gap * gaps)) / 2,
  );

  const centreY = bandY + COVER.bandHeight / 2;
  items.forEach((item, index) => {
    doc
      .save()
      .circle(x + COVER.iconRadius, centreY, COVER.iconRadius)
      .fill(COLOURS.white)
      .restore();
    // Optically centred in the disc: text() places the TOP of the line box, so
    // every run here is offset by half its own line height rather than by a
    // guessed number of points.
    if (item.dingbat) {
      doc.font('ZapfDingbats').fontSize(8).fillColor(brand);
    } else {
      doc.font(FONT.bold).fontSize(4.5).fillColor(brand);
    }
    const glyph = item.dingbat ?? 'www';
    stampText(
      doc,
      glyph,
      x + COVER.iconRadius - doc.widthOfString(glyph) / 2,
      centreY - doc.currentLineHeight() / 2 + (item.nudge ?? 0),
    );
    doc.font(FONT.regular).fontSize(SIZE.small).fillColor(COLOURS.white);
    stampText(
      doc,
      item.text,
      x + iconWidth + iconGap,
      centreY - doc.currentLineHeight() / 2,
    );
    x += widths[index] + gap;
  });
}

function renderCover(
  layout: Layout,
  model: ReportModel,
  brand: string,
  profile: ReportProfile,
): void {
  const { doc } = layout;
  const pageWidth = doc.page.width;
  const gridLeft = COVER.gridLeft;
  const leftColWidth = COVER.leftColWidth;
  const rightX = gridLeft + leftColWidth + COVER.gutter;
  const rightWidth = pageWidth - rightX;
  const row1 = COVER.row1Top;
  const row2 = row1 + COVER.rowHeight + COVER.rowGap;

  // --- The logo band, above the grid ---------------------------------------
  const logoRight = pageWidth - COVER.rightInset;
  const [logoBoxW, logoBoxH] = COVER.logoBox;
  let logoDrawn = false;
  if (model.logo?.available && model.logo.data) {
    try {
      doc.image(model.logo.data, logoRight - logoBoxW, COVER.logoBaseline - logoBoxH, {
        fit: [logoBoxW, logoBoxH],
        align: 'right',
        valign: 'bottom',
      });
      logoDrawn = true;
    } catch {
      // A corrupt logo costs the mark, not the cover.
    }
  }
  if (!logoDrawn) {
    // No mark: set the organisation's name as a wordmark in its place, so the
    // band still reads as branding rather than as a blank strip.
    doc.font(FONT.bold).fontSize(16).fillColor(brand);
    const name = truncateToWidth(doc, model.orgProfile.name, logoBoxW + 90);
    stampText(doc, name, logoRight - doc.widthOfString(name), COVER.logoBaseline - 18);
  }

  // --- Row 1: the decorative panel and the title panel ----------------------
  const coverPainted =
    model.coverImage?.available && model.coverImage.data
      ? paintCoverImage(
          doc,
          model.coverImage.data,
          gridLeft,
          row1,
          leftColWidth,
          COVER.rowHeight,
        )
      : false;
  if (!coverPainted) {
    paintBrandPanel(doc, brand, gridLeft, row1, leftColWidth, COVER.rowHeight);
  }

  doc
    .save()
    .rect(rightX, row1, rightWidth, COVER.rowHeight)
    .fill(brand)
    .restore();
  doc.font(FONT.bold).fontSize(SIZE.title).fillColor(COLOURS.white);
  // The title sits at the TOP-LEFT of a panel far taller than it, as in the
  // reference. It is wrapped here rather than by PDFKit so an unusually long
  // standard title cannot spill out of the panel.
  let titleY = row1 + 10;
  for (const line of wrapToWidth(
    doc,
    profile.documentTitle,
    rightWidth - BAND_PAD - COVER.rightInset,
  )) {
    if (titleY + SIZE.title > row1 + COVER.rowHeight) {
      break;
    }
    stampText(doc, line, rightX + BAND_PAD, titleY);
    titleY += SIZE.title + 4;
  }

  // --- Row 2: the brand square bleeding off the left edge, the building
  // photograph, and the site details on white -------------------------------
  doc
    .save()
    .rect(0, row2, gridLeft - COVER.gutter, COVER.rowHeight)
    .fill(brand)
    .restore();

  const photoPainted =
    model.buildingPhoto?.available && model.buildingPhoto.data
      ? paintCoverImage(
          doc,
          model.buildingPhoto.data,
          gridLeft,
          row2,
          leftColWidth,
          COVER.rowHeight,
        )
      : false;
  if (!photoPainted) {
    // A second solid block in the brand's secondary tone: the composition still
    // reads as three deliberate blocks rather than as a missing photograph.
    const secondary = adjustToMeetAA(
      safeColour(model.orgProfile.brand?.secondary, brand),
      PAPER,
    );
    doc
      .save()
      .rect(gridLeft, row2, leftColWidth, COVER.rowHeight)
      .fill(secondary)
      .restore();
  }

  const labelX = rightX + BAND_PAD;
  const valueX = rightX + COVER.valueOffset;
  const valueWidth = pageWidth - COVER.rightInset - valueX;
  const details: Array<[string, string]> = [
    ['Site:', model.overview.siteName],
    ['Address:', model.overview.address],
    ['Client:', model.overview.clientName],
    ['Visit Date:', formatDate(model.overview.dateCarriedOut)],
    ['Author:', model.signOff.conductedBy],
    ['Review Date:', formatDate(model.signOff.reviewByDate)],
  ];
  // The block must never reach the contact band, however long an address is.
  const detailLimit = COVER.bandTop - 30;
  let detailY = row2 + 3;
  for (const [label, value] of details) {
    doc.font(FONT.regular).fontSize(SIZE.small);
    const lines = wrapToWidth(doc, value, valueWidth);
    if (detailY + COVER.detailLineHeight > detailLimit) {
      break;
    }
    doc.fillColor(brand);
    stampText(doc, truncateToWidth(doc, label, COVER.valueOffset - BAND_PAD), labelX, detailY);
    doc.fillColor(COLOURS.ink);
    for (const line of lines.length > 0 ? lines : ['']) {
      if (detailY + COVER.detailLineHeight > detailLimit) {
        break;
      }
      stampText(doc, line, valueX, detailY);
      detailY += COVER.detailLineHeight;
    }
  }

  // --- The full-bleed contact band above the white foot --------------------
  paintContactBand(doc, brand, coverContactItems(model));

  // The lower third is deliberately empty. Nothing else is emitted on this page:
  // the caller reserves the contents page immediately afterwards.
}

// ----------------------------------------------------------------------------
// Section 1 - Overview (story 1071).
// ----------------------------------------------------------------------------

/** Padding inside a key/value table cell. */
const CELL_PAD = 5;
/** Share of the content width taken by the label column of a key/value table,
 *  matching the reference document's roughly-a-third label column. */
const LABEL_COLUMN_SHARE = 0.33;

/**
 * The two-column bordered table the reference document uses everywhere a fact
 * is stated: a label column of about a third, hairline rules, and rows exactly
 * as tall as their content needs, with a multi-paragraph value living inside one
 * cell. The label is centred against its value; the value reads from the top.
 *
 * A row too tall for a whole page is NOT boxed. Nothing here can split a border
 * across a page break, so a value that long (an action's observation can be)
 * degrades to an unruled label-above-paragraph block, which PDFKit paginates
 * correctly, rather than to a box drawn in the wrong place.
 */
/** The height of one key/value row. Stated once so the grid's painter and its
 *  measurer (which decides whether a whole action card fits) cannot disagree. */
function keyValueRowHeight(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  labelInner: number,
  valueInner: number,
): number {
  // The taller of the two columns, so a row never overlaps the next.
  const valueHeight = doc
    .font(FONT.regular)
    .fontSize(SIZE.body)
    .heightOfString(value, { width: valueInner });
  const labelHeight = doc
    .font(FONT.bold)
    .fontSize(SIZE.body)
    .heightOfString(label, { width: labelInner });
  return Math.max(valueHeight, labelHeight, SIZE.body + 4) + CELL_PAD * 2;
}

/** The key/value grid's columns and ruling, for an evidence row joining it. */
function keyValueEvidenceStyle(layout: Layout): EvidenceRowStyle {
  const labelWidth = Math.round(layout.contentWidth * LABEL_COLUMN_SHARE);
  return {
    left: layout.doc.page.margins.left,
    labelWidth,
    valueWidth: layout.contentWidth - labelWidth,
    labelFont: FONT.bold,
    labelSize: SIZE.body,
    lineWidth: 0.75,
    strokeColour: COLOURS.rule,
  };
}

/** The total height renderKeyValueGrid will lay down for the same arguments,
 *  excluding its trailing gap. Used to keep an action card and its located
 *  evidence on one page. */
function measureKeyValueGrid(
  layout: Layout,
  rows: Array<[string, string]>,
  evidence: ResolvedImage[] = [],
): number {
  const { doc } = layout;
  const labelWidth = Math.round(layout.contentWidth * LABEL_COLUMN_SHARE);
  const valueWidth = layout.contentWidth - labelWidth;
  let total = 0;
  for (const [label, value] of rows) {
    if (value.trim().length === 0) {
      continue;
    }
    total += keyValueRowHeight(
      doc,
      label,
      value,
      labelWidth - CELL_PAD * 2,
      valueWidth - CELL_PAD * 2,
    );
  }
  for (const image of evidence) {
    total += measureEvidenceRow(layout, image, keyValueEvidenceStyle(layout)).rowHeight;
  }
  return total;
}

function renderKeyValueGrid(
  layout: Layout,
  rows: Array<[string, string]>,
  /** Pictures appended as further rows of THIS grid (the action plan's flagged
   *  locations), each in a labelled cell pair matching the rows above. They are
   *  part of the grid rather than a block beneath it so the ruling runs
   *  unbroken from the first label to the last plan. */
  evidence: ResolvedImage[] = [],
): void {
  const { doc } = layout;
  const left = doc.page.margins.left;
  const labelWidth = Math.round(layout.contentWidth * LABEL_COLUMN_SHARE);
  const valueX = left + labelWidth;
  const valueWidth = layout.contentWidth - labelWidth;
  const labelInner = labelWidth - CELL_PAD * 2;
  const valueInner = valueWidth - CELL_PAD * 2;

  for (const [label, value] of rows) {
    // A row with nothing in it is not a row. An empty value cell reads as a
    // rendering fault to whoever receives the document, and a column of them
    // makes a report look unfinished. Note this drops only genuinely BLANK
    // values: a field the assessor considered and could not answer carries the
    // standardised "Not recorded", which is information and stays.
    if (value.trim().length === 0) {
      continue;
    }
    const labelHeight = doc
      .font(FONT.bold)
      .fontSize(SIZE.body)
      .heightOfString(label, { width: labelInner });
    const rowHeight = keyValueRowHeight(doc, label, value, labelInner, valueInner);

    if (rowHeight > layout.fullPageContentHeight) {
      layout.ensureSpace(SIZE.body * 3);
      doc
        .font(FONT.bold)
        .fontSize(SIZE.body)
        .fillColor(COLOURS.ink)
        .text(label, left, doc.y, { width: layout.contentWidth });
      layout.paragraph(value);
      continue;
    }

    layout.ensureSpace(rowHeight);
    const y = doc.y;
    doc
      .save()
      .lineWidth(0.75)
      .strokeColor(COLOURS.rule)
      .rect(left, y, labelWidth, rowHeight)
      .stroke()
      .rect(valueX, y, valueWidth, rowHeight)
      .stroke()
      .restore();
    doc
      .font(FONT.bold)
      .fontSize(SIZE.body)
      .fillColor(COLOURS.ink)
      .text(label, left + CELL_PAD, y + (rowHeight - labelHeight) / 2, {
        width: labelInner,
      });
    doc
      .font(FONT.regular)
      .fontSize(SIZE.body)
      .fillColor(COLOURS.ink)
      .text(value, valueX + CELL_PAD, y + CELL_PAD, { width: valueInner });
    doc.y = y + rowHeight;
  }

  const style = keyValueEvidenceStyle(layout);
  for (const image of evidence) {
    // Reserved whole: an image row cannot be split, and the cap on the drawn
    // height guarantees one always fits a fresh page.
    const metrics = measureEvidenceRow(layout, image, style);
    layout.ensureSpace(metrics.rowHeight);
    paintEvidenceRow(layout, style, metrics);
  }

  doc.moveDown(0.6);
}

function renderOverview(
  layout: Layout,
  model: ReportModel,
  brand: string,
  profile: ReportProfile,
): void {
  layout.section('Executive Summary');

  const o = model.overview;
  const article53 =
    o.article53Persons.length > 0
      ? o.article53Persons.join(', ')
      : 'None recorded';

  // Base facts, then any standard-specific rows the profile contributes. The
  // profile hook is pure and defensive; it returns [] when it adds nothing.
  const overviewRows: Array<[string, string]> = [
    ['Premises address', o.address],
    // "Responsible person" is the statutory term (Regulatory Reform (Fire
    // Safety) Order 2005) - the legally correct heading for this row. Do not
    // reword it to match the field name behind it.
    ['Responsible person', o.responsiblePartyLine],
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

  // The building photograph is NOT repeated here. It is a cover element (the
  // bottom-left cell of the cover grid), which is where the reference documents
  // this report follows put it and where a reader looks for it. Printing it
  // again a page later cost a block of vertical space, and the fixed 156pt
  // advance under it left a band of white whenever the photo fitted shorter than
  // its box - the "blank box" this used to show.
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
    // A bullet with no text is a stray dash on the page - never printed.
    if (line.trim().length === 0) {
      continue;
    }
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
    // These titles are drawn directly rather than through subHeading(), so they
    // carry their own orphan guard: without it a title landed at the foot of a
    // page with its paragraph starting on the next.
    layout.ensureSpace(SIZE.small + 6 + ORPHAN_GUARD);
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
): Map<string, string> {
  layout.section('Fire Risk Assessment');
  layout.paragraph(profile.riskAssessmentIntro);
  // The "Not applicable" convention is explained here, immediately above the
  // tables that use it, and ONLY when this assessment actually contains such an
  // item - a report that explains a convention it never uses invites the reader
  // to go looking for one. Stating it once is what lets each row stay short: the
  // rows carry the decision, this paragraph carries its meaning.
  if (
    model.sections.some((section) =>
      section.rows.some((row) => row.notApplicable === true),
    )
  ) {
    layout.paragraph(profile.notApplicableNote);
  }
  // The numbered heading each subject was given, keyed by the template code the
  // action plan references. Section 3 prints "2.4 Fire Doors" rather than the
  // opaque code, so an action can be found in Section 2 without a decoder.
  const subjectLabels = new Map<string, string>();
  for (const section of model.sections) {
    subjectLabels.set(section.code, renderSubjectTable(layout, section));
  }
  return subjectLabels;
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

/** The two cells of a subject row, as the styled segments the cell painter and
 *  the cell measurer both take. Built in one place so the height reserved for a
 *  row is measured from exactly what will be painted. */
function rowSegments(row: ReportQuestionRow): {
  qSegs: CellSegment[];
  aSegs: CellSegment[];
} {
  // A yesno answer is a compliance signal, so it reads in bold; every other
  // type renders as regular text. Unknown/custom types fall through to regular.
  //
  // A "Not applicable" answer reads in bold for the same reason: it is a
  // positive decision the assessor took about these premises, and the row it
  // sits in must not be mistaken - by a reader scanning the column, or on a
  // photocopy - for the "Not answered" of an item nobody reached. The words
  // themselves carry the distinction (colour and weight are never the sole
  // carrier of meaning, brief 18.5); the emphasis simply makes it findable. It
  // gets no coloured tag on purpose: colour in this document is the RAG safety
  // semantic, and a not-applicable item has no risk grade to signal.
  const answerBold = row.questionType === 'yesno' || row.notApplicable === true;
  return {
    // The question cell: the question ALONE. The template's guidance is
    // deliberately not printed - it is prompting text written for the assessor
    // standing in the building, and repeating it under every row cost pages of
    // an already long document while telling the reader nothing about the
    // premises. The assembled model still carries `row.guidance` for any surface
    // that wants it; the report simply does not spend a line on it.
    qSegs: [
      {
        text: row.questionText,
        font: FONT.regular,
        size: SIZE.small,
        colour: COLOURS.ink,
      },
    ],
    // The answer cell: answer (bold for yesno), observation, severity tag.
    aSegs: [
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
    ],
  };
}

/** The vertical space one subject row needs: the taller of its two cells plus
 *  padding, then - for a matrix question - the grid drawn immediately beneath it,
 *  then the FIRST row of each evidence strip attached to it.
 *
 *  A matrix row's grid is reserved WITH the row: reserving only the row let a
 *  short row sit at the foot of a page with its grid alone at the top of the
 *  next, reading as an unattributed table. Evidence is reserved for the same
 *  reason and it matters more now that a flagged location can hang off any
 *  question: a floor plan captioned "Flagged location: Ground floor" alone at the
 *  top of a page evidences nothing the reader can see. Only the first strip row
 *  is reserved - the strip's later rows can flow, since by then the reader has
 *  the question in view - and the caller already caps the whole reservation at
 *  what a fresh page can hold. */
function measureRowBlock(
  layout: Layout,
  row: ReportQuestionRow,
  qWidth: number,
  aWidth: number,
): number {
  const { doc } = layout;
  const { qSegs, aSegs } = rowSegments(row);
  const rowHeight =
    Math.max(
      segmentsHeight(doc, qSegs, qWidth - 8),
      segmentsHeight(doc, aSegs, aWidth - 8),
    ) + 10;
  const matrixHeight = row.matrix
    ? measureMatrixBlock(doc, row.matrix, row.matrixAnswer, aWidth).total
    : 0;
  return rowHeight + matrixHeight + measureRowEvidence(layout, row);
}

/** Height the evidence beneath a question claims for the keep-together decision:
 *  the FIRST flagged-location row in full (a picture cannot be split, and a plan
 *  captioned "Ground floor" alone at the top of a page evidences nothing the
 *  reader can see) plus the first row of the photo strip. Later rows are allowed
 *  to flow - by then the reader has the question in view - and the caller already
 *  caps the whole reservation at what a fresh page can hold. */
function measureRowEvidence(layout: Layout, row: ReportQuestionRow): number {
  const firstFlag = row.flagImages?.[0];
  const flagHeight = firstFlag
    ? measureEvidenceRow(layout, firstFlag, subjectEvidenceStyle(layout)).rowHeight
    : 0;
  const photoHeight =
    row.photos && row.photos.length > 0
      ? measureImageStrip(
          layout.doc,
          row.photos.slice(0, 1),
          PHOTO_BOX[0],
          PHOTO_BOX[1],
          layout.contentWidth,
        )
      : 0;
  return flagHeight + photoHeight;
}

/** The subject table's own columns and hairline, so an evidence row continues it
 *  seamlessly. Derived in one place because the measurer and the painter must be
 *  handed identical geometry. */
function subjectEvidenceStyle(layout: Layout): EvidenceRowStyle {
  return {
    left: layout.doc.page.margins.left,
    labelWidth: layout.contentWidth * 0.46,
    valueWidth: layout.contentWidth * 0.54,
    labelFont: FONT.regular,
    labelSize: SIZE.small,
    lineWidth: 0.5,
    strokeColour: COLOURS.hairline,
  };
}

function renderSubjectTable(layout: Layout, section: ReportSection): string {
  const { doc } = layout;

  const left = doc.page.margins.left;
  const qWidth = layout.contentWidth * 0.46;
  const aWidth = layout.contentWidth * 0.54;
  const aX = left + qWidth;
  const evidenceStyle = subjectEvidenceStyle(layout);

  // Keep the subject heading with its table. Reserving heading + header + a
  // nominal row chunk was not enough: a first row TALLER than that chunk still
  // broke to a new page, leaving the heading and one header band stranded at the
  // foot of the old page and a second header band at the top of the new one.
  // Reserve the first row's real height instead, capped at what a fresh page can
  // hold so a row taller than a page does not push the heading around for ever.
  const first = section.rows[0];
  const firstRowHeight = first
    ? Math.min(
        measureRowBlock(layout, first, qWidth, aWidth),
        layout.fullPageContentHeight - SUBHEADING_HEIGHT - QA_HEADER_HEIGHT,
      )
    : MIN_ROW_CHUNK;
  layout.ensureSpace(SUBHEADING_HEIGHT + QA_HEADER_HEIGHT + firstRowHeight);
  const heading = layout.subHeading(section.title);

  // Header row (repeated after every page break inside the table).
  layout.ensureSpace(QA_HEADER_HEIGHT + 4);
  paintQaHeader(layout, left, qWidth, aX, aWidth);

  for (const row of section.rows) {
    const { qSegs, aSegs } = rowSegments(row);

    // A row that fits on ONE page is kept whole: if it does not fit the space
    // left here but would fit a fresh page, break first. Only a row taller
    // than a full page is ever split across pages (with the header repeated).
    const blockHeight = measureRowBlock(layout, row, qWidth, aWidth);
    const fitsWholePage =
      blockHeight <= layout.fullPageContentHeight - QA_HEADER_HEIGHT;
    if (blockHeight > layout.remaining && fitsWholePage) {
      layout.newPage();
      paintQaHeader(layout, left, qWidth, aX, aWidth);
    }

    // Paint the row in one or more chunks, each bounded by the space remaining
    // above the footer; the header band is repainted after every break.
    let qRem = qSegs;
    let aRem = aSegs;
    let chunkIndex = 0;
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

      // The question text nearly always ends on the first chunk while a long
      // observation runs on for pages, leaving the question column completely
      // empty beside it. An unlabelled empty column reads as a rendering fault,
      // so mark the continuation. This is table chrome, like the page number:
      // it states where the reader is, it does not add to the record.
      if (chunkIndex > 0 && q.height === 0) {
        doc
          .font(FONT.oblique)
          .fontSize(SIZE.caption)
          .fillColor(COLOURS.muted)
          .text('continued', left + 4, y + 5, { width: qWidth - 8 });
      }
      chunkIndex += 1;

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

    // Flagged locations continue the SAME table: one further row per plan, its
    // left cell naming the plan and its right cell holding the composite, ruled
    // and aligned like every row above it. Any question type can carry them, so
    // they belong here and not only in the action plan, which reaches
    // non-conformities alone.
    //
    // Each row is reserved whole - a picture cannot be chunked the way a cell of
    // text can - and the Question/Answer band is repainted after a break, so a
    // plan is never left at the top of a page under a bare rule. The FIRST of
    // these rows was already reserved with the question itself (measureRowBlock),
    // so the question and its first plan cannot be separated at all.
    for (const flag of row.flagImages ?? []) {
      const metrics = measureEvidenceRow(layout, flag, evidenceStyle);
      if (metrics.rowHeight > layout.remaining) {
        layout.newPage();
        paintQaHeader(layout, left, qWidth, aX, aWidth);
      }
      paintEvidenceRow(layout, evidenceStyle, metrics);
    }

    // A matrix answer's grid is drawn AFTER the row's cell borders, not inside
    // the answer cell: the cell painter splits its content across pages at a word
    // boundary, and a half-drawn risk-level grid would misstate the record. It is
    // laid out in the answer column's width so it reads as part of that column.
    if (row.matrix) {
      renderMatrixGrid(layout, row.matrix, row.matrixAnswer, aX, aWidth);
    }

    // Answer photographs, embedded as a compact titled strip beneath the row so
    // the evidence sits with its question. Assembly has already resolved these to
    // bytes and dropped any that failed to download (brief 18.3).
    if (row.photos && row.photos.length > 0) {
      renderAnswerPhotos(layout, row.photos);
    }
  }
  doc.moveDown(0.8);
  return heading;
}

// ----------------------------------------------------------------------------
// Matrix answers - the two-axis risk-level estimator drawn as a real grid, with
// the chosen cell marked. Used by BS 9792 (likelihood of fire crossed with
// potential consequences) but generic: the axes, options and outcomes all come
// from the template's grid, so any standard's estimator renders the same way.
// ----------------------------------------------------------------------------

/** Padding inside a grid cell, and the floor on a cell's height so a grid of
 *  short labels still rules evenly rather than collapsing to text lines. */
const MATRIX_CELL_PAD = 3;
const MATRIX_MIN_CELL_HEIGHT = 16;

/** Prefix on the chosen cell's outcome. Colour and a heavy border alone would
 *  make colour the sole carrier of meaning (brief 18.5 / conventions 8), and a
 *  bullet survives greyscale printing and photocopying. */
const MATRIX_SELECTED_MARK = '• ';

/** Height one piece of cell text needs, measured through the same path the row
 *  painter uses so grid and table metrics never drift apart. */
function matrixTextHeight(
  doc: PDFKit.PDFDocument,
  text: string,
  bold: boolean,
  width: number,
): number {
  return segmentHeight(
    doc,
    {
      text,
      font: bold ? FONT.bold : FONT.regular,
      size: SIZE.caption,
      colour: COLOURS.ink,
    },
    width,
  );
}

/** Paint one grid cell: optional panel fill, its border, then its text. */
function paintMatrixCell(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  options: { bold?: boolean; filled?: boolean; selected?: boolean },
): void {
  if (options.filled || options.selected) {
    doc.save().rect(x, y, width, height).fillColor(COLOURS.panel).fill().restore();
  }
  doc
    .save()
    .lineWidth(options.selected ? 1.6 : 0.5)
    .strokeColor(options.selected ? COLOURS.ink : COLOURS.hairline)
    .rect(x, y, width, height)
    .stroke()
    .restore();
  doc
    .font(options.bold ? FONT.bold : FONT.regular)
    .fontSize(SIZE.caption)
    .fillColor(COLOURS.ink)
    .text(text, x + MATRIX_CELL_PAD, y + MATRIX_CELL_PAD, {
      width: width - MATRIX_CELL_PAD * 2,
    });
}

/** Everything the grid needs to be measured and then painted identically. It is
 *  computed once because the subject table reserves the block BEFORE painting the
 *  question row, so the row and its grid are never separated by a page break. */
interface MatrixMetrics {
  /** Height of the indivisible block: grid, outcome sentence and legend. */
  total: number;
  labelWidth: number;
  cellWidth: number;
  axisWidth: number;
  axisHeight: number;
  headerHeight: number;
  bodyHeights: number[];
  outcomeText: string;
  outcomeHeight: number;
  legendText: string;
  legendHeight: number;
  /** The text of a body cell, selection mark included, so measuring and painting
   *  can never disagree about how tall a cell is. */
  cellText: (rowIndex: number, columnIndex: number) => string;
  isSelected: (rowIndex: number, columnIndex: number) => boolean;
}

/** Gap above the grid and between the grid and its outcome sentence. */
const MATRIX_BLOCK_GAP = 6;

/**
 * Measure the estimator block at the answer column's width. Definitions are NOT
 * included: they are ordinary flowing text that may legitimately run past a page
 * boundary, whereas the grid may not.
 */
function measureMatrixBlock(
  doc: PDFKit.PDFDocument,
  matrix: QuestionMatrix,
  chosen: MatrixAnswer | undefined,
  width: number,
): MatrixMetrics {
  // The row-label column takes a fixed share so the outcome columns stay equal
  // and the whole grid lands exactly on the answer column's width, never wider.
  const labelWidth = Math.max(width * 0.3, 52);
  const cellWidth = (width - labelWidth) / matrix.columns.length;
  const inner = (w: number): number => w - MATRIX_CELL_PAD * 2;

  // Which cell to mark. Answers store labels, not indices, so a label that is no
  // longer in the grid (a drifted snapshot) simply goes unmarked - the outcome
  // sentence below still carries the full recorded answer.
  const rowIndex = chosen ? matrix.rows.indexOf(chosen.row) : -1;
  const columnIndex = chosen ? matrix.columns.indexOf(chosen.column) : -1;
  const isMarked = rowIndex >= 0 && columnIndex >= 0;
  const isSelected = (r: number, c: number): boolean =>
    isMarked && r === rowIndex && c === columnIndex;
  const cellText = (r: number, c: number): string =>
    `${isSelected(r, c) ? MATRIX_SELECTED_MARK : ''}${matrix.cells[r][c]}`;

  const bandHeight = (labelText: string, cellTexts: string[]): number =>
    Math.max(
      MATRIX_MIN_CELL_HEIGHT,
      matrixTextHeight(doc, labelText, true, inner(labelWidth)) + MATRIX_CELL_PAD * 2,
      ...cellTexts.map(
        // Measured bold throughout: the marked cell is painted bold, and bold is
        // the wider metric, so a band can never come out shorter than it paints.
        (t) => matrixTextHeight(doc, t, true, inner(cellWidth)) + MATRIX_CELL_PAD * 2,
      ),
    );

  const axisWidth = width - labelWidth;
  const axisHeight = matrixTextHeight(doc, matrix.columnLabel, true, axisWidth) + 2;
  const headerHeight = bandHeight(matrix.rowLabel, matrix.columns);
  const bodyHeights = matrix.rows.map((label, r) =>
    bandHeight(
      label,
      matrix.columns.map((_column, c) => cellText(r, c)),
    ),
  );

  const outcomeText = chosen
    ? `Selected: ${chosen.outcome} (${matrix.rowLabel}: ${chosen.row}; ${matrix.columnLabel}: ${chosen.column})`
    : 'No cell of this estimator was selected.';
  const outcomeHeight = matrixTextHeight(doc, outcomeText, true, width) + 2;
  const legendText = isMarked
    ? 'The selected cell is marked with a bullet and a heavy border.'
    : '';
  const legendHeight = legendText
    ? matrixTextHeight(doc, legendText, false, width) + 2
    : 0;

  return {
    total:
      MATRIX_BLOCK_GAP +
      axisHeight +
      headerHeight +
      bodyHeights.reduce((sum, h) => sum + h, 0) +
      4 +
      outcomeHeight +
      legendHeight,
    labelWidth,
    cellWidth,
    axisWidth,
    axisHeight,
    headerHeight,
    bodyHeights,
    outcomeText,
    outcomeHeight,
    legendText,
    legendHeight,
    cellText,
    isSelected,
  };
}

/**
 * Draw the estimator grid at `x` for `width` points (the answer column), with the
 * chosen cell marked and the outcome restated in words beneath it.
 *
 * The block is reserved with a single ensureSpace() so it moves to the next page
 * WHOLE. It is never chunked like a table row: a grid split down the middle would
 * show a reader a different set of cells than the assessor chose from.
 * Definitions follow as ordinary flowing text, each line reserved on its own.
 */
function renderMatrixGrid(
  layout: Layout,
  matrix: QuestionMatrix,
  chosen: MatrixAnswer | undefined,
  x: number,
  width: number,
): void {
  const { doc } = layout;
  const {
    labelWidth,
    cellWidth,
    axisWidth,
    axisHeight,
    headerHeight,
    bodyHeights,
    outcomeText,
    outcomeHeight,
    legendText,
    legendHeight,
    cellText,
    isSelected,
    total,
  } = measureMatrixBlock(doc, matrix, chosen, width);
  layout.ensureSpace(total);

  let y = doc.y + MATRIX_BLOCK_GAP;

  // Column axis heading, sitting over the outcome columns it names.
  doc
    .font(FONT.bold)
    .fontSize(SIZE.caption)
    .fillColor(COLOURS.muted)
    .text(matrix.columnLabel, x + labelWidth, y, { width: axisWidth });
  y += axisHeight;

  // Header band: the row axis name in the corner, then the column options.
  paintMatrixCell(doc, x, y, labelWidth, headerHeight, matrix.rowLabel, {
    bold: true,
    filled: true,
  });
  matrix.columns.forEach((column, c) => {
    paintMatrixCell(
      doc,
      x + labelWidth + c * cellWidth,
      y,
      cellWidth,
      headerHeight,
      column,
      { bold: true, filled: true },
    );
  });
  y += headerHeight;

  matrix.rows.forEach((label, r) => {
    const height = bodyHeights[r];
    paintMatrixCell(doc, x, y, labelWidth, height, label, {
      bold: true,
      filled: true,
    });
    matrix.columns.forEach((_column, c) => {
      const selected = isSelected(r, c);
      paintMatrixCell(
        doc,
        x + labelWidth + c * cellWidth,
        y,
        cellWidth,
        height,
        cellText(r, c),
        { bold: selected, selected },
      );
    });
    y += height;
  });

  y += 4;
  doc
    .font(FONT.bold)
    .fontSize(SIZE.caption)
    .fillColor(COLOURS.ink)
    .text(outcomeText, x, y, { width });
  y += outcomeHeight;
  if (legendText) {
    doc
      .font(FONT.regular)
      .fontSize(SIZE.caption)
      .fillColor(COLOURS.muted)
      .text(legendText, x, y, { width });
    y += legendHeight;
  }
  doc.y = y;

  if (matrix.definitions) {
    renderMatrixDefinitions(layout, matrix.definitions, x, width);
  }
  doc.moveDown(0.3);
}

/** The estimator's term definitions. BS 9792 defines each likelihood and harm
 *  level, and those definitions are part of the assessment record, so they are
 *  printed rather than assumed known. */
function renderMatrixDefinitions(
  layout: Layout,
  definitions: Record<string, string>,
  x: number,
  width: number,
): void {
  const { doc } = layout;
  const entries = Object.entries(definitions);
  if (entries.length === 0) {
    return;
  }

  const headingHeight = matrixTextHeight(doc, 'Definitions', true, width) + 2;
  layout.ensureSpace(headingHeight + MATRIX_MIN_CELL_HEIGHT);
  let y = doc.y + 4;
  doc
    .font(FONT.bold)
    .fontSize(SIZE.caption)
    .fillColor(COLOURS.muted)
    .text('Definitions', x, y, { width });
  y += headingHeight;

  for (const [term, meaning] of entries) {
    const text = `${term}: ${meaning}`;
    const height = matrixTextHeight(doc, text, false, width) + 1;
    doc.y = y;
    // One definition is a short, self-contained line, so it is kept whole; the
    // list as a whole may still flow onto the next page between entries.
    layout.ensureSpace(height);
    y = doc.y;
    doc
      .font(FONT.oblique)
      .fontSize(SIZE.caption)
      .fillColor(COLOURS.muted)
      .text(text, x, y, { width });
    y += height;
  }
  doc.y = y;
}

// ----------------------------------------------------------------------------
// Section 3 - the action plan, high to low severity, with titled images
// including the flag-location composite (stories 1057, 1074).
// ----------------------------------------------------------------------------

function renderActionPlan(
  layout: Layout,
  model: ReportModel,
  subjectLabels: Map<string, string>,
): void {
  layout.section('Fire Action Plan');

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
    renderActionCard(layout, action, index, subjectLabels);
  }
}

/** The card's own head: the severity heading and the gap under it. The Life
 *  Protection line is added when the action carries one. */
const ACTION_CARD_HEAD = 26;
const ACTION_CARD_LTP_LINE = 13;

function renderActionCard(
  layout: Layout,
  action: ReportAction,
  index: number,
  subjectLabels: Map<string, string>,
): void {
  const { doc } = layout;
  const left = doc.page.margins.left;
  const meta = severityMeta(action.severity);

  const detailRows: Array<[string, string]> = [
    // The subject as Section 2 numbered it, falling back to the raw template
    // code when the action names a subject the template no longer declares.
    ['Subject', subjectLabels.get(action.sectionCode) ?? action.sectionCode],
    ['Finding', action.question],
    ['Recommendation and observation', action.observation],
    ['Responsible party', action.responsible],
    ['Due by', formatDate(action.dueBy)],
  ];

  // Keep the whole card together: its head, every detail row, and EVERY located
  // plan. Reserving a nominal 150 points was enough to stop a lone severity
  // heading being stranded, but not enough to stop the plans themselves being
  // cut off from the action they locate - the card would end at "Due by" on one
  // page and the picture would open the next, under no heading at all.
  //
  // Unlike Section 2, nothing repeats a header here, so a spilled plan has
  // nothing on its page tying it to an action; and the action plan is the part
  // of this document that gets extracted and handed to a contractor, where a
  // card that reads as one unbroken unit matters most. A section opener with
  // white space beneath it is a conventional thing to see; half an action is not.
  //
  // Capped at one page's content: a card longer than that cannot be kept whole
  // by any reservation, and an uncapped one would demand space no page has and
  // break for ever.
  const keepTogether =
    ACTION_CARD_HEAD +
    (action.lifeProtection ? ACTION_CARD_LTP_LINE : 0) +
    measureKeyValueGrid(layout, detailRows, action.flagImages) +
    // The supporting photographs are part of the card too: spilled on their own
    // they land above the NEXT action's heading, reading as its evidence.
    measureImageStrip(
      doc,
      action.images,
      ACTION_IMAGE_BOX[0],
      ACTION_IMAGE_BOX[1],
      layout.contentWidth,
    );
  layout.ensureSpace(Math.min(keepTogether, layout.fullPageContentHeight));
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

  // EVERY flag-location composite becomes a further labelled row of the card's
  // own grid (the legacy "Location" column parity, 1057 AC2), so a finding pinned
  // on three plans lists three of them rather than losing two.
  //
  // These composites also appear against the question in Section 2, and that
  // repetition is deliberate. The two sections are read by different people for
  // different purposes: Section 2 is the record of what was assessed, where the
  // location evidences the ANSWER; the action plan is routinely extracted and
  // handed to whoever carries out the remedial work, and an action that says
  // "obstructed escape route" without showing where sends that person back
  // through a forty-page document to find it. Both carry the whole set, labelled
  // identically so a reader can see they are the same plans.
  renderKeyValueGrid(layout, detailRows, action.flagImages);

  // Other titled images (1074 AC2) stay a strip: they are supporting
  // photographs, not the located evidence the grid is ruling.
  if (action.images.length > 0) {
    renderActionImages(layout, action.images);
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

// ----------------------------------------------------------------------------
// Evidence rows - a flagged floor-plan composite drawn as a REAL row of the
// table it belongs to: a labelled cell naming the plan and a cell holding the
// picture, ruled and aligned exactly like the rows above it.
//
// A picture cannot be split down the middle, so an evidence row is the one thing
// in either table that must be reserved WHOLE before any of it is drawn. Its
// height is therefore measured first, from the image's own proportions, and the
// drawn height is capped so a row can always fit a fresh page - otherwise a row
// too tall to place anywhere would either overflow into the footer or bounce
// between pages for ever.
// ----------------------------------------------------------------------------

/** The tallest a plan may be drawn. Comfortably inside a page's content height
 *  even beside a three-line label, and large enough that pins on a plan read at
 *  print size (this is evidence, not a thumbnail). */
const MAX_EVIDENCE_IMAGE_HEIGHT = 250;
/** Label cells are clamped to this many lines. A plan name is free text, and an
 *  unbounded label could otherwise make a row taller than the page it has to
 *  fit on. */
const EVIDENCE_LABEL_MAX_LINES = 3;

/** The geometry and voice of the table an evidence row is joining, so the same
 *  primitive serves the Section 2 subject table and the action plan's detail
 *  grid while each keeps its own columns and rule weight. */
interface EvidenceRowStyle {
  left: number;
  labelWidth: number;
  valueWidth: number;
  labelFont: string;
  labelSize: number;
  lineWidth: number;
  strokeColour: string;
}

/** An evidence row measured: everything the painter needs, so it never has to
 *  re-derive a size the reservation was made from. */
interface EvidenceRowMetrics {
  rowHeight: number;
  labelLines: string[];
  /** Absent when there is nothing drawable; the row carries the marker instead. */
  opened?: OpenedImage;
  drawWidth: number;
  drawHeight: number;
}

/** `text` as at most `maxLines` lines at `width`, the last ellipsised when there
 *  was more. Shared by evidence labels and image-strip captions so both clamp
 *  the same way. */
function clampToLines(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  maxLines: number,
): string[] {
  const wrapped = wrapToWidth(doc, text, width);
  if (wrapped.length <= maxLines) {
    return wrapped;
  }
  const kept = wrapped.slice(0, maxLines);
  // Fold everything past the clamp back into the last kept line and ellipsise
  // it, so the text ends honestly rather than stopping dead mid-sentence.
  kept[kept.length - 1] = truncateToWidth(doc, wrapped.slice(maxLines - 1).join(' '), width);
  return kept;
}

function measureEvidenceRow(
  layout: Layout,
  image: ResolvedImage,
  style: EvidenceRowStyle,
): EvidenceRowMetrics {
  const { doc } = layout;
  const valueInner = style.valueWidth - CELL_PAD * 2;
  const opened = layout.openImage(image);
  let drawWidth = valueInner;
  // An unattachable plan reserves NO picture height. A full-size empty box in the
  // middle of a statutory document reads as a broken report, and a duty-holder
  // cannot tell a rendering fault from a missing survey. The row still appears -
  // the location WAS flagged and silently dropping that would be the worse of the
  // two failures - but it collapses to a single line of explanation in the cell
  // where the plan would have been.
  let drawHeight = 0;
  if (opened) {
    // Fitted to the cell's width and the height cap, whichever binds first, so
    // the plan keeps its proportions and a portrait plan is not stretched.
    const scale = Math.min(
      valueInner / opened.width,
      MAX_EVIDENCE_IMAGE_HEIGHT / opened.height,
    );
    drawWidth = opened.width * scale;
    drawHeight = opened.height * scale;
  }

  doc.font(style.labelFont).fontSize(style.labelSize);
  const labelLines = clampToLines(
    doc,
    image.title,
    style.labelWidth - CELL_PAD * 2,
    EVIDENCE_LABEL_MAX_LINES,
  );
  const labelHeight = labelLines.length * doc.currentLineHeight();

  // Without a picture the value cell carries the explanation, so the row has to
  // be tall enough for THAT rather than for a placeholder.
  let noteHeight = 0;
  if (!opened) {
    doc.font(FONT.oblique).fontSize(SIZE.caption);
    noteHeight = doc.currentLineHeight();
  }

  return {
    rowHeight:
      Math.max(drawHeight, labelHeight, noteHeight) + CELL_PAD * 2,
    labelLines,
    ...(opened ? { opened } : {}),
    drawWidth,
    drawHeight,
  };
}

/** Paint one evidence row at the cursor. The caller has already guaranteed the
 *  space: this draws, it does not paginate. */
function paintEvidenceRow(
  layout: Layout,
  style: EvidenceRowStyle,
  metrics: EvidenceRowMetrics,
): void {
  const { doc } = layout;
  const { rowHeight } = metrics;
  const valueX = style.left + style.labelWidth;
  const y = doc.y;

  doc
    .save()
    .lineWidth(style.lineWidth)
    .strokeColor(style.strokeColour)
    .rect(style.left, y, style.labelWidth, rowHeight)
    .stroke()
    .rect(valueX, y, style.valueWidth, rowHeight)
    .stroke()
    .restore();

  // The label, stamped a line at a time and centred against the picture beside
  // it. Stamped rather than given a wrap width for the reason on stampText: a
  // width-bearing run near the foot of a page paginates on its own.
  doc.font(style.labelFont).fontSize(style.labelSize).fillColor(COLOURS.ink);
  const lineHeight = doc.currentLineHeight();
  let labelY = y + (rowHeight - metrics.labelLines.length * lineHeight) / 2;
  for (const line of metrics.labelLines) {
    stampText(doc, line, style.left + CELL_PAD, labelY);
    labelY += lineHeight;
  }

  if (metrics.opened) {
    doc.image(
      asImageSource(metrics.opened),
      valueX + (style.valueWidth - metrics.drawWidth) / 2,
      y + (rowHeight - metrics.drawHeight) / 2,
      { width: metrics.drawWidth, height: metrics.drawHeight },
    );
  } else {
    // Stated in words rather than drawn as an empty frame. Stamped without a
    // wrap width for the same reason the label is (see stampText).
    doc.font(FONT.oblique).fontSize(SIZE.caption).fillColor(COLOURS.muted);
    const noteHeight = doc.currentLineHeight();
    stampText(
      doc,
      'Plan image not attached',
      valueX + CELL_PAD,
      y + (rowHeight - noteHeight) / 2,
    );
  }
  doc.y = y + rowHeight;
}

/** Action-plan images: a generous box so the flag location is legible (1074 AC2). */
function renderActionImages(layout: Layout, images: ResolvedImage[]): void {
  renderImageStrip(layout, images, ACTION_IMAGE_BOX[0], ACTION_IMAGE_BOX[1]);
}

/** Section 2 answer photographs: a compact thumbnail strip beneath the question
 *  row, so evidence sits with its subject without dominating the table. */
function renderAnswerPhotos(layout: Layout, images: ResolvedImage[]): void {
  layout.doc.moveDown(0.2);
  renderImageStrip(layout, images, PHOTO_BOX[0], PHOTO_BOX[1]);
}

/** The two image box sizes the document uses, stated once so the measurer and the
 *  painter can never be handed different ones. */
const ACTION_IMAGE_BOX: readonly [number, number] = [200, 150];
const PHOTO_BOX: readonly [number, number] = [120, 90];

/** Horizontal gap between boxes, vertical gap between wrapped rows, the gap
 *  between a box and its caption, and the space left below the whole strip. */
const STRIP_GAP = 16;
const STRIP_ROW_GAP = 10;
const STRIP_CAPTION_GAP = 2;
const STRIP_TRAILING = 6;
/** Captions are clamped to this many lines. A caption is drawn immediately below
 *  a box whose height is already reserved, so an unbounded one (a long floor-plan
 *  name, a long photo title) is the one thing in a strip that could grow past the
 *  reservation and reach the footer. */
const CAPTION_MAX_LINES = 2;

/** One image as it will be painted: its box height (a failed image collapses to
 *  the slim marker) and its caption already wrapped and clamped. */
interface StripItem {
  image: ResolvedImage;
  boxHeight: number;
  captionLines: string[];
}

/** One row of a strip and the exact height it occupies, caption included. */
interface StripRow {
  items: StripItem[];
  /** Height of the row's picture band: the tallest box in it. Shorter boxes (an
   *  unavailable image collapses to a slim marker) are aligned to its FOOT, so
   *  every caption in a row sits on one line rather than floating at whatever
   *  height its own box happened to be. */
  boxBand: number;
  height: number;
}

/**
 * Lay a strip out into rows WITHOUT drawing anything, so the space a strip needs
 * is measured from precisely what will be painted. Both the measurer (which
 * decides whether the strip fits beside its question) and the painter consume
 * this, which is what stops the two drifting apart.
 *
 * An image that could not be fetched collapses to a slim marker instead of
 * reserving the full frame: a large empty rectangle where a photograph should be
 * reads as a broken graphic, while a compact rule reads as a deliberate note that
 * the evidence could not be attached. The caption still carries the title, so
 * nothing is lost from the record.
 */
function layOutImageStrip(
  doc: PDFKit.PDFDocument,
  images: ResolvedImage[],
  imgWidth: number,
  imgHeight: number,
  contentWidth: number,
): StripRow[] {
  doc.font(FONT.oblique).fontSize(SIZE.caption);
  const lineHeight = doc.currentLineHeight();
  const perRow = Math.max(
    1,
    Math.floor((contentWidth + STRIP_GAP) / (imgWidth + STRIP_GAP)),
  );

  const rows: StripRow[] = [];
  for (const image of images) {
    const captionLines = clampToLines(doc, image.title, imgWidth, CAPTION_MAX_LINES);
    const item: StripItem = {
      image,
      boxHeight: image.available && image.data ? imgHeight : PLACEHOLDER_HEIGHT,
      captionLines,
    };
    const last = rows[rows.length - 1];
    if (!last || last.items.length >= perRow) {
      rows.push({ items: [item], boxBand: 0, height: 0 });
    } else {
      last.items.push(item);
    }
  }

  for (const row of rows) {
    row.boxBand = Math.max(...row.items.map((item) => item.boxHeight));
    row.height =
      row.boxBand +
      STRIP_CAPTION_GAP +
      Math.max(...row.items.map((item) => item.captionLines.length)) * lineHeight;
  }
  return rows;
}

/** The vertical space a strip will occupy, or 0 when there is nothing to draw. */
function measureImageStrip(
  doc: PDFKit.PDFDocument,
  images: ResolvedImage[] | undefined,
  imgWidth: number,
  imgHeight: number,
  contentWidth: number,
): number {
  if (!images || images.length === 0) {
    return 0;
  }
  const rows = layOutImageStrip(doc, images, imgWidth, imgHeight, contentWidth);
  return (
    rows.reduce((sum, row) => sum + row.height, 0) +
    STRIP_ROW_GAP * Math.max(0, rows.length - 1) +
    STRIP_TRAILING
  );
}

/**
 * Render a strip of titled images at the given box size, wrapping to the next
 * line as needed. Shared by the action plan, the Section 2 answer photos and the
 * Section 2 flagged locations.
 *
 * Each ROW is reserved before any of it is drawn, so a break never separates a
 * box from its caption. An image is indivisible, so a row is the smallest unit
 * that can move; the caller reserves the first row alongside the question it
 * belongs to (see measureRowBlock) and later rows flow.
 */
function renderImageStrip(
  layout: Layout,
  images: ResolvedImage[],
  imgWidth: number,
  imgHeight: number,
): void {
  const { doc } = layout;
  const left = doc.page.margins.left;
  const rows = layOutImageStrip(doc, images, imgWidth, imgHeight, layout.contentWidth);
  if (rows.length === 0) {
    return;
  }
  doc.font(FONT.oblique).fontSize(SIZE.caption);
  const lineHeight = doc.currentLineHeight();

  let bottom = doc.y;
  for (const row of rows) {
    layout.ensureSpace(row.height);
    const rowTop = doc.y;
    let x = left;
    for (const item of row.items) {
      // Sat on the row's baseline, so a slim marker beside a full-height plan
      // shares its caption line instead of hanging in mid-air.
      const boxTop = rowTop + row.boxBand - item.boxHeight;
      let drawn = false;
      if (item.image.available && item.image.data) {
        try {
          doc.image(item.image.data, x, boxTop, { fit: [imgWidth, imgHeight] });
          drawn = true;
        } catch {
          // A corrupt or undecodable image falls through to the marker below.
          // It was measured at full height, so the strip simply ends short.
        }
      }
      if (!drawn) {
        renderImagePlaceholder(layout, x, boxTop, imgWidth, item.boxHeight);
      }

      // The caption, one stamped line at a time. It carries no wrap width for
      // the reason given on stampText: a width-bearing text() near the foot of a
      // page is routed through PDFKit's LineWrapper and paginates on its own.
      doc.font(FONT.oblique).fontSize(SIZE.caption).fillColor(COLOURS.muted);
      let capY = rowTop + row.boxBand + STRIP_CAPTION_GAP;
      for (const line of item.captionLines) {
        stampText(doc, line, x, capY);
        capY += lineHeight;
      }
      x += imgWidth + STRIP_GAP;
    }
    bottom = rowTop + row.height;
    doc.y = bottom + STRIP_ROW_GAP;
  }

  doc.y = bottom + STRIP_TRAILING;
}

/** Height of the slim marker that stands in for an image which could not be
 *  embedded. Deliberately far shorter than a photo box - see renderImageStrip. */
const PLACEHOLDER_HEIGHT = 30;

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
  // Dashed outline, no fill: a solid filled rectangle at photo size looks like a
  // failed image, whereas a dashed outline reads as a deliberately empty slot.
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(COLOURS.hairline)
    .dash(2, { space: 2 })
    .rect(x, y, w, h)
    .stroke()
    .undash()
    .restore();
  // Centred by measurement and stamped, not by handing PDFKit a width: see
  // stampText. A placeholder is the one thing in a strip that can sit at the
  // very foot of a page, and a width-bearing run there spawns a page.
  const label = 'Image unavailable';
  doc.font(FONT.oblique).fontSize(SIZE.caption).fillColor(COLOURS.muted);
  stampText(doc, label, x + (w - doc.widthOfString(label)) / 2, y + h / 2 - 4);
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
  layout.section('Sign-off and Review');
  const s = model.signOff;
  renderKeyValueGrid(layout, [
    ['Conducted by', s.conductedBy],
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
export interface RenderOptions {
  /** How many pages will be spliced in after the cover once the rendered PDF is
   *  merged (the template's certificate). The printed 'Page | N' accounts for
   *  them, so the numbers still match the document the reader holds. */
  insertedPagesAfterCover?: number;
}

/** The registered-company line printed, centred, in the footer of every page but
 *  the cover. Composed from what the org actually records: its name plus its
 *  registered address when one is set, the name alone when it is not, and
 *  nothing at all when even the name is missing (the footer then carries only
 *  the page number rather than a stray comma). */
function registeredLine(model: ReportModel): string {
  const name = model.orgProfile.name?.trim() ?? '';
  const address = model.orgProfile.contact?.address?.trim() ?? '';
  if (!name) {
    return '';
  }
  return address ? `${name}. Registered office: ${address}.` : `${name}.`;
}

export function renderReportPdf(
  model: ReportModel,
  options: RenderOptions = {},
): Promise<Buffer> {
  // Brand accent, validated so a malformed org colour cannot break the document,
  // then darkened until it clears AA on white. The report is a legal record that
  // is read on white paper and photocopied, so the accent is only ever used where
  // it must be SEEN (a heading, a divider rule) and never as a fill with nothing
  // behind it. Safentia's own gold is 1.74:1 on white, which would leave the
  // cover subheading and every section rule effectively invisible in print; the
  // corrected shade keeps the hue and clears 4.5:1.
  const brand = adjustToMeetAA(
    safeColour(model.orgProfile.brand?.primary, COLOURS.ink),
    PAPER,
  );
  // The standard-specific profile. Untagged/custom templates get the generic one.
  const profile = selectProfile(model.standard);

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: PAGE_MARGIN,
          // The footer band is part of the bottom margin, so PDFKit's own
          // automatic page break stops where Layout.bottomLimit does and no
          // content can ever land in the footer strip. See FOOTER_BAND.
          bottom: PAGE_MARGIN + FOOTER_BAND,
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

      // The logo is opened ONCE and drawn on every page from that single
      // embedded XObject. Calling doc.image() with the same Buffer per page
      // embeds a fresh copy each time, which on a long report multiplies the
      // logo's bytes by the page count.
      let logo: OpenedImage | undefined;
      if (model.logo?.available && model.logo.data) {
        try {
          logo = (doc as ImageOpeningDocument).openImage(model.logo.data);
        } catch {
          // An unreadable logo costs the mark, never the document.
        }
      }

      const layout = new Layout(doc, {
        brand,
        orgName: model.orgProfile.name,
        registeredLine: registeredLine(model),
        ...(logo ? { logo } : {}),
      });
      layout.setPageNumberOffset(options.insertedPagesAfterCover ?? 0);

      renderCover(layout, model, brand, profile);

      // Reserve a contents page right after the cover; filled in finalise() once
      // each section's start page is known. Reserving it here keeps every later
      // page number stable when the ToC text is painted in the buffered pass.
      layout.reserveTocPage();

      layout.newPage();
      renderOverview(layout, model, brand, profile);

      layout.newPage();
      const subjectLabels = renderRiskAssessment(layout, model, profile);

      layout.newPage();
      renderActionPlan(layout, model, subjectLabels);
      renderSignOff(layout, model, profile);

      // Stamp 'Page N of M' on every buffered page, then flush the document.
      layout.finalise();
      doc.end();
    } catch (caught) {
      reject(caught instanceof Error ? caught : new Error(String(caught)));
    }
  });
}
