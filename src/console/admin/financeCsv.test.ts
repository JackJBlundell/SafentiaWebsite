// ============================================================================
// financeCsv tests - the pure accounting-export builders behind the Finance
// tab's two toolbar buttons. Rows in, CSV out: these pin the QuickBooks
// 3-column UK shape (dd/MM/yyyy, refunds negative, money-moving rows only),
// the universal activity shape (ISO dates, blank amounts where no money
// moved), lib/csv escaping, the range narrowing, and the filename patterns -
// so an accountant's import never drifts by accident.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { FinanceEvent, Plan } from '../../types';
import {
  activityCsv,
  defaultFinanceRange,
  endOfDayUtcExclusive,
  eventsInRange,
  exportFilename,
  quickBooksCsv,
  startOfDayUtc,
} from './financeCsv';

// --- Fixtures ---------------------------------------------------------------

function plan(name: string): Plan {
  return {
    name,
    stripePriceId: `price_${name.toLowerCase()}`,
    priceMonthlyPence: 4900,
    currency: 'gbp',
    features: { branding: false, emailTemplates: false, prioritySupport: false },
    limits: {
      orgStaff: 5,
      customers: 10,
      notificationsPerMonth: 100,
      assessmentTemplates: 3,
    },
    order: 1,
  };
}

const PLANS: Record<string, Plan> = { bronze: plan('Bronze'), silver: plan('Silver') };

function event(partial: Partial<FinanceEvent>): FinanceEvent {
  return {
    at: Date.UTC(2026, 6, 3, 12), // 3 Jul 2026, midday UTC
    type: 'payment',
    orgId: 'org-a',
    orgName: 'Alpha Fire',
    planId: 'bronze',
    amountPence: 4900,
    currency: 'gbp',
    stripeEventId: 'evt_1',
    ...partial,
  };
}

const lines = (csv: string) => csv.split('\r\n');

// --- QuickBooks (bank-import, 3-column UK) -----------------------------------

describe('quickBooksCsv', () => {
  it('emits the 3-column UK header, dd/MM/yyyy dates and pounds with 2dp', () => {
    const csv = quickBooksCsv([event({})], PLANS);
    expect(lines(csv)).toEqual([
      'Date,Description,Amount',
      '03/07/2026,Safentia subscription - Alpha Fire (Bronze) - evt_1,49.00',
    ]);
  });

  it('emits refunds NEGATIVE, worded as refunds', () => {
    const csv = quickBooksCsv(
      [event({ type: 'refund', amountPence: 2450, stripeEventId: 'evt_r' })],
      PLANS,
    );
    expect(lines(csv)[1]).toBe(
      '03/07/2026,Safentia refund - Alpha Fire (Bronze) - evt_r,-24.50',
    );
  });

  it('includes ONLY money-moving rows: lifecycle, failures and amountless events are skipped', () => {
    const csv = quickBooksCsv(
      [
        event({ type: 'subscription_started', amountPence: undefined }),
        event({ type: 'payment_failed' }),
        event({ type: 'plan_changed', amountPence: undefined }),
        event({ amountPence: undefined }),
        event({}),
      ],
      PLANS,
    );
    expect(lines(csv)).toHaveLength(2);
  });

  it('escapes via lib/csv: a comma in an organisation name quotes the cell', () => {
    const csv = quickBooksCsv(
      [event({ orgName: 'Alpha, Fire & Safety Ltd' })],
      PLANS,
    );
    expect(lines(csv)[1]).toBe(
      '03/07/2026,"Safentia subscription - Alpha, Fire & Safety Ltd (Bronze) - evt_1",49.00',
    );
  });

  it('falls back to the raw planId off-catalogue, and drops the parens without one', () => {
    const offCatalogue = quickBooksCsv([event({ planId: 'legacy' })], PLANS);
    expect(lines(offCatalogue)[1]).toContain('(legacy)');
    const planless = quickBooksCsv([event({ planId: undefined })], PLANS);
    expect(lines(planless)[1]).toBe(
      '03/07/2026,Safentia subscription - Alpha Fire - evt_1,49.00',
    );
  });
});

// --- Universal activity export -----------------------------------------------

describe('activityCsv', () => {
  it('emits every row with ISO dates, the worded type and the Stripe event id', () => {
    const csv = activityCsv(
      [
        event({}),
        event({
          type: 'subscription_started',
          amountPence: undefined,
          currency: undefined,
          stripeEventId: 'evt_2',
        }),
      ],
      PLANS,
    );
    expect(lines(csv)).toEqual([
      'Date (ISO),Type,Organisation,Plan,Amount,Currency,Stripe event id',
      '2026-07-03T12:00:00.000Z,Payment received,Alpha Fire,Bronze,49.00,GBP,evt_1',
      '2026-07-03T12:00:00.000Z,Subscription started,Alpha Fire,Bronze,,,evt_2',
    ]);
  });

  it('signs refunds negative here too, so the two exports never disagree', () => {
    const csv = activityCsv([event({ type: 'refund' })], PLANS);
    expect(lines(csv)[1]).toContain('Refund issued,Alpha Fire,Bronze,-49.00,GBP');
  });
});

// --- Range plumbing -----------------------------------------------------------

describe('range narrowing', () => {
  it('converts yyyy-mm-dd to UTC-midnight bounds, the "to" day inclusive', () => {
    expect(startOfDayUtc('2026-07-03')).toBe(Date.UTC(2026, 6, 3));
    expect(endOfDayUtcExclusive('2026-07-03')).toBe(Date.UTC(2026, 6, 4));
    expect(startOfDayUtc('')).toBeUndefined();
    expect(endOfDayUtcExclusive('')).toBeUndefined();
  });

  it('keeps events inside [from, to) and treats an open bound as unbounded', () => {
    const early = event({ at: Date.UTC(2026, 6, 1), stripeEventId: 'early' });
    const inside = event({ at: Date.UTC(2026, 6, 3, 23, 59), stripeEventId: 'in' });
    const late = event({ at: Date.UTC(2026, 6, 4), stripeEventId: 'late' });
    const all = [early, inside, late];

    const from = startOfDayUtc('2026-07-02');
    const to = endOfDayUtcExclusive('2026-07-03');
    expect(eventsInRange(all, from, to).map((e) => e.stripeEventId)).toEqual(['in']);
    expect(eventsInRange(all, undefined, to)).toHaveLength(2);
    expect(eventsInRange(all, from, undefined)).toHaveLength(2);
    expect(eventsInRange(all, undefined, undefined)).toHaveLength(3);
  });

  it('defaults to the last 12 calendar months from an injected clock', () => {
    expect(defaultFinanceRange(Date.UTC(2026, 7, 11, 9))).toEqual({
      from: '2025-09-01',
      to: '2026-08-11',
    });
    // January anchors into the previous year without arithmetic drift.
    expect(defaultFinanceRange(Date.UTC(2026, 0, 5, 9))).toEqual({
      from: '2025-02-01',
      to: '2026-01-05',
    });
  });
});

// --- Filenames -----------------------------------------------------------------

describe('exportFilename', () => {
  it('carries kind, environment and range; open bounds read as words', () => {
    expect(exportFilename('quickbooks', 'live', '2025-09-01', '2026-08-11')).toBe(
      'safentia-quickbooks-live-2025-09-01-2026-08-11.csv',
    );
    expect(exportFilename('activity', 'test', '', '2026-08-11')).toBe(
      'safentia-activity-test-start-2026-08-11.csv',
    );
    expect(exportFilename('activity', 'live', '2025-09-01', '')).toBe(
      'safentia-activity-live-2025-09-01-now.csv',
    );
  });
});
