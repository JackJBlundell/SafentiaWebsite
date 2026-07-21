// ============================================================================
// OrgDetail (story 2069) - one organisation, read-only: its profile facts,
// live size counts and a bounded window of recent activity. No mutation
// exists on this screen by design (see AdminRoutes) - tenant changes belong
// to the tenant's own admins.
// ============================================================================

import { limitToLast, orderByChild, query } from 'firebase/database';
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { forEnv } from '../../paths';
import {
  useRtdbQuery,
  type RtdbQueryBuilder,
} from '../../query/useRtdbQuery';
import type {
  ActivityEntry,
  Customer,
  Organisation,
  OrgMember,
} from '../../types';
import { StatusBadge } from '../customers/shared';
import { DataTable, type Column } from '../ui/DataTable';
import { DescriptionList, type DescriptionItem } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { usePlatformEnv } from './platformEnv';
import styles from './admin.module.css';

const ACTIVITY_WINDOW = 20;

interface ActivityRow {
  id: string;
  entry: ActivityEntry;
}

interface CustomerRow {
  id: string;
  customer: Customer;
}

function formatWhen(millis: number): string {
  return new Date(millis).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function OrgDetail() {
  const { orgId = '' } = useParams<{ orgId: string }>();
  // The environment is the platform-wide choice from the rail toggle, no longer
  // read from the URL; only the org id comes from the route.
  const { env } = usePlatformEnv();
  const paths = forEnv(env);

  const orgQuery = useRtdbQuery<Organisation | null>({
    key: ['platformOrg', env, orgId],
    path: paths.db.organisation(orgId),
    enabled: Boolean(orgId),
  });
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: ['platformOrgMembers', env, orgId],
    path: paths.db.orgMembers(orgId),
    enabled: Boolean(orgId),
  });
  // The org's customers, for the drill-down into a customer's sites and
  // buildings. Read via the superAdmin cascade; platform-scoped cache key.
  const customersQuery = useRtdbQuery<Record<string, Customer> | null>({
    key: ['platformOrgCustomers', env, orgId],
    path: paths.db.customers(orgId),
    enabled: Boolean(orgId),
  });
  // Bounded, indexed window over the org's audit trail - never the whole tree.
  const buildWindow = useMemo<RtdbQueryBuilder>(
    () => (node) => query(node, orderByChild('at'), limitToLast(ACTIVITY_WINDOW)),
    [],
  );
  const activityQuery = useRtdbQuery<ActivityRow[]>({
    key: ['platformOrgActivity', env, orgId, ACTIVITY_WINDOW],
    path: paths.db.activity(orgId),
    enabled: Boolean(orgId),
    build: buildWindow,
    select: (value) =>
      Object.entries((value as Record<string, ActivityEntry> | null) ?? {})
        .map(([id, entry]) => ({ id, entry }))
        .sort((a, b) => b.entry.at - a.entry.at),
  });

  if (orgQuery.isError) {
    return <ErrorNotice message="Could not load this organisation. Please try again." />;
  }
  if (!orgQuery.isLoading && !orgQuery.data) {
    return (
      <EmptyState
        title="Organisation not found"
        body="This organisation does not exist in this environment."
      />
    );
  }

  const profile = orgQuery.data?.profile;
  const members = Object.values(membersQuery.data ?? {});
  const facts: DescriptionItem[] = [
    { label: 'Environment', value: env === 'test' ? 'Test' : 'Live' },
    { label: 'Organisation id', value: orgId },
    { label: 'Members', value: String(members.length) },
    {
      label: 'Active members',
      value: String(members.filter((m) => m?.status === 'active').length),
    },
    { label: 'Contact email', value: profile?.contact?.email },
  ];

  const customerRows: CustomerRow[] = Object.entries(customersQuery.data ?? {})
    .map(([id, customer]) => ({ id, customer }))
    .sort((a, b) =>
      (a.customer.name ?? '').localeCompare(b.customer.name ?? '', 'en-GB'),
    );
  const customerColumns: Array<Column<CustomerRow>> = [
    { header: 'Customer', cell: (row) => row.customer.name },
    {
      header: 'Status',
      cell: (row) => <StatusBadge status={row.customer.status} />,
      desktopOnly: true,
    },
    {
      header: 'Contact',
      cell: (row) => row.customer.email ?? '',
      desktopOnly: true,
    },
  ];

  const columns: Array<Column<ActivityRow>> = [
    { header: 'When', cell: (row) => formatWhen(row.entry.at), width: '1%' },
    { header: 'Action', cell: (row) => row.entry.action },
    { header: 'Target', cell: (row) => row.entry.target, desktopOnly: true },
    {
      header: 'Actor',
      cell: (row) =>
        membersQuery.data?.[row.entry.actorUid]?.name ?? row.entry.actorUid,
      desktopOnly: true,
    },
  ];

  return (
    <div className={styles.stack}>
      <PageHeader
        title={profile?.name ?? orgId}
        crumbs={[
          { label: 'Platform', to: '/app/admin' },
          { label: profile?.name ?? orgId },
        ]}
        lede="Read-only oversight. Nothing on this screen changes the organisation."
      />
      <section aria-label="Organisation facts" className={styles.card}>
        <DescriptionList items={facts} />
      </section>
      <section aria-label="Customers" className={styles.card}>
        <h2 className={styles.sectionHeading}>Customers</h2>
        {customerRows.length === 0 ? (
          <p className={styles.emptyNote}>This organisation has no customers.</p>
        ) : (
          <DataTable
            columns={customerColumns}
            rows={customerRows}
            rowKey={(row) => row.id}
            rowHref={(row) => `/app/admin/${orgId}/customers/${row.id}`}
            label="Customers"
          />
        )}
      </section>
      <section aria-label="Recent activity" className={styles.card}>
        <h2 className={styles.sectionHeading}>
          Recent activity (latest {ACTIVITY_WINDOW})
        </h2>
        {(activityQuery.data?.length ?? 0) === 0 ? (
          <p className={styles.emptyNote}>No activity recorded yet.</p>
        ) : (
          <DataTable
            columns={columns}
            rows={activityQuery.data ?? []}
            rowKey={(row) => row.id}
            label="Recent activity"
          />
        )}
        {/* Honest disclosure, not a placeholder: /activity writes are
            server-only (callables and triggers), so this read-only console
            cannot append a "platform operator viewed this organisation" row
            itself. Recording platform access needs a dedicated callable -
            tracked in FUTURE_WORK.md. */}
        <p className={styles.footnote}>
          Platform access is not currently recorded in organisation activity
          logs.
        </p>
      </section>
    </div>
  );
}
