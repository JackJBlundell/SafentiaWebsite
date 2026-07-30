// ============================================================================
// SiteWizard - guided creation of a site, then its first buildings (two steps).
//
// Step 1 gathers the site details through the console's one AddressField, which
// carries the location with the address - a picked suggestion pins it, and its
// map mode drags the pin onto the exact spot; creating the site is what advances
// the wizard, so a site always exists before buildings are offered. Step 2 is
// SKIPPABLE quick-add: name plus an address defaulting to
// the site's, with a link to each created building's edit page for the full
// details. Validation and payload shape mirror SiteForm's create path; there
// is no clear protocol because a wizard only ever creates.
// ============================================================================

import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import type {
  GeoPoint,
  ManageBuildingInput,
  ManageBuildingResult,
  ManageSiteInput,
  ManageSiteResult,
  Site,
} from '../../types';
import { AddressField } from '../ui/AddressField';
import { ErrorNotice, PageHeader, type Crumb } from '../ui/Page';
import { Stepper } from '../ui/Stepper';
import { useCallable } from '../ui/useCallable';
import { ContactPicker } from './ContactPicker';
import { useUnsavedGuard } from './useUnsavedGuard';
import { NoAccessPanel, urls, useOrgScope } from './shared';
import shared from './shared.module.css';
import styles from './SiteWizard.module.css';

const STEPS = ['Site details', 'Buildings'] as const;

interface CreatedBuilding {
  buildingId: string;
  name: string;
}

export function SiteWizard() {
  const { customerId = '' } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const { isAdmin, ready } = useOrgScope();
  const manageSite = useCallable<ManageSiteInput, ManageSiteResult>('manageSite');
  const manageBuilding = useCallable<ManageBuildingInput, ManageBuildingResult>(
    'manageBuilding',
  );

  // Step 1 state.
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  // Derived from the address, never typed: AddressField sets it from a picked
  // suggestion or a dropped pin, and clears it when the address is edited away
  // from what produced it.
  const [geo, setGeo] = useState<GeoPoint | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Set once step 1 succeeds; its presence is what step 2 operates on.
  const [siteId, setSiteId] = useState<string | null>(null);

  // Step 2 state.
  const [buildingName, setBuildingName] = useState('');
  const [buildingAddress, setBuildingAddress] = useState('');
  const [buildingError, setBuildingError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedBuilding[]>([]);

  // Unsaved work: step 1 fields before the site commits, then any quick-add
  // building typed but not yet added. Creating the site (or a building) is the
  // save; Finish navigates away, which unmounts the guard.
  useUnsavedGuard(
    siteId === null
      ? Boolean(name.trim() || address.trim() || geo || contactId)
      : buildingName.trim().length > 0,
  );

  const crumbs: Crumb[] = [
    { label: 'Customers', to: urls.customers },
    { label: 'Customer', to: urls.customer(customerId) },
    { label: 'New site' },
  ];

  if (ready && !isAdmin) {
    return <NoAccessPanel />;
  }

  const createSite = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter the site name.');
      return;
    }
    setFieldError(null);

    // Create only: empties are simply absent (nothing exists to clear yet).
    const site: Site = { name: trimmedName };
    const trimmedAddress = address.trim();
    if (trimmedAddress) site.address = trimmedAddress;
    if (geo) site.geo = geo;
    if (contactId) site.contactId = contactId;

    const result = await manageSite.call({ action: 'create', customerId, site });
    if (result) {
      // Default the first building's address to the site's.
      setBuildingAddress(trimmedAddress);
      setSiteId(result.siteId);
    }
  };

  const addBuilding = async (event: FormEvent) => {
    event.preventDefault();
    if (!siteId) {
      return;
    }
    const trimmedName = buildingName.trim();
    if (!trimmedName) {
      setBuildingError('Enter the building name.');
      return;
    }
    setBuildingError(null);
    const building: ManageBuildingInput['building'] = {
      name: trimmedName,
      customerId,
    };
    const trimmedAddress = buildingAddress.trim();
    if (trimmedAddress) building.address = trimmedAddress;
    const result = await manageBuilding.call({
      action: 'create',
      siteId,
      building,
    });
    if (result) {
      setCreated((list) => [
        ...list,
        { buildingId: result.buildingId, name: trimmedName },
      ]);
      setBuildingName('');
      // Keep the site's address as the default for the next quick-add.
      setBuildingAddress(address.trim());
    }
  };

  const step = siteId ? 1 : 0;

  return (
    <div className={styles.root}>
      <PageHeader
        title="New site"
        lede={
          step === 0
            ? 'Add a location for this customer. Its buildings come next.'
            : 'Add the buildings at this site now, or finish and add them later.'
        }
        crumbs={crumbs}
      />

      <div className={styles.stepper}>
        <Stepper steps={STEPS} current={step} />
      </div>

      {step === 0 && (
        <form className={shared.form} onSubmit={(event) => void createSite(event)}>
          <fieldset className={shared.fieldset}>
            <legend className={shared.legend}>Site details</legend>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="wizard-site-name">
                Name
              </label>
              <input
                id="wizard-site-name"
                className={shared.input}
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className={shared.field}>
              <AddressField
                id="wizard-site-address"
                label="Address (optional)"
                value={address}
                onChange={setAddress}
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
              {manageSite.pending ? 'Creating' : 'Create site'}
            </Button>
            <Button variant="secondary" to={urls.customer(customerId)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step === 1 && siteId && (
        <div className={styles.stepBody}>
          <form
            className={shared.form}
            onSubmit={(event) => void addBuilding(event)}
          >
            <fieldset className={shared.fieldset}>
              <legend className={shared.legend}>Add a building</legend>
              <p className={shared.hint}>
                Quick-add each building with just a name. You can fill in floor
                counts, alarms and contacts from its page afterwards.
              </p>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="wizard-building-name">
                  Building name
                </label>
                <input
                  id="wizard-building-name"
                  className={shared.input}
                  type="text"
                  value={buildingName}
                  onChange={(event) => setBuildingName(event.target.value)}
                />
              </div>
              <div className={shared.field}>
                <AddressField
                  id="wizard-building-address"
                  label="Address (optional)"
                  value={buildingAddress}
                  onChange={setBuildingAddress}
                />
              </div>

              {buildingError && <ErrorNotice message={buildingError} />}
              {manageBuilding.error && (
                <ErrorNotice message={manageBuilding.error} />
              )}

              <div>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={manageBuilding.pending}
                >
                  {manageBuilding.pending ? 'Adding' : 'Add building'}
                </Button>
              </div>
            </fieldset>
          </form>

          {created.length > 0 && (
            <ul className={styles.createdList} aria-label="Buildings added">
              {created.map((building) => (
                <li key={building.buildingId} className={styles.createdRow}>
                  <span className={styles.createdName}>{building.name}</span>
                  <Button
                    variant="ghost"
                    to={urls.buildingEdit(customerId, siteId, building.buildingId)}
                  >
                    Add full details
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className={shared.formActions}>
            <Button onClick={() => navigate(urls.site(customerId, siteId))}>
              {created.length > 0 ? 'Finish' : 'Skip and finish'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
