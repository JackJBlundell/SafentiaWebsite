// ============================================================================
// financeMetrics tests - the pure billing roll-ups behind the Finance tab.
//
// Pins the revenue vocabulary (which statuses count), the zero-safety of every
// division, the month bucketing of the payments series, and the exact currency
// strings the tiles show - so a rules change here is a deliberate edit, never
// a drift.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { FinanceEvent, Organisation, Plan } from '../../types';
import {
  activeSubscriptionCount,
  arpoPence,
  formatPence,
  groupEventsByDay,
  isRevenueStatus,
  monthlyNetRevenue,
  monthsForRange,
  mrrPence,
  pastDueCount,
  planChangePhrase,
  planMix,
  statusChip,
  stripeCustomerUrl,
  subscriptionRows,
  type SubscriptionRow,
} from './financeMetrics';

// --- Fixtures ---------------------------------------------------------------

function plan(name: string, priceMonthlyPence: number, order: number): Plan {
  return {
    name,
    stripePriceId: `price_${name.toLowerCase()}`,
    priceMonthlyPence,
    currency: 'gbp',
    features: { branding: false, emailTemplates: false, prioritySupport: false },
    limits: {
      orgStaff: 5,
      customers: 10,
      notificationsPerMonth: 100,
      assessmentTemplates: 3,
    },
    order,
  };
}

const PLANS: Record<string, Plan> = {
  bronze: plan('Bronze', 4900, 1),
  silver: plan('Silver', 9900, 2),
  gold: plan('Gold', 19900, 3),
};

function org(
  name: string,
  subscription?: Organisation['subscription'],
): Organisation {
  return {
    profile: { name, brand: { primary: '#000', secondary: '#fff' } },
    ...(subscription ? { subscription } : {}),
  };
}

const ORGS: Record<string, Organisation> = {
  'org-active': org('Alpha Fire', { planId: 'gold', status: 'active' }),
  'org-pastdue': org('Bravo Safety', {
    planId: 'silver',
    status: 'past_due',
    paymentState: 'past_due',
  }),
  'org-trial': org('Charlie Compliance', { planId: 'bronze', status: 'trialing' }),
  'org-canceled': org('Delta Risk', { planId: 'gold', status: 'canceled' }),
  'org-unpaid': org('Echo Estates', { planId: 'silver', status: 'unpaid' }),
  'org-incomplete': org('Foxtrot Ltd', { planId: 'bronze', status: 'incomplete' }),
  // Pre-billing org: no subscription block at all - never a row.
  'org-prebilling': org('Golf Group'),
};

// --- Status vocabulary --------------------------------------------------------

describe('isRevenueStatus', () => {
  it('counts active, past_due and trialing; nothing else', () => {
    expect(isRevenueStatus('active')).toBe(true);
    expect(isRevenueStatus('past_due')).toBe(true);
    expect(isRevenueStatus('trialing')).toBe(true);
    expect(isRevenueStatus('canceled')).toBe(false);
    expect(isRevenueStatus('unpaid')).toBe(false);
    expect(isRevenueStatus('incomplete')).toBe(false);
    expect(isRevenueStatus(undefined)).toBe(false);
  });
});

// --- Rows, MRR, active count, ARPO -------------------------------------------

describe('subscriptionRows', () => {
  it('flattens only orgs with a subscription block, ordered by MRR descending', () => {
    const rows = subscriptionRows(ORGS, PLANS);
    // Six orgs carry a subscription block; the pre-billing org never appears.
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.orgId)).not.toContain('org-prebilling');
    // Gold £199 first, then silver £99, then bronze £49, then the £0 rows by name.
    expect(rows.map((row) => row.mrrPence).slice(0, 3)).toEqual([19900, 9900, 4900]);
    expect(rows.slice(3).map((row) => row.orgName)).toEqual([
      'Delta Risk',
      'Echo Estates',
      'Foxtrot Ltd',
    ]);
  });

  it('gives a revenue-status row with an unknown plan £0 MRR but still counts it active', () => {
    const rows = subscriptionRows(
      { 'org-x': org('X-Ray', { planId: 'platinum', status: 'active' }) },
      PLANS,
    );
    expect(rows[0].mrrPence).toBe(0);
    expect(rows[0].revenue).toBe(true);
    // Honest label: the raw planId, never a guessed catalogue name.
    expect(rows[0].planName).toBe('platinum');
    expect(activeSubscriptionCount(rows)).toBe(1);
  });

  it('handles absent inputs as empty, never throwing', () => {
    expect(subscriptionRows(null, null)).toEqual([]);
    expect(subscriptionRows(undefined, undefined)).toEqual([]);
  });
});

describe('mrrPence / activeSubscriptionCount / arpoPence', () => {
  it('sums only revenue statuses into MRR', () => {
    const rows = subscriptionRows(ORGS, PLANS);
    // gold 19900 + silver 9900 + bronze 4900; canceled/unpaid/incomplete add 0.
    expect(mrrPence(rows)).toBe(34700);
    expect(activeSubscriptionCount(rows)).toBe(3);
  });

  it('is zero-safe: no active subscriptions means £0 ARPO, never NaN', () => {
    expect(arpoPence(0, 0)).toBe(0);
    expect(arpoPence(34700, 0)).toBe(0);
  });

  it('rounds ARPO to the penny', () => {
    // 34700 / 3 = 11566.66... -> 11567.
    expect(arpoPence(34700, 3)).toBe(11567);
  });
});

// --- Plan mix -----------------------------------------------------------------

describe('planMix', () => {
  it('counts revenue subscriptions per plan in catalogue order, keeping real zeros', () => {
    const rows = subscriptionRows(ORGS, PLANS);
    expect(planMix(rows, PLANS)).toEqual([
      { planId: 'bronze', label: 'Bronze', count: 1 },
      { planId: 'silver', label: 'Silver', count: 1 },
      { planId: 'gold', label: 'Gold', count: 1 },
    ]);
    // A plan nobody is on stays in the mix as an honest zero.
    const goldOnly = subscriptionRows(
      { 'org-a': org('A', { planId: 'gold', status: 'active' }) },
      PLANS,
    );
    expect(planMix(goldOnly, PLANS)).toEqual([
      { planId: 'bronze', label: 'Bronze', count: 0 },
      { planId: 'silver', label: 'Silver', count: 0 },
      { planId: 'gold', label: 'Gold', count: 1 },
    ]);
  });

  it('excludes non-revenue statuses and appends subscribed plans missing from the catalogue', () => {
    const rows = subscriptionRows(
      {
        'org-a': org('A', { planId: 'gold', status: 'canceled' }),
        'org-b': org('B', { planId: 'platinum', status: 'active' }),
      },
      PLANS,
    );
    expect(planMix(rows, PLANS)).toEqual([
      { planId: 'bronze', label: 'Bronze', count: 0 },
      { planId: 'silver', label: 'Silver', count: 0 },
      { planId: 'gold', label: 'Gold', count: 0 },
      { planId: 'platinum', label: 'platinum', count: 1 },
    ]);
  });
});

// --- Monthly payment series ---------------------------------------------------

describe('monthlyNetRevenue', () => {
  const at = (year: number, month: number, day: number) =>
    new Date(year, month - 1, day).getTime();
  const event = (partial: Partial<FinanceEvent>): FinanceEvent => ({
    at: at(2026, 8, 1),
    type: 'payment',
    orgId: 'org-a',
    orgName: 'Alpha Fire',
    stripeEventId: 'evt_1',
    ...partial,
  });

  it('sums payments minus refunds into local-calendar month buckets', () => {
    const totals = monthlyNetRevenue([
      event({ at: at(2026, 7, 3), amountPence: 4900 }),
      event({ at: at(2026, 7, 28), amountPence: 9900 }),
      event({ at: at(2026, 7, 30), type: 'refund', amountPence: 4900 }),
      event({ at: at(2026, 8, 1), amountPence: 19900 }),
    ]);
    expect(totals.get('2026-07')).toBe(9900);
    expect(totals.get('2026-08')).toBe(19900);
    expect(totals.size).toBe(2);
  });

  it('goes honestly negative when refunds outrun payments', () => {
    const totals = monthlyNetRevenue([
      event({ at: at(2026, 7, 3), amountPence: 4900 }),
      event({ at: at(2026, 7, 4), type: 'refund', amountPence: 9900 }),
    ]);
    expect(totals.get('2026-07')).toBe(-5000);
  });

  it('ignores failures, lifecycle events and amountless entries', () => {
    const totals = monthlyNetRevenue([
      event({ at: at(2026, 7, 3), amountPence: 4900 }),
      event({ at: at(2026, 7, 5), type: 'payment_failed', amountPence: 9900 }),
      event({ at: at(2026, 7, 6), type: 'subscription_started' }),
      event({ at: at(2026, 7, 7), amountPence: undefined }),
    ]);
    expect(totals.get('2026-07')).toBe(4900);
    expect(totals.size).toBe(1);
  });

  it('returns an empty map for an empty window', () => {
    expect(monthlyNetRevenue([]).size).toBe(0);
  });
});

describe('monthsForRange', () => {
  const NOW = new Date(2026, 7, 11).getTime(); // 11 Aug 2026, local.

  it('spans the range inclusive of both bound months, oldest first', () => {
    // Mid-month instants, so the local-calendar month is the same in any
    // timezone the suite runs in (monthKey buckets locally by convention).
    const months = monthsForRange(
      Date.UTC(2026, 4, 15), // May 2026
      Date.UTC(2026, 7, 12), // exclusive: covers into Aug 2026
      NOW,
    );
    expect(months.map((month) => month.key)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
  });

  it('falls back to 12 months ending at the range end when the start is open', () => {
    const months = monthsForRange(undefined, Date.UTC(2026, 7, 12), NOW);
    expect(months).toHaveLength(12);
    expect(months[11].key).toBe('2026-08');
    expect(months[0].key).toBe('2025-09');
  });

  it('anchors an open end to now, and caps a runaway span at 24 months', () => {
    const open = monthsForRange(Date.UTC(2026, 6, 15), undefined, NOW);
    expect(open[open.length - 1].key).toBe('2026-08');
    const runaway = monthsForRange(Date.UTC(1999, 0, 15), undefined, NOW);
    expect(runaway).toHaveLength(24);
  });
});

// --- Presentation -------------------------------------------------------------

describe('formatPence', () => {
  it('drops the pennies on whole pounds and keeps them otherwise', () => {
    expect(formatPence(0)).toBe('£0');
    expect(formatPence(4900)).toBe('£49');
    expect(formatPence(123456)).toBe('£1,234.56');
    expect(formatPence(11567)).toBe('£115.67');
  });
});

const baseRow: SubscriptionRow = {
  orgId: 'org-a',
  orgName: 'Alpha Fire',
  planId: 'silver',
  planName: 'Silver',
  status: 'active',
  suspended: false,
  revenue: true,
  mrrPence: 9900,
};

// 12 Sep 2026, midday UTC - safely mid-month in any timezone.
const PERIOD_END = Date.UTC(2026, 8, 12, 12);

describe('pastDueCount', () => {
  it('counts a past_due status OR a past_due payment state, once per org', () => {
    expect(
      pastDueCount([
        baseRow,
        { ...baseRow, orgId: 'b', status: 'past_due' },
        { ...baseRow, orgId: 'c', paymentState: 'past_due' },
        { ...baseRow, orgId: 'd', status: 'past_due', paymentState: 'past_due' },
        { ...baseRow, orgId: 'e', paymentState: 'action_required' },
      ]),
    ).toBe(3);
  });
});

describe('statusChip', () => {
  it('words each lifecycle state, colour never alone', () => {
    expect(statusChip(baseRow)).toEqual({ label: 'Active', tone: 'success' });
    expect(statusChip({ ...baseRow, status: 'trialing' })).toEqual({
      label: 'Trialling',
      tone: 'info',
    });
    expect(
      statusChip({ ...baseRow, status: 'canceled', revenue: false }),
    ).toEqual({ label: 'Cancelled', tone: 'neutral' });
    expect(statusChip({ ...baseRow, status: 'unpaid', revenue: false })).toEqual(
      { label: 'Unpaid', tone: 'error' },
    );
  });

  it('renders a scheduled cancellation as its own DISTINCT state: "Ends {date}"', () => {
    expect(
      statusChip({
        ...baseRow,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: PERIOD_END,
      }),
    ).toEqual({ label: 'Ends 12 Sept 2026', tone: 'warning' });
    // Without a known period end the wording stays honest, never a blank date.
    expect(statusChip({ ...baseRow, cancelAtPeriodEnd: true })).toEqual({
      label: 'Ends at period end',
      tone: 'warning',
    });
  });

  it('suspended (the webhook mirror) outranks everything else', () => {
    expect(
      statusChip({
        ...baseRow,
        suspended: true,
        cancelAtPeriodEnd: true,
        status: 'unpaid',
        revenue: false,
      }),
    ).toEqual({ label: 'Suspended', tone: 'error' });
  });

  it('dunning states read in words', () => {
    expect(statusChip({ ...baseRow, paymentState: 'past_due' })).toEqual({
      label: 'Past due',
      tone: 'warning',
    });
    expect(statusChip({ ...baseRow, paymentState: 'action_required' })).toEqual(
      { label: 'Action required', tone: 'warning' },
    );
  });
});

describe('planChangePhrase', () => {
  it('phrases a pending downgrade as "{from} → {to} at {date}"', () => {
    expect(
      planChangePhrase({
        ...baseRow,
        pendingPlanName: 'Bronze',
        currentPeriodEnd: PERIOD_END,
      }),
    ).toBe('Silver → Bronze at 12 Sept 2026');
  });

  it('is undefined without a pending plan, honest without a period end', () => {
    expect(planChangePhrase(baseRow)).toBeUndefined();
    expect(
      planChangePhrase({ ...baseRow, pendingPlanName: 'Bronze' }),
    ).toBe('Silver → Bronze at period end');
  });
});

describe('subscriptionRows - deferred billing detail', () => {
  it('resolves pendingPlanId to its catalogue name and carries the suspension mirror', () => {
    const rows = subscriptionRows(
      {
        'org-a': {
          profile: {
            name: 'Alpha Fire',
            brand: { primary: '#000', secondary: '#fff' },
            suspended: true,
          },
          subscription: {
            planId: 'silver',
            status: 'unpaid',
            pendingPlanId: 'bronze',
            cancelAtPeriodEnd: true,
          },
        },
      },
      PLANS,
    );
    expect(rows[0].pendingPlanName).toBe('Bronze');
    expect(rows[0].suspended).toBe(true);
    expect(rows[0].cancelAtPeriodEnd).toBe(true);
  });
});

describe('groupEventsByDay', () => {
  const entry = (id: string, at: number): { id: string; event: FinanceEvent } => ({
    id,
    event: {
      at,
      type: 'payment',
      orgId: 'org-a',
      orgName: 'Alpha Fire',
      stripeEventId: `evt_${id}`,
    },
  });

  it('groups a newest-first window into UTC days, preserving order', () => {
    const groups = groupEventsByDay([
      entry('c', Date.UTC(2026, 7, 11, 15)),
      entry('b', Date.UTC(2026, 7, 11, 9)),
      entry('a', Date.UTC(2026, 7, 9, 23, 30)),
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      '2026-08-11',
      '2026-08-09',
    ]);
    expect(groups[0].label).toBe('Tue, 11 Aug 2026');
    expect(groups[0].entries.map((item) => item.id)).toEqual(['c', 'b']);
    expect(groups[1].entries.map((item) => item.id)).toEqual(['a']);
  });

  it('returns no groups for an empty window', () => {
    expect(groupEventsByDay([])).toEqual([]);
  });
});

describe('stripeCustomerUrl', () => {
  it('routes test-mode customers under the /test dashboard prefix', () => {
    expect(stripeCustomerUrl('test', 'cus_123')).toBe(
      'https://dashboard.stripe.com/test/customers/cus_123',
    );
    expect(stripeCustomerUrl('live', 'cus_123')).toBe(
      'https://dashboard.stripe.com/customers/cus_123',
    );
  });
});
