// ============================================================================
// GlobalSearch - the org console's jump-to-anything box, shown in the chrome.
//
// Typing searches four org-readable domains at once (customers, sites,
// buildings, jobs) and offers grouped results that link straight to each
// entity's existing console page. It is a NAVIGATION aid, not a report: every
// read it makes is one the console already makes elsewhere.
//
//   - Customers  reuse keys.customers(orgId)      (bounded: an org's own list)
//   - Buildings  reuse keys.buildingsRoot(orgId)  (the SAME shared listener the
//                                                   dashboard and reports hold)
//   - Jobs       reuse keys.jobsWindow(orgId, N)  (a bounded, indexed window -
//                                                   never the whole /jobs node)
//   - Sites      a bounded, CAPPED per-customer fan-out (sites nest under a
//                customer, so there is no single org-wide node; this mirrors the
//                JobsBoard SiteBuildingsResolver precedent). If an org has more
//                customers than the cap, the Sites group is honestly partial and
//                the overlay says so.
//
// Every listener is LAZY: nothing attaches until the box is focused, so the
// chrome adds no reads for the many sessions that never search. The matching
// and grouping live in the pure searchModel beside this file; this component is
// the live shell and the keyboard/a11y contract over it.
//
// A11y: the input is a combobox owning a listbox popup; ArrowUp/Down move a
// highlighted option via aria-activedescendant (focus never leaves the input),
// Enter navigates to it, Escape clears then closes, and an outside click
// dismisses. Cmd/Ctrl+K focuses the box from anywhere (except while another
// text field is being typed into).
// ============================================================================

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { limitToLast, orderByChild, query } from 'firebase/database';
import { useAuth } from '../../auth/AuthProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery, type RtdbQueryBuilder } from '../../query/useRtdbQuery';
import type { Customer, OrgMember, Site } from '../../types';
import {
  flattenBuildings,
  type BuildingsRootNode,
} from '../reports/orgMetrics';
import {
  buildSearchResults,
  type JobRow,
  type SearchResultItem,
  type SiteRow,
  type StaffRow,
} from './searchModel';
import styles from './GlobalSearch.module.css';

/** The debounce before a keystroke becomes a search (brief: ~150ms). */
const DEBOUNCE_MS = 150;

/** The jobs window search reads: bounded and indexed (orderByChild), the same
 *  shape as the JobsBoard's board window, so search never reads all of /jobs. */
const JOBS_WINDOW = 200;

/** The most customers the Sites fan-out will resolve. Beyond this the Sites
 *  group is honestly partial (mirrors JobsBoard's MAX_SITE_LOOKUPS guard). */
const MAX_SITE_CUSTOMER_LOOKUPS = 40;

/** The magnifier, drawn inline (currentColor, aria-hidden - the label carries
 *  the meaning). */
function SearchIcon() {
  return (
    <svg viewBox="0 0 18 18" className={styles.icon} aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5" />
      <path d="M12 12l3 3" />
    </svg>
  );
}

/**
 * A hidden, bounded subscription to ONE customer's sites, reported up to the
 * parent. Rendered only while the box is active, so the fan-out attaches lazily
 * and detaches the moment search closes.
 */
function SiteSource({
  orgId,
  customerId,
  path,
  onLoaded,
}: {
  orgId: string;
  customerId: string;
  path: string;
  onLoaded: (customerId: string, sites: Record<string, Site>) => void;
}) {
  const sites = useRtdbQuery<Record<string, Site> | null>({
    key: keys.sites(orgId, customerId),
    path,
  });
  const data = sites.data;
  useEffect(() => {
    if (data !== undefined) {
      onLoaded(customerId, data ?? {});
    }
  }, [data, customerId, onLoaded]);
  return null;
}

export function GlobalSearch() {
  const { claims, paths } = useAuth();
  const navigate = useNavigate();
  const orgId = claims?.orgId ?? '';
  const ready = Boolean(orgId && paths);

  const inputId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // `active` gates every listener: nothing reads until the box is focused, and
  // closing releases the lot. `query` is what the user sees; `debounced` is what
  // the results derive from.
  const [active, setActive] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [sitesByCustomer, setSitesByCustomer] = useState<
    Record<string, Record<string, Site>>
  >({});

  const close = useCallback(() => {
    setActive(false);
    setQueryText('');
    setDebounced('');
    setActiveIndex(0);
  }, []);

  // Debounce keystrokes into the derived query. Cleared on unmount so a pending
  // timer can never fire into an unmounted tree.
  useEffect(() => {
    debounceRef.current = setTimeout(() => setDebounced(queryText), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [queryText]);

  // The live reads, all lazily enabled with `active`.
  const customersQuery = useRtdbQuery<Record<string, Customer> | null>({
    key: keys.customers(orgId),
    path: paths ? paths.db.customers(orgId) : '',
    enabled: ready && active,
  });

  const buildingsQuery = useRtdbQuery<BuildingsRootNode | null>({
    key: keys.buildingsRoot(orgId),
    path: paths ? paths.db.buildingsRoot(orgId) : '',
    enabled: ready && active,
  });

  const buildJobsWindow = useMemo<RtdbQueryBuilder>(
    () => (node) => query(node, orderByChild('scheduledFor'), limitToLast(JOBS_WINDOW)),
    [],
  );
  const jobsQuery = useRtdbQuery<Record<string, JobRow> | null>({
    key: keys.jobsWindow(orgId, JOBS_WINDOW),
    path: paths ? paths.db.jobs(orgId) : '',
    enabled: ready && active,
    build: buildJobsWindow,
  });

  // The Staff group is oversight material - a colleague's history - so it opens
  // to administrators and auditors ONLY, deliberately tighter than the
  // /orgMembers read rule (which also admits assessors). The subscription is
  // gated by that role AND the staff rows are withheld from the model below -
  // belt and braces, so an assessor/finance/viewer never attaches the members
  // read nor sees a staff result even if the node is cached from another reader.
  // The list is an org's own membership, bounded by nature.
  const canViewStaff =
    claims?.roles.admin === true || claims?.roles.auditor === true;
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: paths ? paths.db.orgMembers(orgId) : '',
    enabled: ready && active && canViewStaff,
  });

  // The Sites fan-out: one bounded read per customer, capped. The cap is a
  // fan-out guard, not a secret; when it bites the overlay says the Sites group
  // is partial rather than silently dropping customers' sites.
  const customerIds = useMemo(
    () => Object.keys(customersQuery.data ?? {}),
    [customersQuery.data],
  );
  const lookedUpCustomerIds = useMemo(
    () => customerIds.slice(0, MAX_SITE_CUSTOMER_LOOKUPS),
    [customerIds],
  );
  const sitesCapped = customerIds.length > MAX_SITE_CUSTOMER_LOOKUPS;
  const onSitesLoaded = useCallback(
    (customerId: string, sites: Record<string, Site>) =>
      setSitesByCustomer((previous) => ({ ...previous, [customerId]: sites })),
    [],
  );

  const buildings = useMemo(
    () => flattenBuildings(buildingsQuery.data),
    [buildingsQuery.data],
  );
  const sites = useMemo<SiteRow[]>(() => {
    const rows: SiteRow[] = [];
    for (const [customerId, perCustomer] of Object.entries(sitesByCustomer)) {
      for (const [siteId, site] of Object.entries(perCustomer)) {
        rows.push({ customerId, siteId, site });
      }
    }
    return rows;
  }, [sitesByCustomer]);
  const jobs = useMemo<JobRow[]>(() => {
    const node = jobsQuery.data ?? {};
    return Object.entries(node).map(([id, job]) => ({ ...job, id }));
  }, [jobsQuery.data]);
  const staff = useMemo<StaffRow[]>(() => {
    // Withheld unless the viewer may see staff, whatever the cache holds.
    if (!canViewStaff) {
      return [];
    }
    return Object.entries(membersQuery.data ?? {}).map(([uid, member]) => ({
      uid,
      member,
    }));
  }, [membersQuery.data, canViewStaff]);

  const results = useMemo(
    () =>
      buildSearchResults(
        { customers: customersQuery.data, buildings, sites, jobs, staff },
        debounced,
      ),
    [customersQuery.data, buildings, sites, jobs, staff, debounced],
  );

  const trimmed = debounced.trim();
  const hasQuery = trimmed.length > 0;
  const flat = results.flat;
  const expanded = active && hasQuery && flat.length > 0;

  // Keep the highlight within the current result set as it changes underneath.
  useEffect(() => {
    setActiveIndex((index) => (flat.length === 0 ? 0 : Math.min(index, flat.length - 1)));
  }, [flat.length]);

  // Outside click dismisses; the listener exists only while active, so a shut
  // box adds no document-level work.
  useEffect(() => {
    if (!active) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [active, close]);

  // Cmd/Ctrl+K focuses the box from anywhere. Registered once. It does not steal
  // the chord from another text field being typed into (only from non-editable
  // focus, or from the search input itself).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) {
        return;
      }
      const el = document.activeElement as HTMLElement | null;
      const editingElsewhere =
        el !== null &&
        el !== inputRef.current &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable);
      if (editingElsewhere) {
        return;
      }
      event.preventDefault();
      setActive(true);
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const go = useCallback(
    (item: SearchResultItem) => {
      close();
      navigate(item.to);
    },
    [close, navigate],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // First Escape clears a query; a second (already empty) closes the box.
      event.preventDefault();
      if (queryText.length > 0) {
        setQueryText('');
        setDebounced('');
      } else {
        close();
      }
      return;
    }
    if (flat.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % flat.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + flat.length) % flat.length);
    } else if (event.key === 'Enter') {
      if (activeIndex >= 0 && activeIndex < flat.length) {
        event.preventDefault();
        go(flat[activeIndex]);
      }
    }
  };

  if (!ready) {
    return null;
  }

  const activeDescendant = expanded ? flat[activeIndex]?.id : undefined;
  const showPanel = active;

  return (
    <div className={styles.root} ref={rootRef} role="search">
      <label className={styles.srOnly} htmlFor={inputId}>
        {canViewStaff
          ? 'Search customers, sites, buildings, jobs and staff'
          : 'Search customers, sites, buildings and jobs'}
      </label>
      <div className={styles.field}>
        <SearchIcon />
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder="Search"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendant}
          value={queryText}
          onFocus={() => setActive(true)}
          onChange={(event) => setQueryText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <kbd className={styles.hint} aria-hidden="true">
          {navigatorIsApple() ? 'Cmd K' : 'Ctrl K'}
        </kbd>
      </div>

      {/* The Sites fan-out lives here so it mounts only while active. */}
      {active &&
        lookedUpCustomerIds.map((customerId) => (
          <SiteSource
            key={customerId}
            orgId={orgId}
            customerId={customerId}
            path={paths ? paths.db.sites(orgId, customerId) : ''}
            onLoaded={onSitesLoaded}
          />
        ))}

      {showPanel && (
        <div className={styles.panel}>
          {!hasQuery && (
            <p className={styles.note} role="note">
              {canViewStaff
                ? 'Start typing to find a customer, site, building, job or staff member.'
                : 'Start typing to find a customer, site, building or job.'}
            </p>
          )}

          {hasQuery && flat.length === 0 && (
            <p className={styles.note} role="status">
              No matches for &ldquo;{trimmed}&rdquo;.
            </p>
          )}

          {hasQuery && flat.length > 0 && (
            <ul id={listId} role="listbox" aria-label="Search results" className={styles.listbox}>
              {results.groups.map((group) => (
                <li key={group.kind} role="presentation" className={styles.group}>
                  <p className={styles.groupHeading} id={`${listId}-${group.kind}`}>
                    {group.heading}
                  </p>
                  <ul role="group" aria-labelledby={`${listId}-${group.kind}`} className={styles.groupList}>
                    {group.items.map((item) => {
                      const highlighted = item.id === activeDescendant;
                      return (
                        <li key={item.id} role="presentation">
                          <Link
                            id={item.id}
                            role="option"
                            aria-selected={highlighted}
                            to={item.to}
                            className={
                              highlighted ? styles.optionActive : styles.option
                            }
                            onClick={() => close()}
                            onMouseEnter={() =>
                              setActiveIndex(flat.findIndex((f) => f.id === item.id))
                            }
                          >
                            <span className={styles.optionLabel}>{item.label}</span>
                            {item.detail && (
                              <span className={styles.optionDetail}>{item.detail}</span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                    {group.moreCount > 0 && (
                      <li role="presentation" className={styles.more}>
                        and {group.moreCount} more
                      </li>
                    )}
                  </ul>
                </li>
              ))}
              {sitesCapped && (
                <li role="presentation" className={styles.coverage}>
                  Sites shown for the first {MAX_SITE_CUSTOMER_LOOKUPS} customers.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Best-effort platform hint for the shortcut key cap; purely presentational
 *  (the shortcut itself accepts either modifier regardless). */
function navigatorIsApple(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
