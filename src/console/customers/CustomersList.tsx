// ============================================================================
// CustomersList - the live directory of the organisations this org serves.
//
// Live from /customers/{orgId}; client-side search over name, address and
// switchboard details; archived customers hidden behind an explicit toggle so
// the working list stays short without ever losing history. Admins get the
// add action; everyone else browses. Desktop-first: a real DataTable in a
// flush Card, with search, the archive toggle and the add action on one
// Toolbar row.
//
// At-a-glance risk: the same two org-root reads the dashboard makes (shared
// query keys, so navigating here from a dashboard tile costs no new listener)
// feed a per-customer RagSummary strip and an overdue-actions badge on every
// row. The dashboard's tiles drill through with ?risk=<level> / ?overdue=1,
// which filter to the customers holding that problem and sort worst-first,
// behind a dismissible chip; no param means the plain directory, unchanged.
// ============================================================================

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Customer,
  ManageCustomerInput,
  ManageCustomerResult,
  RiskLevel,
} from '../../types';
import { Card } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { Toolbar, ToolbarGroup } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import {
  countBuildingsByRisk,
  countOverdueActions,
  flattenBuildings,
  type ActionsRootNode,
  type BuildingRow,
  type BuildingsRootNode,
  type OverdueCounts,
} from '../reports/orgMetrics';
import { OverdueBadge, RagSummary } from './RagSummary';
import {
  LoadingNote,
  sortByName,
  StatusBadge,
  toEntries,
  urls,
  useOrgScope,
} from './shared';
import shared from './shared.module.css';
import styles from './CustomersList.module.css';

type CustomerRow = { id: string; customer: Customer };

/** One customer's roll-up across the estate: buildings by stored risk level,
 *  plus its overdue action counts. */
interface CustomerRollup {
  counts: Record<RiskLevel, number>;
  overdue: OverdueCounts;
}

/** The honest zero for a customer with no buildings yet: RagSummary renders
 *  its "No buildings" wording, the badge its quiet 0. */
const EMPTY_ROLLUP: CustomerRollup = {
  counts: { high: 0, medium: 0, low: 0, pending: 0 },
  overdue: { overdue: 0, lifeProtectionOverdue: 0 },
};

/** The ?risk= vocabulary; anything else is ignored, never guessed at. */
function parseRiskParam(value: string | null): RiskLevel | null {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'pending'
    ? value
    : null;
}

/** Filter-chip wording per drill-through. */
const RISK_FILTER_LABELS: Record<RiskLevel, string> = {
  high: 'Showing customers with high-risk buildings',
  medium: 'Showing customers with medium-risk buildings',
  low: 'Showing customers with low-risk buildings',
  pending: 'Showing customers with buildings not yet assessed',
};
const OVERDUE_FILTER_LABEL = 'Showing customers with overdue actions';

function buildColumns(
  isAdmin: boolean,
  rollups: Map<string, CustomerRollup> | undefined,
): Array<Column<CustomerRow>> {
  // While the org-root reads attach, the risk cells stay quietly blank (a
  // placeholder, never an invented zero); once loaded, a customer missing
  // from the map is a REAL zero-buildings customer.
  const rollupFor = (id: string): CustomerRollup | undefined =>
    rollups === undefined ? undefined : (rollups.get(id) ?? EMPTY_ROLLUP);
  return [
    {
      header: 'Organisation',
      cell: (row) => (
        <span className={styles.orgCell}>
          <span className={styles.cellName}>{row.customer.name}</span>
          {row.customer.address && (
            <span className={styles.cellMeta}>{row.customer.address}</span>
          )}
        </span>
      ),
    },
    {
      header: 'Switchboard',
      desktopOnly: true,
      cell: (row) => (
        <span className={styles.orgCell}>
          {row.customer.email && <span>{row.customer.email}</span>}
          {row.customer.phone && (
            <span className={styles.cellMeta}>{row.customer.phone}</span>
          )}
        </span>
      ),
    },
    {
      header: 'Buildings',
      cell: (row) => {
        const rollup = rollupFor(row.id);
        return rollup ? <RagSummary counts={rollup.counts} /> : null;
      },
    },
    {
      header: 'Overdue',
      desktopOnly: true,
      cell: (row) => {
        const rollup = rollupFor(row.id);
        return rollup ? <OverdueBadge counts={rollup.overdue} /> : null;
      },
    },
    {
      header: 'Status',
      cell: (row) => <StatusBadge status={row.customer.status} />,
    },
    {
      header: '',
      desktopOnly: true,
      align: 'end',
      width: '1%',
      // Archived rows carry the restore action for admins (DataTable keeps
      // interactive cell content above the stretched row link); everything
      // else keeps the plain navigation hint.
      cell: (row) =>
        isAdmin && row.customer.status === 'archived' ? (
          <RestoreRowAction customerId={row.id} name={row.customer.name} />
        ) : (
          <span className={styles.chevron} aria-hidden="true">
            &rsaquo;
          </span>
        ),
    },
  ];
}

// The archived row's inline restore: a two-step confirm on the button itself
// (first click arms it, the second calls the Function), so a stray click on a
// dense list never flips a customer's state.
function RestoreRowAction({ customerId, name }: { customerId: string; name: string }) {
  const manageCustomer = useCallable<ManageCustomerInput, ManageCustomerResult>(
    'manageCustomer',
  );
  const [confirming, setConfirming] = useState(false);

  const onClick = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const result = await manageCustomer.call({ action: 'restore', customerId });
    if (result) {
      setConfirming(false);
    }
  };

  return (
    <span className={styles.rowAction}>
      {manageCustomer.error && (
        <span role="alert" className={styles.rowActionError}>
          {manageCustomer.error}
        </span>
      )}
      <Button
        variant="secondary"
        disabled={manageCustomer.pending}
        aria-label={confirming ? `Confirm restore of ${name}` : `Restore ${name}`}
        onClick={() => void onClick()}
      >
        {manageCustomer.pending
          ? 'Restoring'
          : confirming
            ? 'Confirm restore'
            : 'Restore'}
      </Button>
    </span>
  );
}

export function CustomersList() {
  const { ready, orgId, db, isAdmin } = useOrgScope();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const customers = useRtdbQuery<Record<string, Customer> | null>({
    key: keys.customers(orgId),
    path: ready ? db!.customers(orgId) : '',
    enabled: ready,
  });

  // The dashboard's two org-root roll-up reads, byte-for-byte the same query
  // keys, so arriving from a ConsoleHome tile attaches NO new listener - the
  // shared cache serves both pages. These two reads are the ceiling: every
  // per-row figure below is derived from them, no per-row fan-out.
  const buildingsNode = useRtdbQuery<BuildingsRootNode | null>({
    key: keys.buildingsRoot(orgId),
    path: ready ? db!.buildingsRoot(orgId) : '',
    enabled: ready,
  });
  const actionsNode = useRtdbQuery<ActionsRootNode | null>({
    key: keys.actionsRoot(orgId),
    path: ready ? db!.actionsRoot(orgId) : '',
    enabled: ready,
  });

  // Group the estate by customer: buildings directly (Building carries its
  // customerId), actions via their building's nesting key. `undefined` while
  // either read is still attaching, so cells show a placeholder, not a lie.
  const rollups = useMemo(() => {
    if (buildingsNode.data === undefined || actionsNode.data === undefined) {
      return undefined;
    }
    const byCustomer = new Map<string, BuildingRow[]>();
    const customerByBuilding = new Map<string, string>();
    for (const row of flattenBuildings(buildingsNode.data)) {
      const list = byCustomer.get(row.building.customerId);
      if (list) {
        list.push(row);
      } else {
        byCustomer.set(row.building.customerId, [row]);
      }
      customerByBuilding.set(row.buildingId, row.building.customerId);
    }
    const result = new Map<string, CustomerRollup>();
    for (const [customerId, buildingRows] of byCustomer) {
      result.set(customerId, {
        counts: countBuildingsByRisk(buildingRows),
        overdue: { overdue: 0, lifeProtectionOverdue: 0 },
      });
    }
    const now = Date.now();
    for (const [buildingId, perBuilding] of Object.entries(actionsNode.data ?? {})) {
      const customerId = customerByBuilding.get(buildingId);
      const rollup = customerId ? result.get(customerId) : undefined;
      if (!rollup) continue;
      const overdue = countOverdueActions(Object.values(perBuilding), now);
      rollup.overdue.overdue += overdue.overdue;
      rollup.overdue.lifeProtectionOverdue += overdue.lifeProtectionOverdue;
    }
    return result;
  }, [buildingsNode.data, actionsNode.data]);

  // The dashboard drill-through params. An unknown ?risk value is ignored;
  // ?overdue=1 only applies when no (valid) risk filter is present.
  const riskFilter = parseRiskParam(searchParams.get('risk'));
  const overdueFilter = riskFilter === null && searchParams.get('overdue') === '1';
  const filterLabel = riskFilter
    ? RISK_FILTER_LABELS[riskFilter]
    : overdueFilter
      ? OVERDUE_FILTER_LABEL
      : null;
  const clearFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('risk');
    next.delete('overdue');
    setSearchParams(next, { replace: true });
  };

  const rows: CustomerRow[] = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let entries = sortByName(toEntries(customers.data))
      .filter(([, customer]) => showArchived || customer.status !== 'archived')
      .filter(([, customer]) => {
        if (!needle) return true;
        const haystack = [
          customer.name,
          customer.address,
          customer.email,
          customer.phone,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(needle);
      });
    // Drill-through filters wait for the roll-ups: until both org-root reads
    // land the full directory shows rather than a false "no matches" flash.
    if (rollups !== undefined) {
      if (riskFilter) {
        const countFor = (id: string) => rollups.get(id)?.counts[riskFilter] ?? 0;
        entries = entries
          .filter(([id]) => countFor(id) > 0)
          .sort((a, b) => countFor(b[0]) - countFor(a[0]));
      } else if (overdueFilter) {
        const countFor = (id: string) => rollups.get(id)?.overdue.overdue ?? 0;
        entries = entries
          .filter(([id]) => countFor(id) > 0)
          .sort((a, b) => countFor(b[0]) - countFor(a[0]));
      }
    }
    return entries.map(([id, customer]) => ({ id, customer }));
  }, [customers.data, search, showArchived, rollups, riskFilter, overdueFilter]);

  const total = toEntries(customers.data).length;
  const columns = useMemo(() => buildColumns(isAdmin, rollups), [isAdmin, rollups]);

  return (
    <div className={styles.root}>
      <PageHeader
        title="Customers"
        lede="The organisations you assess. Each holds its people, sites and buildings."
      />

      {customers.isError && (
        <ErrorNotice message="Could not load customers. Please try again." />
      )}

      {customers.isLoading ? (
        <LoadingNote>Loading customers</LoadingNote>
      ) : total === 0 ? (
        <EmptyState
          title="No customers yet"
          body="Add your first customer organisation to start recording its sites, buildings and assessments."
          action={
            isAdmin ? <Button to={urls.customerNew}>Add customer</Button> : undefined
          }
        />
      ) : (
        <>
          <Toolbar>
            <ToolbarGroup>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="customers-search">
                  Search customers
                </label>
                <input
                  id="customers-search"
                  className={`${shared.input} ${styles.search}`}
                  type="search"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </ToolbarGroup>
            <ToolbarGroup>
              <label className={shared.checkboxRow}>
                <input
                  type="checkbox"
                  className={shared.checkbox}
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                  aria-label="Show archived"
                />
                <span className={shared.label}>Show archived</span>
              </label>
            </ToolbarGroup>
            {isAdmin && (
              <ToolbarGroup push>
                <Button to={urls.customerNew}>Add customer</Button>
              </ToolbarGroup>
            )}
          </Toolbar>

          {filterLabel && (
            <div className={styles.filterRow}>
              <span className={styles.filterChip}>
                {filterLabel}
                <button
                  type="button"
                  className={styles.filterClear}
                  onClick={clearFilter}
                  aria-label="Clear filter"
                >
                  <span aria-hidden="true">&times;</span>
                </button>
              </span>
            </div>
          )}

          <Card flush={rows.length > 0}>
            {rows.length === 0 ? (
              <p className={styles.noMatches}>
                {filterLabel
                  ? 'No customers match this filter. Clear it to see the full directory.'
                  : 'No customers match. Adjust the search or include archived customers.'}
              </p>
            ) : (
              <DataTable
                label="Customers"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                rowHref={(row) => urls.customer(row.id)}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
