// ============================================================================
// SiteForm - create or edit one site under a customer.
//
// Name is required. The location is optional and DERIVED from the address -
// AddressField owns both, so there is no coordinate pair to validate and no way
// to save a point that disagrees with the address beside it. The customer name
// is read live for the breadcrumb, and an edit prefills from the live sites
// list.
// ============================================================================

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  ClearableFields,
  Customer,
  GeoPoint,
  ManageSiteInput,
  ManageSiteResult,
  Site,
} from '../../types';
import { AddressField } from '../ui/AddressField';
import { ErrorNotice, PageHeader, type Crumb } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { ContactPicker } from './ContactPicker';
import { LoadingNote, urls, useOrgScope } from './shared';
import shared from './shared.module.css';
import styles from './SiteForm.module.css';

export function SiteForm({ mode }: { mode: 'create' | 'edit' }) {
  const editing = mode === 'edit';
  const { customerId = '', siteId } = useParams<{
    customerId: string;
    siteId: string;
  }>();
  const navigate = useNavigate();
  const { ready, orgId, db } = useOrgScope();
  const manageSite = useCallable<ManageSiteInput, ManageSiteResult>('manageSite');

  const customer = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId, customerId),
    path: ready ? db!.customer(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });
  const sites = useRtdbQuery<Record<string, Site> | null>({
    key: keys.sites(orgId, customerId),
    path: ready ? db!.sites(orgId, customerId) : '',
    enabled: ready && editing && Boolean(customerId),
  });
  const existing = editing && siteId ? sites.data?.[siteId] : undefined;

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [contactId, setContactId] = useState<string | null>(null);
  const [geo, setGeo] = useState<GeoPoint | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (editing && !prefilled && existing) {
      setName(existing.name);
      setAddress(existing.address ?? '');
      setContactId(existing.contactId ?? null);
      setGeo(existing.geo ?? null);
      setPrefilled(true);
    }
  }, [editing, prefilled, existing]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter the site name.');
      return;
    }
    setFieldError(null);

    // An emptied optional field that WAS set on the loaded record sends an
    // explicit null - the CLEAR intent (the server deletes the key). A field
    // that was never set and is still empty stays absent (no change). On
    // create there is no record, so empties are simply absent.
    const record = editing ? existing : undefined;
    const site: ClearableFields<Site> = { name: trimmedName };
    const trimmedAddress = address.trim();
    if (trimmedAddress) site.address = trimmedAddress;
    else if (record?.address) site.address = null;
    // The site contact follows the same protocol: only the contactId travels;
    // person details live on the contact record, never on the site.
    if (contactId) site.contactId = contactId;
    else if (record?.contactId) site.contactId = null;
    if (geo) site.geo = geo;
    else if (record?.geo) site.geo = null;

    const result = editing
      ? await manageSite.call({ action: 'update', customerId, siteId, site })
      : await manageSite.call({ action: 'create', customerId, site });
    if (result) {
      navigate(urls.site(customerId, result.siteId));
    }
  };

  const customerName = customer.data?.name ?? 'Customer';
  const crumbs: Crumb[] = [
    { label: 'Customers', to: urls.customers },
    { label: customerName, to: urls.customer(customerId) },
    ...(editing && siteId
      ? [
          {
            label: existing?.name ?? 'Site',
            to: urls.site(customerId, siteId),
          },
          { label: 'Edit' },
        ]
      : [{ label: 'New site' }]),
  ];

  if (editing && sites.isLoading) {
    return <LoadingNote>Loading site</LoadingNote>;
  }

  return (
    <div className={styles.root}>
      <PageHeader
        title={editing ? 'Edit site' : 'New site'}
        lede={
          editing
            ? `Update this site for ${customerName}.`
            : `Add a location for ${customerName}. Its buildings come next.`
        }
        crumbs={crumbs}
      />

      <form className={shared.form} onSubmit={(event) => void onSubmit(event)}>
        <fieldset className={shared.fieldset}>
          <legend className={shared.legend}>Site</legend>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="site-name">
              Name
            </label>
            <input
              id="site-name"
              className={shared.input}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className={shared.field}>
            <AddressField
              id="site-address"
              label="Address (optional)"
              value={address}
              onChange={setAddress}
              // Sites are the one record that keeps a point: assessors navigate
              // to it, so the pin can be dragged onto the right gate.
              geo={geo}
              onGeoChange={setGeo}
            />
          </div>
          <div className={shared.field}>
            <ContactPicker
              customerId={customerId}
              label="Site contact"
              value={contactId ?? undefined}
              onChange={(nextId) => setContactId(nextId)}
              allowNone
            />
          </div>
        </fieldset>

        {fieldError && <ErrorNotice message={fieldError} />}
        {manageSite.error && <ErrorNotice message={manageSite.error} />}

        <div className={shared.formActions}>
          <Button type="submit" disabled={manageSite.pending}>
            {manageSite.pending
              ? 'Saving'
              : editing
                ? 'Save changes'
                : 'Create site'}
          </Button>
          <Button
            variant="secondary"
            to={
              editing && siteId
                ? urls.site(customerId, siteId)
                : urls.customer(customerId)
            }
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
