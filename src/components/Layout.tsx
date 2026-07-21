// ============================================================================
// Layout primitives: Container and Section.
//
// Two components carry the whole page rhythm. Marketing pages compose them and
// never set their own outer padding or max-width, so every section on every page
// shares one measure and one vertical cadence. That consistency is most of what
// makes a site feel considered rather than assembled.
// ============================================================================

import React from 'react';
import styles from './Layout.module.css';

export interface ContainerProps {
  children: React.ReactNode;
  /** Narrows to a comfortable reading measure for long-form prose. */
  prose?: boolean;
  className?: string;
}

export function Container({ children, prose = false, className = '' }: ContainerProps) {
  const classes = [styles.container, prose ? styles.prose : '', className]
    .filter(Boolean)
    .join(' ');
  return <div className={classes}>{children}</div>;
}

export interface SectionProps {
  children: React.ReactNode;
  /** Vertical rhythm (sectionSpacing). */
  spacing?: 'tight' | 'base' | 'loose';
  /** Paints the section on the alternate surface, to separate bands of content. */
  tone?: 'default' | 'alt' | 'ink';
  /** Renders as <section aria-labelledby>. Pass the id of the section heading. */
  labelledBy?: string;
  id?: string;
  className?: string;
}

export function Section({
  children,
  spacing = 'base',
  tone = 'default',
  labelledBy,
  id,
  className = '',
}: SectionProps) {
  const classes = [styles.section, styles[spacing], styles[tone], className]
    .filter(Boolean)
    .join(' ');
  return (
    <section id={id} aria-labelledby={labelledBy} className={classes}>
      {children}
    </section>
  );
}
