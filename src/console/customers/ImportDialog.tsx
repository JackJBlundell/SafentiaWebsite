// ============================================================================
// ImportDialog - bulk CSV import of an estate, in one modal.
//
// The same dialog serves both entry points: from a customer it imports SITES
// and the buildings that stand on them; from a site it imports BUILDINGS onto
// that one site. Only the columns and the copy differ, so the flow, the
// validation surface and the summary are written once.
//
// The flow is deliberately read-before-write. The whole file is parsed and
// validated in the browser first and every problem is listed at once, with its
// line number and column; the Import button stays disabled until the file is
// clean. Partial imports are not offered: half an estate landed under a
// customer is far harder to unpick than a corrected spreadsheet is to produce,
// and the callable writes the whole file in one atomic update to match.
//
// Accessibility: focus moves into the dialog on open, Tab is trapped within
// it, Escape closes, and focus returns to whatever opened it.
// ============================================================================

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { Button } from '../../components/Button';
import type { ImportRecordsInput, ImportRecordsResult } from '../../types';
import { downloadCsv, parseCsv } from '../lib/csv';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import {
  buildExampleCsv,
  columnsFor,
  readImportRows,
  IMPORT_EXCLUSIONS,
  MAX_IMPORT_ROWS,
  type ImportMode,
  type ImportParseResult,
} from './importModel';
import styles from './ImportDialog.module.css';

const FOCUSABLE =
  'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])';

/** A CSV of the permitted row count cannot approach this, so anything larger is
 *  the wrong file rather than a big one - caught before it is read into memory. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Beyond this the preview stops being scannable and starts being a scroll. */
const PREVIEW_LIMIT = 100;

interface ImportDialogProps {
  mode: ImportMode;
  customerId: string;
  /** Required in `buildings` mode: the site the records land on. */
  siteId?: string;
  /** Existing site names under the customer, or building names on the site, so
   *  a name that already exists can be flagged before it is duplicated. */
  existingNames: readonly string[];
  onClose: () => void;
}

const COPY = {
  sites: {
    title: 'Import sites',
    lede: 'Add several sites, and the buildings that stand on them, from one spreadsheet.',
    shape:
      'One row per building. Repeat the site columns on every row that belongs to that site, and the import groups them. To record a site that has no buildings yet, fill in its site columns and leave building_name blank.',
    fileName: 'safentia-sites-example.csv',
  },
  buildings: {
    title: 'Import buildings',
    lede: 'Add several buildings to this site from one spreadsheet.',
    shape:
      'One row per building. Every row lands on this site, so there are no site columns.',
    fileName: 'safentia-buildings-example.csv',
  },
} as const;

export function ImportDialog({
  mode,
  customerId,
  siteId,
  existingNames,
  onClose,
}: ImportDialogProps) {
  const importRecords = useCallable<ImportRecordsInput, ImportRecordsResult>(
    'importRecords',
  );
  const [fileName, setFileName] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [done, setDone] = useState<ImportRecordsResult | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);

  const copy = COPY[mode];
  const columns = useMemo(() => columnsFor(mode), [mode]);
  const busy = importRecords.pending;

  // Never abandon the flow mid-callable: the write is atomic, but closing over
  // it would leave the admin unsure whether their estate landed.
  const close = useCallback(() => {
    if (busy) {
      return;
    }
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    headingRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
      }
    };
  }, []);

  // Escape closes; Tab wraps within the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) {
        return;
      }
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => !element.hasAttribute('disabled'));
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clearing the input lets the same corrected file be chosen twice running,
    // which is exactly what happens after a failed validation.
    event.target.value = '';
    if (!file) {
      return;
    }
    setParsed(null);
    setDone(null);
    setReadError(null);
    importRecords.clearError();
    setFileName(file.name);
    if (file.size > MAX_FILE_BYTES) {
      setReadError(
        'That file is too large to be a list of sites. Export just the rows you need as CSV and try again.',
      );
      return;
    }
    try {
      const text = await file.text();
      setParsed(
        readImportRows(parseCsv(text), { mode, existingNames }),
      );
    } catch {
      setReadError(
        'That file could not be read. Save it as CSV from your spreadsheet and try again.',
      );
    }
  };

  const onImport = async () => {
    if (!parsed || parsed.errors.length > 0) {
      return;
    }
    const input: ImportRecordsInput =
      mode === 'sites'
        ? { mode, customerId, sites: parsed.sites }
        : { mode, customerId, siteId, buildings: parsed.buildings };
    const result = await importRecords.call(input);
    if (result) {
      setDone(result);
      setParsed(null);
    }
  };

  const blocked = parsed !== null && parsed.errors.length > 0;
  const ready = parsed !== null && parsed.errors.length === 0;

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={close}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <h2
            id="import-dialog-title"
            className={styles.title}
            ref={headingRef}
            tabIndex={-1}
          >
            {copy.title}
          </h2>
          <p className={styles.copy}>{copy.lede}</p>
        </header>

        <div className={styles.body}>
          {done ? (
            <div className={styles.result} role="status">
              <p className={styles.resultLine}>
                Imported {describeCounts(done)}.
              </p>
              <p className={styles.copy}>
                They are in the list behind this dialog already. Open each
                record to add contacts, photos and the rest of its service
                schedule.
              </p>
            </div>
          ) : (
            <>
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>How it works</h3>
                <ol className={styles.steps}>
                  <li>
                    Download the example file and fill it in, or match its
                    column headings in your own spreadsheet.
                  </li>
                  <li>Save it as CSV, then choose it below.</li>
                  <li>
                    Check the preview. Every problem is listed with its line
                    number, and nothing is imported until they are all fixed.
                  </li>
                </ol>
                <p className={styles.copy}>{copy.shape}</p>
                <p className={styles.copy}>
                  Column headings must match exactly. Optional columns can be
                  left out of the file entirely, or left blank on any row. A
                  file may carry up to {MAX_IMPORT_ROWS} rows.
                </p>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      downloadCsv(buildExampleCsv(mode), copy.fileName)
                    }
                  >
                    Download example CSV
                  </Button>
                </div>
              </section>

              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>The columns</h3>
                <div className={styles.tableScroll}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Column</th>
                        <th scope="col">Required</th>
                        <th scope="col">What to put in it</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((column) => (
                        <tr key={column.header}>
                          <td>
                            <code className={styles.code}>{column.header}</code>
                          </td>
                          <td>{column.required ? 'Required' : 'Optional'}</td>
                          <td>{column.help}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3 className={styles.sectionTitle}>What import does not cover</h3>
                <ul className={styles.list}>
                  {IMPORT_EXCLUSIONS.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </section>

              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Your file</h3>
                <div className={styles.actions}>
                  <input
                    id="import-file"
                    className={styles.file}
                    type="file"
                    accept=".csv,text/csv"
                    disabled={busy}
                    onChange={(event) => void onFile(event)}
                  />
                  <label className={styles.fileLabel} htmlFor="import-file">
                    Choose CSV file
                  </label>
                  <span className={styles.fileName}>
                    {fileName || 'No file chosen'}
                  </span>
                </div>
              </section>

              {readError && <ErrorNotice message={readError} />}
              {importRecords.error && (
                <ErrorNotice message={importRecords.error} />
              )}

              {parsed && (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Preview</h3>
                  <p className={styles.summary} role="status">
                    {blocked
                      ? `This file cannot be imported yet: ${countLabel(parsed.errors.length, 'problem', 'problems')} to fix.`
                      : `Ready to import ${describeParsed(parsed, mode)}.`}
                  </p>

                  {blocked && (
                    <ul className={styles.problems}>
                      {parsed.errors.map((problem) => (
                        <li
                          key={`${problem.line}-${problem.column}-${problem.message}`}
                        >
                          <span className={styles.problemWhere}>
                            Line {problem.line}, {problem.column}
                          </span>
                          <span>{problem.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {parsed.warnings.length > 0 && (
                    <ul className={styles.warnings}>
                      {parsed.warnings.map((problem) => (
                        <li
                          key={`${problem.line}-${problem.column}-${problem.message}`}
                        >
                          <span className={styles.problemWhere}>
                            Line {problem.line}, {problem.column}
                          </span>
                          <span>{problem.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {parsed.rows.length > 0 && (
                    <div className={styles.tableScroll}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th scope="col">Line</th>
                            {mode === 'sites' && <th scope="col">Site</th>}
                            <th scope="col">Building</th>
                            <th scope="col">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parsed.rows.slice(0, PREVIEW_LIMIT).map((row) => (
                            <tr key={row.line}>
                              <td>{row.line}</td>
                              {mode === 'sites' && (
                                <td>{row.siteName || '-'}</td>
                              )}
                              <td>
                                {row.siteOnly
                                  ? 'No buildings on this row'
                                  : row.buildingName || '-'}
                              </td>
                              <td>
                                <span
                                  className={
                                    row.valid ? styles.ok : styles.notOk
                                  }
                                >
                                  {row.valid ? 'Ready' : 'Needs fixing'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {parsed.rows.length > PREVIEW_LIMIT && (
                    <p className={styles.copy}>
                      Showing the first {PREVIEW_LIMIT} of {parsed.rows.length}{' '}
                      rows. Every row was checked, and every problem is listed
                      above.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        <footer className={styles.footer}>
          {done ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button
                disabled={!ready || busy}
                onClick={() => void onImport()}
              >
                {busy ? 'Importing' : 'Import'}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={close}>
                Cancel
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeCounts(result: ImportRecordsResult): string {
  const parts: string[] = [];
  if (result.sitesCreated > 0) {
    parts.push(countLabel(result.sitesCreated, 'site', 'sites'));
  }
  parts.push(countLabel(result.buildingsCreated, 'building', 'buildings'));
  return parts.join(' and ');
}

function describeParsed(parsed: ImportParseResult, mode: ImportMode): string {
  const parts: string[] = [];
  if (mode === 'sites') {
    parts.push(countLabel(parsed.siteCount, 'site', 'sites'));
  }
  parts.push(countLabel(parsed.buildingCount, 'building', 'buildings'));
  return parts.join(' and ');
}
