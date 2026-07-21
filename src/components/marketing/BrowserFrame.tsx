// ============================================================================
// BrowserFrame - a CSS-drawn browser chrome for depicting the web console and
// the released PDF report. Decorative, so aria-hidden (see PhoneFrame).
// The toolbar dots are deliberately neutral: red, amber and green are a fixed
// safety language in this product and are never spent on decoration.
// ============================================================================

import React from 'react';
import styles from './BrowserFrame.module.css';

export interface BrowserFrameProps {
  children: React.ReactNode;
  /** The address shown in the toolbar pill. */
  url?: string;
  className?: string;
}

export function BrowserFrame({ children, url, className = '' }: BrowserFrameProps) {
  return (
    <div className={`${styles.browser} ${className}`} aria-hidden="true">
      <div className={styles.toolbar}>
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
        {url && <span className={styles.address}>{url}</span>}
      </div>
      <div className={styles.viewport}>{children}</div>
    </div>
  );
}
