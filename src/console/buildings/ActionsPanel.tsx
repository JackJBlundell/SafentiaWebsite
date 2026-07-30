// ============================================================================
// ActionsPanel - the building's action plan (stories 2042/2043/2045).
//
// One severity-ordered LIST of the building's remedial actions (assessment-born
// and admin-recorded alike), with status/severity/responsible/overdue filters
// and a "View location" link for flag-born actions. Admins manage the plan
// through the manageAction callable ONLY - create, edit, sign off and reopen -
// so every mutation lands with its audit entry server-side.
//
// WHY CARDS, NOT A TABLE: an action is one long sentence (the observation) plus
// five short facts. A table gave the sentence whatever width the short facts
// left over, which on the tablets this is actually read on was a sliver. Each
// action is now a card: a state rail (severity, status, LTP, overdue) reads
// first, the observation is the headline at full measure, and the supporting
// facts sit under it as labelled pairs that reflow to one column when narrow.
// Nothing is hidden at any width - a compliance record must not drop columns.
//
// Overdue comes from orgMetrics' isActionOverdue - the console's ONE overdue
// derivation (story 2045) - so this list can never disagree with a dashboard.
// An overdue action that protects life (LTP) is the plan's loudest state and
// is escalated visually beyond the ordinary overdue tone - never colour alone.
//
// Sign-off is a MODAL (SignOffDialog), not an inline row expansion: it closes
// the action in the legal record and now also carries the optional supporting
// document, neither of which belongs inches from Reopen in a cramped row.
// Reopen keeps its lighter press-then-confirm in place, since it only returns
// an action to work.
//
// A CUSTOMER CLAIM IS NOT A SIGN-OFF. The duty-holder can now report from their
// portal that remedial work is in hand or done (respondToAction), which arrives
// as `customerResponse` plus an attributed entry in the same status history.
// It is shown here as reported speech, with an "Awaiting verification" badge
// while nobody has checked - deliberately loud, because it is work waiting on
// THIS panel. Closing the action remains an org admin's act, and only Sign off
// does it.
//
// RESPONSIBLE PARTY: A CONTACT, NOT A NAME. Who owes an action is chosen from
// the customer's contact directory, and manageAction writes the name from that
// contact's own record - there is no text box, because Safentia emails this
// person when the action is assigned and again as its due date approaches, and
// a typed name is somebody who can never be told. The picker preselects the
// building's own responsible party (the default an admin set), so the usual
// case is confirming a choice rather than making one.
//
// Actions raised before the linkage carry a name and nothing to email. They are
// shown with that name and an explicit "not linked to a contact" note, so an
// admin can see exactly why no reminder is going out and fix it by re-picking.
// ============================================================================

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
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
  ActionCustomerResponse,
  ActionResponseState,
  ActionStatus,
  ActionStatusChange,
  Building,
  ManageActionInput,
  ManageActionResult,
  SafentiaDocument,
  Severity,
} from '../../types';
import { ErrorNotice } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { useCallable } from '../ui/useCallable';
import { isActionOverdue } from '../reports/orgMetrics';
// The one way a screen attaches a person to something, shared with the
// customers area so the plan and the contact roster can never disagree.
import { ContactPicker } from '../customers/ContactPicker';
import { SignOffDialog } from './SignOffDialog';
import styles from './ActionsPanel.module.css';
import { fromDateInputValue, toDateInputValue } from '../lib/dateInput';

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

/** How the customer's own progress claim reads to STAFF. Always attributed to
 *  the customer and always phrased as something they SAY: the action is not
 *  closed until someone here verifies the work and signs it off. */
const CUSTOMER_CLAIM_LABELS: Record<ActionResponseState, string> = {
  inHand: 'The customer says the work is in hand',
  completed: 'The customer says the work is completed',
};

/** The status chip: label-led (colour is only a supporting cue), one tone per
 *  lifecycle state so in-progress reads distinctly from open and signed-off. */
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

/**
 * Resolve a stored-file reference to something a browser can open.
 *
 * Two shapes exist in the pipeline: a full https download URL (older flag
 * composites) and a Storage object path (documents, and every file this panel
 * writes). A path is exchanged for a tokened URL minted for the signed-in
 * member, exactly as the rules intend; an https value is already usable.
 * `failed` is a real state, not a null - a dead link is worse than honest copy.
 */
function useStoredFileUrl(reference: string): {
  url: string | null;
  failed: boolean;
} {
  const isDirect = /^https?:\/\//.test(reference);
  const [url, setUrl] = useState<string | null>(isDirect ? reference : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isDirect) {
      setUrl(reference);
      return;
    }
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    getDownloadURL(storageRef(firebase.storage(), reference))
      .then((downloadUrl) => {
        if (!cancelled) {
          setUrl(downloadUrl);
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
  }, [reference, isDirect]);

  return { url, failed };
}

/** "View location" for an action born from a flagged floor-plan answer (story
 *  2042): the flag composite, opened full size in a new tab. */
function LocationFlagLink({ url }: { url: string }) {
  const resolved = useStoredFileUrl(url);
  if (resolved.failed) {
    return (
      <span className={styles.locationUnavailable}>Location unavailable</span>
    );
  }
  if (!resolved.url) {
    return null;
  }
  return (
    <a
      className={styles.locationLink}
      href={resolved.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      View location
    </a>
  );
}

/** The supporting document attached at sign-off: the proof the work was done.
 *  Shown wherever the sign-off is shown - on the closed action and on the
 *  history entry that recorded it - because a closure a reader cannot verify is
 *  only half a record. */
function EvidenceLink({ document }: { document: SafentiaDocument }) {
  const resolved = useStoredFileUrl(document.storagePath);
  return (
    <p className={styles.evidence}>
      <span className={styles.evidenceLabel}>Evidence</span>
      {resolved.failed ? (
        <span className={styles.evidenceUnavailable}>
          {document.fileName} (unavailable)
        </span>
      ) : resolved.url ? (
        <a
          className={styles.evidenceLink}
          href={resolved.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {document.fileName}
        </a>
      ) : (
        <span className={styles.evidenceUnavailable}>{document.fileName}</span>
      )}
    </p>
  );
}

/** The duty-holder's own report of progress, recorded from the customer portal
 *  (respondToAction). It is a CLAIM the organisation still has to verify, so it
 *  is presented as reported speech and, while the action is open, says outright
 *  what is owed here: sign-off. It never moves the action to signed off - only
 *  the Sign off control above does that. */
function CustomerResponse({
  response,
  status,
}: {
  response: ActionCustomerResponse;
  /** The action's current status: once it is signed off, the prompt to verify
   *  has been answered and must stop asking. */
  status: ActionStatus;
}) {
  return (
    <div className={styles.customerResponse}>
      <span className={styles.customerResponseLabel}>
        {CUSTOMER_CLAIM_LABELS[response.state]} &middot;{' '}
        {formatDateTime(response.at)}
      </span>
      {response.note && <span>{response.note}</span>}
      {status !== 'signedOff' && (
        <span className={styles.customerResponseAsk}>
          Verify the work, then sign this action off to close it.
        </span>
      )}
    </div>
  );
}

/** The compact per-action lifecycle trail (story 2044 AC3): what changed, when,
 *  by whom, and the completion note and evidence captured at sign-off. Oldest
 *  first, as the server appends it. */
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
            {formatDateTime(entry.at)} by{' '}
            {/* `response` is only ever set on an entry the CUSTOMER recorded,
                so it is what keeps their claim from reading as a colleague's
                move in the same trail. */}
            {entry.response
              ? 'the customer'
              : actorLabel(entry.byUid, viewerUid)}
          </span>
          {entry.response && (
            <span className={styles.historyClaim}>
              {CUSTOMER_CLAIM_LABELS[entry.response]}
            </span>
          )}
          {entry.note && (
            <span className={styles.historyNote}>{entry.note}</span>
          )}
          {entry.evidence && <EvidenceLink document={entry.evidence} />}
        </li>
      ))}
    </ol>
  );
}

function SeverityChip({ severity }: { severity: Severity }) {
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

/** One labelled supporting fact under the observation. */
function Fact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  );
}

/** The editable draft behind both the add and the edit forms. */
interface Draft {
  observation: string;
  severity: Severity;
  /** The CustomerContact who owes the work; null is Unassigned. The name is
   *  never held here - the server derives it from the contact record, so the
   *  plan cannot disagree with the directory about who somebody is. */
  responsibleContactId: string | null;
  dueBy: string;
  lifeProtection: boolean;
}
const EMPTY_DRAFT: Draft = {
  observation: '',
  severity: 'M',
  responsibleContactId: null,
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
  // The building's own responsible party, as a contact link: what a new action
  // starts on, so the usual case is confirming a choice rather than making one.
  const defaultContactId =
    buildingQuery.data?.responsibleParty?.contactId ?? null;
  const customerId = buildingQuery.data?.customerId ?? '';
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
  // The action whose sign-off dialog is open. Carries the observation so the
  // dialog can restate what is being closed without re-reading the plan.
  const [signingOff, setSigningOff] = useState<{
    id: string;
    observation: string;
  } | null>(null);
  // Reopen keeps its two-step press-then-confirm inline: the id awaiting its
  // confirm press.
  const [reopening, setReopening] = useState<string | null>(null);

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
    setReopening(null);
    manage.clearError();
  };

  // A new action starts on the building's default responsible party: the admin
  // confirms it (or picks someone else) rather than choosing again from
  // scratch. If the building read has not landed yet the picker simply opens on
  // nobody - the panel never blocks recording the finding.
  const newDraft = (): Draft => ({
    ...EMPTY_DRAFT,
    responsibleContactId: defaultContactId,
  });

  // An existing action opens on whatever it already carries. An action raised
  // before the contact linkage opens on nobody, which is honest: it has a name
  // on it but no person the platform can reach, and saving is what fixes that.
  const editDraft = (action: Action): Draft => ({
    observation: action.observation,
    severity: action.severity,
    responsibleContactId: action.responsibleContactId ?? null,
    dueBy: toDateInputValue(action.dueBy),
    lifeProtection: action.lifeProtection,
  });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.observation.trim()) {
      return;
    }
    const dueBy = fromDateInputValue(draft.dueBy);
    if (formTarget === 'new') {
      const result = await manage.call({
        action: 'create',
        buildingId,
        fields: {
          observation: draft.observation.trim(),
          severity: draft.severity,
          ...(draft.responsibleContactId
            ? { responsibleContactId: draft.responsibleContactId }
            : {}),
          ...(dueBy !== undefined ? { dueBy } : {}),
          lifeProtection: draft.lifeProtection,
        },
      });
      if (result) {
        setFormTarget(null);
      }
    } else if (formTarget) {
      // Edit: the whitelisted fields only; an emptied optional sends null (the
      // CLEAR intent), so choosing nobody or blanking the due date really
      // clears. Clearing the contact clears the recorded name with it - the
      // server keeps the pair together.
      const result = await manage.call({
        action: 'update',
        buildingId,
        actionId: formTarget,
        fields: {
          observation: draft.observation.trim(),
          severity: draft.severity,
          responsibleContactId: draft.responsibleContactId,
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

  const onConfirmReopen = async (id: string) => {
    const result = await manage.call({
      action: 'reopen',
      buildingId,
      actionId: id,
    });
    if (result) {
      setReopening(null);
    }
  };

  // Sign-off opens the dialog, where the completion note and the optional
  // supporting document have room. Shared by open and in-progress actions.
  const signOffButton = (row: ActionRow) => (
    <Button
      variant="secondary"
      onClick={() =>
        setSigningOff({ id: row.id, observation: row.action.observation })
      }
    >
      Sign off
    </Button>
  );

  // Reopen stays a two-step press-then-confirm: it is a smaller move than
  // sign-off (back to work, nothing captured), so it does not need a surface of
  // its own - but it does still change the legal reading of the plan.
  const reopenControl = (id: string) => {
    if (reopening !== id) {
      return (
        <Button variant="secondary" onClick={() => setReopening(id)}>
          Reopen
        </Button>
      );
    }
    return (
      <>
        <Button
          onClick={() => void onConfirmReopen(id)}
          disabled={manage.pending}
        >
          Confirm reopen
        </Button>
        <Button variant="secondary" onClick={() => setReopening(null)}>
          Cancel
        </Button>
      </>
    );
  };

  const cardActions = (row: ActionRow) => {
    if (row.action.status === 'open') {
      return (
        <>
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
          {signOffButton(row)}
        </>
      );
    }
    if (row.action.status === 'inProgress') {
      return (
        <>
          {signOffButton(row)}
          {reopenControl(row.id)}
        </>
      );
    }
    if (row.action.status === 'signedOff') {
      return reopenControl(row.id);
    }
    return null;
  };

  const hasActions = Object.keys(actionsQuery.data ?? {}).length > 0;

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
          {/* The responsible party is a contact and only a contact: this is who
              Safentia emails, so it cannot be a typed name. The picker's own
              "Add new contact" form covers anyone not in the directory yet. */}
          <div className={styles.field}>
            <ContactPicker
              customerId={customerId}
              label="Responsible"
              value={draft.responsibleContactId ?? undefined}
              onChange={(nextId) =>
                setDraft((current) => ({
                  ...current,
                  responsibleContactId: nextId,
                }))
              }
              allowNone
            />
            <p className={styles.formNote}>
              Safentia emails this person when the action is assigned to them
              and again as the due date approaches.
            </p>
          </div>
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

      {actionsQuery.isLoading && !actionsQuery.isError && (
        <SkeletonRows rows={3} label="Loading the action plan" />
      )}

      {rows.length === 0 && !actionsQuery.isLoading && !actionsQuery.isError && (
        <p className={styles.emptyNote}>
          {hasActions
            ? 'No actions match the current filters.'
            : 'No actions have been recorded for this building yet.'}
        </p>
      )}

      {rows.length > 0 && (
        <ul className={styles.cards} aria-label="Action plan">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`${styles.card} ${
                row.overdue && row.action.lifeProtection ? styles.cardUrgent : ''
              }`.trim()}
            >
              <div className={styles.stateRail}>
                <SeverityChip severity={row.action.severity} />
                <StatusChip status={row.action.status} />
                {row.action.lifeProtection && (
                  <span className={styles.ltpBadge}>Life protection</span>
                )}
                {row.overdue && (
                  <span className={styles.overdueBadge}>
                    {row.action.lifeProtection ? 'Overdue · LTP' : 'Overdue'}
                  </span>
                )}
                {/* The customer has said the work is done and nobody here has
                    checked yet: the one state on this card that is waiting on
                    US, so it reads in the state rail rather than only below. */}
                {row.action.customerResponse?.state === 'completed' &&
                  row.action.status !== 'signedOff' && (
                    <span className={styles.verifyBadge}>
                      Awaiting verification
                    </span>
                  )}
              </div>

              <p className={styles.observation}>{row.action.observation}</p>

              <dl className={styles.facts}>
                <Fact label="Responsible">
                  {row.action.responsible ?? 'Unassigned'}
                  {/* An action with a name but no contact behind it is one
                      nobody is being chased about. Say so on the card, rather
                      than leaving a silence to be discovered later. */}
                  {row.action.responsible &&
                    !row.action.responsibleContactId && (
                      <span className={styles.unlinkedNote}>
                        Not linked to a contact, so no reminders are emailed.
                        Edit this action to choose one.
                      </span>
                    )}
                </Fact>
                <Fact label="Due">
                  {row.action.dueBy === undefined ? (
                    'Not set'
                  ) : (
                    <span className={row.overdue ? styles.overdue : undefined}>
                      {formatDate(row.action.dueBy)}
                    </span>
                  )}
                </Fact>
                {row.action.signedOffAt !== undefined && (
                  <Fact label="Signed off">
                    {formatDateTime(row.action.signedOffAt)}
                    {row.action.signedOffBy
                      ? ` by ${actorLabel(row.action.signedOffBy, user?.uid)}`
                      : ''}
                  </Fact>
                )}
                {row.action.locationFlagUrl && (
                  <Fact label="Location">
                    <LocationFlagLink url={row.action.locationFlagUrl} />
                  </Fact>
                )}
              </dl>

              {row.action.customerResponse && (
                <CustomerResponse
                  response={row.action.customerResponse}
                  status={row.action.status}
                />
              )}
              {row.action.completionNote && (
                <p className={styles.completionNote}>
                  <span className={styles.completionLabel}>Completion note</span>
                  {row.action.completionNote}
                </p>
              )}
              {row.action.completionEvidence && (
                <EvidenceLink document={row.action.completionEvidence} />
              )}

              {isAdmin && (
                <div className={styles.cardActions}>{cardActions(row)}</div>
              )}

              {/* The lifecycle trail is available to every viewer, not just
                  admins, so a building owner can see how an action progressed. */}
              <details className={styles.history}>
                <summary className={styles.historySummary}>
                  History ({row.action.statusHistory?.length ?? 0})
                </summary>
                <StatusHistory
                  history={row.action.statusHistory ?? []}
                  viewerUid={user?.uid}
                />
              </details>
            </li>
          ))}
        </ul>
      )}

      {signingOff && (
        <SignOffDialog
          buildingId={buildingId}
          actionId={signingOff.id}
          observation={signingOff.observation}
          onClose={() => setSigningOff(null)}
        />
      )}
    </section>
  );
}
