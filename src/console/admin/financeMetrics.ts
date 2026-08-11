// ============================================================================
// financeMetrics - pure roll-ups over subscriptions, plans and finance events
// for the super-admin Finance tab (Phase 3 §7).
//
// The platform twin of reports/orgMetrics: every figure the Finance tab (and
// the dashboard's revenue summary) shows is derived here, in one pure module,
// so the tile, the chart and the health table can never disagree about what
// counts as recurring revenue. Nothing here reads or writes anything - callers
// pass in the org root, the plan catalogue and the finance-event window they
// already subscribe to.
//
// WHAT COUNTS AS REVENUE: a subscription in `active`, `past_due` or `trialing`.
// Past-due keeps counting because dunning is a grace window, not a cancellation
// (§3.5); trialing counts because Stripe will convert it at period end. Every
// other status (canceled, unpaid, incomplete) contributes nothing. A revenue
// subscription whose plan is missing from the catalogue still COUNTS as an
// active subscription but contributes £0 of MRR - the honest number, never an
// invented price.
// ============================================================================

import type {
  Environment,
  FinanceEvent,
  Organisation,
  OrgSubscription,
  Plan,
  SubscriptionStatus,
} from '../../types';
import { lastMonths, monthKey } from '../reports/orgMetrics';

// ----------------------------------------------------------------------------
// Revenue-counting vocabulary.
// ----------------------------------------------------------------------------

/** Subscription statuses that count toward MRR and the active tile. */
export const REVENUE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  'active',
  'past_due',
  'trialing',
]);

/** True when a subscription is in a revenue-counting lifecycle state. */
export function isRevenueStatus(status: SubscriptionStatus | undefined): boolean {
  return status !== undefined && REVENUE_STATUSES.has(status);
}

// ----------------------------------------------------------------------------
// Per-organisation subscription rows (the health table's shape).
// ----------------------------------------------------------------------------

/** One org's billing position, flattened for the tiles and the health table. */
export interface SubscriptionRow {
  orgId: string;
  orgName: string;
  planId?: string;
  /** The catalogue name, falling back to the raw planId when the catalogue has
   *  no entry - honest, never a guessed display name. */
  planName: string;
  status?: SubscriptionStatus;
  paymentState?: OrgSubscription['paymentState'];
  currentPeriodEnd?: number;
  stripeCustomerId?: string;
  /** The subscription ends (rather than renews) at currentPeriodEnd. */
  cancelAtPeriodEnd?: boolean;
  /** Display name of the plan a scheduled downgrade lands on at period end
   *  (Phase 3 §3.2), resolved like planName - catalogue name or the raw id. */
  pendingPlanName?: string;
  /** The webhook's member-readable suspension mirror (org.profile.suspended):
   *  entitlements are off, which the status chip must say in words. */
  suspended: boolean;
  /** Whether this row counts toward the active-subscriptions tile. */
  revenue: boolean;
  /** This org's monthly recurring contribution in pence (0 unless the row is
   *  revenue-counting AND its plan is priced in the catalogue). */
  mrrPence: number;
}

/**
 * Flatten the org root into subscription rows, largest MRR contribution first
 * (ties by name) - exactly the order the health table presents. Orgs without a
 * subscription block are pre-billing and do not appear: they have no billing
 * position to report, which is different from a £0 one.
 */
export function subscriptionRows(
  orgs: Record<string, Organisation> | null | undefined,
  plans: Record<string, Plan> | null | undefined,
): SubscriptionRow[] {
  const rows: SubscriptionRow[] = [];
  for (const [orgId, org] of Object.entries(orgs ?? {})) {
    const subscription = org?.subscription;
    if (!subscription) {
      continue;
    }
    const plan = subscription.planId ? plans?.[subscription.planId] : undefined;
    const revenue = isRevenueStatus(subscription.status);
    const pendingPlanId = subscription.pendingPlanId;
    rows.push({
      orgId,
      orgName: org.profile?.name ?? orgId,
      planId: subscription.planId,
      planName: plan?.name ?? subscription.planId ?? 'No plan',
      status: subscription.status,
      paymentState: subscription.paymentState,
      currentPeriodEnd: subscription.currentPeriodEnd,
      stripeCustomerId: subscription.stripeCustomerId,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      pendingPlanName: pendingPlanId
        ? (plans?.[pendingPlanId]?.name ?? pendingPlanId)
        : undefined,
      suspended: org.profile?.suspended === true,
      revenue,
      mrrPence: revenue && plan ? plan.priceMonthlyPence : 0,
    });
  }
  return rows.sort(
    (a, b) =>
      b.mrrPence - a.mrrPence || a.orgName.localeCompare(b.orgName, 'en-GB'),
  );
}

// ----------------------------------------------------------------------------
// The three headline figures.
// ----------------------------------------------------------------------------

/** Monthly recurring revenue: the sum of every row's contribution, in pence. */
export function mrrPence(rows: readonly SubscriptionRow[]): number {
  return rows.reduce((sum, row) => sum + row.mrrPence, 0);
}

/** How many organisations hold a revenue-counting subscription. */
export function activeSubscriptionCount(
  rows: readonly SubscriptionRow[],
): number {
  return rows.filter((row) => row.revenue).length;
}

/** Average revenue per organisation, in pence, rounded to the penny. Zero-safe:
 *  no active subscriptions means £0, never NaN or a division error. */
export function arpoPence(totalMrrPence: number, activeCount: number): number {
  return activeCount === 0 ? 0 : Math.round(totalMrrPence / activeCount);
}

/** How many organisations are in dunning: a past_due lifecycle status OR a
 *  past_due payment state (the §3.5 grace window). The fourth headline tile -
 *  MRR says how much; this says how much of it is currently at risk. */
export function pastDueCount(rows: readonly SubscriptionRow[]): number {
  return rows.filter(
    (row) => row.status === 'past_due' || row.paymentState === 'past_due',
  ).length;
}

// ----------------------------------------------------------------------------
// Plan mix (the bar chart's series).
// ----------------------------------------------------------------------------

export interface PlanMixSlice {
  planId: string;
  label: string;
  count: number;
}

/**
 * Organisations per plan among revenue-counting subscriptions, in the
 * catalogue's display order. Every catalogue plan appears - a priced plan
 * nobody is on is a real zero worth seeing - and any subscribed planId missing
 * from the catalogue is appended (alphabetically) rather than silently dropped.
 */
export function planMix(
  rows: readonly SubscriptionRow[],
  plans: Record<string, Plan> | null | undefined,
): PlanMixSlice[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.revenue && row.planId) {
      counts.set(row.planId, (counts.get(row.planId) ?? 0) + 1);
    }
  }
  const catalogue = Object.entries(plans ?? {}).sort(
    (a, b) => a[1].order - b[1].order,
  );
  const slices: PlanMixSlice[] = catalogue.map(([planId, plan]) => ({
    planId,
    label: plan.name,
    count: counts.get(planId) ?? 0,
  }));
  const known = new Set(slices.map((slice) => slice.planId));
  const strays = Array.from(counts.keys())
    .filter((planId) => !known.has(planId))
    .sort((a, b) => a.localeCompare(b, 'en-GB'));
  for (const planId of strays) {
    slices.push({ planId, label: planId, count: counts.get(planId) ?? 0 });
  }
  return slices;
}

// ----------------------------------------------------------------------------
// Revenue over time (the line chart's series).
// ----------------------------------------------------------------------------

/**
 * Net revenue per month key (orgMetrics.monthKey) from the finance-event
 * window: payments add, refunds subtract, and nothing else moves money -
 * failures and lifecycle events are feed entries, not revenue. An event
 * without a numeric amount contributes nothing rather than NaN-poisoning the
 * month, and a month where refunds outran payments is an honest negative.
 */
export function monthlyNetRevenue(
  events: readonly FinanceEvent[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const event of events) {
    if (
      (event.type !== 'payment' && event.type !== 'refund') ||
      typeof event.amountPence !== 'number'
    ) {
      continue;
    }
    const key = monthKey(event.at);
    const signed =
      event.type === 'refund' ? -event.amountPence : event.amountPence;
    totals.set(key, (totals.get(key) ?? 0) + signed);
  }
  return totals;
}

/**
 * The calendar months the revenue chart plots for a date range: every month
 * from the range's start to its end, oldest first, in orgMetrics' month shape.
 * An open start falls back to 12 months ending at the range's end; an open end
 * anchors to `now`. Capped at 24 months (the most recent) so a mistyped year
 * can never render a thousand-point SVG.
 */
export function monthsForRange(
  fromMs: number | undefined,
  toMsExclusive: number | undefined,
  now: number,
): Array<{ key: string; label: string }> {
  const end = new Date(toMsExclusive === undefined ? now : toMsExclusive - 1);
  let span = 12;
  if (fromMs !== undefined) {
    const start = new Date(fromMs);
    span =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth()) +
      1;
  }
  return lastMonths(Math.min(24, Math.max(1, span)), end.getTime());
}

// ----------------------------------------------------------------------------
// Presentation helpers (pure, so the tests pin the exact strings).
// ----------------------------------------------------------------------------

const wholePounds = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const exactPounds = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "£1,234" for whole pounds, "£1,234.56" when pennies are present - the penny
 *  is never rounded away, and a round figure never wears a fussy ".00". */
export function formatPence(pence: number): string {
  const pounds = pence / 100;
  return pence % 100 === 0 ? wholePounds.format(pounds) : exactPounds.format(pounds);
}

/** Human labels for the subscription lifecycle, in British English for display
 *  ("canceled" is Stripe's spelling; the operator reads "Cancelled"). */
export const STATUS_LABELS: Record<SubscriptionStatus, string> = {
  active: 'Active',
  trialing: 'Trialling',
  past_due: 'Past due',
  canceled: 'Cancelled',
  unpaid: 'Unpaid',
  incomplete: 'Incomplete',
};

/** Calm feed phrases per finance-event type - statements of record, no alarm. */
export const EVENT_PHRASES: Record<FinanceEvent['type'], string> = {
  payment: 'Payment received',
  payment_failed: 'Payment failed',
  refund: 'Refund issued',
  subscription_started: 'Subscription started',
  subscription_canceled: 'Subscription cancelled',
  plan_changed: 'Plan changed',
};

/** The chip/dot palette vocabulary. Tones are always paired with words - the
 *  phrase carries the meaning, the tint only reinforces it. */
export type FinanceTone = 'success' | 'info' | 'warning' | 'error' | 'neutral';

/** Feed-dot tone per event type. Money in reads success, money out warning,
 *  a failure error; lifecycle events are neutral statements of record. */
export const EVENT_TONES: Record<FinanceEvent['type'], FinanceTone> = {
  payment: 'success',
  payment_failed: 'error',
  refund: 'warning',
  subscription_started: 'info',
  subscription_canceled: 'neutral',
  plan_changed: 'neutral',
};

/** "12 Sep 2026" - the health table's date voice, pinned here so the chip and
 *  the pending-plan phrase agree with the tests to the character. */
const chipDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/**
 * The health table's worded status chip. Precedence is the operator's
 * priority order, most actionable first: a suspended organisation (webhook
 * mirror - entitlements are off) beats everything; a scheduled cancellation
 * reads as its own state ("Ends {date}") because an active-but-ending
 * subscription is NOT the same health as an active one; dunning next; then
 * the plain lifecycle word. Colour never carries meaning alone.
 */
export function statusChip(row: SubscriptionRow): {
  label: string;
  tone: FinanceTone;
} {
  if (row.suspended) {
    return { label: 'Suspended', tone: 'error' };
  }
  if (row.cancelAtPeriodEnd && row.revenue) {
    return {
      label: row.currentPeriodEnd
        ? `Ends ${chipDate.format(row.currentPeriodEnd)}`
        : 'Ends at period end',
      tone: 'warning',
    };
  }
  if (row.status === 'past_due' || row.paymentState === 'past_due') {
    return { label: 'Past due', tone: 'warning' };
  }
  if (row.paymentState === 'action_required') {
    return { label: 'Action required', tone: 'warning' };
  }
  switch (row.status) {
    case 'active':
      return { label: 'Active', tone: 'success' };
    case 'trialing':
      return { label: 'Trialling', tone: 'info' };
    case 'canceled':
      return { label: 'Cancelled', tone: 'neutral' };
    case 'unpaid':
      return { label: 'Unpaid', tone: 'error' };
    case 'incomplete':
      return { label: 'Incomplete', tone: 'neutral' };
    default:
      return { label: 'No status', tone: 'neutral' };
  }
}

/** "Silver → Bronze at 12 Sep 2026" - the scheduled-downgrade line under the
 *  plan name (Phase 3 §3.2); undefined when no change is pending. */
export function planChangePhrase(row: SubscriptionRow): string | undefined {
  if (!row.pendingPlanName) {
    return undefined;
  }
  const when = row.currentPeriodEnd
    ? chipDate.format(row.currentPeriodEnd)
    : 'period end';
  return `${row.planName} → ${row.pendingPlanName} at ${when}`;
}

// ----------------------------------------------------------------------------
// Feed grouping (the billing activity aside).
// ----------------------------------------------------------------------------

/** "Tue 11 Aug 2026" - feed day headings, in UTC like the audit trail: a
 *  billing record must not shift days with the operator's timezone. */
const feedDay = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export interface FeedDayGroup {
  /** yyyy-mm-dd (UTC) - stable list key. */
  key: string;
  /** e.g. "Tue 11 Aug 2026". */
  label: string;
  entries: Array<{ id: string; event: FinanceEvent }>;
}

/**
 * Group a newest-first feed window into UTC calendar days, preserving order
 * within and across groups. Pure and order-preserving: the caller's sort is
 * the sort.
 */
export function groupEventsByDay(
  entries: ReadonlyArray<{ id: string; event: FinanceEvent }>,
): FeedDayGroup[] {
  const groups: FeedDayGroup[] = [];
  for (const entry of entries) {
    const key = new Date(entry.event.at).toISOString().slice(0, 10);
    const current = groups[groups.length - 1];
    if (current && current.key === key) {
      current.entries.push(entry);
    } else {
      groups.push({ key, label: feedDay.format(entry.event.at), entries: [entry] });
    }
  }
  return groups;
}

/**
 * The Stripe dashboard page for a customer - the tab's ONE way out to act on a
 * subscription (refunds, comps and every other mutation happen in Stripe, never
 * here). Test-mode customers live under the /test dashboard prefix.
 */
export function stripeCustomerUrl(
  env: Environment,
  stripeCustomerId: string,
): string {
  const prefix =
    env === 'test'
      ? 'https://dashboard.stripe.com/test'
      : 'https://dashboard.stripe.com';
  return `${prefix}/customers/${stripeCustomerId}`;
}
