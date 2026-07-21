// ============================================================================
// PhoneFrame - a CSS-drawn native app frame for product depictions.
//
// The site ships no raster imagery (story 2075), so every product visual is
// drawn in CSS and inline SVG. The frame is aria-hidden: the mock UI inside is
// a decorative depiction whose meaning the surrounding copy already carries,
// and reading fake interface text to a screen reader would be noise.
// ============================================================================

import React from 'react';
import styles from './PhoneFrame.module.css';

export interface PhoneFrameProps {
  children: React.ReactNode;
  className?: string;
}

export function PhoneFrame({ children, className = '' }: PhoneFrameProps) {
  return (
    <div className={`${styles.phone} ${className}`} aria-hidden="true">
      <span className={styles.speaker} />
      <div className={styles.screen}>{children}</div>
    </div>
  );
}
