// ============================================================================
// financeCsv - pure accounting-export builders for the super-admin Finance tab.
//
// Everything here is rows-in, string-out: the builders take the finance-event
// window the page already holds (narrowed to the operator's date range) plus
// the plan catalogue for display names, and return finished CSV text via the
// console's one CSV serialiser (lib/csv - RFC 4180, formula-guarded). No
// builder reads a clock or the network, so the tests pin exact output.
//
// Two shapes, two audiences:
//  - QuickBooks: the QuickBooks Online bank-import 3-column format
//    (Date,Description,Amount), UK dates, refunds negative - ONLY rows where
//    money moved, because a bank feed has no line for "subscription started".
//  - Activity: every feed row with its Stripe event id, for reconciliation
//    against the Stripe dashboard - amount blank where no money moved.
// ============================================================================

import type { FinanceEvent, Plan } from '../../types';
import { toCsv } from '../lib/csv';
import { EVENT_PHRASES } from './financeMetrics';

const DAY_MS = 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// Date-range plumbing (the platform's yyyy-mm-dd / UTC-midnight convention).
// ----------------------------------------------------------------------------

/** yyyy-mm-dd -> epoch millis at midnight UTC; undefined for an empty bound. */
export function startOfDayUtc(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** yyyy-mm-dd -> the first millisecond AFTER that day (exclusive upper bound),
 *  so a "to" date includes the whole of its own day. */
export function endOfDayUtcExclusive(value: string): number | undefined {
  const start = startOfDayUtc(value);
  return start === undefined ? undefined : start + DAY_MS;
}

/** Narrow events to [fromMs, toMsExclusive). An undefined bound is open. */
export function eventsInRange(
  events: readonly FinanceEvent[],
  fromMs: number | undefined,
  toMsExclusive: number | undefined,
): FinanceEvent[] {
  return events.filter(
    (event) =>
      (fromMs === undefined || event.at >= fromMs) &&
      (toMsExclusive === undefined || event.at < toMsExclusive),
  );
}

/**
 * The page's default window: the last 12 calendar months, as the yyyy-mm-dd
 * pair the FilterBar holds - from the first day of the month 11 months ago,
 * to today. The clock is injected so tests pin exact strings.
 */
export function defaultFinanceRange(now: number): { from: string; to: string } {
  const today = new Date(now);
  const start = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1),
  );
  return {
    from: start.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

// ----------------------------------------------------------------------------
// Shared cell formatting.
// ----------------------------------------------------------------------------

/** The catalogue name for a planId, falling back to the raw id - honest, never
 *  a guessed display name - and empty for an event with no plan. */
function planLabel(
  planId: string | undefined,
  plans: Record<string, Plan> | null | undefined,
): string {
  if (!planId) {
    return '';
  }
  return plans?.[planId]?.name ?? planId;
}

/** Pounds with exactly two decimal places; refunds negative. QuickBooks reads
 *  the sign as the direction of the money, so a refund MUST carry a minus. */
function signedPounds(event: FinanceEvent): string {
  const pence = event.amountPence as number;
  const pounds = pence / 100;
  return (event.type === 'refund' ? -pounds : pounds).toFixed(2);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** dd/MM/yyyy in UTC - the UK format QuickBooks Online expects on import. */
function ukDateUtc(millis: number): string {
  const date = new Date(millis);
  return `${pad2(date.getUTCDate())}/${pad2(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

// ----------------------------------------------------------------------------
// The two builders.
// ----------------------------------------------------------------------------

/**
 * QuickBooks Online bank-import CSV (3-column UK format). Only money-moving
 * rows appear - payments positive, refunds negative - because the format
 * models a bank statement, and lifecycle events move no money. An event
 * without a numeric amount is skipped rather than invented as zero.
 */
export function quickBooksCsv(
  events: readonly FinanceEvent[],
  plans: Record<string, Plan> | null | undefined,
): string {
  const rows: string[][] = [['Date', 'Description', 'Amount']];
  for (const event of events) {
    if (
      (event.type !== 'payment' && event.type !== 'refund') ||
      typeof event.amountPence !== 'number'
    ) {
      continue;
    }
    const noun = event.type === 'refund' ? 'refund' : 'subscription';
    const plan = planLabel(event.planId, plans);
    const description =
      `Safentia ${noun} - ${event.orgName}` +
      (plan ? ` (${plan})` : '') +
      ` - ${event.stripeEventId}`;
    rows.push([ukDateUtc(event.at), description, signedPounds(event)]);
  }
  return toCsv(rows);
}

/**
 * The universal export: every feed row in the range, one line each, with the
 * Stripe event id for dashboard reconciliation. Amount and currency are blank
 * where no money moved - blank is honest, zero would be a lie.
 */
export function activityCsv(
  events: readonly FinanceEvent[],
  plans: Record<string, Plan> | null | undefined,
): string {
  const rows: string[][] = [
    ['Date (ISO)', 'Type', 'Organisation', 'Plan', 'Amount', 'Currency', 'Stripe event id'],
  ];
  for (const event of events) {
    const hasAmount = typeof event.amountPence === 'number';
    rows.push([
      new Date(event.at).toISOString(),
      EVENT_PHRASES[event.type] ?? event.type,
      event.orgName,
      planLabel(event.planId, plans),
      hasAmount ? signedPounds(event) : '',
      hasAmount ? (event.currency ?? 'gbp').toUpperCase() : '',
      event.stripeEventId,
    ]);
  }
  return toCsv(rows);
}

/** `safentia-{kind}-{env}-{from}-{to}.csv`; an open bound reads as a word so
 *  the filename never carries a bare double hyphen. */
export function exportFilename(
  kind: 'quickbooks' | 'activity',
  env: string,
  from: string,
  to: string,
): string {
  return `safentia-${kind}-${env}-${from || 'start'}-${to || 'now'}.csv`;
}
