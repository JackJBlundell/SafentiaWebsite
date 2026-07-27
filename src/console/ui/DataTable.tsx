// ============================================================================
// DataTable - a real table on desktop, labelled cards on mobile.
//
// Directories were stacked card lists at every width, which wastes a wide
// screen and makes scanning columns impossible. This renders ONE semantic
// <table>; the stylesheet lays it out as a grid of labelled blocks below the
// breakpoint using each cell's data-label. One DOM, two presentations, no
// duplicated render paths to drift apart.
//
// Deliberately not a data-grid: no sorting, paging or virtualisation until a
// screen genuinely needs them. Row interaction is a whole-row click when
// `onRowClick`/`rowHref` is provided, with the FIRST column carrying the real
// link/button for keyboard and screen-reader users - a clickable <tr> alone is
// invisible to both.
//
// An optional `expansion` adds a disclosure column: a real <button> carrying
// aria-expanded/aria-controls, and a panel row beneath. It sits in its own
// trailing cell so it never competes with the row's stretched link - the two
// are separate targets, and the panel is a landmark labelled by its toggle.
// ============================================================================

import React from 'react';
import { Link } from 'react-router-dom';
import styles from './DataTable.module.css';

export interface Column<T> {
  /** Column header. */
  header: string;
  /** Cell renderer. */
  cell: (row: T) => React.ReactNode;
  /** Hidden on mobile when true - for low-value columns a card can drop. */
  desktopOnly?: boolean;
  /** Right-aligns (numbers, actions). */
  align?: 'end';
  /** Fixed-ish width hint, e.g. '1%' for an actions column. */
  width?: string;
}

/** An in-place disclosure per row, rendered in its own trailing column. */
export interface RowExpansion<T> {
  /** Column header for the disclosure cell, e.g. 'Contents'. */
  header: string;
  /** Names the row inside the toggle so the button is unique to screen
   *  readers - 'Show contents' repeated down a table names nothing. */
  label: (row: T) => string;
  /** The revealed panel. Built only while the row is open. */
  content: (row: T) => React.ReactNode;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  /** Navigates the whole row; the first column also renders a real <Link>. */
  rowHref?: (row: T) => string;
  /** Accessible label for the table. */
  label: string;
  /** Adds a per-row disclosure column and panel row. */
  expansion?: RowExpansion<T>;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  label,
  expansion,
}: DataTableProps<T>) {
  // Rows open independently rather than one-at-a-time: closing what someone is
  // reading because they opened a second row is the more surprising behaviour.
  const [openRows, setOpenRows] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const idBase = React.useId();

  // A horizontally scrolling box is only reachable by keyboard when it is a tab
  // stop with a name, and the action plan's six columns genuinely do not fit
  // beside the detail page's aside. The stop is added only while there is
  // something to scroll to, so tables that fit never add a dead stop to the tab
  // order. It is an ordinary stop, not a trap: Tab leaves it as usual.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = React.useState(false);
  React.useEffect(() => {
    const box = scrollRef.current;
    // jsdom has no ResizeObserver; the tab stop is a progressive enhancement
    // and its absence must not break rendering under test.
    if (!box || typeof ResizeObserver === 'undefined') {
      return;
    }
    // Sub-pixel table widths make an exact comparison report a phantom overflow.
    const measure = () => setScrollable(box.scrollWidth > box.clientWidth + 1);
    measure();
    // The box and the table resize independently: the box with the column it
    // sits in, the table with the rows and text it is given.
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const table = box.firstElementChild;
    if (table) {
      observer.observe(table);
    }
    return () => observer.disconnect();
  }, []);

  const toggleRow = (key: string) =>
    setOpenRows((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      tabIndex={scrollable ? 0 : undefined}
      role={scrollable ? 'region' : undefined}
      aria-label={scrollable ? `${label}, scrollable` : undefined}
    >
      <table className={styles.table} aria-label={label}>
        <thead className={styles.head}>
          <tr>
            {columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                className={[
                  styles.th,
                  column.align === 'end' ? styles.end : '',
                  column.desktopOnly ? styles.desktopOnly : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
            {expansion && (
              <th scope="col" className={`${styles.th} ${styles.end}`} style={{ width: '1%' }}>
                {expansion.header}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const href = rowHref?.(row);
            const open = openRows.has(key);
            const panelId = `${idBase}-panel-${key}`;
            const toggleId = `${idBase}-toggle-${key}`;
            return (
              <React.Fragment key={key}>
                <tr
                  className={[
                    href ? styles.rowLinked : styles.row,
                    expansion && open ? styles.rowOpen : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {columns.map((column, index) => (
                    <td
                      key={column.header}
                      data-label={column.header}
                      className={[
                        styles.td,
                        column.align === 'end' ? styles.end : '',
                        column.desktopOnly ? styles.desktopOnly : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {href && index === 0 ? (
                        // The row's one real link: stretched to cover the row
                        // via CSS, keyboard-reachable, announced with the text.
                        <Link to={href} className={styles.rowLink}>
                          {column.cell(row)}
                        </Link>
                      ) : (
                        column.cell(row)
                      )}
                    </td>
                  ))}
                  {expansion && (
                    <td
                      data-label={expansion.header}
                      className={`${styles.td} ${styles.end}`}
                    >
                      <button
                        type="button"
                        id={toggleId}
                        className={styles.toggle}
                        aria-expanded={open}
                        aria-controls={panelId}
                        onClick={() => toggleRow(key)}
                      >
                        <span className={styles.toggleCaret} aria-hidden="true" />
                        <span>{open ? 'Hide' : 'Show'}</span>
                        <span className={styles.visuallyHidden}>
                          {' '}
                          {expansion.label(row)}
                        </span>
                      </button>
                    </td>
                  )}
                </tr>
                {expansion && (
                  // Kept in the DOM so aria-controls always resolves to a real
                  // element; the body is built only while open.
                  <tr className={styles.panelRow} hidden={!open}>
                    <td className={styles.panelCell} colSpan={columns.length + 1}>
                      <div
                        id={panelId}
                        role="region"
                        aria-labelledby={toggleId}
                        className={styles.panel}
                      >
                        {open && expansion.content(row)}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
