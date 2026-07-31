// ============================================================================
// ActivityPage - the organisation's audit trail (story 2062), strictly
// read-only. Every consequential action across the platform is appended to
// /activity/{orgId} by the Functions (clients cannot write it: `.write: false`
// in the rules), and this screen is the compliance window onto that trail.
//
// The log grows forever, so the subscription is NEVER the whole subtree: it is
// an indexed, bounded query - orderByChild('at') + limitToLast(N) against the
// declared `.indexOn: at` - and "Load more" widens N by a page at a time. The
// UI states the window honestly ("Showing the most recent N events") because
// the filters below search only what has been loaded, not all history.
//
// Actor uids are resolved to display names via a second subscription to
// /orgMembers/{orgId} (a bounded staff list), falling back to the raw uid for
// an actor who has left or was never a member (e.g. a system principal).
//
// Presentation: the console kit - filters in a Toolbar, the table a DataTable
// inside a flush Card, so this screen reads exactly like the staff directory.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import {
  limitToLast,
  orderByChild,
  query,
} from 'firebase/database';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type {
  ActivityEntry,
  Customer,
  CustomerMember,
  OrgMember,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable } from '../ui/DataTable';
import { activeFilters, FilterBar, type FilterField } from '../ui/FilterBar';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { actorName as resolveActorName } from '../lib/actorName';
import {
  activityTargetUrl,
  humaniseAction,
  sentenceCase,
} from '../lib/humaniseActivity';
import {
  flattenBuildings,
  type BuildingsRootNode,
} from '../reports/orgMetrics';
import styles from './ActivityPage.module.css';

/** How many events each page of the window holds. */
const PAGE_SIZE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActivityRow extends ActivityEntry {
  id: string;
}

/** Newest-first activity rows, ordered explicitly by `at` (descending). The
 *  selector runs off the cached raw value, which carries no iteration order, so
 *  the order is derived from the entries rather than snapshot iteration. */
function selectActivityRows(value: unknown): ActivityRow[] {
  const node = (value as Record<string, ActivityEntry> | null) ?? {};
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

/** A date-range bound as it reads on its filter chip: "12 Jun 2026". Pinned to
 *  UTC because the bounds themselves are UTC midnights (the platform's
 *  date-only convention); formatting them locally would show the day before for
 *  anyone west of Greenwich. */
const dateOnlyFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** yyyy-mm-dd -> epoch millis at midnight UTC (the platform convention). */
function startOfDayUtc(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** yyyy-mm-dd -> the first millisecond AFTER that day (exclusive upper bound),
 *  so a "to" date includes the whole of its own day. */
function endOfDayUtcExclusive(value: string): number | undefined {
  const start = startOfDayUtc(value);
  return start === undefined ? undefined : start + DAY_MS;
}

export function ActivityPage() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(orgId && paths);

  const [windowSize, setWindowSize] = useState(PAGE_SIZE);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Bounded, indexed window over the audit trail; never the whole subtree.
  const buildWindow = useMemo<RtdbQueryBuilder>(
    () => (node) => query(node, orderByChild('at'), limitToLast(windowSize)),
    [windowSize],
  );
  const activityQuery = useRtdbQuery<ActivityRow[]>({
    key: keys.activity(orgId, windowSize),
    path: paths ? paths.db.activity(orgId) : '',
    select: selectActivityRows,
    enabled,
    build: buildWindow,
  });

  // The staff directory, for resolving actor uids to display names. Bounded by
  // nature (an organisation's member list), so no query constraint is needed.
  // database.rules.json grants the /orgMembers read to admin, assessor and
  // auditor ONLY: for a viewer or finance member the listener would be denied
  // and retried forever, so the subscription is gated by role and the Who
  // column falls back to the raw uid.
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

  // The organisation's CUSTOMER-portal accounts, so a portal person in the trail
  // is named rather than mislabelled a former staff member. A customer accepting
  // a report is the trail entry most likely to be relied on later - it is the
  // duty-holder's sign-off - so getting the actor right matters more here than
  // the one extra subscription costs. The node is {customerId: {uid: member}};
  // the trail only knows uids, so it is flattened to one uid -> name map.
  const portalMembersQuery = useRtdbQuery<
    Record<string, Record<string, CustomerMember>> | null
  >({
    key: keys.customerMembersByOrg(orgId),
    path: paths ? paths.db.customerMembersByOrg(orgId) : '',
    enabled: enabled && canReadMembers,
  });
  const portalMembers = useMemo<Record<string, { name: string }>>(() => {
    const flat: Record<string, { name: string }> = {};
    for (const byUid of Object.values(portalMembersQuery.data ?? {})) {
      for (const [uid, member] of Object.entries(byUid ?? {})) {
        if (member?.name) {
          flat[uid] = { name: member.name };
        }
      }
    }
    return flat;
  }, [portalMembersQuery.data]);

  const actorName = (uid: string): string =>
    resolveActorName(members, uid, members !== undefined, portalMembers);

  // The customer and building directories, for the scope filters. Both nodes
  // are org-readable by every role (the customer directory and the dashboard
  // already make these exact reads, so the cache keys are shared and no new
  // listener is attached when both pages have been visited).
  const customersNode = useRtdbQuery<Record<string, Customer> | null>({
    key: keys.customers(orgId),
    path: paths ? paths.db.customers(orgId) : '',
    enabled,
  });
  const buildingsNode = useRtdbQuery<BuildingsRootNode | null>({
    key: keys.buildingsRoot(orgId),
    path: paths ? paths.db.buildingsRoot(orgId) : '',
    enabled,
  });

  // Audit targets are bare ids (a customerId, a buildingId, an assessmentId),
  // so "scope to this customer" means: events targeting the customer itself,
  // OR any of its buildings. Deeper targets (assessments, actions) do not
  // carry their ancestry in the entry, so they honestly fall outside the
  // scope filters rather than being guessed at.
  const buildingRows = useMemo(
    () =>
      buildingsNode.data === undefined || buildingsNode.data === null
        ? []
        : flattenBuildings(buildingsNode.data),
    [buildingsNode.data],
  );
  const customerOptions = useMemo(
    () =>
      Object.entries(customersNode.data ?? {})
        .map(([id, customer]) => ({ id, name: customer.name ?? id }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en-GB')),
    [customersNode.data],
  );
  // Building options narrow to the chosen customer's estate when one is set.
  const buildingOptions = useMemo(
    () =>
      buildingRows
        .filter(
          (row) => !customerId || row.building.customerId === customerId,
        )
        .map((row) => ({ id: row.buildingId, name: row.building.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en-GB')),
    [buildingRows, customerId],
  );
  const customerBuildingIds = useMemo(() => {
    if (!customerId) {
      return null;
    }
    return new Set(
      buildingRows
        .filter((row) => row.building.customerId === customerId)
        .map((row) => row.buildingId),
    );
  }, [buildingRows, customerId]);

  // keepPreviousData, locally: "Load more" widens the window, which mints a
  // new key and re-subscribes, so the query's data is briefly undefined. The
  // last non-empty window stays rendered as a placeholder meanwhile - the
  // table must not blank while the wider listener attaches.
  const [previousRows, setPreviousRows] = useState<ActivityRow[]>([]);
  const liveRows = activityQuery.data;
  useEffect(() => {
    if (liveRows && liveRows.length > 0) {
      setPreviousRows(liveRows);
    }
  }, [liveRows]);
  const rows = liveRows ?? previousRows;

  // The action-kind filter's options come from the loaded window itself, so it
  // always offers exactly (and only) the actions that are present.
  const distinctActions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.action))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const fromMs = startOfDayUtc(fromDate);
    const toMs = endOfDayUtcExclusive(toDate);
    return rows.filter((row) => {
      if (action && row.action !== action) {
        return false;
      }
      if (
        customerId &&
        row.target !== customerId &&
        !customerBuildingIds?.has(row.target)
      ) {
        return false;
      }
      if (buildingId && row.target !== buildingId) {
        return false;
      }
      if (
        needle &&
        !row.action.toLowerCase().includes(needle) &&
        !humaniseAction(row.action).phrase.includes(needle) &&
        !row.target.toLowerCase().includes(needle)
      ) {
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
  }, [
    rows,
    search,
    action,
    customerId,
    buildingId,
    customerBuildingIds,
    fromDate,
    toDate,
  ]);

  // The trail's filters, declared once. FilterBar renders them, derives the
  // chips and clears them; this page keeps only the state and the predicate.
  const filterFields: FilterField[] = [
    {
      kind: 'search',
      id: 'activity-search',
      label: 'Search',
      placeholder: 'Action or target',
      value: search,
      onChange: setSearch,
    },
    {
      kind: 'select',
      id: 'activity-action',
      label: 'Action',
      allLabel: 'All actions',
      value: action,
      onChange: setAction,
      // Options come from the loaded window itself, so the filter offers
      // exactly - and only - the actions actually present in it.
      options: distinctActions.map((value) => ({
        value,
        label: sentenceCase(humaniseAction(value).phrase),
      })),
    },
    {
      kind: 'select',
      id: 'activity-customer',
      label: 'Customer',
      allLabel: 'All customers',
      value: customerId,
      // A building belongs to one customer, so changing (or clearing, from the
      // chip) the scope resets the narrower filter rather than stranding it.
      onChange: (value) => {
        setCustomerId(value);
        setBuildingId('');
      },
      options: customerOptions.map((option) => ({
        value: option.id,
        label: option.name,
      })),
    },
    {
      kind: 'select',
      id: 'activity-building',
      label: 'Building',
      allLabel: customerId ? "All of this customer's buildings" : 'All buildings',
      value: buildingId,
      onChange: setBuildingId,
      options: buildingOptions.map((option) => ({
        value: option.id,
        label: option.name,
      })),
    },
    {
      kind: 'dateRange',
      id: 'activity-date',
      label: 'Date',
      from: fromDate,
      to: toDate,
      onChangeFrom: setFromDate,
      onChangeTo: setToDate,
      formatValue: (value) => {
        const ms = startOfDayUtc(value);
        return ms === undefined ? value : dateOnlyFormat.format(ms);
      },
    },
  ];
  const filtersActive = activeFilters(filterFields).length > 0;
  // A full window means older events may exist beyond it; a short one means the
  // whole history is already loaded and "Load more" would be a lie.
  const mayHaveOlder = rows.length >= windowSize;

  return (
    <div className={styles.root}>
      <PageHeader
        title="Activity"
        lede="The organisation's audit trail: every recorded action, newest first. Entries are written by the platform and cannot be edited."
      />

      {activityQuery.isError && (
        <ErrorNotice message="Could not load the activity log. Please try again." />
      )}

      {activityQuery.isLoading && !activityQuery.isError && rows.length === 0 && (
        <p role="status" className={styles.loading}>
          Loading activity
        </p>
      )}

      {!activityQuery.isLoading && !activityQuery.isError && rows.length === 0 && (
        <EmptyState
          title="No activity yet"
          body="Actions across the organisation are recorded here automatically as your team works."
        />
      )}

      {rows.length > 0 && (
        <>
          <FilterBar
            label="Filter activity"
            className={styles.filterBar}
            fields={filterFields}
            note={
              <>
                Showing the most recent {rows.length} events
                {filtersActive ? `, ${filtered.length} matching the filters` : ''}.
                Filters search this window only.
              </>
            }
          />

          <Card flush>
            <CardHeader title="Events" />
            {filtered.length === 0 ? (
              <p className={styles.noMatch}>
                No events match the current filters.
              </p>
            ) : (
              <DataTable<ActivityRow>
                label="Activity log"
                columns={[
                  {
                    header: 'When',
                    width: '1%',
                    cell: (row) => (
                      <time
                        className={styles.time}
                        dateTime={new Date(row.at).toISOString()}
                      >
                        {dateTimeFormat.format(row.at)}
                      </time>
                    ),
                  },
                  {
                    header: 'Who',
                    cell: (row) => (
                      <span className={styles.actor}>
                        {actorName(row.actorUid)}
                      </span>
                    ),
                  },
                  {
                    header: 'Action',
                    // Humanised phrase for people; the raw audit code stays
                    // reachable on the title so nothing is hidden from a
                    // compliance reader.
                    cell: (row) => {
                      const { phrase, detail } = humaniseAction(row.action);
                      return (
                        <span className={styles.action} title={row.action}>
                          {sentenceCase(phrase)}
                          {detail ? ` (${detail})` : ''}
                        </span>
                      );
                    },
                  },
                  {
                    header: 'Target',
                    // Customer and job targets resolve to real console
                    // routes; everything else (assessments have no console
                    // view yet, buildings need ancestor ids the entry does
                    // not carry) stays text rather than a dead link.
                    cell: (row) => {
                      const targetUrl = activityTargetUrl(
                        row.action,
                        row.target,
                      );
                      return targetUrl ? (
                        <Link to={targetUrl} className={styles.targetLink}>
                          {row.target}
                        </Link>
                      ) : (
                        <span className={styles.target}>{row.target}</span>
                      );
                    },
                  },
                ]}
                rows={filtered}
                rowKey={(row) => row.id}
              />
            )}
          </Card>

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
    </div>
  );
}
