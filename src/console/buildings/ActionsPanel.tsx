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
//
// Responsible party: there is ONE responsible party per building, chosen once
// by an admin and inherited by everything the building produces. So the add
// form does not start from a blank text box - it reads the building and
// preselects that default (the `responsibleParty` the admin set), offering the
// names already used in the plan alongside it. An admin confirms a choice
// instead of retyping a name, which is what let the plan drift into
// near-duplicate spellings of the same person.
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
  ActionStatus,
  ActionStatusChange,
  Building,
  ManageActionInput,
  ManageActionResult,
  Severity,
} from '../../types';
import { ErrorNotice } from '../ui/Page';
import { DataTable, type Column, type RowExpansion } from '../ui/DataTable';
import { useCallable } from '../ui/useCallable';
import { isActionOverdue } from '../reports/orgMetrics';
import styles from './ActionsPanel.module.css';

const SEVERITY_ORDER: Record<Severity, number> = { H: 0, M: 1, L: 2 };

type StatusFilter = 'all' | 'open' | 'inProgress' | 'signedOff';
type SeverityFilter = 'all' | Severity;

/** The full lifecycle wording, so a status is never carried by colour alone. */
const STATUS_LABELS: Record<ActionStatus, string> = {
  open: 'Open',
  inProgress: 'In progress',
  signedOff: 'Signed off',
  archived: 'Archived',
};

/** The Responsible filter's value encoding: fixed options plus one prefixed
 *  entry per distinct responsible name, so a name can never collide with the
 *  fixed values. */
type ResponsibleFilter = 'all' | 'unassigned' | `name:${string}`;
const responsibleOption = (name: string): ResponsibleFilter => `name:${name}`;

/** The Responsible FIELD's value encoding in the add/edit form. Same prefixing
 *  trick as the filter above (a party genuinely called "Unassigned" can never
 *  be read as the fixed entry), plus 'other' for the free-text escape hatch -
 *  a one-off contractor still has to be typeable. */
type ResponsibleChoice = 'unassigned' | 'other' | `name:${string}`;
const responsibleChoice = (name: string): ResponsibleChoice => `name:${name}`;

/** The building's default responsible party: the structured `responsibleParty`
 *  an admin set. Empty when the building names nobody. */
function buildingDefaultResponsible(building: Building | null | undefined): string {
  return building?.responsibleParty?.name?.trim() || '';
}

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

/** Date and time of a status change, in UTC to match the stored day (the panel
 *  shows time as well as date because several moves can happen on one day). */
function formatDateTime(epochMillis: number): string {
  return new Date(epochMillis).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/** Resolve who made a change to a name the viewer can read. The panel does not
 *  load the member directory (and story 2044 forbids adding a per-row read), so
 *  we can only recognise the viewer's own uid; anyone else is a neutral label. */
function actorLabel(byUid: string, viewerUid: string | undefined): string {
  return byUid === viewerUid ? 'you' : 'a team member';
}

/** The status column's chip: label-led (colour is only a supporting cue), one
 *  tone per lifecycle state so in-progress reads distinctly from open and
 *  signed-off. */
const STATUS_CLASS: Record<ActionStatus, string> = {
  open: styles.statusOpen,
  inProgress: styles.statusInProgress,
  signedOff: styles.statusSignedOff,
  archived: styles.statusArchived,
};
function StatusChip({ status }: { status: ActionStatus }) {
  return (
    <span className={`${styles.statusChip} ${STATUS_CLASS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** The compact per-action lifecycle trail (story 2044 AC3): what changed, when,
 *  by whom, and the completion note captured at sign-off. Oldest first, as the
 *  server appends it. */
function StatusHistory({
  history,
  viewerUid,
}: {
  history: readonly ActionStatusChange[];
  viewerUid: string | undefined;
}) {
  if (history.length === 0) {
    return (
      <p className={styles.historyEmpty}>
        No status changes have been recorded yet.
      </p>
    );
  }
  return (
    <ol className={styles.historyList}>
      {history.map((entry, index) => (
        <li key={index} className={styles.historyItem}>
          <StatusChip status={entry.status} />
          <span className={styles.historyMeta}>
            {formatDateTime(entry.at)} by {actorLabel(entry.byUid, viewerUid)}
          </span>
          {entry.note && (
            <span className={styles.historyNote}>{entry.note}</span>
          )}
        </li>
      ))}
    </ol>
  );
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
  /** TRUE while the admin is typing a name the picker does not offer, so the
   *  free-text box stays open even when it is momentarily empty (which is a
   *  different intent from choosing Unassigned). */
  responsibleOther: boolean;
  dueBy: string;
  lifeProtection: boolean;
}
const EMPTY_DRAFT: Draft = {
  observation: '',
  severity: 'M',
  responsible: '',
  responsibleOther: false,
  dueBy: '',
  lifeProtection: false,
};

export function ActionsPanel({
  siteId,
  buildingId,
}: {
  siteId: string;
  buildingId: string;
}) {
  const { claims, paths, user } = useAuth();
  const orgId = claims?.orgId ?? '';
  const isAdmin = claims?.roles.admin === true;

  const actionsQuery = useRtdbQuery<Record<string, Action> | null>({
    key: keys.actions(orgId, buildingId),
    path: paths ? paths.db.actions(orgId, buildingId) : '',
    enabled: Boolean(orgId && paths && buildingId),
  });
  // The building, for its default responsible party. Read on the SAME cache key
  // the building page already uses (the ServiceSchedulePanel precedent), so the
  // panel stays self-contained without opening a second subscription to a node
  // its host is already watching.
  const buildingQuery = useRtdbQuery<Building | null>({
    key: keys.building(orgId, siteId, buildingId),
    path: paths ? paths.db.building(orgId, siteId, buildingId) : '',
    enabled: Boolean(orgId && paths && siteId && buildingId),
  });
  const defaultResponsible = buildingDefaultResponsible(buildingQuery.data);
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
  // The optional completion note captured while a sign-off is being confirmed
  // (story 2044 AC2). Kept beside `confirming` so cancelling clears it.
  const [completionNote, setCompletionNote] = useState('');

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

  // The Responsible FIELD's options: the building's default first (it is the
  // answer for nearly every action, so it leads and is the one preselected),
  // then the other names already in the plan. Offering the plan's own names is
  // what stops the same person being re-typed three ways.
  const responsibleChoices = useMemo(
    () => [
      ...(defaultResponsible ? [defaultResponsible] : []),
      ...responsibleOptions.names.filter((name) => name !== defaultResponsible),
    ],
    [defaultResponsible, responsibleOptions.names],
  );

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
    setCompletionNote('');
    manage.clearError();
  };

  // A new action starts on the building's default responsible party: the admin
  // confirms it (or picks someone else) rather than retyping a name the record
  // already holds. If the building read has not landed yet the picker simply
  // opens on Unassigned - the panel never blocks recording the finding.
  const newDraft = (): Draft => ({
    ...EMPTY_DRAFT,
    responsible: defaultResponsible,
  });

  // An existing action opens on whatever it already carries. A name the picker
  // no longer offers (typed before it left the plan) opens the free-text box
  // holding that name, so editing an action can never silently reassign it.
  const editDraft = (action: Action): Draft => ({
    observation: action.observation,
    severity: action.severity,
    responsible: action.responsible ?? '',
    responsibleOther: Boolean(
      action.responsible && !responsibleChoices.includes(action.responsible),
    ),
    dueBy: toDateInputValue(action.dueBy),
    lifeProtection: action.lifeProtection,
  });

  const disarm = () => {
    setConfirming(null);
    setCompletionNote('');
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

  // Start needs no confirmation: moving open work to in progress is not a
  // legally significant close the way sign-off and reopen are.
  const onStart = async (id: string) => {
    await manage.call({ action: 'start', buildingId, actionId: id });
  };

  const onConfirmVerb = async (id: string, verb: 'signOff' | 'reopen') => {
    const note = completionNote.trim();
    const result = await manage.call({
      action: verb,
      buildingId,
      actionId: id,
      // The completion note only rides along with a sign-off, and only when the
      // admin actually wrote one.
      ...(verb === 'signOff' && note ? { completionNote: note } : {}),
    });
    if (result) {
      disarm();
    }
  };

  // Sign-off is a two-step press-then-confirm because it changes the legal
  // reading of the plan; the confirm step also offers the optional completion
  // note. Shared by open and in-progress rows.
  const signOffControl = (id: string) => {
    const armed = confirming?.id === id && confirming.verb === 'signOff';
    if (!armed) {
      return (
        <Button
          variant="secondary"
          onClick={() => {
            setConfirming({ id, verb: 'signOff' });
            setCompletionNote('');
          }}
        >
          Sign off
        </Button>
      );
    }
    return (
      <span className={styles.signOffConfirm}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Completion note (optional)</span>
          <textarea
            className={styles.textarea}
            rows={2}
            value={completionNote}
            onChange={(event) => setCompletionNote(event.target.value)}
          />
        </label>
        <span className={styles.rowActions}>
          <Button
            onClick={() => void onConfirmVerb(id, 'signOff')}
            disabled={manage.pending}
          >
            Confirm sign off
          </Button>
          <Button variant="secondary" onClick={disarm}>
            Cancel
          </Button>
        </span>
      </span>
    );
  };

  // Reopen is likewise two-step. Shared by signed-off and in-progress rows.
  const reopenControl = (id: string) => {
    const armed = confirming?.id === id && confirming.verb === 'reopen';
    if (!armed) {
      return (
        <Button
          variant="secondary"
          onClick={() => setConfirming({ id, verb: 'reopen' })}
        >
          Reopen
        </Button>
      );
    }
    return (
      <>
        <Button
          onClick={() => void onConfirmVerb(id, 'reopen')}
          disabled={manage.pending}
        >
          Confirm reopen
        </Button>
        <Button variant="secondary" onClick={disarm}>
          Cancel
        </Button>
      </>
    );
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
    // Every column but Observation asks for a token 1% so the browser sizes it
    // to its own content and hands the whole surplus to the free text, rather
    // than sharing width evenly and leaving the observation a sliver.
    {
      header: 'Responsible',
      cell: (row) => row.action.responsible ?? 'Unassigned',
      desktopOnly: true,
      width: '1%',
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
      width: '1%',
    },
    {
      header: 'Status',
      cell: (row) => <StatusChip status={row.action.status} />,
      width: '1%',
    },
  ];
  if (isAdmin) {
    columns.push({
      header: 'Manage',
      align: 'end',
      width: '1%',
      cell: (row) => {
        if (row.action.status === 'open') {
          return (
            <span className={styles.rowActions}>
              <Button
                variant="secondary"
                onClick={() => openForm(row.id, editDraft(row.action))}
              >
                Edit
              </Button>
              <Button
                variant="secondary"
                onClick={() => void onStart(row.id)}
                disabled={manage.pending}
              >
                Start
              </Button>
              {signOffControl(row.id)}
            </span>
          );
        }
        if (row.action.status === 'inProgress') {
          return (
            <span className={styles.rowActions}>
              {signOffControl(row.id)}
              {reopenControl(row.id)}
            </span>
          );
        }
        if (row.action.status === 'signedOff') {
          return <span className={styles.rowActions}>{reopenControl(row.id)}</span>;
        }
        return null;
      },
    });
  }

  // The lifecycle trail is a per-row disclosure, available to every viewer (not
  // just admins) so a building owner can see how an action progressed.
  const historyExpansion: RowExpansion<ActionRow> = {
    header: 'History',
    label: (row) => `status history for ${row.action.observation}`,
    content: (row) => (
      <StatusHistory
        history={row.action.statusHistory ?? []}
        viewerUid={user?.uid}
      />
    ),
  };

  return (
    <section className={styles.panel} aria-labelledby="actions-panel-heading">
      <div className={styles.headRow}>
        <h2 id="actions-panel-heading" className={styles.heading}>
          Action plan
        </h2>
        {isAdmin && formTarget === null && (
          <Button variant="secondary" onClick={() => openForm('new', newDraft())}>
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
            <option value="inProgress">In progress</option>
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
              <select
                className={styles.select}
                value={
                  draft.responsibleOther
                    ? 'other'
                    : draft.responsible
                      ? responsibleChoice(draft.responsible)
                      : 'unassigned'
                }
                onChange={(event) => {
                  const choice = event.target.value as ResponsibleChoice;
                  setDraft((current) => ({
                    ...current,
                    // 'other' clears the name so the box opens empty and ready
                    // to type; the fixed entries close it again.
                    responsible:
                      choice === 'unassigned' || choice === 'other'
                        ? ''
                        : choice.slice('name:'.length),
                    responsibleOther: choice === 'other',
                  }));
                }}
              >
                {responsibleChoices.map((name) => (
                  <option key={name} value={responsibleChoice(name)}>
                    {name === defaultResponsible
                      ? `${name} (building default)`
                      : name}
                  </option>
                ))}
                <option value="unassigned">Unassigned</option>
                <option value="other">Someone else</option>
              </select>
            </label>
            {draft.responsibleOther && (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Responsible name</span>
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
            )}
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
          expansion={historyExpansion}
        />
      )}
    </section>
  );
}
