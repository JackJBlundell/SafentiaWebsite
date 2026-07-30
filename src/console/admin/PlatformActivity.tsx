// ============================================================================
// PlatformActivity (story 2070) - the platform-wide audit trail as one unified,
// filterable table across organisations.
//
// CAPPED, AND SAYS SO: there is no cross-org activity index (the trail is
// tenant-scoped by design), so this screen reads per organisation - the FIRST
// 15 organisations by name, each one's latest 10 entries - and merges them into
// a single newest-first list. The cap is disclosed on screen; an operator
// drills into any org for its full window. Read-only oversight throughout.
//
// Each organisation owns its own subscription (hooks cannot loop; components
// can): a hidden OrgActivitySource per org subscribes to that org's bounded,
// indexed window AND its members list (via the shared orgMembers key, so a
// revisit from the members overview attaches no new listener), resolves actor
// uids to names there, and reports its flattened rows up. The parent holds the
// merged list and every filter, so search, the category/organisation/time
// filters, the single result count and the empty states all reason over the
// whole trail at once rather than per section. Filtering is client-side over
// the already-loaded windows; no filter ever changes a subscription's shape.
// ============================================================================

import { limitToLast, orderByChild, query } from 'firebase/database';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/Button';
import { forEnv } from '../../paths';
import { keys } from '../../query/keys';
import {
  useRtdbQuery,
  type RtdbQueryBuilder,
} from '../../query/useRtdbQuery';
import type {
  ActivityEntry,
  Environment,
  OrgMember,
  Organisation,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { Toolbar, ToolbarGroup } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { actorName as resolveActorName } from '../lib/actorName';
import { humaniseAction, sentenceCase } from '../lib/humaniseActivity';
import { usePlatformEnv } from './platformEnv';
import shared from '../customers/shared.module.css';
import admin from './admin.module.css';
import styles from './PlatformActivity.module.css';

const ORG_CAP = 15;
const PER_ORG_WINDOW = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One merged, org-tagged audit row. `id` is namespaced by org so a stable key
 *  never collides between two orgs' entry ids. `actor` is the resolved display
 *  name, falling back to the placeholder/uid the shared resolver returns. */
interface FlatRow {
  id: string;
  orgId: string;
  orgName: string;
  at: number;
  action: string;
  target: string;
  actor: string;
}

/** The event family an action belongs to: its first dot-separated segment
 *  ("assessment.stage.released" -> "assessment"; "member.updated (roles)" ->
 *  "member"). */
function actionFamily(action: string): string {
  const head = action.split('.')[0] ?? action;
  return head.split(' ')[0] ?? head;
}

/** Families grouped into the human categories an operator thinks in. Derived
 *  from the action prefix rather than hand-maintained per code, so a new action
 *  in an existing family is categorised without a code change here. */
const CATEGORY_BY_FAMILY: Record<string, string> = {
  assessment: 'Assessments',
  report: 'Reports',
  customer: 'Customers',
  customerContact: 'Customers',
  member: 'Members',
  invitation: 'Members',
  site: 'Sites and buildings',
  building: 'Sites and buildings',
  floorPlan: 'Sites and buildings',
  document: 'Sites and buildings',
  action: 'Actions',
  actions: 'Actions',
  job: 'Jobs',
  organisation: 'Organisation',
  orgProfile: 'Organisation',
  orgSettings: 'Organisation',
  template: 'Templates',
};

/** The category an action falls under. An unmapped family stays honest: its
 *  bare name, title-cased, rather than being folded into a wrong bucket. */
function actionCategory(action: string): string {
  const family = actionFamily(action);
  return (
    CATEGORY_BY_FAMILY[family] ??
    family.charAt(0).toUpperCase() + family.slice(1)
  );
}

/** The time-window filter vocabulary. `ms` absent means "all time". */
const TIME_RANGES: ReadonlyArray<{ value: string; label: string; ms?: number }> = [
  { value: 'all', label: 'All time' },
  { value: '24h', label: 'Last 24 hours', ms: DAY_MS },
  { value: '7d', label: 'Last 7 days', ms: 7 * DAY_MS },
  { value: '30d', label: 'Last 30 days', ms: 30 * DAY_MS },
];

/** British date, 24-hour time: "12 Jun 2026, 14:03". */
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** The key one reported window is stored under: per ENVIRONMENT and org, so a
 *  window is only ever read back under the environment it was read from. */
function sourceKey(env: Environment, orgId: string): string {
  return `${env}/${orgId}`;
}

/** One org's bounded window plus its members, reported up as flat rows. Renders
 *  nothing: it exists only to own this org's subscriptions. */
function OrgActivitySource({
  env,
  orgId,
  name,
  onData,
}: {
  env: Environment;
  orgId: string;
  name: string;
  /** Reports this org's settled rows to the parent under its env-scoped key.
   *  Called only when the content changes, so the parent can store it without a
   *  render loop. */
  onData: (sourceId: string, rows: FlatRow[]) => void;
}) {
  const paths = forEnv(env);
  const buildWindow = useMemo<RtdbQueryBuilder>(
    () => (node) => query(node, orderByChild('at'), limitToLast(PER_ORG_WINDOW)),
    [],
  );
  const activity = useRtdbQuery<Array<{ id: string; entry: ActivityEntry }>>({
    key: ['platformActivity', env, orgId, PER_ORG_WINDOW],
    path: paths.db.activity(orgId),
    build: buildWindow,
    select: (value) =>
      Object.entries((value as Record<string, ActivityEntry> | null) ?? {})
        .map(([id, entry]) => ({ id, entry }))
        .sort((a, b) => b.entry.at - a.entry.at),
  });

  // The staff directory, for resolving actor uids to display names. Bounded by
  // nature (one org's members) and keyed identically to the members overview,
  // so the cache is shared and no per-row read is introduced.
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths.db.orgMembers(orgId),
  });
  const members = membersQuery.data;
  const membersLoaded = members !== undefined;

  const rows = useMemo<FlatRow[]>(
    () =>
      (activity.data ?? []).map(({ id, entry }) => ({
        id: `${orgId}/${id}`,
        orgId,
        orgName: name,
        at: entry.at,
        action: entry.action,
        target: entry.target,
        actor: resolveActorName(members ?? null, entry.actorUid, membersLoaded),
      })),
    [activity.data, orgId, name, members, membersLoaded],
  );

  // The activity read erroring should not blank the whole screen: this org just
  // contributes nothing, so it settles as an empty window.
  const settled = !activity.isLoading;
  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (!settled) {
      return;
    }
    // A cheap content signature (org name plus each row's id, time and resolved
    // actor) guards the report: the RTDB selector mints a fresh array on every
    // render, so reporting unconditionally would loop the parent's state.
    // The environment is part of the signature as well as the key: two
    // environments can hold windows that are identical row for row (both empty,
    // most often), and without it a switch between them would look like "no
    // change" and never be reported.
    const signature = `${env}::${name}::${rows
      .map((row) => `${row.id}~${row.at}~${row.actor}`)
      .join('|')}`;
    if (signature === lastSignature.current) {
      return;
    }
    lastSignature.current = signature;
    onData(sourceKey(env, orgId), rows);
  }, [settled, rows, env, name, orgId, onData]);

  return null;
}

export function PlatformActivity() {
  // The environment is the platform-wide choice from the rail toggle.
  const { env } = usePlatformEnv();
  const paths = forEnv(env);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [orgFilter, setOrgFilter] = useState('all');
  const [timeRange, setTimeRange] = useState('all');

  // Rows reported by each org's source, keyed by ENVIRONMENT and org so a
  // re-report replaces that org's window without disturbing the others.
  //
  // Namespaced rather than cleared, deliberately. This map used to be wiped by an
  // effect on [env] - which also fires on MOUNT, and a child's effect runs BEFORE
  // its parent's, so the clear landed on top of the windows the children had just
  // reported. Their content-signature guard then refused to report the same
  // window a second time, leaving settledCount at 0 and the screen on "Loading
  // activity" for good. Not a theoretical ordering: the query cache holds data
  // for the session (staleTime Infinity), so every REVISIT paints synchronously
  // and every child settles inside the first commit - Activity worked once per
  // session and never again until a full reload. Keying by environment means
  // nothing has to be cleared: the other environment's entries are simply never
  // looked up, which also rules out the flash of live rows under a test heading
  // that the per-org key allowed while a child was re-reporting.
  const [sources, setSources] = useState<Record<string, FlatRow[]>>({});
  const onData = useCallback((sourceId: string, rows: FlatRow[]) => {
    setSources((previous) => ({ ...previous, [sourceId]: rows }));
  }, []);

  const orgsQuery = useRtdbQuery<Record<string, Organisation> | null>({
    key: ['platformOrgs', env],
    path: paths.db.organisationsRoot(),
  });

  const orgs = useMemo(
    () =>
      Object.entries(orgsQuery.data ?? {})
        .map(([orgId, org]) => ({ orgId, name: org?.profile?.name ?? orgId }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en-GB')),
    [orgsQuery.data],
  );
  const shown = useMemo(() => orgs.slice(0, ORG_CAP), [orgs]);

  // The merged, newest-first trail, restricted to the orgs currently shown so a
  // stale window (an org that dropped out of the cap) never leaks in.
  const allRows = useMemo(() => {
    const merged: FlatRow[] = [];
    // Driven by the orgs currently SHOWN, so a window belonging to the other
    // environment - or to an org that has dropped out of the cap - cannot leak in.
    for (const org of shown) {
      merged.push(...(sources[sourceKey(env, org.orgId)] ?? []));
    }
    return merged.sort((a, b) => b.at - a.at);
  }, [sources, shown, env]);

  // The filter option lists come from the loaded rows themselves, so each offers
  // exactly (and only) the values present - never an empty category or org.
  const categoryOptions = useMemo(
    () =>
      Array.from(new Set(allRows.map((row) => actionCategory(row.action)))).sort(
        (a, b) => a.localeCompare(b, 'en-GB'),
      ),
    [allRows],
  );
  const orgOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of allRows) {
      byId.set(row.orgId, row.orgName);
    }
    return Array.from(byId, ([orgId, name]) => ({ orgId, name })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en-GB'),
    );
  }, [allRows]);

  // Computed once per mount: a live trail wants "last 24 hours" measured from
  // arrival, not re-evaluated on every keystroke.
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rangeMs = TIME_RANGES.find((range) => range.value === timeRange)?.ms;
    const since = rangeMs === undefined ? undefined : now - rangeMs;
    return allRows.filter((row) => {
      if (category !== 'all' && actionCategory(row.action) !== category) {
        return false;
      }
      if (orgFilter !== 'all' && row.orgId !== orgFilter) {
        return false;
      }
      if (since !== undefined && row.at < since) {
        return false;
      }
      if (needle) {
        const { phrase, detail } = humaniseAction(row.action);
        const haystack = [phrase, detail, row.actor, row.target, row.orgName]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) {
          return false;
        }
      }
      return true;
    });
  }, [allRows, search, category, orgFilter, timeRange, now]);

  const filtersActive =
    search.trim() !== '' ||
    category !== 'all' ||
    orgFilter !== 'all' ||
    timeRange !== 'all';
  const clearFilters = () => {
    setSearch('');
    setCategory('all');
    setOrgFilter('all');
    setTimeRange('all');
  };

  // A window still attaching for one of the shown orgs means the merged list is
  // incomplete; only then is a "no activity" verdict premature.
  const settledCount = shown.filter(
    (org) => sources[sourceKey(env, org.orgId)],
  ).length;
  const stillLoading =
    orgsQuery.isLoading || (shown.length > 0 && settledCount < shown.length);

  const columns: Array<Column<FlatRow>> = [
    {
      header: 'When',
      width: '1%',
      cell: (row) => (
        <time
          className={styles.time}
          dateTime={new Date(row.at).toISOString()}
          title={new Date(row.at).toLocaleString('en-GB')}
        >
          {dateTimeFormat.format(row.at)}
        </time>
      ),
    },
    {
      header: 'Organisation',
      cell: (row) => (
        <Link to={`/app/admin/${row.orgId}`} className={styles.orgLink}>
          {row.orgName}
        </Link>
      ),
    },
    {
      header: 'Who',
      cell: (row) => <span className={styles.actor}>{row.actor}</span>,
    },
    {
      header: 'Action',
      // Humanised phrase for people; the raw audit code stays reachable on the
      // title so a compliance reader loses nothing.
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
      // The target is a bare id in another org's tree; the drill-down is the
      // Organisation link beside it, so this stays honest text rather than a
      // cross-org link that would point at the wrong tenant.
      desktopOnly: true,
      cell: (row) => <span className={styles.target}>{row.target}</span>,
    },
  ];

  return (
    <div className={admin.stack}>
      <PageHeader
        title="Platform activity"
        crumbs={[{ label: 'Platform', to: '/app/admin' }, { label: 'Activity' }]}
        lede={`The latest ${PER_ORG_WINDOW} audit entries per organisation (${env} environment), newest first. Read-only oversight.`}
      />

      {orgsQuery.isError && (
        <ErrorNotice message="Could not load the organisations. Please try again." />
      )}

      {/* The subscriptions live here regardless of the body's state below. */}
      {shown.map((org) => (
        <OrgActivitySource
          key={org.orgId}
          env={env}
          orgId={org.orgId}
          name={org.name}
          onData={onData}
        />
      ))}

      {orgs.length > ORG_CAP && (
        <p className={admin.footnote}>
          Showing the first {ORG_CAP} of {orgs.length} organisations by name;
          open an organisation for its full activity window.
        </p>
      )}

      {stillLoading && allRows.length === 0 ? (
        <p role="status" className={admin.emptyNote}>
          Loading activity
        </p>
      ) : !orgsQuery.isLoading && shown.length === 0 && !orgsQuery.isError ? (
        <p className={admin.emptyNote}>
          No organisations exist in the {env} environment yet.
        </p>
      ) : allRows.length === 0 ? (
        <EmptyState
          title="No activity yet"
          body="Actions across these organisations are recorded here automatically as their teams work."
        />
      ) : (
        <>
          <form
            aria-label="Filter activity"
            onSubmit={(event) => event.preventDefault()}
          >
            <Toolbar>
              <ToolbarGroup>
                <div className={`${styles.field} ${styles.searchField}`}>
                  <label className={shared.label} htmlFor="activity-search">
                    Search
                  </label>
                  <input
                    id="activity-search"
                    className={shared.input}
                    type="search"
                    autoComplete="off"
                    placeholder="Action, person, organisation or target"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className={styles.field}>
                  <label className={shared.label} htmlFor="activity-category">
                    Event type
                  </label>
                  <select
                    id="activity-category"
                    className={shared.select}
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    <option value="all">All types</option>
                    {categoryOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                {orgOptions.length > 1 && (
                  <div className={styles.field}>
                    <label className={shared.label} htmlFor="activity-org">
                      Organisation
                    </label>
                    <select
                      id="activity-org"
                      className={shared.select}
                      value={orgFilter}
                      onChange={(event) => setOrgFilter(event.target.value)}
                    >
                      <option value="all">All organisations</option>
                      {orgOptions.map((option) => (
                        <option key={option.orgId} value={option.orgId}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div className={styles.field}>
                  <label className={shared.label} htmlFor="activity-time">
                    Time
                  </label>
                  <select
                    id="activity-time"
                    className={shared.select}
                    value={timeRange}
                    onChange={(event) => setTimeRange(event.target.value)}
                  >
                    {TIME_RANGES.map((range) => (
                      <option key={range.value} value={range.value}>
                        {range.label}
                      </option>
                    ))}
                  </select>
                </div>
              </ToolbarGroup>
              <ToolbarGroup push>
                <div className={styles.summary}>
                  <p className={admin.resultCount} role="status">
                    Showing {filtered.length} of {allRows.length} loaded
                    {allRows.length === 1 ? ' event' : ' events'}
                    {filtersActive ? ' matching the filters' : ''}. Filters search
                    the loaded windows only.
                  </p>
                  {filtersActive && (
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={clearFilters}
                    >
                      Clear filters
                    </Button>
                  )}
                </div>
              </ToolbarGroup>
            </Toolbar>
          </form>

          {filtered.length === 0 ? (
            <div className={admin.noMatch}>
              <p className={admin.emptyNote}>
                No events match your search and filters.
              </p>
              <Button variant="secondary" type="button" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          ) : (
            <Card flush>
              <CardHeader title="Events" />
              <DataTable<FlatRow>
                label="Platform activity"
                columns={columns}
                rows={filtered}
                rowKey={(row) => row.id}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
