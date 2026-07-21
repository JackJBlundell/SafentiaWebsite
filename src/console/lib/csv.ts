// ============================================================================
// CSV - the one place the console reads and writes comma-separated text.
//
// Spreadsheets are how non-technical administrators hold a portfolio, so both
// directions have to survive what Excel, Numbers and Google Sheets actually
// emit: a UTF-8 byte-order mark, CRLF line endings, quoted cells containing
// commas, newlines and doubled quotes. Hand-rolled `split(',')` handles none of
// that, which is why parsing and serialising live together here rather than
// being re-derived per panel.
//
// Serialising also guards against CSV formula injection: a cell opening with
// =, +, - or @ is treated as a formula by spreadsheet applications, so stored
// text could otherwise execute in the reader's application.
// ============================================================================

/** RFC 4180 line ending. Every spreadsheet reads it; some only read it. */
const LINE_ENDING = '\r\n';

/**
 * Parse CSV text into rows of raw cell strings. Tolerant by design: a stray
 * BOM, mixed CRLF/LF/CR endings and a trailing blank line are all normal
 * spreadsheet output, not user error, so they are absorbed rather than
 * reported. Cells are returned verbatim (untrimmed) - trimming is the caller's
 * decision, since leading space can be meaningful in a name.
 */
export function parseCsv(text: string): string[][] {
  // The BOM would otherwise become part of the first header, so no column ever
  // matches and the file reads as if it had the wrong columns entirely.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      // A doubled quote inside a quoted cell is one literal quote; a lone one
      // closes the cell.
      if (input[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\r' || char === '\n') {
      // CRLF is one break, not two empty rows.
      if (char === '\r' && input[index + 1] === '\n') {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }

  // Whatever is still buffered is the final row, unless the file ended on a
  // line break (in which case there is nothing left to flush).
  if (cell.length > 0 || row.length > 0 || quoted) {
    row.push(cell);
    rows.push(row);
  }

  // A file that ends with a newline yields a trailing row of one empty cell,
  // and spreadsheets routinely pad with fully blank rows. Neither is data.
  return rows.filter((cells) => cells.some((value) => value.trim().length > 0));
}

/** A bare number, which a spreadsheet reads as a number and never as a formula.
 *  Exempting it matters: negative values (a western longitude, a temperature)
 *  open with a minus sign, and prefixing those with a quote would turn honest
 *  data into text that no longer parses on the way back in. */
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/** Escape one cell for output: formula-guarded, and quoted when it holds a
 *  comma, quote or line break. Pure, exported for tests. */
export function escapeCsvField(field: string): string {
  const trimmed = field.trim();
  const isFormula = /^[=+\-@]/.test(trimmed) && !PLAIN_NUMBER.test(trimmed);
  const guarded = isFormula ? `'${field}` : field;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** Serialise rows (the first is conventionally the header) to CSV text. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((cells) => cells.map(escapeCsvField).join(','))
    .join(LINE_ENDING);
}

/** Trigger a browser download of CSV text via a transient object URL. The BOM
 *  is deliberate: without it Excel on Windows renders non-ASCII names as
 *  mojibake, and British addresses carry accented characters routinely. */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
