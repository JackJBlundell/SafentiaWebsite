// ============================================================================
// ContactPicker - the ONE way a screen attaches a person to something. It
// offers the customer's contact roster (the same live list ContactsPanel
// manages) as an accessible single-select, plus an inline "Add new contact"
// form so a missing person can be created without leaving the flow. The new
// contact is created through manageCustomerContact - the same callable the
// roster uses - and auto-selected on success.
//
// Non-admins get a read-only display of the current contact: they can see who
// is assigned but every mutation affordance is hidden, matching the rest of
// the customers area.
// ============================================================================

import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  ClearableFields,
  CustomerContact,
  ManageCustomerContactInput,
  ManageCustomerContactResult,
} from '../../types';
import { ErrorNotice } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import {
  isValidEmail,
  LoadingNote,
  sortByName,
  toEntries,
  useOrgScope,
} from './shared';
import shared from './shared.module.css';
import styles from './ContactPicker.module.css';

export interface ContactPickerProps {
  customerId: string;
  label: string;
  /** The selected contact's id, when one is assigned. */
  value?: string;
  onChange: (contactId: string | null, contact: CustomerContact | null) => void;
  /** Offers an explicit "None" choice (the CLEAR intent for the caller). */
  allowNone?: boolean;
}

/** One line describing a contact: name, then the job title when known. */
function contactLine(contact: CustomerContact): string {
  return contact.jobTitle ? `${contact.name}, ${contact.jobTitle}` : contact.name;
}

export function ContactPicker({
  customerId,
  label,
  value,
  onChange,
  allowNone,
}: ContactPickerProps) {
  const { ready, orgId, db, isAdmin } = useOrgScope();
  const groupId = useId();

  const contacts = useRtdbQuery<Record<string, CustomerContact> | null>({
    key: keys.customerContacts(orgId, customerId),
    path: ready ? db!.customerContacts(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });

  const [adding, setAdding] = useState(false);

  // Primary first, the rest alphabetical - the same order as ContactsPanel.
  const entries = sortByName(toEntries(contacts.data));
  entries.sort(
    (a, b) => Number(b[1].isPrimary === true) - Number(a[1].isPrimary === true),
  );

  const current = value ? (contacts.data?.[value] ?? null) : null;

  // Read-only for non-admins: show who is assigned, nothing else.
  if (!isAdmin) {
    return (
      <div className={styles.root}>
        <span className={shared.label}>{label}</span>
        {contacts.isLoading ? (
          <LoadingNote>Loading contacts</LoadingNote>
        ) : (
          <p className={styles.readOnly}>
            {current
              ? contactLine(current)
              : value
                ? 'The assigned contact is no longer in the contact list.'
                : 'None assigned.'}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <span className={shared.label} id={`${groupId}-label`}>
        {label}
      </span>

      {contacts.isLoading && <LoadingNote>Loading contacts</LoadingNote>}
      {contacts.isError && (
        <ErrorNotice message="Could not load the customer's contacts. Please try again." />
      )}

      {!contacts.isLoading && !contacts.isError && (
        <>
          {entries.length === 0 ? (
            <p className={shared.hint}>No contacts yet. Add one to assign.</p>
          ) : (
            <div
              className={styles.list}
              role="radiogroup"
              aria-labelledby={`${groupId}-label`}
            >
              {allowNone && (
                <label
                  className={
                    value ? styles.optionRow : styles.optionRowSelected
                  }
                >
                  <input
                    type="radio"
                    name={`${groupId}-contact`}
                    className={styles.radio}
                    checked={!value}
                    onChange={() => onChange(null, null)}
                  />
                  <span className={styles.optionBody}>
                    <span className={styles.optionName}>None</span>
                  </span>
                </label>
              )}
              {entries.map(([contactId, contact]) => (
                <label
                  key={contactId}
                  className={
                    value === contactId
                      ? styles.optionRowSelected
                      : styles.optionRow
                  }
                >
                  <input
                    type="radio"
                    name={`${groupId}-contact`}
                    className={styles.radio}
                    checked={value === contactId}
                    onChange={() => onChange(contactId, contact)}
                  />
                  <span className={styles.optionBody}>
                    <span className={styles.optionName}>
                      {contact.name}
                      {contact.isPrimary && (
                        <span className={styles.primaryBadge}>Primary</span>
                      )}
                    </span>
                    {contact.jobTitle && (
                      <span className={styles.optionMeta}>{contact.jobTitle}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}

          {value && !current && (
            <p className={shared.hint}>
              The previously assigned contact is no longer in the contact list.
              Choose another{allowNone ? ', or None' : ''}.
            </p>
          )}

          {adding ? (
            <AddContactForm
              customerId={customerId}
              onCancel={() => setAdding(false)}
              onCreated={(contactId, contact) => {
                setAdding(false);
                onChange(contactId, contact);
              }}
            />
          ) : (
            <div>
              <Button variant="secondary" onClick={() => setAdding(true)}>
                Add new contact
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// The compact inline creator: name required, the rest optional. Creating goes
// through manageCustomerContact so the roster, the portal flows and this picker
// can never disagree about what a contact is.
// ----------------------------------------------------------------------------

function AddContactForm({
  customerId,
  onCancel,
  onCreated,
}: {
  customerId: string;
  onCancel: () => void;
  onCreated: (contactId: string, contact: CustomerContact) => void;
}) {
  const manage = useCallable<ManageCustomerContactInput, ManageCustomerContactResult>(
    'manageCustomerContact',
  );
  const formId = useId();

  const [name, setName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

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
    setFieldError(null);

    const contact: ClearableFields<CustomerContact> = { name: trimmedName };
    const trimmedJob = jobTitle.trim();
    if (trimmedJob) contact.jobTitle = trimmedJob;
    if (trimmedEmail) contact.email = trimmedEmail;
    const trimmedPhone = phone.trim();
    if (trimmedPhone) contact.phone = trimmedPhone;

    const result = await manage.call({ action: 'create', customerId, contact });
    if (result) {
      // The live roster listener delivers the stored record momentarily; this
      // local copy lets the caller take its snapshot immediately.
      const created: CustomerContact = {
        name: trimmedName,
        ...(trimmedJob ? { jobTitle: trimmedJob } : {}),
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
        ...(trimmedPhone ? { phone: trimmedPhone } : {}),
        createdAt: Date.now(),
      };
      onCreated(result.contactId, created);
    }
  };

  return (
    <div className={styles.addForm}>
      <h4 className={styles.addFormTitle}>Add new contact</h4>
      <div className={shared.fieldRow}>
        <div className={shared.field}>
          <label className={shared.label} htmlFor={`${formId}-name`}>
            Name
          </label>
          <input
            id={`${formId}-name`}
            className={shared.input}
            type="text"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={shared.field}>
          <label className={shared.label} htmlFor={`${formId}-job`}>
            Job title (optional)
          </label>
          <input
            id={`${formId}-job`}
            className={shared.input}
            type="text"
            autoComplete="off"
            value={jobTitle}
            onChange={(event) => setJobTitle(event.target.value)}
          />
        </div>
      </div>
      <div className={shared.fieldRow}>
        <div className={shared.field}>
          <label className={shared.label} htmlFor={`${formId}-email`}>
            Email (optional)
          </label>
          <input
            id={`${formId}-email`}
            className={shared.input}
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className={shared.field}>
          <label className={shared.label} htmlFor={`${formId}-phone`}>
            Phone (optional)
          </label>
          <input
            id={`${formId}-phone`}
            className={shared.input}
            type="tel"
            autoComplete="off"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
      </div>

      {fieldError && <ErrorNotice message={fieldError} />}
      {manage.error && <ErrorNotice message={manage.error} />}

      <div className={shared.formActions}>
        <Button disabled={manage.pending} onClick={() => void save()}>
          {manage.pending ? 'Adding' : 'Add contact'}
        </Button>
        <Button variant="ghost" disabled={manage.pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
