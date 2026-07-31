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

  // --- Table or cards? ------------------------------------------------------
  // Decided from the width this table HAS and the number of columns it carries,
  // because those are the two things that actually determine whether a table
  // fits. A single breakpoint could not: at 768px a two-column list of sites is
  // perfectly readable as a table while a seven-column release list is already
  // crushed, so one number made one of them wrong whichever value was chosen -
  // and both were reported, from the same build.
  //
  // The console compounds it. A page here is the window minus the sidebar, and
  // often minus a detail aside as well, so a table on a 1440px screen can have
  // 700px of actual room. A viewport breakpoint never sees that at all.
  const [layout, setLayout] = React.useState<'table' | 'cards'>('table');
  // Roughly what a column needs before its content starts wrapping to three and
  // four lines. Deliberately generous for the first column, which carries the
  // row's name and is the one worth keeping readable.
  const minTableWidth = Math.min(140 + columns.length * 120, 1100);

  React.useEffect(() => {
    const box = scrollRef.current;
    // jsdom has no ResizeObserver; the tab stop is a progressive enhancement
    // and its absence must not break rendering under test. Defaulting to
    // 'table' also keeps the server-rendered markup a real table.
    if (!box || typeof ResizeObserver === 'undefined') {
      return;
    }
    // Sub-pixel table widths make an exact comparison report a phantom overflow.
    const measure = () => {
      setScrollable(box.scrollWidth > box.clientWidth + 1);
      setLayout(box.clientWidth >= minTableWidth ? 'table' : 'cards');
    };
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
    // minTableWidth changes only when the column set does, which is exactly when
    // the decision needs re-taking.
  }, [minTableWidth]);

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
      // The stylesheet lays the same DOM out either way off this one attribute.
      data-layout={layout}
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
                      {/* Every cell's content is wrapped, so NO cell can set the
                          height of its row. The clamp cannot live on the <td>
                          itself - it needs display:-webkit-box, and a table cell
                          that stops being display:table-cell drops out of the
                          table layout entirely - so it goes on a span inside.
                          See .cellClamp. */}
                      {href && index === 0 ? (
                        // The row's one real link: stretched to cover the row
                        // via CSS, keyboard-reachable, announced with the text.
                        <Link to={href} className={styles.rowLink}>
                          <span className={styles.cellClamp}>
                            {column.cell(row)}
                          </span>
                        </Link>
                      ) : (
                        <span className={styles.cellClamp}>
                          {column.cell(row)}
                        </span>
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
