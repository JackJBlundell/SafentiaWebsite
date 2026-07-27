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

export const CUSTOMER_ROLE_LABELS: Record<CustomerRole, string> = {
  admin: 'Admin',
  finance: 'Finance',
  viewer: 'Viewer',
};

/** What saving this form will do about email, worked out from the same two
 *  inputs the server uses. `reason` explains a "nothing will be sent" outcome
 *  so the admin knows which field to fill in rather than guessing. */
interface InviteOutcome {
  willInvite: boolean;
  message: string;
}

function describeInvite(email: string, roleCount: number): InviteOutcome {
  const trimmed = email.trim();
  const emailUsable = trimmed.length > 0 && isValidEmail(trimmed);
  if (emailUsable && roleCount > 0) {
    return {
      willInvite: true,
      message: `Saving will email ${trimmed} an invitation to the customer portal. They get access once they accept it.`,
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

  const roleCount = Object.keys(roles).length;
  const outcome = useMemo(
    () => describeInvite(email, roleCount),
    [email, roleCount],
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
            optional, and is granted here.
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
            <fieldset className={styles.roles}>
              <legend className={styles.sectionTitle}>Portal access</legend>
              <p className={styles.copy}>
                Ticking a role is what gives this person a way into the customer
                portal. Leave them all clear and they stay a contact record
                only. Viewer is the usual starting point.
              </p>
              {CUSTOMER_ROLES.map((role) => (
                <label key={role} className={shared.checkboxRow}>
                  <input
                    type="checkbox"
                    className={shared.checkbox}
                    checked={roles[role] === true}
                    onChange={(event) => toggleRole(role, event.target.checked)}
                  />
                  <span className={shared.label}>
                    {CUSTOMER_ROLE_LABELS[role]}
                  </span>
                </label>
              ))}
            </fieldset>

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
            {busy ? 'Saving' : outcome.willInvite ? 'Add and invite' : 'Add contact'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
        </footer>
      </div>
    </div>
  );
}
