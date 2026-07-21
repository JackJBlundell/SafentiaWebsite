// ============================================================================
// EmailLogPanel - the email send log (admin-only), strictly read-only. Every
// dispatch attempt is appended server-side to /{env}/emailLog/{orgId} by the
// email seam; the console never writes here. This screen is the operator's
// window onto what actually left the platform, when, and to whom.
//
// Recipients are stored REDACTED at write time (first character of the local
// part plus the full domain, e.g. "j***@example.com"): the log is long-lived,
// so it holds only enough to recognise WHO was written to, not the full PII
// (data minimisation). The panel renders them as-is.
//
// Like the audit trail and the log book, the log grows forever, so the
// subscription is an indexed, bounded query - orderByChild('sentAt') +
// limitToLast(N) against the declared `.indexOn: sentAt` - never the whole
// subtree. database.rules.json grants the read to ADMIN ONLY, so this panel is
// mounted behind an admin gate (ActivityRoutes): a non-admin listener would be
// denied and retried uselessly, so it must never attach.
//
// Presentation: the console kit - a category filter in a Toolbar, the table a
// DataTable inside a flush Card, so this screen reads like the audit trail.
// ============================================================================

import { useMemo, useState } from 'react';
import {
  limitToLast,
  orderByChild,
  query,
} from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type { EmailLogEntry } from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable } from '../ui/DataTable';
import { Toolbar, ToolbarGroup } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import styles from './EmailLogPanel.module.css';

/** The fixed window: the most recent 200 sends. The log is admin-only and read
 *  rarely, so a single bounded page is enough - no "Load more" here. */
const WINDOW_SIZE = 200;

export interface EmailLogRow extends EmailLogEntry {
  id: string;
}

/** Preserve the query's ascending-`sentAt` order via snapshot.forEach (a plain
 *  Object.entries over `.val()` would lose it), then flip to newest-first. */
function selectEmailRows(value: unknown): EmailLogRow[] {
  const node = (value as Record<string, EmailLogEntry> | null) ?? {};
  return Object.entries(node)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.sentAt - a.sentAt);
}

/** British date, 24-hour time: "12 Jun 2026, 14:03". Sits on the row's title
 *  as the exact moment behind the relative phrase. */
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const relativeFormat = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

const TIME_DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
];

/** "2 hours ago" from epoch millis; the exact timestamp goes on the title, so
 *  the feed reads at a glance without losing the precise moment. */
function relativeTime(at: number, now: number): string {
  let duration = (at - now) / 1000;
  for (const division of TIME_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relativeFormat.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return relativeFormat.format(Math.round(duration), 'years');
}

/** The badge presentation for each outcome. The label carries the meaning in
 *  words, never colour alone (a mono/colour-blind reader must not depend on the
 *  token); the class only tints it. An unrecognised outcome falls back to a
 *  neutral badge showing the raw string, so nothing recorded is ever hidden. */
const OUTCOME_BADGE: Record<
  EmailLogEntry['outcome'],
  { label: string; className: string }
> = {
  sent: { label: 'Sent', className: 'outcomeSent' },
  'skipped-no-provider': {
    label: 'Skipped (no provider)',
    className: 'outcomeSkipped',
  },
  failed: { label: 'Failed', className: 'outcomeFailed' },
};

export function EmailLogPanel() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(orgId && paths);

  const [category, setCategory] = useState('');

  // Bounded, indexed window over the send log; never the whole subtree.
  const buildWindow = useMemo<RtdbQueryBuilder>(
    () => (node) => query(node, orderByChild('sentAt'), limitToLast(WINDOW_SIZE)),
    [],
  );
  const emailQuery = useRtdbQuery<EmailLogRow[]>({
    key: keys.emailLog(orgId, WINDOW_SIZE),
    path: paths ? paths.db.emailLog(orgId) : '',
    select: selectEmailRows,
    enabled,
    build: buildWindow,
  });

  const rows = emailQuery.data ?? [];

  // The category filter's options come from the loaded window itself, so it
  // offers exactly (and only) the categories present - never a hard-coded list
  // that could drift from the send catalogue on the server.
  const distinctCategories = useMemo(
    () =>
      Array.from(new Set(rows.map((row) => row.category)))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'en-GB')),
    [rows],
  );

  const filtered = useMemo(
    () => (category ? rows.filter((row) => row.category === category) : rows),
    [rows, category],
  );

  return (
    <div className={styles.root}>
      <PageHeader
        title="Emails"
        lede="Every message the platform has sent, newest first: what it was, when it went, and whether it left. Recipients are stored redacted for privacy."
      />

      {emailQuery.isError && (
        <ErrorNotice message="Could not load the email log. Please try again." />
      )}

      {emailQuery.isLoading && !emailQuery.isError && rows.length === 0 && (
        <Card flush>
          <CardHeader title="Sends" />
          <div className={styles.skeletonWrap}>
            <SkeletonRows rows={6} label="Loading emails" />
          </div>
        </Card>
      )}

      {!emailQuery.isLoading && !emailQuery.isError && rows.length === 0 && (
        <EmptyState
          title="No emails yet"
          body="No emails have been sent yet. Messages appear here as the platform sends them."
        />
      )}

      {rows.length > 0 && (
        <>
          <form
            aria-label="Filter emails"
            onSubmit={(event) => event.preventDefault()}
          >
            <Toolbar>
              <ToolbarGroup>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="email-category">
                    Category
                  </label>
                  <select
                    id="email-category"
                    className={styles.select}
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    <option value="">All categories</option>
                    {distinctCategories.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>
              </ToolbarGroup>
              <ToolbarGroup push>
                <p className={styles.windowNote} role="status">
                  The most recent {rows.length} sends
                  {category ? `, ${filtered.length} in this category` : ''}.
                  Recipients are stored redacted for privacy.
                </p>
              </ToolbarGroup>
            </Toolbar>
          </form>

          <Card flush>
            <CardHeader title="Sends" />
            {filtered.length === 0 ? (
              <p className={styles.noMatch}>No emails match the current filter.</p>
            ) : (
              <DataTable<EmailLogRow>
                label="Email send log"
                columns={[
                  {
                    header: 'Sent',
                    width: '1%',
                    cell: (row) => (
                      <time
                        className={styles.time}
                        dateTime={new Date(row.sentAt).toISOString()}
                        title={dateTimeFormat.format(row.sentAt)}
                      >
                        {relativeTime(row.sentAt, Date.now())}
                      </time>
                    ),
                  },
                  {
                    header: 'Category',
                    cell: (row) => (
                      <span className={styles.category}>{row.category}</span>
                    ),
                  },
                  {
                    header: 'Recipient',
                    // Redacted server-side (e.g. "j***@example.com"); rendered
                    // exactly as stored - the console never holds the full
                    // address.
                    cell: (row) => (
                      <span className={styles.recipient}>{row.to}</span>
                    ),
                  },
                  {
                    header: 'Subject',
                    cell: (row) => (
                      <span className={styles.subject}>{row.subject}</span>
                    ),
                  },
                  {
                    header: 'Outcome',
                    cell: (row) => {
                      const badge = OUTCOME_BADGE[row.outcome];
                      // An outcome outside the known set still shows its raw
                      // value in a neutral badge rather than vanishing.
                      return badge ? (
                        <span
                          className={`${styles.badge} ${styles[badge.className]}`}
                        >
                          {badge.label}
                        </span>
                      ) : (
                        <span className={`${styles.badge} ${styles.outcomeSkipped}`}>
                          {row.outcome}
                        </span>
                      );
                    },
                  },
                ]}
                rows={filtered}
                rowKey={(row) => row.id}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
