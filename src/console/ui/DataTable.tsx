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

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  /** Navigates the whole row; the first column also renders a real <Link>. */
  rowHref?: (row: T) => string;
  /** Accessible label for the table. */
  label: string;
}

export function DataTable<T>({ columns, rows, rowKey, rowHref, label }: DataTableProps<T>) {
  return (
    <div className={styles.scroll}>
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
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = rowHref?.(row);
            return (
              <tr key={rowKey(row)} className={href ? styles.rowLinked : styles.row}>
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
                      // The row's one real link: stretched to cover the row via
                      // CSS, keyboard-reachable, announced with the cell text.
                      <Link to={href} className={styles.rowLink}>
                        {column.cell(row)}
                      </Link>
                    ) : (
                      column.cell(row)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
