// ============================================================================
// Stepper - the small progress header the creation wizards share. Purely
// presentational: the owning wizard decides the current step; done steps are
// marked with a tick so colour is never the sole carrier.
// ============================================================================

import styles from './Stepper.module.css';

export interface StepperProps {
  steps: readonly string[];
  /** Zero-based index of the current step. An index past the last step marks
   *  every step done (the wizard's finish screen). */
  current: number;
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className={styles.list} aria-label="Progress">
      {steps.map((step, index) => {
        const state =
          index < current ? 'done' : index === current ? 'current' : 'todo';
        return (
          <li
            key={step}
            className={styles[state]}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className={styles.marker} aria-hidden="true">
              {state === 'done' ? '✓' : index + 1}
            </span>
            <span className={styles.name}>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
