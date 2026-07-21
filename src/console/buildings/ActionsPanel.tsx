// ============================================================================
// ActionsPanel - the building's action plan (stories 2042/2043/2045).
//
// One severity-ordered table of the building's remedial actions (assessment-
// born and admin-recorded alike), with status/severity/responsible/overdue
// filters and a "View location" link for flag-born actions. Admins
// manage the plan through the manageAction callable ONLY - create, edit, sign
// off and reopen - so every mutation lands with its audit entry server-side.
// Sign off and reopen are two-step ("press, then confirm") because both change
// the legal reading of the plan.
//
// Overdue comes from orgMetrics' isActionOverdue - the console's ONE overdue
// derivation (story 2045) - so this table can never disagree with a dashboard.
// An overdue action that protects life (LTP) is the plan's loudest state and
// is escalated visually beyond the ordinary overdue tone - never colour alone.
// ============================================================================

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { firebase } from '../../firebase';
import { useTheme } from '../../design/ThemeProvider';
import { severityPresentation } from '../../design/rag';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Action,
  ManageActionInput,
  ManageActionResult,
  Severity,
} from '../../types';
import { ErrorNotice } from '../ui/Page';
import { DataTable, type Column } from '../ui/DataTable';
import { useCallable } from '../ui/useCallable';
import { isActionOverdue } from '../reports/orgMetrics';
import styles from './ActionsPanel.module.css';

const SEVERITY_ORDER: Record<Severity, number> = { H: 0, M: 1, L: 2 };

type StatusFilter = 'all' | 'open' | 'signedOff';
type SeverityFilter = 'all' | Severity;

/** The Responsible filter's value encoding: fixed options plus one prefixed
 *  entry per distinct responsible name, so a name can never collide with the
 *  fixed values. */
type ResponsibleFilter = 'all' | 'unassigned' | `name:${string}`;
const responsibleOption = (name: string): ResponsibleFilter => `name:${name}`;

interface ActionRow {
  id: string;
  action: Action;
  overdue: boolean;
}

function formatDate(epochMillis: number): string {
  return new Date(epochMillis).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Epoch millis <-> the yyyy-mm-dd a date input speaks, in UTC. */
function toDateInputValue(epochMillis: number | undefined): string {
  return epochMillis === undefined
    ? ''
    : new Date(epochMillis).toISOString().slice(0, 10);
}
function fromDateInputValue(value: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function SeverityCell({ severity }: { severity: Severity }) {
  const { theme } = useTheme();
  const rag = severityPresentation(theme, severity);
  return (
    <span
      className={styles.severityChip}
      style={{ color: rag.color, background: rag.surface }}
    >
      <span aria-hidden="true">{rag.icon}</span>
      {rag.label}
    </span>
  );
}

/**
 * "View location" for an action born from a flagged floor-plan answer (story
 * 2042). `locationFlagUrl` is the flag composite and may be stored as a full
 * https download URL or as a Storage object path (both shapes exist in the
 * pipeline - see report assembly's toObjectPath); an https value links
 * directly, a path resolves through getDownloadURL exactly like a document
 * row. Resolution failure degrades to honest muted copy, never a dead link.
 * The link opens the full-size composite in a new tab.
 */
function LocationFlagLink({ url }: { url: string }) {
  const isDirect = /^https?:\/\//.test(url);
  const [resolved, setResolved] = useState<string | null>(
    isDirect ? url : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isDirect) {
      return;
    }
    let cancelled = false;
    getDownloadURL(storageRef(firebase.storage(), url))
      .then((downloadUrl) => {
        if (!cancelled) {
          setResolved(downloadUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, isDirect]);

  if (failed) {
    return (
      <span className={styles.locationUnavailable}>Location unavailable</span>
    );
  }
  if (!resolved) {
    return null;
  }
  return (
    <a
      className={styles.locationLink}
      href={resolved}
      target="_blank"
      rel="noopener noreferrer"
    >
      View location
    </a>
  );
}

/** The editable draft behind both the add and the edit forms. */
interface Draft {
  observation: string;
  severity: Severity;
  responsible: string;
  dueBy: string;
  lifeProtection: boolean;
}
const EMPTY_DRAFT: Draft = {
  observation: '',
  severity: 'M',
  responsible: '',
  dueBy: '',
  lifeProtection: false,
};

export function ActionsPanel({ buildingId }: { buildingId: string }) {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const isAdmin = claims?.roles.admin === true;

  const actionsQuery = useRtdbQuery<Record<string, Action> | null>({
    key: keys.actions(orgId, buildingId),
    path: paths ? paths.db.actions(orgId, buildingId) : '',
    enabled: Boolean(orgId && paths && buildingId),
  });
  const manage = useCallable<ManageActionInput, ManageActionResult>(
    'manageAction',
  );

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [responsibleFilter, setResponsibleFilter] =
    useState<ResponsibleFilter>('all');
  const [overdueOnly, setOverdueOnly] = useState(false);
  // The form is one surface with two modes: null = closed, 'new' = add,
  // otherwise the id of the action being edited.
  const [formTarget, setFormTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // Two-step confirmation: the id awaiting its confirm press, and which verb.
  const [confirming, setConfirming] = useState<{
    id: string;
    verb: 'signOff' | 'reopen';
  } | null>(null);

  // The Responsible filter's options: every distinct name present in the plan
  // (story 2042), plus Unassigned when any action carries no responsible. The
  // options come from the SAME data as the rows, so the select can never offer
  // a value that matches nothing.
  const responsibleOptions = useMemo(() => {
    const actions = Object.values(actionsQuery.data ?? {});
    const names = [
      ...new Set(
        actions.flatMap((action) =>
          action.responsible ? [action.responsible] : [],
        ),
      ),
    ].sort((a, b) => a.localeCompare(b, 'en-GB'));
    return {
      names,
      hasUnassigned: actions.some((action) => !action.responsible),
    };
  }, [actionsQuery.data]);

  const now = Date.now();
  const rows = useMemo<ActionRow[]>(() => {
    const all = Object.entries(actionsQuery.data ?? {}).map(([id, action]) => ({
      id,
      action,
      overdue: isActionOverdue(action, now),
    }));
    return all
      .filter((row) => {
        if (statusFilter !== 'all' && row.action.status !== statusFilter) {
          return false;
        }
        if (severityFilter !== 'all' && row.action.severity !== severityFilter) {
          return false;
        }
        if (responsibleFilter === 'unassigned' && row.action.responsible) {
          return false;
        }
        if (
          responsibleFilter !== 'all' &&
          responsibleFilter !== 'unassigned' &&
          responsibleOption(row.action.responsible ?? '') !== responsibleFilter
        ) {
          return false;
        }
        if (overdueOnly && !row.overdue) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const bySeverity =
          SEVERITY_ORDER[a.action.severity] - SEVERITY_ORDER[b.action.severity];
        if (bySeverity !== 0) {
          return bySeverity;
        }
        return (a.action.dueBy ?? Infinity) - (b.action.dueBy ?? Infinity);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is per-render by design
  }, [actionsQuery.data, statusFilter, severityFilter, responsibleFilter, overdueOnly]);

  const openForm = (target: string | null, seed: Draft) => {
    setFormTarget(target);
    setDraft(seed);
    setConfirming(null);
    manage.clearError();
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.observation.trim()) {
      return;
    }
    const dueBy = fromDateInputValue(draft.dueBy);
    const responsible = draft.responsible.trim();
    if (formTarget === 'new') {
      const result = await manage.call({
        action: 'create',
        buildingId,
        fields: {
          observation: draft.observation.trim(),
          severity: draft.severity,
          ...(responsible ? { responsible } : {}),
          ...(dueBy !== undefined ? { dueBy } : {}),
          lifeProtection: draft.lifeProtection,
        },
      });
      if (result) {
        setFormTarget(null);
      }
    } else if (formTarget) {
      // Edit: the whitelisted fields only; an emptied optional sends null (the
      // CLEAR intent), so a blanked responsible or due date really clears.
      const result = await manage.call({
        action: 'update',
        buildingId,
        actionId: formTarget,
        fields: {
          observation: draft.observation.trim(),
          severity: draft.severity,
          responsible: responsible || null,
          dueBy: dueBy ?? null,
          lifeProtection: draft.lifeProtection,
        },
      });
      if (result) {
        setFormTarget(null);
      }
    }
  };

  const onConfirmVerb = async (id: string, verb: 'signOff' | 'reopen') => {
    const result = await manage.call({ action: verb, buildingId, actionId: id });
    if (result) {
      setConfirming(null);
    }
  };

  const columns: Array<Column<ActionRow>> = [
    {
      header: 'Severity',
      cell: (row) => <SeverityCell severity={row.action.severity} />,
      width: '1%',
    },
    {
      header: 'Observation',
      cell: (row) => (
        <span className={styles.observation}>
          {row.action.observation}
          {row.action.lifeProtection && (
            <span className={styles.ltpBadge}>Life protection</span>
          )}
          {row.action.locationFlagUrl && (
            <LocationFlagLink url={row.action.locationFlagUrl} />
          )}
        </span>
      ),
    },
    {
      header: 'Responsible',
      cell: (row) => row.action.responsible ?? 'Unassigned',
      desktopOnly: true,
    },
    {
      header: 'Due',
      cell: (row) =>
        row.action.dueBy === undefined ? (
          'Not set'
        ) : (
          <span
            className={[
              row.overdue ? styles.overdue : '',
              row.overdue && row.action.lifeProtection ? styles.overdueLtp : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {formatDate(row.action.dueBy)}
            {row.overdue && (
              <span className={styles.overdueBadge}>
                {row.action.lifeProtection ? 'Overdue · LTP' : 'Overdue'}
              </span>
            )}
          </span>
        ),
    },
    {
      header: 'Status',
      cell: (row) =>
        row.action.status === 'signedOff'
          ? 'Signed off'
          : row.action.status === 'archived'
            ? 'Archived'
            : 'Open',
    },
  ];
  if (isAdmin) {
    columns.push({
      header: 'Manage',
      align: 'end',
      cell: (row) => {
        const pendingHere = confirming?.id === row.id;
        if (row.action.status === 'open') {
          return (
            <span className={styles.rowActions}>
              <Button
                variant="secondary"
               
                onClick={() =>
                  openForm(row.id, {
                    observation: row.action.observation,
                    severity: row.action.severity,
                    responsible: row.action.responsible ?? '',
                    dueBy: toDateInputValue(row.action.dueBy),
                    lifeProtection: row.action.lifeProtection,
                  })
                }
              >
                Edit
              </Button>
              {pendingHere && confirming?.verb === 'signOff' ? (
                <>
                  <Button
                   
                    onClick={() => void onConfirmVerb(row.id, 'signOff')}
                    disabled={manage.pending}
                  >
                    Confirm sign off
                  </Button>
                  <Button
                    variant="secondary"
                   
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                 
                  onClick={() => setConfirming({ id: row.id, verb: 'signOff' })}
                >
                  Sign off
                </Button>
              )}
            </span>
          );
        }
        if (row.action.status === 'signedOff') {
          return (
            <span className={styles.rowActions}>
              {pendingHere && confirming?.verb === 'reopen' ? (
                <>
                  <Button
                   
                    onClick={() => void onConfirmVerb(row.id, 'reopen')}
                    disabled={manage.pending}
                  >
                    Confirm reopen
                  </Button>
                  <Button
                    variant="secondary"
                   
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                 
                  onClick={() => setConfirming({ id: row.id, verb: 'reopen' })}
                >
                  Reopen
                </Button>
              )}
            </span>
          );
        }
        return null;
      },
    });
  }

  return (
    <section className={styles.panel} aria-labelledby="actions-panel-heading">
      <div className={styles.headRow}>
        <h2 id="actions-panel-heading" className={styles.heading}>
          Action plan
        </h2>
        {isAdmin && formTarget === null && (
          <Button
            variant="secondary"
            onClick={() => openForm('new', EMPTY_DRAFT)}
          >
            Add action
          </Button>
        )}
      </div>

      {actionsQuery.isError && (
        <ErrorNotice message="Could not load the action plan. Please try again." />
      )}

      <div className={styles.filters}>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Status</span>
          <select
            className={styles.select}
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as StatusFilter)
            }
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="signedOff">Signed off</option>
          </select>
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Severity</span>
          <select
            className={styles.select}
            value={severityFilter}
            onChange={(event) =>
              setSeverityFilter(event.target.value as SeverityFilter)
            }
          >
            <option value="all">All severities</option>
            <option value="H">High</option>
            <option value="M">Medium</option>
            <option value="L">Low</option>
          </select>
        </label>
        <label className={styles.filterField}>
          <span className={styles.filterLabel}>Responsible</span>
          <select
            className={styles.select}
            value={responsibleFilter}
            onChange={(event) =>
              setResponsibleFilter(event.target.value as ResponsibleFilter)
            }
          >
            <option value="all">Everyone</option>
            {responsibleOptions.names.map((name) => (
              <option key={name} value={responsibleOption(name)}>
                {name}
              </option>
            ))}
            {responsibleOptions.hasUnassigned && (
              <option value="unassigned">Unassigned</option>
            )}
          </select>
        </label>
        <label className={styles.checkField}>
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(event) => setOverdueOnly(event.target.checked)}
          />
          <span>Overdue only</span>
        </label>
      </div>

      {isAdmin && formTarget !== null && (
        <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
          <h3 className={styles.formHeading}>
            {formTarget === 'new' ? 'Add an action' : 'Edit action'}
          </h3>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Observation</span>
            <textarea
              className={styles.textarea}
              value={draft.observation}
              required
              rows={3}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  observation: event.target.value,
                }))
              }
            />
          </label>
          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Severity</span>
              <select
                className={styles.select}
                value={draft.severity}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    severity: event.target.value as Severity,
                  }))
                }
              >
                <option value="H">High</option>
                <option value="M">Medium</option>
                <option value="L">Low</option>
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Responsible</span>
              <input
                className={styles.input}
                type="text"
                value={draft.responsible}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    responsible: event.target.value,
                  }))
                }
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Due by</span>
              <input
                className={styles.input}
                type="date"
                value={draft.dueBy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    dueBy: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          {formTarget === 'new' && (
            <p className={styles.formNote}>
              Leave the due date empty to use the standard window for the
              severity: High 7 days, Medium 30 days, Low 90 days.
            </p>
          )}
          <label className={styles.checkField}>
            <input
              type="checkbox"
              checked={draft.lifeProtection}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  lifeProtection: event.target.checked,
                }))
              }
            />
            <span>This action protects life (LTP)</span>
          </label>
          {manage.error && (
            <p role="alert" className={styles.inlineError}>
              {manage.error}
            </p>
          )}
          <div className={styles.formActions}>
            <Button type="submit" disabled={manage.pending}>
              {manage.pending
                ? 'Saving'
                : formTarget === 'new'
                  ? 'Add action'
                  : 'Save changes'}
            </Button>
            <Button
              variant="secondary"
              type="button"
              onClick={() => setFormTarget(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {manage.error && formTarget === null && (
        <p role="alert" className={styles.inlineError}>
          {manage.error}
        </p>
      )}

      {rows.length === 0 && !actionsQuery.isLoading && !actionsQuery.isError ? (
        <p className={styles.emptyNote}>
          {Object.keys(actionsQuery.data ?? {}).length === 0
            ? 'No actions have been recorded for this building yet.'
            : 'No actions match the current filters.'}
        </p>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          label="Action plan"
        />
      )}
    </section>
  );
}
