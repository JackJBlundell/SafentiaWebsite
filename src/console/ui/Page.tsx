// ============================================================================
// Console page primitives: PageHeader, Breadcrumbs, EmptyState, ErrorNotice.
//
// Every console screen composes these instead of hand-rolling its own header
// band, so titles, breadcrumbs and action placement stay identical from the
// staff directory to the building detail. One rhythm, one hierarchy.
// ============================================================================

import React from 'react';
import { Link } from 'react-router-dom';
import styles from './Page.module.css';

export interface Crumb {
  label: string;
  /** Omit on the current (last) crumb. */
  to?: string;
}

export function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className={styles.breadcrumbs}>
      <ol className={styles.crumbList}>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className={styles.crumb}>
              {crumb.to && !isLast ? (
                <Link to={crumb.to} className={styles.crumbLink}>
                  {crumb.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
              )}
              {!isLast && (
                <span aria-hidden="true" className={styles.crumbSeparator}>
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface PageHeaderProps {
  title: string;
  /** One supporting sentence under the title. */
  lede?: string;
  crumbs?: Crumb[];
  /** A prominent "back to X" link above the title. Breadcrumbs show the whole
   *  trail but read as orientation, not a control; this is the single obvious
   *  way back one level, which is what a reader on a deep page reaches for. Give
   *  it the destination label (e.g. "your buildings") and its route. */
  back?: { label: string; to: string };
  /** Small, non-interactive badges that sit inline beside the title (e.g. live
   *  counts). Each carries its own text, so the badge means something without
   *  its colour; the caller styles them, the header only lays them out. */
  badges?: React.ReactNode;
  /** Right-aligned action, usually one primary Button. */
  action?: React.ReactNode;
}

export function PageHeader({ title, lede, crumbs, back, badges, action }: PageHeaderProps) {
  return (
    <div className={styles.header}>
      {back && (
        <Link to={back.to} className={styles.backLink}>
          <span aria-hidden="true">&#8592;</span> Back to {back.label}
        </Link>
      )}
      {crumbs && crumbs.length > 0 && <Breadcrumbs crumbs={crumbs} />}
      <div className={styles.headerRow}>
        <div>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{title}</h1>
            {badges && <span className={styles.badges}>{badges}</span>}
          </div>
          {lede && <p className={styles.lede}>{lede}</p>}
        </div>
        {action && <div className={styles.action}>{action}</div>}
      </div>
    </div>
  );
}

/** A guided empty state: what this list is, and the one action that fills it. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <h2 className={styles.emptyTitle}>{title}</h2>
      <p className={styles.emptyBody}>{body}</p>
      {action}
    </div>
  );
}

/** An inline, announced failure with the user-safe message. */
export function ErrorNotice({ message }: { message: string }) {
  return (
    <p role="alert" className={styles.error}>
      {message}
    </p>
  );
}
