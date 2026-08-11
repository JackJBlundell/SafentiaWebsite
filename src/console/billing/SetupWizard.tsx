// ============================================================================
// SetupWizard - the post-subscribe first-run wizard (PHASE3_BILLING_PLAN.md
// §3.1 step 7). Rendered full-screen by SetupGate once the webhook has
// provisioned the organisation (onboarding step 'setup') and until the wizard
// is finished or skipped through.
//
// Three working steps: Branding -> Team -> First customer. There is no Finish
// step in the stepper - the last pane's "Finish setup" hands over to the
// full-page SetupCompleteScreen (held ABOVE this component, because the gates
// unmount the wizard the moment the node flips to 'done' - see ConsoleRoute).
// The organisation's NAME and contact details are no longer collected here -
// the pre-payment details step (OrgDetailsPage/saveOnboardingDetails) gathered
// them and provisioning wrote them to the profile - so the first pane is
// branding only (colour pickers, entitlement-gated; the server still calls
// this step 'profile' in the skipTo vocabulary and setupDone marks). Buildings
// and jobs are DELIBERATELY not wizard steps - a building needs a customer, a
// site and often a photo, which is console work, not first-run work; the
// Getting Started checklist on the dashboard picks up from where this wizard
// leaves off (§7).
//
// The Team and First customer panes are LIST BUILDERS, one shared pattern:
// rows of pending entries with add/remove, one batch send with per-row
// outcomes (a sent row locks, a failed row shows the server's calm message and
// stays editable for retry), and the existing skip semantics unchanged.
//
// Two write channels, by design (§5.4):
// - The FORMS call the real business callables (updateOrgProfile,
//   createInvitation, manageCustomer) - never bespoke write paths - and the
//   server piggybacks the setupDone/{step} mark onto each successful write.
//   The tick therefore arrives through the LIVE usersOnboarding listener with
//   no client write at all.
// - NAVIGATION forward into new ground (skip, continue, finish) goes through
//   advanceOnboarding, the one callable allowed to move setupStep / stamp
//   completedAt. The server's setupStep records FURTHEST progress, not the
//   current position: Back (and moving forward again over ground already
//   advanced past) is purely local, so review never re-calls the server and a
//   reload still resumes at the furthest recorded step by construction.
// ============================================================================

import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { Wordmark } from '../../components/Wordmark';
import { DEFAULT_BRAND } from '../../design/tokens/palette';
import { usersOnboarding } from '../../paths';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { ORG_ROLES } from '../../types';
import type {
  AdvanceOnboardingRequest,
  AdvanceOnboardingResponse,
  CreateInvitationInput,
  CreateInvitationResult,
  ManageCustomerInput,
  ManageCustomerResult,
  OrgRole,
  UpdateOrgProfileInput,
  UpdateOrgProfileResult,
  UserOnboarding,
} from '../../types';
import { ROLE_LABELS } from '../staff/shared';
import { ErrorNotice } from '../ui/Page';
import { Stepper } from '../ui/Stepper';
import { useCallable } from '../ui/useCallable';
import type { SetupSummary } from './SetupCompleteScreen';
import { UpsellNotice } from './UpsellNotice';
import { useEntitlements } from './useEntitlements';
import styles from './SetupWizard.module.css';

export interface SetupWizardProps {
  /** The caller's onboarding node as SetupGate read it. The wizard subscribes
   *  to the same node live (same cache key), so this is the first paint and
   *  the live value takes over for setupDone ticks and step movements. */
  onboarding: UserOnboarding;
  /** Called the moment "Finish setup" is pressed, with what this session
   *  actually did. The holder (ConsoleRoute) renders SetupCompleteScreen while
   *  the flag is set - the wizard itself unmounts when the node flips 'done',
   *  so the celebration cannot live here. */
  onCelebrate: (summary: SetupSummary) => void;
}

/** Stepper labels, in order. Exactly the three WORKING steps - finishing is
 *  its own full-page moment (SetupCompleteScreen), not a stepper entry. The
 *  first pane is 'Branding' in the UI but 'profile' to the server (skipTo /
 *  setupDone vocabulary, kept for compatibility - updateOrgProfile stamps
 *  that mark). */
const STEP_LABELS = ['Branding', 'Team', 'First customer'] as const;

/** Where a first-time forward movement from pane 0/1 lands the server's
 *  setupStep. Pane 2's forward action is finish, not a skipTo. */
const FORWARD_TARGETS = ['team', 'customer'] as const;

/** How far the node's recorded setupStep says this admin has ever got. Used
 *  for two things: the reload resume point (clamped to the last pane for
 *  safety), and deciding whether a forward movement breaks new ground (call
 *  advanceOnboarding) or merely re-crosses reviewed ground (local only). */
function furthestIndex(step: UserOnboarding['setupStep']): number {
  switch (step) {
    case 'team':
      return 1;
    case 'customer':
      return 2;
    default:
      return 0;
  }
}

// --- List-builder row models (lifted to the wizard so Back never loses what
// --- was typed: the panes unmount on every pane switch).

type RowStatus = 'draft' | 'sent' | 'failed';

export interface InviteRow {
  id: number;
  email: string;
  role: OrgRole;
  status: RowStatus;
  /** The server's calm message when the send failed; cleared on edit. */
  error: string | null;
}

export interface CustomerRow {
  id: number;
  name: string;
  contactName: string;
  contactEmail: string;
  status: RowStatus;
  error: string | null;
}

/** Wizard-local caps on batch size. Invitations: createInvitation is rate
 *  limited to 10/min server-side, so one batch never exceeds it. Customers:
 *  the console proper is the place for bulk entry; the wizard seeds a first
 *  handful. */
const INVITE_ROW_CAP = 10;
const CUSTOMER_ROW_CAP = 5;

/** Format sanity only - the server (and the mailbox) are the real validators.
 *  Kept loose on purpose: rejecting an unusual-but-real address here would be
 *  worse than letting the server answer. */
const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;

let nextRowId = 1;
const freshInviteRow = (): InviteRow => ({
  id: nextRowId++,
  email: '',
  role: 'assessor',
  status: 'draft',
  error: null,
});
const freshCustomerRow = (): CustomerRow => ({
  id: nextRowId++,
  name: '',
  contactName: '',
  contactEmail: '',
  status: 'draft',
  error: null,
});

export default function SetupWizard({ onboarding, onCelebrate }: SetupWizardProps) {
  const { user } = useAuth();
  const uid = user?.uid ?? '';

  // Live view of the node: server-side piggyback marks (setupDone) and any
  // movement made in another tab land here without client writes. Shares
  // SetupGate's cache key, so the listener is warm from the first paint.
  const live = useRtdbQuery<UserOnboarding | null>({
    key: keys.userOnboarding(uid),
    path: usersOnboarding(uid),
    enabled: Boolean(uid),
  });
  const node = live.data ?? onboarding;
  const done = node.setupDone ?? {};

  // The CURRENT pane is local state; the server records only the FURTHEST
  // step (see file header). A reload resumes at the furthest point, clamped
  // to the last pane now that finishing is no longer a pane of its own.
  const [current, setCurrent] = useState<number>(() =>
    Math.min(furthestIndex(onboarding.setupStep), STEP_LABELS.length - 1),
  );

  // Pane state lives here so Back (which unmounts the pane) loses nothing.
  const [brandingSaved, setBrandingSaved] = useState(false);
  const [inviteRows, setInviteRows] = useState<InviteRow[]>(() => [freshInviteRow()]);
  const [customerRows, setCustomerRows] = useState<CustomerRow[]>(() => [
    freshCustomerRow(),
  ]);

  const advance = useCallable<AdvanceOnboardingRequest, AdvanceOnboardingResponse>(
    'advanceOnboarding',
  );

  /** Move forward from pane 0 or 1. New ground (beyond the furthest recorded
   *  step) is recorded server-side FIRST so a reload resumes there; reviewed
   *  ground (the admin came Back and is returning) moves locally only - the
   *  server already knows. */
  const goForward = async (from: 0 | 1) => {
    if (furthestIndex(node.setupStep) > from) {
      setCurrent(from + 1);
      return;
    }
    const result = await advance.call({ skipTo: FORWARD_TARGETS[from] });
    if (result) setCurrent(from + 1);
  };

  /** Back is purely local review - no advanceOnboarding, no step rewind. */
  const goBack = (to: 0 | 1) => setCurrent(to);

  const finish = () => {
    // Celebrate immediately and let the server catch up in the background:
    // awaiting here would race SetupGate's unmount (the node flips 'done' the
    // moment the call lands). If the call fails the node stays at 'setup' and
    // the CTA simply lands back in the wizard - rare, and recoverable.
    onCelebrate({
      brandingSaved,
      invitesSent: inviteRows.filter((row) => row.status === 'sent').length,
      customersAdded: customerRows.filter((row) => row.status === 'sent').length,
    });
    void advance.call({ finish: true });
  };

  return (
    <main className={styles.root}>
      <div className={styles.panel}>
        <Wordmark size="lg" />
        <h1 className={styles.heading}>Let&rsquo;s set up your organisation</h1>
        <Stepper steps={STEP_LABELS} current={current} />
        {current === 0 && (
          <BrandingPane
            done={done.profile === true}
            advancePending={advance.pending}
            advanceError={advance.error}
            onForward={() => goForward(0)}
            saved={brandingSaved}
            onSaved={() => setBrandingSaved(true)}
          />
        )}
        {current === 1 && (
          <TeamPane
            done={done.team === true}
            advancePending={advance.pending}
            advanceError={advance.error}
            onForward={() => goForward(1)}
            onBack={() => goBack(0)}
            rows={inviteRows}
            setRows={setInviteRows}
          />
        )}
        {current === 2 && (
          <CustomerPane
            done={done.customer === true}
            advancePending={advance.pending}
            advanceError={advance.error}
            onFinish={finish}
            onBack={() => goBack(1)}
            rows={customerRows}
            setRows={setCustomerRows}
          />
        )}
      </div>
    </main>
  );
}

// ============================================================================
// Shared pane scaffolding
// ============================================================================

function PaneHeader({ title, done, copy }: { title: string; done: boolean; copy: string }) {
  return (
    <header className={styles.paneHeader}>
      <h2 className={styles.paneTitle}>
        {title}
        {done && (
          <span className={styles.doneChip} role="status">
            <span aria-hidden="true">✓</span> Done
          </span>
        )}
      </h2>
      <p className={styles.paneCopy}>{copy}</p>
    </header>
  );
}

/** The forward control every working pane carries: 'Skip for now' until the
 *  step's mark has landed, 'Continue' once it has (ticked steps let you move
 *  on - the same movement either way, per the advanceOnboarding contract).
 *  The last pane passes its own terminal label ('Finish setup'). */
function ForwardButton({
  done,
  pending,
  onForward,
  label,
}: {
  done: boolean;
  pending: boolean;
  onForward: () => void;
  label?: { done: string; todo: string };
}) {
  const labels = label ?? { done: 'Continue', todo: 'Skip for now' };
  return (
    <Button
      type="button"
      variant={done ? 'primary' : 'ghost'}
      disabled={pending}
      onClick={onForward}
    >
      {done ? labels.done : labels.todo}
    </Button>
  );
}

/** The quiet review control on panes 1 and 2. Local only - the server records
 *  furthest progress, never the current position, so going back to look at an
 *  earlier pane is not a movement it needs to hear about. */
function BackButton({ pending, onBack }: { pending: boolean; onBack: () => void }) {
  return (
    <Button type="button" variant="ghost" disabled={pending} onClick={onBack}>
      Back
    </Button>
  );
}

interface PaneProps {
  done: boolean;
  advancePending: boolean;
  advanceError: string | null;
  onForward: () => void;
}

// ============================================================================
// Step 1 - Branding (updateOrgProfile). The org's name and contact details
// were collected before payment (OrgDetailsPage) and provisioned onto the
// profile, so this pane is colours only - entitlement-gated exactly as the
// server gates them (§6). Non-entitled plans see the upsell and skip on.
// ============================================================================

function BrandingPane(
  pane: PaneProps & { saved: boolean; onSaved: () => void },
) {
  const save = useCallable<UpdateOrgProfileInput, UpdateOrgProfileResult>(
    'updateOrgProfile',
  );
  const { entitlements, isAdmin } = useEntitlements();
  const branding = entitlements.features.branding;

  const [primary, setPrimary] = useState<string>(DEFAULT_BRAND.primary);
  const [secondary, setSecondary] = useState<string>(DEFAULT_BRAND.secondary);

  const pending = save.pending || pane.advancePending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Colours only: the server rejects branded fields without the feature
    // (§6), and this form does not render without it (see below).
    const result = await save.call({
      profile: { brand: { primary, secondary } },
    });
    if (result) {
      pane.onSaved();
      pane.onForward();
    }
  };

  return (
    <section className={styles.pane}>
      <PaneHeader
        title="Your branding"
        done={pane.done}
        copy="Your organisation's details are already set up. Choose the colours your reports and customer portal wear - you can change them at any time from Settings."
      />
      {branding ? (
        <form className={styles.form} onSubmit={submit}>
          <div className={styles.colourRow}>
            <ColourField
              id="setup-brand-primary"
              label="Primary colour"
              value={primary}
              onChange={setPrimary}
              disabled={pending}
            />
            <ColourField
              id="setup-brand-secondary"
              label="Secondary colour"
              value={secondary}
              onChange={setSecondary}
              disabled={pending}
            />
          </div>
          {save.error && <ErrorNotice message={save.error} />}
          {pane.advanceError && <ErrorNotice message={pane.advanceError} />}
          {pane.saved && (
            <p className={styles.status} role="status">
              Branding saved.
            </p>
          )}
          <div className={styles.actions}>
            <Button type="submit" disabled={pending}>
              Save and continue
            </Button>
            <ForwardButton done={pane.done} pending={pending} onForward={pane.onForward} />
          </div>
        </form>
      ) : (
        <div className={styles.form}>
          <UpsellNotice
            message="Brand colours are part of the Silver plan and above. Your reports use the Safentia look until you upgrade."
            isAdmin={isAdmin}
          />
          {pane.advanceError && <ErrorNotice message={pane.advanceError} />}
          <div className={styles.actions}>
            <ForwardButton done={pane.done} pending={pending} onForward={pane.onForward} />
          </div>
        </div>
      )}
    </section>
  );
}

function ColourField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.colourInput}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </div>
  );
}

// ============================================================================
// Step 2 - Team (createInvitation, one batch of rows sent sequentially)
// ============================================================================

function TeamPane({
  done,
  advancePending,
  advanceError,
  onForward,
  onBack,
  rows,
  setRows,
}: PaneProps & {
  onBack: () => void;
  rows: InviteRow[];
  setRows: Dispatch<SetStateAction<InviteRow[]>>;
}) {
  const invite = useCallable<CreateInvitationInput, CreateInvitationResult>(
    'createInvitation',
  );
  const { entitlements, usage, plan } = useEntitlements();
  const [sending, setSending] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const pending = sending || advancePending;

  // --- Allowance maths. limits.orgStaff is the plan's seat ceiling (-1 =
  // unlimited); usage.staffCount is the server-maintained live headcount.
  // Every row in the list - sent or not - consumes allowance, so the remaining
  // figure is ceiling minus existing staff minus the whole list. Presentation
  // only: the server's own limit check remains the boundary.
  const staffLimit = entitlements.limits.orgStaff;
  const unlimited = staffLimit === -1;
  const staffCount = usage?.staffCount ?? 0;
  const remaining = unlimited
    ? Number.POSITIVE_INFINITY
    : Math.max(0, staffLimit - staffCount - rows.length);
  const atRowCap = rows.length >= INVITE_ROW_CAP;
  const canAddRow = !atRowCap && remaining > 0;

  const unsent = rows.filter((row) => row.status !== 'sent');
  const sendCount = unsent.filter((row) => row.email.trim()).length;

  /** Format + duplicate validation across the list; used by both add and send.
   *  Returns the first problem's message, or null when the list is clean. */
  const validate = (candidates: InviteRow[]): string | null => {
    const seen = new Set<string>();
    for (const row of candidates) {
      const email = row.email.trim().toLowerCase();
      if (!email) continue;
      if (!EMAIL_SHAPE.test(email)) {
        return `${row.email.trim()} does not look like an email address.`;
      }
      if (seen.has(email)) {
        return `${row.email.trim()} is already in the list.`;
      }
      seen.add(email);
    }
    return null;
  };

  const addRow = () => {
    const problem = validate(rows);
    if (problem) {
      setListError(problem);
      return;
    }
    setListError(null);
    setRows((current) => [...current, freshInviteRow()]);
  };

  const removeRow = (id: number) =>
    setRows((current) => current.filter((row) => row.id !== id));

  const editRow = (id: number, patch: Partial<Pick<InviteRow, 'email' | 'role'>>) =>
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? { ...row, ...patch, status: 'draft' as const, error: null }
          : row,
      ),
    );

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const targets = rows.filter((row) => row.status !== 'sent' && row.email.trim());
    if (targets.length === 0) return;
    const problem = validate(rows);
    if (problem) {
      setListError(problem);
      return;
    }
    setListError(null);
    setSending(true);
    try {
      // Sequential on purpose: createInvitation is rate limited (10/min) and
      // each success piggybacks the setupDone/team mark server-side, so the
      // step ticks itself the moment the first send lands.
      for (const row of targets) {
        const outcome = await invite.callWithFailure({
          email: row.email.trim(),
          roles: { [row.role]: true },
        });
        setRows((current) =>
          current.map((r) =>
            r.id === row.id
              ? outcome.data
                ? { ...r, status: 'sent' as const, error: null }
                : {
                    ...r,
                    status: 'failed' as const,
                    error:
                      outcome.failure?.message ??
                      'Something went wrong. Please try again.',
                  }
              : r,
          ),
        );
      }
    } finally {
      setSending(false);
    }
  };

  const headerCopy = unlimited
    ? 'Colleagues receive an email invitation and choose their own password. You can invite more people at any time from Settings.'
    : `Your ${plan?.name ?? 'current'} plan includes up to ${staffLimit} team members. Colleagues receive an email invitation and choose their own password.`;

  return (
    <section className={styles.pane}>
      <PaneHeader title="Invite your team" done={done} copy={headerCopy} />
      <form className={styles.form} onSubmit={send}>
        <ul className={styles.rows}>
          {rows.map((row) => (
            <li key={row.id} className={styles.row}>
              {row.status === 'sent' ? (
                <p className={styles.rowSent} role="status">
                  <span aria-hidden="true">✓</span> Invitation sent to{' '}
                  <strong>{row.email.trim()}</strong> ({ROLE_LABELS[row.role]})
                </p>
              ) : (
                <>
                  <div className={styles.rowFields}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={`invite-email-${row.id}`}>
                        Email address
                      </label>
                      <input
                        id={`invite-email-${row.id}`}
                        className={styles.input}
                        type="email"
                        value={row.email}
                        onChange={(event) =>
                          editRow(row.id, { email: event.target.value })
                        }
                        disabled={pending}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={`invite-role-${row.id}`}>
                        Role
                      </label>
                      <select
                        id={`invite-role-${row.id}`}
                        className={styles.input}
                        value={row.role}
                        onChange={(event) =>
                          editRow(row.id, { role: event.target.value as OrgRole })
                        }
                        disabled={pending}
                      >
                        {ORG_ROLES.map((option) => (
                          <option key={option} value={option}>
                            {ROLE_LABELS[option]}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {row.error && <p className={styles.rowError}>{row.error}</p>}
                  {rows.length > 1 && (
                    <button
                      type="button"
                      className={styles.removeButton}
                      aria-label={`Remove ${row.email.trim() || 'this row'}`}
                      onClick={() => removeRow(row.id)}
                      disabled={pending}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <div className={styles.addRowLine}>
          <Button type="button" variant="ghost" disabled={pending || !canAddRow} onClick={addRow}>
            Add another
          </Button>
          {!canAddRow && (
            <p className={styles.allowanceNote}>
              {atRowCap
                ? 'That is the most invitations one batch can send - you can invite more from Settings.'
                : "That's everyone your plan includes - you can add more seats from Settings later."}
            </p>
          )}
        </div>
        {listError && <ErrorNotice message={listError} />}
        {advanceError && <ErrorNotice message={advanceError} />}
        <div className={styles.actions}>
          <Button type="submit" disabled={pending || sendCount === 0}>
            {/* "Send 0 invites" reads as a bug; the empty state names the
                action, the counted label appears once there is a count. */}
            {sendCount === 0
              ? 'Send invites'
              : `Send ${sendCount} invite${sendCount === 1 ? '' : 's'}`}
          </Button>
          <ForwardButton
            done={done || rows.some((row) => row.status === 'sent')}
            pending={pending}
            onForward={onForward}
          />
          <BackButton pending={pending} onBack={onBack} />
        </div>
      </form>
    </section>
  );
}

// ============================================================================
// Step 3 - First customer (manageCustomer creates, same list-builder pattern)
// ============================================================================

function CustomerPane({
  done,
  advancePending,
  advanceError,
  onFinish,
  onBack,
  rows,
  setRows,
}: Omit<PaneProps, 'onForward'> & {
  onFinish: () => void;
  onBack: () => void;
  rows: CustomerRow[];
  setRows: Dispatch<SetStateAction<CustomerRow[]>>;
}) {
  const create = useCallable<ManageCustomerInput, ManageCustomerResult>(
    'manageCustomer',
  );
  const [sending, setSending] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const pending = sending || advancePending;

  // Row cap only - the console proper is the place for bulk customer entry.
  const atRowCap = rows.length >= CUSTOMER_ROW_CAP;

  const complete = (row: CustomerRow) =>
    Boolean(row.name.trim() && row.contactName.trim());
  const sendCount = rows.filter((row) => row.status !== 'sent' && complete(row)).length;

  const addRow = () => {
    // A new row only makes sense once the ones before it hold a customer.
    const unfinished = rows.find((row) => row.status !== 'sent' && !complete(row));
    if (unfinished) {
      setListError('Give every customer a name and a primary contact before adding another.');
      return;
    }
    setListError(null);
    setRows((current) => [...current, freshCustomerRow()]);
  };

  const removeRow = (id: number) =>
    setRows((current) => current.filter((row) => row.id !== id));

  const editRow = (
    id: number,
    patch: Partial<Pick<CustomerRow, 'name' | 'contactName' | 'contactEmail'>>,
  ) =>
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? { ...row, ...patch, status: 'draft' as const, error: null }
          : row,
      ),
    );

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const targets = rows.filter((row) => row.status !== 'sent' && complete(row));
    if (targets.length === 0) return;
    setListError(null);
    setSending(true);
    try {
      // Sequential, mirroring the team pane: each success piggybacks the
      // setupDone/customer mark server-side, so the step ticks itself.
      for (const row of targets) {
        const outcome = await create.callWithFailure({
          action: 'create',
          customer: { name: row.name.trim() },
          primaryContact: {
            name: row.contactName.trim(),
            ...(row.contactEmail.trim() ? { email: row.contactEmail.trim() } : {}),
          },
        });
        setRows((current) =>
          current.map((r) =>
            r.id === row.id
              ? outcome.data
                ? { ...r, status: 'sent' as const, error: null }
                : {
                    ...r,
                    status: 'failed' as const,
                    error:
                      outcome.failure?.message ??
                      'Something went wrong. Please try again.',
                  }
              : r,
          ),
        );
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={styles.pane}>
      <PaneHeader
        title="Add your first customers"
        done={done}
        copy="A customer is an organisation you assess for. Give their primary contact an email address and they are invited to the customer portal automatically."
      />
      <form className={styles.form} onSubmit={send}>
        <ul className={styles.rows}>
          {rows.map((row) => (
            <li key={row.id} className={styles.row}>
              {row.status === 'sent' ? (
                <p className={styles.rowSent} role="status">
                  <span aria-hidden="true">✓</span> Customer added:{' '}
                  <strong>{row.name.trim()}</strong>
                </p>
              ) : (
                <>
                  <div className={styles.rowFields}>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={`customer-name-${row.id}`}>
                        Customer name
                      </label>
                      <input
                        id={`customer-name-${row.id}`}
                        className={styles.input}
                        type="text"
                        value={row.name}
                        onChange={(event) => editRow(row.id, { name: event.target.value })}
                        disabled={pending}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={`customer-contact-${row.id}`}>
                        Primary contact name
                      </label>
                      <input
                        id={`customer-contact-${row.id}`}
                        className={styles.input}
                        type="text"
                        value={row.contactName}
                        onChange={(event) =>
                          editRow(row.id, { contactName: event.target.value })
                        }
                        disabled={pending}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={`customer-email-${row.id}`}>
                        Contact email <span className={styles.optional}>(optional)</span>
                      </label>
                      <input
                        id={`customer-email-${row.id}`}
                        className={styles.input}
                        type="email"
                        value={row.contactEmail}
                        onChange={(event) =>
                          editRow(row.id, { contactEmail: event.target.value })
                        }
                        disabled={pending}
                      />
                    </div>
                  </div>
                  {row.error && <p className={styles.rowError}>{row.error}</p>}
                  {rows.length > 1 && (
                    <button
                      type="button"
                      className={styles.removeButton}
                      aria-label={`Remove ${row.name.trim() || 'this row'}`}
                      onClick={() => removeRow(row.id)}
                      disabled={pending}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <div className={styles.addRowLine}>
          <Button type="button" variant="ghost" disabled={pending || atRowCap} onClick={addRow}>
            Add another
          </Button>
          {atRowCap && (
            <p className={styles.allowanceNote}>
              A handful is plenty to start with - add the rest from the Customers page.
            </p>
          )}
        </div>
        {listError && <ErrorNotice message={listError} />}
        {advanceError && <ErrorNotice message={advanceError} />}
        <div className={styles.actions}>
          <Button type="submit" disabled={pending || sendCount === 0}>
            {/* Same empty-state rule as the invites pane: never "Add 0". */}
            {sendCount === 0
              ? 'Add customers'
              : `Add ${sendCount} customer${sendCount === 1 ? '' : 's'}`}
          </Button>
          <ForwardButton
            done
            pending={pending}
            onForward={onFinish}
            label={{ done: 'Finish setup', todo: 'Finish setup' }}
          />
          <BackButton pending={pending} onBack={onBack} />
        </div>
      </form>
    </section>
  );
}
