// ============================================================================
// LimitNudge - the calm word BEFORE the wall (assessment MEDIUM 20).
//
// Plan limits were a hard stop at N with no warning at N-1: the create control
// simply gave way to the at-limit UpsellNotice the moment the ceiling was hit.
// This is the quieter, earlier surface - a single line that appears once an org
// is at >=80% of a finite limit but has not yet reached it, so the last seat or
// two never arrives as a surprise.
//
// Deliberately dumb, exactly like UpsellNotice: no hook calls, no billing
// knowledge. The call site decides WHEN to show it (isNearLimit over the same
// usage + limit its at-limit gate reads) and hides it the instant the wall
// takes over, so the two never render together. Admins get the "View plans"
// link to Billing; everyone else the administrator wording, because upgrading
// is an administrator decision.
// ============================================================================

import { Link } from 'react-router-dom';
import styles from './LimitNudge.module.css';

export interface LimitNudgeProps {
  /** Seats/records used, counted exactly as the at-limit gate counts them. */
  used: number;
  /** The finite plan ceiling (the caller only renders this for a finite one). */
  limit: number;
  /** Plural noun for the counted thing, e.g. "team members", "customers". */
  noun: string;
  /** Admins see the "View plans" link; non-admins the administrator wording. */
  isAdmin: boolean;
}

export function LimitNudge({ used, limit, noun, isAdmin }: LimitNudgeProps) {
  return (
    <div className={styles.nudge} role="status">
      <p className={styles.message}>
        {used} of {limit} {noun} used
        {isAdmin ? ' - upgrade your plan for more.' : ' - approaching your plan limit.'}
      </p>
      {isAdmin ? (
        <Link className={styles.link} to="/app/settings/billing">
          View plans
        </Link>
      ) : (
        <span className={styles.message}>
          Ask your administrator about upgrading.
        </span>
      )}
    </div>
  );
}
