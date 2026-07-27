// ============================================================================
// CustomerForm - EDIT the organisation's own details (name, address,
// switchboard email, phone). Creation is the CustomerWizard's job; people are
// managed on the profile's contacts panel, never on this form.
//
// Archiving is deliberately NOT here - it lives on the detail page with its
// own confirm step, so an edit can never archive by accident.
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
import { AddressSearch } from '../ui/AddressSearch';
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
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  // Prefill once from the live record; after that the person owns the fields.
  useEffect(() => {
    if (!prefilled && existing.data) {
      setName(existing.data.name);
      setAddress(existing.data.address ?? '');
      setEmail(existing.data.email ?? '');
      setPhone(existing.data.phone ?? '');
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
            <AddressSearch
              id="customer-address"
              label="Head office address (optional)"
              value={address}
              onChange={setAddress}
              onSelect={(selection) => setAddress(selection.address)}
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
