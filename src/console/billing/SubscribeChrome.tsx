// ============================================================================
// SubscribeChrome - the shared full-screen chrome of the pre-payment
// subscribe sequence (Phase 3 §3.1): OrgDetailsPage -> SubscribePlanPage ->
// SubscribePaymentPage all render inside it, so the three screens read as ONE
// considered journey rather than three ad-hoc pages.
//
// Final production shape (design iteration with the owner): a fixed-feeling
// HEADER BAR across the top of the page - wordmark on the left, the
// three-step progress centred - and the step's content as its own centred
// block in the remaining viewport, free to scroll when it is taller than the
// screen (the plan matrix on a short laptop, for instance). The bar gives
// every step the same anchor; the content owns the rest.
//
// Purely presentational, tokens-only: the owning page decides the step index
// and the copy. The body eases in per step (motion tokens; suppressed under
// prefers-reduced-motion) so moving between steps feels deliberate.
// ============================================================================

import type { ReactNode } from 'react';
import { Wordmark } from '../../components/Wordmark';
import { Stepper } from '../ui/Stepper';
import styles from './SubscribeChrome.module.css';

/** The journey's three visible steps, in order. The confirming wait after
 *  payment has its own screen (the journey is out of the buyer's hands). */
export const SUBSCRIBE_STEPS = [
  'Your organisation',
  'Choose your plan',
  'Payment',
] as const;

const WIDTH_CLASS = {
  narrow: 'panel',
  medium: 'panelMedium',
  wide: 'panelWide',
} as const;

export interface SubscribeChromeProps {
  /** Zero-based index into SUBSCRIBE_STEPS. */
  step: 0 | 1 | 2;
  heading: string;
  /** The step's one calm subline, under the heading. */
  lede: ReactNode;
  /** 'narrow' for single-column forms, 'medium' for the two-column details
   *  form, 'wide' for the plan matrix. */
  width?: 'narrow' | 'medium' | 'wide';
  children: ReactNode;
}

export function SubscribeChrome({
  step,
  heading,
  lede,
  width = 'narrow',
  children,
}: SubscribeChromeProps) {
  return (
    <main className={styles.root}>
      <header className={styles.pageBar}>
        <div className={styles.pageBarBrand}>
          <Wordmark size="md" />
        </div>
        <div className={styles.pageBarSteps}>
          <Stepper steps={SUBSCRIBE_STEPS} current={step} />
        </div>
      </header>

      <div className={styles.content}>
        <div className={styles[WIDTH_CLASS[width]]}>
          <div className={styles.stepBody}>
            <header className={styles.stepHeader}>
              <h1 className={styles.heading}>{heading}</h1>
              <p className={styles.lede}>{lede}</p>
            </header>
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}
