// ============================================================================
// Card primitives - the console's unit of surface.
//
// Every panel of content sits on a Card, so elevation, radius, border and
// internal rhythm are decided once. Pages compose Cards inside the Grid
// primitives; they do not paint their own surfaces. This is the piece that
// stops the console reading as one long scroll: content becomes bounded,
// scannable regions that can sit side by side on a wide screen.
// ============================================================================

import React from 'react';
import { Skeleton, SkeletonStatus } from './Skeleton';
import styles from './Card.module.css';

export interface CardProps {
  children: React.ReactNode;
  /** Removes the internal padding for flush content such as tables. */
  flush?: boolean;
  className?: string;
}

export function Card({ children, flush = false, className = '' }: CardProps) {
  const classes = [styles.card, flush ? styles.flush : '', className]
    .filter(Boolean)
    .join(' ');
  return <section className={classes}>{children}</section>;
}

export interface CardHeaderProps {
  title: string;
  /** One quiet supporting line under the title. */
  hint?: string;
  /** Right-aligned action (a Button, a toggle, a count). */
  action?: React.ReactNode;
  /** Heading level; cards default to h2 so page structure stays honest. */
  as?: 'h2' | 'h3';
}

export function CardHeader({ title, hint, action, as: Heading = 'h2' }: CardHeaderProps) {
  return (
    <header className={styles.header}>
      <div>
        <Heading className={styles.title}>{title}</Heading>
        {hint && <p className={styles.hint}>{hint}</p>}
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </header>
  );
}

/** A stat tile: one number the reader can act on, with its label and context.
 *  Composed in a CardGrid on overview pages. An `undefined` value means the
 *  backing read has not attached yet, so the tile shows a value-shaped
 *  skeleton - never the word "No data" where a number belongs, and never an
 *  invented zero. */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon,
}: {
  label: string;
  value: string | number | undefined;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger';
  /** A small decorative inline SVG (stroke currentColor, aria-hidden) shown
   *  beside the label; the label alone carries the meaning. */
  icon?: React.ReactNode;
}) {
  return (
    <div className={`${styles.stat} ${styles[`stat-${tone}`]}`}>
      <span className={styles.statLabelRow}>
        {icon && (
          <span aria-hidden="true" className={styles.statIcon}>
            {icon}
          </span>
        )}
        <span className={styles.statLabel}>{label}</span>
      </span>
      {value === undefined ? (
        <span className={styles.statValue}>
          <SkeletonStatus label={`Loading ${label}`} />
          <Skeleton width="2.5ch" height="1.75rem" />
        </span>
      ) : (
        <span className={styles.statValue}>{value}</span>
      )}
      {hint && <span className={styles.statHint}>{hint}</span>}
    </div>
  );
}
