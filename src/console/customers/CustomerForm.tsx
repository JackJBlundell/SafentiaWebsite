// ============================================================================
// CustomerForm - EDIT the organisation's own details (name, address,
// switchboard email, phone) and the contract end date. Creation is the
// CustomerWizard's job; people are managed on the profile's contacts panel, and
// the review-reminder switch sits on the customer PAGE - it is a switch someone
// flicks while looking at the customer, not a field they open a form to edit.
//
// Archiving is deliberately NOT here - it lives on the detail page with its own
// confirm step, so an edit can never archive by accident. The contract end date
// is the SCHEDULED form of that same action: on the morning after the date, the
// platform archives the customer exactly as the button would, so the field is
// bounded to future dates and the copy says plainly what it will do.
// ============================================================================

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  ClearableFields,
  Customer,
  ManageCustomerInput,
  ManageCustomerResult,
} from '../../types';
import { AddressField } from '../ui/AddressField';
import {
  DAY_MS,
  fromDateInputValue,
  toDateInputValue,
  todayUtc,
} from '../lib/dateInput';
import { ErrorNotice, PageHeader, type Crumb } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { CustomerImageField, useCustomerImage } from './CustomerImageField';
import { isValidEmail, LoadingNote, urls, useOrgScope } from './shared';
import shared from './shared.module.css';
import styles from './CustomerForm.module.css';

export function CustomerForm() {
  const { customerId } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const { ready, orgId, db, isAdmin } = useOrgScope();
  const manageCustomer = useCallable<ManageCustomerInput, ManageCustomerResult>(
    'manageCustomer',
  );

  const existing = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId, customerId ?? 'none'),
    path: ready && customerId ? db!.customer(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });

  const image = useCustomerImage(existing.data?.photoUrl ?? null);

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // Held as the yyyy-mm-dd the date input speaks; converted to midnight UTC on
  // save so the stored value follows the platform's date-only convention and
  // cannot drift a day with the browser's timezone.
  const [contractEnd, setContractEnd] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  // Prefill once from the live record; after that the person owns the fields.
  useEffect(() => {
    if (!prefilled && existing.data) {
      setName(existing.data.name);
      setAddress(existing.data.address ?? '');
      setEmail(existing.data.email ?? '');
      setPhone(existing.data.phone ?? '');
      setContractEnd(toDateInputValue(existing.data.contractEndDate));
      setPrefilled(true);
    }
  }, [prefilled, existing.data]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter the organisation name.');
      return;
    }
    const trimmedEmail = email.trim();
    if (trimmedEmail && !isValidEmail(trimmedEmail)) {
      setFieldError('Enter a valid email address, or leave the field empty.');
      return;
    }
    setFieldError(null);

    // An emptied optional field that WAS set on the loaded record sends an
    // explicit null - the CLEAR intent (the server deletes the key). A field
    // that was never set and is still empty stays absent (no change).
    const record = existing.data;
    const customer: ClearableFields<Customer> = { name: trimmedName };
    const trimmedAddress = address.trim();
    if (trimmedAddress) customer.address = trimmedAddress;
    else if (record?.address) customer.address = null;
    if (trimmedEmail) customer.email = trimmedEmail;
    else if (record?.email) customer.email = null;
    const trimmedPhone = phone.trim();
    if (trimmedPhone) customer.phone = trimmedPhone;
    else if (record?.phone) customer.phone = null;

    // The contract end date. Cleared to null when emptied; validated here as
    // well as server-side so the person is told before the round trip.
    if (contractEnd) {
      const parsed = fromDateInputValue(contractEnd);
      if (parsed === undefined) {
        setFieldError('Enter the contract end date as a real date.');
        return;
      }
      if (parsed <= todayUtc()) {
        setFieldError(
          'The contract end date must be in the future. To end access now, archive the customer instead.',
        );
        return;
      }
      customer.contractEndDate = parsed;
    } else if (record?.contractEndDate) {
      customer.contractEndDate = null;
    }

    // Upload any freshly cropped image and fold its URL (or a clearing null)
    // into the same payload; a failed upload aborts before any write.
    const imageChange = await image.resolve();
    if (imageChange === 'error') {
      return;
    }
    if ('photoUrl' in imageChange) {
      customer.photoUrl = imageChange.photoUrl;
    }

    const result = await manageCustomer.call({
      action: 'update',
      customerId,
      customer,
    });
    if (result) {
      navigate(urls.customer(result.customerId));
    }
  };

  const crumbs: Crumb[] = [
    { label: 'Customers', to: urls.customers },
    {
      label: existing.data?.name ?? 'Customer',
      to: customerId ? urls.customer(customerId) : undefined,
    },
    { label: 'Edit' },
  ];

  if (existing.isLoading) {
    return <LoadingNote>Loading customer</LoadingNote>;
  }

  return (
    <div className={styles.root}>
      <PageHeader
        title="Edit organisation"
        lede="The organisation's own record. Its people are managed from the contacts panel on the profile."
        crumbs={crumbs}
      />

      <form className={shared.form} onSubmit={(event) => void onSubmit(event)}>
        <fieldset className={shared.fieldset}>
          <legend className={shared.legend}>Organisation</legend>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="customer-name">
              Name
            </label>
            <input
              id="customer-name"
              className={shared.input}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className={shared.field}>
            {/* No `geo`: a customer record keeps no point, so map mode here is
                only the quicker way to a correctly spelt address. */}
            <AddressField
              id="customer-address"
              label="Head office address (optional)"
              value={address}
              onChange={setAddress}
            />
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="customer-email">
              Switchboard email (optional)
            </label>
            <input
              id="customer-email"
              className={shared.input}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="customer-phone">
              Phone (optional)
            </label>
            <input
              id="customer-phone"
              className={shared.input}
              type="tel"
              autoComplete="off"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </div>
          {isAdmin && (
            <CustomerImageField
              image={image}
              name={name.trim() || existing.data?.name || 'this customer'}
              disabled={manageCustomer.pending || image.uploading}
            />
          )}
        </fieldset>

        <fieldset className={shared.fieldset}>
          <legend className={shared.legend}>Contract</legend>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="customer-contract-end">
              Contract end date (optional)
            </label>
            <input
              id="customer-contract-end"
              className={shared.input}
              type="date"
              value={contractEnd}
              min={toDateInputValue(todayUtc() + DAY_MS)}
              onChange={(event) => setContractEnd(event.target.value)}
              aria-describedby="customer-contract-end-hint"
            />
            <p id="customer-contract-end-hint" className={styles.note}>
              The last day of the contract. On the morning after this date we
              archive the customer automatically: their portal sign-ins stop
              working and their reminders stop. Nothing is deleted - their sites,
              buildings and assessment history stay in your records, and
              restoring them brings their access back. Leave empty for an
              open-ended contract.
            </p>
          </div>
        </fieldset>

        {fieldError && <ErrorNotice message={fieldError} />}
        {manageCustomer.error && <ErrorNotice message={manageCustomer.error} />}

        <div className={shared.formActions}>
          <Button
            type="submit"
            disabled={manageCustomer.pending || image.uploading}
          >
            {image.uploading
              ? 'Uploading image'
              : manageCustomer.pending
                ? 'Saving'
                : 'Save changes'}
          </Button>
          <Button
            variant="secondary"
            to={customerId ? urls.customer(customerId) : urls.customers}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
