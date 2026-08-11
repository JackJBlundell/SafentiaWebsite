// ============================================================================
// UpsellNotice - the calm face of an entitlement gate.
//
// Where a create control would sit, an at-limit organisation sees this quiet
// card-let instead: one sentence of context supplied by the call site, and the
// way forward. Admins get the "View plans" link to Billing; everyone else is
// pointed at their administrator, because plans are an administrator decision.
//
// Deliberately dumb: no hook calls, no billing knowledge - the caller decides
// WHEN to gate (via useEntitlements) and WHAT the sentence says. §6.3: gates
// block new creates only, so this component never hides or removes anything;
// it only stands in for the one action the plan does not include.
// ============================================================================

import { Link } from 'react-router-dom';
import styles from './UpsellNotice.module.css';

export interface UpsellNoticeProps {
  /** The one-sentence, call-site-specific explanation, e.g.
   *  "You're on Bronze (5 staff included). Upgrade to invite more staff." */
  message: string;
  /** Admins see the "View plans" link; non-admins the administrator wording. */
  isAdmin: boolean;
}

export function UpsellNotice({ message, isAdmin }: UpsellNoticeProps) {
  return (
    <div className={styles.notice} role="status">
      <p className={styles.message}>{message}</p>
      {isAdmin ? (
        <Link className={styles.link} to="/app/settings/billing">
          View plans
        </Link>
      ) : (
        <p className={styles.message}>
          Ask your administrator about upgrading your plan.
        </p>
      )}
    </div>
  );
}
