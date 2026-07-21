// ============================================================================
// LogBookPanel - a building's Fire Safety Log Book (story 2063), read-only.
// Entries are appended by assessors in the app and by the platform at key
// events (e.g. fraCompleted on release); the console never writes here.
//
// Like the activity trail, the log book grows forever, so the subscription is
// an indexed, bounded query - orderByChild('at') + limitToLast(N) against the
// declared `.indexOn: at` - never the whole subtree, with "Load more" widening
// the window a page at a time.
//
// AC3: "Export CSV" serialises the CURRENTLY FILTERED rows client-side with
// RFC 4180 escaping (fields quoted when needed, embedded quotes doubled) and
// downloads through a Blob object URL. The builders are exported as pure
// functions so the escaping is unit-testable without a DOM download.
// ============================================================================

import { useMemo, useState } from 'react';
import {
  limitToLast,
  orderByChild,
  query,
} from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { downloadCsv, escapeCsvField, toCsv } from '../lib/csv';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import {
  LOG_BOOK_TYPES,
  type LogBookEntry,
  type LogBookType,
  type OrgMember,
} from '../../types';
import { EmptyState, ErrorNotice } from '../ui/Page';
import { actorName } from '../lib/actorName';
import styles from './LogBookPanel.module.css';

/** How many entries each page of the window holds. */
const PAGE_SIZE = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Human labels for every log book entry kind. The Record type makes the map
 *  exhaustive by construction: adding a kind to the union breaks this compile. */
export const LOG_BOOK_TYPE_LABELS: Record<LogBookType, string> = {
  fireIncident: 'Fire incident',
  falseAlarm: 'False alarm',
  fireDoorRecord: 'Fire exit door record',
  serviceConfirmed: 'Service dates confirmed',
  assessorAction: 'Assessor action',
  fraCompleted: 'Fire risk assessment completed',
};

export interface LogBookRow extends LogBookEntry {
  id: string;
}

/** Newest-first log book rows, ordered explicitly by `at` (descending). The
 *  selector runs off the cached raw value, which carries no iteration order, so
 *  ordering is derived from the entries rather than snapshot iteration. */
function selectLogBookRows(value: unknown): LogBookRow[] {
  const node = (value as Record<string, LogBookEntry> | null) ?? {};
  return Object.entries(node)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.at - a.at);
}

/** British date, 24-hour time: "12 Jun 2026, 14:03". */
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** yyyy-mm-dd -> epoch millis at midnight UTC (the platform convention). */
function startOfDayUtc(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Humanise a camelCase payload key: "doorLocation" -> "Door location". */
function humaniseKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Flatten an entry's type-specific payload into displayable label/value pairs.
 * Payload shapes vary by kind and are validated at write time; primitives are
 * shown as-is and anything structured is serialised, so nothing recorded is
 * ever silently dropped. Pure and exported for the CSV path and tests.
 */
export function payloadPairs(
  payload: Record<string, unknown> | undefined,
): [string, string][] {
  if (!payload) {
    return [];
  }
  return Object.entries(payload).map(([key, value]) => {
    let text: string;
    if (value === null || value === undefined) {
      text = '';
    } else if (typeof value === 'boolean') {
      text = value ? 'Yes' : 'No';
    } else if (typeof value === 'string' || typeof value === 'number') {
      text = String(value);
    } else {
      text = JSON.stringify(value);
    }
    return [humaniseKey(key), text];
  });
}

// The escaping contract (RFC 4180 quoting plus the formula-injection guard)
// lives in ../lib/csv, which the CSV import shares. Re-exported here because
// the log book's own tests assert it alongside the builder below.
export { escapeCsvField };

/** The shape the CSV builder needs; names already resolved by the caller. */
export interface LogBookCsvRow {
  at: number;
  type: LogBookType;
  recordedBy: string;
  payload: Record<string, unknown> | undefined;
}

/** Serialise rows (already filtered, newest first) to CSV. Pure, exported for
 *  tests. CRLF line endings per RFC 4180. */
export function buildLogBookCsv(rows: readonly LogBookCsvRow[]): string {
  const header = ['Recorded at', 'Entry type', 'Recorded by', 'Details'];
  const lines = [
    header,
    ...rows.map((row) => [
      dateTimeFormat.format(row.at),
      LOG_BOOK_TYPE_LABELS[row.type] ?? row.type,
      row.recordedBy,
      payloadPairs(row.payload)
        .map(([label, value]) => `${label}: ${value}`)
        .join('; '),
    ]),
  ];
  return toCsv(lines);
}

export function LogBookPanel({ buildingId }: { buildingId: string }) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(orgId && paths);

  const [windowSize, setWindowSize] = useState(PAGE_SIZE);
  const [activeKinds, setActiveKinds] = useState<ReadonlySet<LogBookType>>(
    new Set(),
  );
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Bounded, indexed window over the log book; never the whole subtree.
  const buildWindow = useMemo<RtdbQueryBuilder>(
    () => (node) => query(node, orderByChild('at'), limitToLast(windowSize)),
    [windowSize],
  );
  const logBookQuery = useRtdbQuery<LogBookRow[]>({
    key: keys.logBookWindow(orgId, buildingId, windowSize),
    path: paths ? paths.db.logBook(orgId, buildingId) : '',
    select: selectLogBookRows,
    enabled,
    build: buildWindow,
  });

  // Resolve recorder uids to display names; fall back to the raw uid.
  // database.rules.json grants the /orgMembers read to admin, assessor and
  // auditor ONLY: for a viewer or finance member the listener would be denied
  // and retried forever, so the subscription is gated by role.
  const canReadMembers =
    claims?.roles.admin === true ||
    claims?.roles.assessor === true ||
    claims?.roles.auditor === true;
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: enabled && canReadMembers,
  });
  const members = membersQuery.data;
  const recorderName = (uid: string): string =>
    actorName(members, uid, members !== undefined);

  const rows = logBookQuery.data ?? [];

  const filtered = useMemo(() => {
    const fromMs = startOfDayUtc(fromDate);
    const toEnd = startOfDayUtc(toDate);
    const toMs = toEnd === undefined ? undefined : toEnd + DAY_MS;
    return rows.filter((row) => {
      if (activeKinds.size > 0 && !activeKinds.has(row.type)) {
        return false;
      }
      if (fromMs !== undefined && row.at < fromMs) {
        return false;
      }
      if (toMs !== undefined && row.at >= toMs) {
        return false;
      }
      return true;
    });
  }, [rows, activeKinds, fromDate, toDate]);

  const filtersActive = activeKinds.size > 0 || Boolean(fromDate || toDate);
  const mayHaveOlder = rows.length >= windowSize;

  const toggleKind = (kind: LogBookType) => {
    setActiveKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  };

  const onExport = () => {
    const csv = buildLogBookCsv(
      filtered.map((row) => ({
        at: row.at,
        type: row.type,
        recordedBy: recorderName(row.byUid),
        payload: row.payload,
      })),
    );
    const today = new Date().toISOString().slice(0, 10);
    downloadCsv(csv, `safentia-logbook-${buildingId}-${today}.csv`);
  };

  return (
    <section className={styles.panel} aria-labelledby="log-book-heading">
      <div className={styles.headRow}>
        <h2 id="log-book-heading" className={styles.heading}>
          Fire safety log book
        </h2>
        {rows.length > 0 && (
          <Button
            variant="secondary"
            type="button"
            onClick={onExport}
            disabled={filtered.length === 0}
          >
            Export CSV
          </Button>
        )}
      </div>

      {logBookQuery.isError && (
        <ErrorNotice message="Could not load the log book. Please try again." />
      )}

      {logBookQuery.isLoading && !logBookQuery.isError && (
        <p role="status" className={styles.loading}>
          Loading log book
        </p>
      )}

      {!logBookQuery.isLoading && !logBookQuery.isError && rows.length === 0 && (
        <EmptyState
          title="No log book entries yet"
          body="Entries are recorded by assessors in the app and by the platform at key events."
        />
      )}

      {rows.length > 0 && (
        <>
          <div
            className={styles.chips}
            role="group"
            aria-label="Filter by entry type"
          >
            {LOG_BOOK_TYPES.map((kind) => {
              const active = activeKinds.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  className={[styles.chip, active ? styles.chipActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={active}
                  onClick={() => toggleKind(kind)}
                >
                  {LOG_BOOK_TYPE_LABELS[kind]}
                </button>
              );
            })}
          </div>

          <div className={styles.dateFilters}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`logbook-from-${buildingId}`}>
                From
              </label>
              <input
                id={`logbook-from-${buildingId}`}
                className={styles.dateInput}
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`logbook-to-${buildingId}`}>
                To
              </label>
              <input
                id={`logbook-to-${buildingId}`}
                className={styles.dateInput}
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
              />
            </div>
          </div>

          <p className={styles.windowNote} role="status">
            Showing the most recent {rows.length} entries
            {filtersActive ? `, ${filtered.length} matching the filters` : ''}.
            Filters and the CSV export cover this window only.
          </p>

          {filtered.length === 0 ? (
            <p className={styles.noMatch}>No entries match the current filters.</p>
          ) : (
            <ul className={styles.entries}>
              {filtered.map((row) => {
                const pairs = payloadPairs(row.payload);
                return (
                  <li key={row.id} className={styles.entry}>
                    <div className={styles.entryHead}>
                      <span className={styles.badge}>
                        {LOG_BOOK_TYPE_LABELS[row.type] ?? row.type}
                      </span>
                      <span className={styles.entryTime}>
                        {dateTimeFormat.format(row.at)}
                      </span>
                      <span className={styles.entryBy}>
                        Recorded by {recorderName(row.byUid)}
                      </span>
                    </div>
                    {pairs.length > 0 && (
                      <dl className={styles.payload}>
                        {pairs.map(([label, value]) => (
                          <div key={label} className={styles.payloadRow}>
                            <dt className={styles.payloadLabel}>{label}</dt>
                            <dd className={styles.payloadValue}>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {mayHaveOlder && (
            <div className={styles.loadMore}>
              <Button
                variant="secondary"
                type="button"
                onClick={() => setWindowSize((size) => size + PAGE_SIZE)}
              >
                Load {PAGE_SIZE} more
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
