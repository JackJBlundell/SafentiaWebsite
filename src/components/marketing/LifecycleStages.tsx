// ============================================================================
// LifecycleStages - the validation lifecycle drawn as a five-stage sequence.
//
// The labels are the product's EXACT stage names, verbatim. They appear in the
// app, the console and the audit trail; the marketing site quoting them
// loosely would be the first inconsistency a prospect notices in a demo.
// ============================================================================

import styles from './LifecycleStages.module.css';

const STAGES = [
  {
    label: 'Assessment in progress',
    note: 'The assessor works through the template on site, offline included.',
  },
  {
    label: 'Ready for validation',
    note: 'The assessor submits the finished assessment for review.',
  },
  {
    label: 'More information required',
    note: 'The auditor flags specific questions; the assessor responds to each one.',
  },
  {
    label: 'Complete, ready for release',
    note: 'Validation has passed and the report is ready to generate.',
  },
  {
    label: 'Released',
    note: 'The formal PDF report is generated server-side and available to share.',
  },
] as const;

export interface LifecycleStagesProps {
  /** Shows a one-line description under each stage. */
  detailed?: boolean;
  className?: string;
}

export function LifecycleStages({ detailed = false, className = '' }: LifecycleStagesProps) {
  return (
    <ol className={`${styles.list} ${detailed ? styles.detailed : ''} ${className}`}>
      {STAGES.map((stage, index) => (
        <li key={stage.label} className={styles.stage}>
          <span className={styles.marker} aria-hidden="true">
            {index + 1}
          </span>
          <span className={styles.label}>{stage.label}</span>
          {detailed && <span className={styles.note}>{stage.note}</span>}
        </li>
      ))}
    </ol>
  );
}
