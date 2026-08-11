// ============================================================================
// cleanupBilling - the age-threshold selection logic.
//
// The scheduled wrapper is glue (bounded query + multi-location delete); what
// must be exactly right is WHICH entries a page of query results actually
// loses. Two invariants matter: a 'processing' claim marker is NEVER deleted
// by this sweep however old - a fresh one belongs to a running invocation,
// and a stale one (crashed invocation) is claimStripeEvent's to RECLAIM in
// place on the next Stripe retry, so deleting it here would erase the
// attempt record the reclaim path preserves. And entries whose timestamp
// cannot prove they are within retention (missing or non-numeric - which the
// RTDB endAt query DOES return, null ordering first) are deleted rather than
// kept forever. '../admin' is mocked so importing the module under jest never
// initialises firebase-admin (reportClientError precedent).
// ============================================================================

import {
  EMAIL_LOG_RETENTION_MS,
  FINANCE_EVENT_RETENTION_MS,
  STRIPE_EVENT_RETENTION_MS,
  expiredEmailLogEntryIds,
  expiredFinanceEventIds,
  expiredStripeEventIds,
} from '../functions/cleanupBilling';
import type { StripeEventClaim } from '../lib/stripe';
import type { EmailLogEntry, FinanceEvent } from '../shared/types';

jest.mock('../admin', () => ({ db: {} }));

const CUTOFF = 1_000_000;

function claim(status: StripeEventClaim['status'], receivedAt?: number): StripeEventClaim {
  return { type: 'invoice.paid', receivedAt: receivedAt as number, status };
}

function finance(at?: number): FinanceEvent {
  return {
    at: at as number,
    type: 'payment',
    orgId: 'org1',
    orgName: 'Org One',
    stripeEventId: 'evt_1',
  };
}

describe('retention windows', () => {
  it('sweeps done-markers at 30 days, the finance feed and email log at 12 months', () => {
    expect(STRIPE_EVENT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(FINANCE_EVENT_RETENTION_MS).toBe(365 * 24 * 60 * 60 * 1000);
    expect(EMAIL_LOG_RETENTION_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });
});

describe('expiredStripeEventIds', () => {
  it('selects only DONE markers at or past the cutoff', () => {
    const ids = expiredStripeEventIds(
      {
        evt_old_done: claim('done', CUTOFF - 1),
        evt_boundary_done: claim('done', CUTOFF),
        evt_fresh_done: claim('done', CUTOFF + 1),
        evt_old_processing: claim('processing', CUTOFF - 500_000),
      },
      CUTOFF,
    );
    expect(ids.sort()).toEqual(['evt_boundary_done', 'evt_old_done']);
  });

  it('never touches processing claims, however old - stale ones are reclaimed by claimStripeEvent, not swept', () => {
    // A stuck 'processing' marker is a crashed invocation's orphan. The sweep
    // leaves it alone: the next Stripe retry reclaims it in place (lib/stripe
    // stale-claim reclaim), keeping the attempt count. Cleanup only ever
    // removes 'done' markers past retention.
    expect(
      expiredStripeEventIds({ evt_stuck: claim('processing', 0) }, CUTOFF),
    ).toEqual([]);
  });

  it('deletes done markers with an unprovable receivedAt', () => {
    const malformed = {
      evt_no_ts: claim('done'),
      evt_bad_ts: { ...claim('done'), receivedAt: 'yesterday' as unknown as number },
    };
    expect(expiredStripeEventIds(malformed, CUTOFF).sort()).toEqual([
      'evt_bad_ts',
      'evt_no_ts',
    ]);
  });

  it('ignores null/undefined entries defensively', () => {
    expect(
      expiredStripeEventIds({ evt_null: null, evt_undef: undefined }, CUTOFF),
    ).toEqual([]);
  });
});

describe('expiredFinanceEventIds', () => {
  it('selects entries at or past the cutoff and keeps fresh ones', () => {
    const ids = expiredFinanceEventIds(
      {
        fe_old: finance(CUTOFF - 1),
        fe_boundary: finance(CUTOFF),
        fe_fresh: finance(CUTOFF + 1),
      },
      CUTOFF,
    );
    expect(ids.sort()).toEqual(['fe_boundary', 'fe_old']);
  });

  it('deletes entries with an unprovable timestamp', () => {
    const ids = expiredFinanceEventIds(
      {
        fe_no_ts: finance(),
        fe_bad_ts: { ...finance(1), at: 'then' as unknown as number },
        fe_null: null,
      },
      CUTOFF,
    );
    expect(ids.sort()).toEqual(['fe_bad_ts', 'fe_no_ts', 'fe_null']);
  });
});

describe('expiredEmailLogEntryIds', () => {
  function logEntry(sentAt?: number): EmailLogEntry {
    return {
      to: 'j***@example.com',
      subject: 'Test',
      category: 'invitation',
      sentAt: sentAt as number,
      outcome: 'sent',
    };
  }

  it('selects entries at or past the cutoff, keeps fresh ones, and deletes unprovable timestamps', () => {
    const ids = expiredEmailLogEntryIds(
      {
        el_old: logEntry(CUTOFF - 1),
        el_boundary: logEntry(CUTOFF),
        el_fresh: logEntry(CUTOFF + 1),
        el_no_ts: logEntry(),
        el_null: null,
      },
      CUTOFF,
    );
    expect(ids.sort()).toEqual(['el_boundary', 'el_no_ts', 'el_null', 'el_old']);
  });
});
