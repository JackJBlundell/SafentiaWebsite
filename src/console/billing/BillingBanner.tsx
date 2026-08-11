// ============================================================================
// BillingBanner - the dunning / suspension notice in the console chrome (§3.5).
//
// One banner, rendered by ConsoleShell above the routed content in ORG mode.
// Admin states (billing is administrator ground - only an admin can read the
// subscription node or act on it):
//
//   - paymentState 'past_due'        -> "Payment failed" (grace window open;
//     entitlements are UNCHANGED - never degrade a live safety tool over a
//     card hiccup, so this is a nudge, not a lockout).
//   - paymentState 'action_required' -> the bank wants 3DS confirmation.
//   - suspended (status unpaid/canceled/incomplete) -> the full-width variant:
//     creates are paused, existing data untouched (§6.3 - nothing deleted or
//     hidden).
//
// NON-ADMIN members cannot read the subscription (rules, by design) - but a
// suspended org still refuses their create actions server-side, so silence
// here would leave them with nothing but raw errors (SEV-1 fix 3). They get a
// read-only variant driven by the org profile's `suspended` mirror - a single
// member-readable boolean maintained by the Stripe webhook that leaks no
// billing detail - with no action link, because acting on billing is not
// theirs to do.
//
// No dismiss control on purpose: this reflects a live billing state, not a
// toast - it clears itself the moment the webhook clears the state. role
// "status" (polite), because a payment problem is urgent to fix but must not
// interrupt in-flight safety work mid-sentence.
// ============================================================================

import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { OrgProfile } from '../../types';
import { useEntitlements } from './useEntitlements';
import styles from './BillingBanner.module.css';

export function BillingBanner() {
  const { entitlements, subscription, isAdmin, loading } = useEntitlements();
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';

  // The member-readable suspension mirror (profile is member-readable; the
  // subscription node is not). Attached only for non-admins - admins already
  // hold the richer subscription-driven states below.
  const profile = useRtdbQuery<OrgProfile | null>({
    key: keys.orgProfile(orgId),
    path: paths ? paths.db.orgProfile(orgId) : '',
    enabled: Boolean(orgId && paths) && !isAdmin,
  });

  if (!isAdmin) {
    // While loading say nothing rather than flashing a banner the data may
    // retract a beat later; an errored read degrades to silence too - the
    // server remains the boundary either way.
    if (profile.isLoading || profile.isError || profile.data?.suspended !== true) {
      return null;
    }
    return (
      <div className={`${styles.banner} ${styles.suspended}`} role="status">
        <span>
          Your organisation&apos;s subscription is paused, so creating new work
          is unavailable just now. Please ask your administrator. All existing
          data is untouched.
        </span>
      </div>
    );
  }

  if (loading || !subscription) {
    return null;
  }

  if (entitlements.suspended) {
    return (
      <div className={`${styles.banner} ${styles.suspended}`} role="status">
        <span>
          Your subscription has ended, so creating new work is paused. All of
          your existing data is untouched.
        </span>
        <Link className={styles.link} to="/app/settings/billing">
          Reactivate your subscription
        </Link>
      </div>
    );
  }

  if (subscription.paymentState === 'past_due') {
    return (
      <div className={`${styles.banner} ${styles.warning}`} role="status">
        <span>
          Your last payment failed. Please update your card - everything keeps
          working while you do.
        </span>
        <Link className={styles.link} to="/app/settings/billing">
          Update your card
        </Link>
      </div>
    );
  }

  if (subscription.paymentState === 'action_required') {
    return (
      <div className={`${styles.banner} ${styles.warning}`} role="status">
        <span>Your bank needs to confirm your payment.</span>
        <Link className={styles.link} to="/app/settings/billing">
          Confirm payment
        </Link>
      </div>
    );
  }

  return null;
}
