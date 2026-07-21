// ============================================================================
// Layout grammar: PageGrid, CardGrid, DescriptionList, Toolbar.
//
// These four shapes are what turn the console from a stacked scroll into a
// designed application on a wide screen:
//   - PageGrid: the master-and-aside detail layout. Content on the left, a
//     sticky column of key facts and actions on the right; collapses to one
//     column below the desktop breakpoint.
//   - CardGrid: responsive card/stat tiling (auto-fill, so it uses whatever
//     width exists without per-page media queries).
//   - DescriptionList: label/value facts in a two-column grid, replacing the
//     ad-hoc paragraph stacks detail pages grew.
//   - Toolbar: the search/filter/action row above a table, wrapping cleanly.
// ============================================================================

import React from 'react';
import styles from './Grid.module.css';

/** Master content + sticky aside. Pass `aside` only when there are genuine key
 *  facts/actions to pin; a page with no aside just uses normal flow. */
export function PageGrid({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  if (!aside) {
    return <div className={styles.single}>{children}</div>;
  }
  return (
    <div className={styles.page}>
      <div className={styles.main}>{children}</div>
      <aside className={styles.aside}>{aside}</aside>
    </div>
  );
}

/** Responsive tile grid. `min` is the tile's minimum width in px. */
export function CardGrid({
  children,
  min = 220,
}: {
  children: React.ReactNode;
  min?: number;
}) {
  return (
    <div
      className={styles.cards}
      style={{ ['--card-min' as string]: `${min}px` }}
    >
      {children}
    </div>
  );
}

export interface DescriptionItem {
  label: string;
  value: React.ReactNode;
}

/** Label/value facts. Renders nothing for items whose value is empty, so pages
 *  never show a wall of dashes for unset optional fields. */
export function DescriptionList({ items }: { items: DescriptionItem[] }) {
  const present = items.filter(
    (item) => item.value !== undefined && item.value !== null && item.value !== '',
  );
  if (present.length === 0) {
    return null;
  }
  return (
    <dl className={styles.dl}>
      {present.map((item) => (
        <div key={item.label} className={styles.dlRow}>
          <dt className={styles.dt}>{item.label}</dt>
          <dd className={styles.dd}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The row of controls above a table or list: search, filters, then actions
 *  pushed to the end. Wraps without collapsing into a vertical stack. */
export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className={styles.toolbar}>{children}</div>;
}

/** Groups Toolbar children that belong together (e.g. filter chips). */
export function ToolbarGroup({
  children,
  push = false,
}: {
  children: React.ReactNode;
  /** Pushes this group to the far end of the row. */
  push?: boolean;
}) {
  return (
    <div className={push ? `${styles.toolbarGroup} ${styles.toolbarPush}` : styles.toolbarGroup}>
      {children}
    </div>
  );
}
