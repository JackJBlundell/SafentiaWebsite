// ============================================================================
// PlatformActivity (story 2070) - recent activity across organisations, one
// bounded window per org.
//
// CAPPED, AND SAYS SO: activity is read per organisation (there is no cross-
// org index, deliberately - the audit trail is tenant-scoped), so this screen
// iterates the FIRST 15 organisations by name and takes each one's latest 10
// entries. The cap is disclosed on screen; an operator drills into any org's
// detail page for its full window. Read-only oversight throughout.
// ============================================================================

import { limitToLast, orderByChild, query } from 'firebase/database';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { forEnv } from '../../paths';
import {
  useRtdbQuery,
  type RtdbQueryBuilder,
} from '../../query/useRtdbQuery';
import type {
  ActivityEntry,
  Environment,
  Organisation,
} from '../../types';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { usePlatformEnv } from './platformEnv';
import styles from './admin.module.css';

const ORG_CAP = 15;
const PER_ORG_WINDOW = 10;

function formatWhen(millis: number): string {
  return new Date(millis).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The event family an action belongs to: its first dot-separated segment
 *  ("assessment.stage.released" -> "assessment"; "member.updated (roles)" ->
 *  "member"). Derived from the loaded entries rather than a hand-typed list,
 *  so the filter can never drift from what the Functions actually write. */
function actionFamily(action: string): string {
  const head = action.split('.')[0] ?? action;
  return head.split(' ')[0] ?? head;
}

/** One org's bounded window - its own component so each org owns its own
 *  subscription (hooks cannot loop; components can). */
function OrgActivityBlock({
  env,
  orgId,
  name,
  family,
  onFamilies,
}: {
  env: Environment;
  orgId: string;
  name: string;
  /** The selected event family, or 'all'. Filtering is client-side over the
   *  already-loaded window - the subscription itself never changes shape. */
  family: string;
  /** Reports the families present in this org's window so the parent's select
   *  offers exactly the types that exist in the loaded data. */
  onFamilies: (families: string[]) => void;
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
  const allRows = activity.data ?? [];

  useEffect(() => {
    if (allRows.length > 0) {
      onFamilies(allRows.map((row) => actionFamily(row.entry.action)));
    }
    // Keyed on the loaded data; onFamilies is a stable, guarded callback.
  }, [allRows, onFamilies]);

  const rows =
    family === 'all'
      ? allRows
      : allRows.filter((row) => actionFamily(row.entry.action) === family);

  return (
    <section className={styles.card} aria-label={`${name} activity`}>
      <h2 className={styles.sectionHeading}>
        <Link to={`/app/admin/${orgId}`}>{name}</Link>
      </h2>
      {rows.length === 0 ? (
        <p className={styles.emptyNote}>
          {family === 'all'
            ? 'No recent activity.'
            : 'No recent activity of this type.'}
        </p>
      ) : (
        <ul className={styles.activityList}>
          {rows.map((row) => (
            <li key={row.id} className={styles.activityRow}>
              <span className={styles.activityWhen}>
                {formatWhen(row.entry.at)}
              </span>
              <span>{row.entry.action}</span>
              <span className={styles.activityTarget}>{row.entry.target}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PlatformActivity() {
  // The environment is the platform-wide choice from the rail toggle, no longer
  // read from the URL.
  const { env } = usePlatformEnv();
  const paths = forEnv(env);

  // Event-type filter (story 2070 polish): client-side over the loaded
  // windows. The option list accumulates from what the blocks actually loaded.
  const [family, setFamily] = useState('all');
  const [families, setFamilies] = useState<string[]>([]);
  const registerFamilies = useCallback((reported: string[]) => {
    setFamilies((previous) => {
      const merged = Array.from(new Set([...previous, ...reported])).sort();
      // Referential guard: an unchanged list keeps the previous state object,
      // so the reporting effect cannot re-render in a loop.
      return merged.length === previous.length ? previous : merged;
    });
  }, []);

  const orgsQuery = useRtdbQuery<Record<string, Organisation> | null>({
    key: ['platformOrgs', env],
    path: paths.db.organisationsRoot(),
  });

  const orgs = Object.entries(orgsQuery.data ?? {})
    .map(([orgId, org]) => ({ orgId, name: org?.profile?.name ?? orgId }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = orgs.slice(0, ORG_CAP);

  return (
    <div className={styles.stack}>
      <PageHeader
        title="Platform activity"
        crumbs={[
          { label: 'Platform', to: '/app/admin' },
          { label: 'Activity' },
        ]}
        lede={`The latest ${PER_ORG_WINDOW} audit entries per organisation (${env} environment). Read-only oversight.`}
      />
      {orgsQuery.isError && (
        <ErrorNotice message="Could not load the organisations. Please try again." />
      )}
      {families.length > 0 && (
        <div className={styles.toolbar}>
          <label className={styles.filterLabel} htmlFor="activity-family">
            Event type
          </label>
          <select
            id="activity-family"
            className={styles.filterSelect}
            value={family}
            onChange={(event) => setFamily(event.target.value)}
          >
            <option value="all">All types</option>
            {families.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      )}
      {orgs.length > ORG_CAP && (
        <p className={styles.footnote}>
          Showing the first {ORG_CAP} of {orgs.length} organisations by name;
          open an organisation for its full activity window.
        </p>
      )}
      {shown.map((org) => (
        <OrgActivityBlock
          key={org.orgId}
          env={env}
          orgId={org.orgId}
          name={org.name}
          family={family}
          onFamilies={registerFamilies}
        />
      ))}
      {!orgsQuery.isLoading && shown.length === 0 && !orgsQuery.isError && (
        <p className={styles.emptyNote}>
          No organisations exist in the {env} environment yet.
        </p>
      )}
    </div>
  );
}
