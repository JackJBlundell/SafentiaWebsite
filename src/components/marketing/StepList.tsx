// ============================================================================
// StepList - the numbered end-to-end walk on the How it works page. Each step
// is a heading, a short body and a small CSS/SVG visual; visuals alternate
// sides on a desktop and stack under the text on a phone.
// ============================================================================

import React from 'react';
import styles from './StepList.module.css';

export interface Step {
  title: string;
  body: React.ReactNode;
  /** A small product visual. Decorative; rendered aria-hidden. */
  visual?: React.ReactNode;
}

export interface StepListProps {
  steps: readonly Step[];
}

export function StepList({ steps }: StepListProps) {
  return (
    <ol className={styles.list}>
      {steps.map((step, index) => (
        <li key={step.title} className={styles.step}>
          <div className={styles.text}>
            <span className={styles.number} aria-hidden="true">
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 className={styles.title}>{step.title}</h3>
            <div className={styles.body}>{step.body}</div>
          </div>
          {step.visual && (
            <div className={styles.visual} aria-hidden="true">
              {step.visual}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
