// ============================================================================
// SiteForm - create or edit one site under a customer.
//
// Name is required; coordinates are optional but validated as a pair (a lone
// latitude is a data-entry slip, not a location). The customer name is read
// live for the breadcrumb, and an edit prefills from the live sites list.
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
import { AddressSearch } from '../ui/AddressSearch';
import { LocationPicker } from '../ui/LocationPicker';
import { ErrorNotice, PageHeader, type Crumb } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { ContactPicker } from './ContactPicker';
import { LoadingNote, toGeoPoint, urls, useOrgScope } from './shared';
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
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (editing && !prefilled && existing) {
      setName(existing.name);
      setAddress(existing.address ?? '');
      setContactId(existing.contactId ?? null);
      setLat(existing.geo ? String(existing.geo.lat) : '');
      setLng(existing.geo ? String(existing.geo.lng) : '');
      setPrefilled(true);
    }
  }, [editing, prefilled, existing]);

  // The two text fields stay the source of truth; the map both reads from and
  // writes to them, so neither input can drift from the other.
  const pin = toGeoPoint(lat, lng);
  const setPin = (geo: GeoPoint) => {
    setLat(String(geo.lat));
    setLng(String(geo.lng));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter the site name.');
      return;
    }
    const hasLat = lat.trim() !== '';
    const hasLng = lng.trim() !== '';
    if (hasLat !== hasLng) {
      setFieldError('Enter both latitude and longitude, or leave both empty.');
      return;
    }
    let geo: Site['geo'];
    if (hasLat && hasLng) {
      const latValue = Number(lat);
      const lngValue = Number(lng);
      if (!Number.isFinite(latValue) || latValue < -90 || latValue > 90) {
        setFieldError('Latitude must be a number between -90 and 90.');
        return;
      }
      if (!Number.isFinite(lngValue) || lngValue < -180 || lngValue > 180) {
        setFieldError('Longitude must be a number between -180 and 180.');
        return;
      }
      geo = { lat: latValue, lng: lngValue };
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
            <AddressSearch
              id="site-address"
              label="Address (optional)"
              value={address}
              onChange={setAddress}
              onSelect={(selection) => {
                setAddress(selection.address);
                // A pick also pins the map and fills the coordinate fields
                // below; both stay editable for manual correction.
                setPin(selection.geo);
              }}
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

        <fieldset className={shared.fieldset}>
          <legend className={shared.legend}>Location (optional)</legend>
          <p className={shared.hint}>
            Coordinates place the site on maps. Enter both values or leave both
            empty.
          </p>
          <LocationPicker
            value={pin}
            onChange={setPin}
            searchId="site-map-search"
          />
          <div className={shared.fieldRow}>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="site-lat">
                Latitude
              </label>
              <input
                id="site-lat"
                className={shared.input}
                type="number"
                inputMode="decimal"
                step="any"
                min={-90}
                max={90}
                value={lat}
                onChange={(event) => setLat(event.target.value)}
              />
            </div>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="site-lng">
                Longitude
              </label>
              <input
                id="site-lng"
                className={shared.input}
                type="number"
                inputMode="decimal"
                step="any"
                min={-180}
                max={180}
                value={lng}
                onChange={(event) => setLng(event.target.value)}
              />
            </div>
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
