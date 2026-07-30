// ============================================================================
// ContactCreateDialog - add a person at a customer organisation, in one modal.
//
// Creating a contact can send that person an email, so the consequence is
// stated on the form rather than discovered afterwards. manageCustomerContact
// auto-issues a portal invitation when the new contact has BOTH an email
// address AND at least one portal role (see autoInvitePortalContact); with
// neither, or only one of the two, nothing is sent. The notice below is derived
// from the live field values so it can never promise an email that will not go.
//
// Editing an existing contact stays inline beneath its card; this dialog is the
// create path only, where the invitation decision is being made for the first
// time.
//
// This file also owns the console's one description of what a portal role MEANS
// (CUSTOMER_ROLE_META, PortalRoleChoice, PORTAL_ROLE_SCOPE_NOTE). A role is a
// grant of access to somebody else's fire-safety information, so the meaning
// travels with the control rather than living in a help page: the contacts panel
// renders the same picker at invite time and reads the same labels back
// afterwards, and neither can drift from the other.
//
// Accessibility: focus moves into the dialog on open, Tab is trapped within it,
// Escape closes, and focus returns to whatever opened it - the same posture as
// ImportDialog and CreateOrganisationDialog.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { CUSTOMER_ROLES } from '../../types';
import type {
  ClearableFields,
  CustomerContact,
  CustomerRole,
  CustomerRoleSet,
  ManageCustomerContactInput,
  ManageCustomerContactResult,
} from '../../types';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { isValidEmail } from './shared';
import shared from './shared.module.css';
import styles from './ContactCreateDialog.module.css';

const FOCUSABLE =
  'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])';

export interface PortalRoleMeta {
  label: string;
  /** One plain line: what holding this role actually lets the person do. */
  meaning: string;
}

/**
 * The three portal roles, and what each one grants TODAY. Deliberately modest:
 * the portal's read rules are scoped by customer, not by role, so finance and
 * viewer see exactly the same information - only `admin` unlocks anything extra
 * (the portal's own team page, and the portalInviteTeammate callable). Claiming
 * a difference between finance and viewer would be a promise the rules do not
 * keep, and an admin choosing a role has to be able to trust this copy.
 *
 * One definition, exported: the contacts panel, the create dialog and every
 * other console surface that names a portal role reads it from here, so the
 * wording cannot drift between the place a role is granted and the place it is
 * later checked.
 */
export const CUSTOMER_ROLE_META: Record<CustomerRole, PortalRoleMeta> = {
  admin: {
    label: 'Portal admin',
    meaning:
      'Sees this customer’s reports, buildings and actions, and can invite their own colleagues into the portal.',
  },
  finance: {
    label: 'Finance',
    meaning:
      'Sees the same reports, buildings and actions as a viewer. A label for billing contacts; it grants nothing extra today.',
  },
  viewer: {
    label: 'Viewer',
    meaning:
      'Sees this customer’s reports, buildings and actions. Cannot invite anyone.',
  },
};

/** The sentence that keeps the word "admin" honest. A portal admin runs their
 *  own organisation's portal; they are not staff of the fire-safety org and
 *  hold nothing in this console. Shown wherever a portal role is granted. */
export const PORTAL_ROLE_SCOPE_NOTE =
  'These roles apply to this customer’s own portal only. A portal admin is not an administrator of your Safentia console, and can never see another customer’s information.';

/**
 * The sentence that keeps the report-copies setting honest, and the reason it
 * lives beside PORTAL_ROLE_SCOPE_NOTE rather than in the panel that renders it:
 * turning report copies off is the console's easiest act to misread. It stops
 * ONE email. Somebody who reads it as "stop emailing this person" and switches
 * it off for a caretaker has quietly decided the caretaker should also miss the
 * visit notice and the chase about the fire door they owe - so the boundary is
 * stated at every place the setting is shown or changed, from one definition
 * neither surface can drift from.
 */
export const REPORT_SCOPE_NOTE =
  'This covers released fire risk assessment reports only. Review reminders, visit notices and emails about actions someone is responsible for are sent for a different reason and are never affected by it.';

/** The labels a role set carries, in canonical order. */
export function portalRoleLabels(
  roles: CustomerRoleSet | null | undefined,
): string[] {
  return CUSTOMER_ROLES.filter((role) => roles?.[role] === true).map(
    (role) => CUSTOMER_ROLE_META[role].label,
  );
}

/** "Viewer", or "Viewer and Finance" - a role list read aloud rather than
 *  comma-jammed, because it lands mid-sentence in copy an admin is relying on. */
export function formatRoleList(labels: string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The role choice itself: every role named, with its one line of meaning beside
 * it and the scope note underneath. Shared by the create dialog and the contacts
 * panel's invite step so a role is never granted from a bare checkbox whose
 * consequence lives somewhere else.
 */
export function PortalRoleChoice({
  legend,
  intro,
  roles,
  disabled,
  onToggle,
}: {
  legend: string;
  intro: string;
  roles: CustomerRoleSet;
  disabled?: boolean;
  onToggle: (role: CustomerRole, on: boolean) => void;
}) {
  return (
    <fieldset className={styles.roles}>
      <legend className={styles.sectionTitle}>{legend}</legend>
      <p className={styles.copy}>{intro}</p>
      {CUSTOMER_ROLES.map((role) => (
        <label key={role} className={styles.roleRow}>
          <input
            type="checkbox"
            className={styles.roleCheckbox}
            checked={roles[role] === true}
            disabled={disabled}
            onChange={(event) => onToggle(role, event.target.checked)}
          />
          <span className={styles.roleText}>
            <span className={styles.roleLabel}>
              {CUSTOMER_ROLE_META[role].label}
            </span>
            <span className={styles.roleMeaning}>
              {CUSTOMER_ROLE_META[role].meaning}
            </span>
          </span>
        </label>
      ))}
      <p className={styles.roleScope}>{PORTAL_ROLE_SCOPE_NOTE}</p>
    </fieldset>
  );
}

/** What saving this form will do about email, worked out from the same two
 *  inputs the server uses. The message names the ROLE being granted, so the
 *  admin reads back what they are handing over before they hand it over; a
 *  "nothing will be sent" outcome says which field is missing. */
interface InviteOutcome {
  willInvite: boolean;
  message: string;
}

function describeInvite(email: string, roleLabels: string[]): InviteOutcome {
  const trimmed = email.trim();
  const roleCount = roleLabels.length;
  const emailUsable = trimmed.length > 0 && isValidEmail(trimmed);
  if (emailUsable && roleCount > 0) {
    return {
      willInvite: true,
      message: `Saving will email ${trimmed} an invitation to the customer portal as ${formatRoleList(roleLabels)}. They get that access once they accept it.`,
    };
  }
  if (roleCount === 0 && trimmed.length === 0) {
    return {
      willInvite: false,
      message:
        'No invitation will be sent. Add an email address and tick at least one portal role to give this person access to the customer portal.',
    };
  }
  if (roleCount === 0) {
    return {
      willInvite: false,
      message:
        'No invitation will be sent. Tick at least one portal role to give this person access to the customer portal.',
    };
  }
  if (trimmed.length === 0) {
    return {
      willInvite: false,
      message:
        'No invitation will be sent. Add an email address so the invitation has somewhere to go.',
    };
  }
  return {
    willInvite: false,
    message:
      'No invitation will be sent. That email address is not valid, so there is nowhere to send it.',
  };
}

export function ContactCreateDialog({
  customerId,
  onClose,
}: {
  customerId: string;
  onClose: () => void;
}) {
  const manage = useCallable<
    ManageCustomerContactInput,
    ManageCustomerContactResult
  >('manageCustomerContact');

  const [name, setName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // Ticked by default, because that is what the platform does with a contact
  // who says nothing: absent means "send them the report" (see
  // CustomerContact.receivesReports). The form starts where the schema starts.
  const [receivesReports, setReceivesReports] = useState(true);
  const [roles, setRoles] = useState<CustomerRoleSet>({});
  const [fieldError, setFieldError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);

  const busy = manage.pending;

  // Never abandon the flow mid-callable: the contact may already exist by then,
  // and the invitation email is sent on the back of that same write.
  const close = useCallback(() => {
    if (busy) {
      return;
    }
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    headingRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
      }
    };
  }, []);

  // Escape closes; Tab wraps within the dialog.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) {
        return;
      }
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => !element.hasAttribute('disabled'));
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  const chosenLabels = useMemo(() => portalRoleLabels(roles), [roles]);
  const roleCount = chosenLabels.length;
  const outcome = useMemo(
    () => describeInvite(email, chosenLabels),
    [email, chosenLabels],
  );

  const toggleRole = (role: CustomerRole, on: boolean) => {
    setRoles((current) => {
      const next: CustomerRoleSet = { ...current };
      // A role set is optional `true` flags, so "off" means the key is absent.
      if (on) next[role] = true;
      else delete next[role];
      return next;
    });
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter the contact name.');
      return;
    }
    const trimmedEmail = email.trim();
    if (trimmedEmail && !isValidEmail(trimmedEmail)) {
      setFieldError('Enter a valid email address, or leave the field empty.');
      return;
    }
    if (roleCount > 0 && !trimmedEmail) {
      setFieldError(
        'Portal access needs an email address. Add one, or clear the portal roles.',
      );
      return;
    }
    setFieldError(null);

    const payload: ClearableFields<CustomerContact> = { name: trimmedName };
    if (trimmedEmail) payload.email = trimmedEmail;
    const trimmedPhone = phone.trim();
    if (trimmedPhone) payload.phone = trimmedPhone;
    const trimmedJob = jobTitle.trim();
    if (trimmedJob) payload.jobTitle = trimmedJob;
    // Only the opt-out is worth sending: the server stores `false` and treats
    // `true` as the default it does not need to record.
    if (!receivesReports) payload.receivesReports = false;
    if (roleCount > 0) payload.portalRoles = roles;

    const result = await manage.call({
      action: 'create',
      customerId,
      contact: payload,
    });
    if (result) {
      onClose();
    }
  };

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={close}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.head}>
          <h2
            id="contact-dialog-title"
            className={styles.title}
            ref={headingRef}
            tabIndex={-1}
          >
            Add contact
          </h2>
          <p className={styles.copy}>
            Someone you deal with at this organisation. Portal access is
            optional, and the role you tick below is the one they will hold.
          </p>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Who they are</h3>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="contact-dialog-name">
                Name
              </label>
              <input
                id="contact-dialog-name"
                className={shared.input}
                type="text"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="contact-dialog-job">
                Job title (optional)
              </label>
              <input
                id="contact-dialog-job"
                className={shared.input}
                type="text"
                autoComplete="off"
                value={jobTitle}
                onChange={(event) => setJobTitle(event.target.value)}
              />
            </div>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="contact-dialog-email">
                Email (optional)
              </label>
              <input
                id="contact-dialog-email"
                className={shared.input}
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="contact-dialog-phone">
                Phone (optional)
              </label>
              <input
                id="contact-dialog-phone"
                className={shared.input}
                type="tel"
                autoComplete="off"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Report emails</h3>
            <div className={styles.reports}>
              <label className={styles.roleRow}>
                <input
                  type="checkbox"
                  className={styles.roleCheckbox}
                  checked={receivesReports}
                  disabled={busy}
                  onChange={(event) =>
                    setReceivesReports(event.target.checked)
                  }
                />
                <span className={styles.roleText}>
                  <span className={styles.roleLabel}>
                    Send them released reports
                  </span>
                  <span className={styles.roleMeaning}>
                    They get a copy of every released fire risk assessment for
                    this customer. Untick it for someone who deals with one
                    building job — a door check, a contractor visit — and does
                    not need the whole assessment.
                  </span>
                </span>
              </label>
              <p className={styles.roleScope}>{REPORT_SCOPE_NOTE}</p>
            </div>
            {/* The tick is a preference, not a promise: with no address there is
                nothing to send. Said here rather than by disabling the control,
                because the email field is one section up and still being
                filled in. */}
            {email.trim().length === 0 && (
              <p className={styles.reportBlocked}>
                No email address yet, so nothing can be sent to this person at
                all — not reports, reminders, visit notices or action emails.
                This choice is kept for when an address is added.
              </p>
            )}
          </section>

          <section className={styles.section}>
            <PortalRoleChoice
              legend="Portal access"
              intro="Ticking a role is what gives this person a way into the customer portal, and it is the role they will hold once they accept. Leave them all clear and they stay a contact record only. Viewer is the usual starting point."
              roles={roles}
              disabled={busy}
              onToggle={toggleRole}
            />

            <p
              className={
                outcome.willInvite ? styles.noticeSend : styles.noticeQuiet
              }
              role="status"
            >
              <span className={styles.noticeLabel}>
                {outcome.willInvite ? 'An email will be sent' : 'No email'}
              </span>
              <span className={styles.noticeCopy}>{outcome.message}</span>
            </p>
          </section>

          {fieldError && <ErrorNotice message={fieldError} />}
          {manage.error && <ErrorNotice message={manage.error} />}
        </div>

        <footer className={styles.footer}>
          <Button disabled={busy} onClick={() => void save()}>
            {busy
              ? 'Saving'
              : outcome.willInvite
                ? `Add and invite as ${formatRoleList(chosenLabels)}`
                : 'Add contact'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
        </footer>
      </div>
    </div>
  );
}
