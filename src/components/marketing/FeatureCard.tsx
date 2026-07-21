// ============================================================================
// FeatureCard - a heading, one small inline-SVG icon and a short body. Used in
// three-up strips. The icon inherits currentColor so it follows the theme.
// ============================================================================

import React from 'react';
import styles from './FeatureCard.module.css';

export interface FeatureCardProps {
  /** A small (16-24px) inline SVG using currentColor strokes. */
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}

export function FeatureCard({ icon, title, children }: FeatureCardProps) {
  return (
    <div className={styles.card}>
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.body}>{children}</p>
    </div>
  );
}
