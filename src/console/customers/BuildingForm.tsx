// ============================================================================
// BuildingForm - create or edit one building (story 2020).
//
// Covers every admin-settable Building/BuildingDetails field: identity,
// physical details, alarm, and the responsible people (the responsible party
// plus the Article 5(3) duty-holders). Three things are deliberately absent:
// riskLevel/ragDistribution/lastAssessedAt are DERIVED from assessments and
// never editable; the service schedule has its own panel on the building page;
// and the photo is managed by the uploads flow, not a form field.
//
// THE RESPONSIBLE PARTY IS A CONTACT, NOT A NAME. It is picked from the
// customer's contact directory and nowhere else - the typed-name alternative
// that used to sit beside it is gone, and manageBuilding now refuses a party
// without a contact link. That record is what the platform emails when an
// assessment is released and when remedial work falls due, so a name with
// nobody behind it was a person on a statutory record who could never be told
// they were on it. Someone missing from the directory is added from the picker.
// ============================================================================

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  ALARM_CATEGORIES,
  type AlarmCategory,
  type Building,
  type BuildingDetails,
  type ClearableFields,
  type Customer,
  type CustomerContact,
  type ManageBuildingInput,
  type ManageBuildingResult,
  type ResponsibleParty,
  type Site,
} from '../../types';
import { AddressField } from '../ui/AddressField';
import { ErrorNotice, PageHeader, type Crumb } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { ContactPicker } from './ContactPicker';
import { LoadingNote, urls, useOrgScope } from './shared';
import shared from './shared.module.css';
import styles from './BuildingForm.module.css';

/** Sanity ceilings for the physical details, mirroring what manageBuilding
 *  enforces server-side. Generous enough for any real building yet bounded so
 *  a typo cannot store an absurd figure. */
const DETAIL_LIMITS = {
  area: 10_000_000, // m2
  floors: 200,
  occupiedFloors: 200,
  occupants: 100_000,
} as const;

/** Parse an optional numeric field. Returns undefined for empty, an error
 *  message for nonsense, and the number otherwise. */
function parseOptionalNumber(
  raw: string,
  label: string,
  integer: boolean,
  max: number,
): { value?: number; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) {
    return { error: `${label} must be a number of 0 or more.` };
  }
  if (integer && !Number.isInteger(value)) {
    return { error: `${label} must be a whole number.` };
  }
  if (value > max) {
    return {
      error: `${label} must be ${max.toLocaleString('en-GB')} or less.`,
    };
  }
  return { value };
}

export function BuildingForm({ mode }: { mode: 'create' | 'edit' }) {
  const editing = mode === 'edit';
  const {
    customerId = '',
    siteId = '',
    buildingId,
  } = useParams<{ customerId: string; siteId: string; buildingId: string }>();
  const navigate = useNavigate();
  const { ready, orgId, db } = useOrgScope();
  const manageBuilding = useCallable<ManageBuildingInput, ManageBuildingResult>(
    'manageBuilding',
  );

  const customer = useRtdbQuery<Customer | null>({
    key: keys.customer(orgId, customerId),
    path: ready ? db!.customer(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });
  const sites = useRtdbQuery<Record<string, Site> | null>({
    key: keys.sites(orgId, customerId),
    path: ready ? db!.sites(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });
  const existing = useRtdbQuery<Building | null>({
    key: keys.building(orgId, siteId, buildingId ?? 'none'),
    path:
      ready && buildingId ? db!.building(orgId, siteId, buildingId) : '',
    enabled: ready && editing && Boolean(buildingId),
  });

  // Identity
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  // Details
  const [area, setArea] = useState('');
  const [floors, setFloors] = useState('');
  const [occupiedFloors, setOccupiedFloors] = useState('');
  const [occupants, setOccupants] = useState('');
  const [isLandlord, setIsLandlord] = useState(false);
  const [alarmType, setAlarmType] = useState('');
  const [alarmCategory, setAlarmCategory] = useState<'' | AlarmCategory>('');
  // Responsible people. The party comes from the customer's contact roster and
  // only from there; the picked contact is snapshotted onto the party with its
  // contactId link.
  const [rpContactId, setRpContactId] = useState<string | null>(null);
  // The picked contact, captured at pick time for the snapshot. Null while an
  // edit's preselected contact is untouched - the stored party then stands.
  const [rpContact, setRpContact] = useState<CustomerContact | null>(null);
  const [article53, setArticle53] = useState<string[]>([]);

  const [fieldError, setFieldError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (editing && !prefilled && existing.data) {
      const record = existing.data;
      setName(record.name);
      setAddress(record.address ?? '');
      setArea(record.details?.area !== undefined ? String(record.details.area) : '');
      setFloors(
        record.details?.floors !== undefined ? String(record.details.floors) : '',
      );
      setOccupiedFloors(
        record.details?.occupiedFloors !== undefined
          ? String(record.details.occupiedFloors)
          : '',
      );
      setOccupants(
        record.details?.occupants !== undefined
          ? String(record.details.occupants)
          : '',
      );
      setIsLandlord(record.details?.isLandlord === true);
      setAlarmType(record.details?.alarmType ?? '');
      setAlarmCategory(record.details?.alarmCategory ?? '');
      // A linked party preselects the picker. A party from before the linkage
      // (or from an import) has no contactId to preselect, so the picker opens
      // on nobody and the notice below names who is currently on the record -
      // saving the form is what replaces them with a real contact.
      setRpContactId(record.responsibleParty?.contactId ?? null);
      setArticle53(record.article53Persons ?? []);
      setPrefilled(true);
    }
  }, [editing, prefilled, existing.data]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter the building name.');
      return;
    }

    const areaParsed = parseOptionalNumber(
      area,
      'Floor area',
      false,
      DETAIL_LIMITS.area,
    );
    const floorsParsed = parseOptionalNumber(
      floors,
      'Floors',
      true,
      DETAIL_LIMITS.floors,
    );
    const occupiedParsed = parseOptionalNumber(
      occupiedFloors,
      'Occupied floors',
      true,
      DETAIL_LIMITS.occupiedFloors,
    );
    const occupantsParsed = parseOptionalNumber(
      occupants,
      'Occupants',
      true,
      DETAIL_LIMITS.occupants,
    );
    const numberError =
      areaParsed.error ??
      floorsParsed.error ??
      occupiedParsed.error ??
      occupantsParsed.error;
    if (numberError) {
      setFieldError(numberError);
      return;
    }
    if (
      floorsParsed.value !== undefined &&
      occupiedParsed.value !== undefined &&
      occupiedParsed.value > floorsParsed.value
    ) {
      setFieldError('Occupied floors cannot exceed the number of floors.');
      return;
    }

    setFieldError(null);

    // An emptied optional field that WAS set on the loaded record sends an
    // explicit null - the CLEAR intent (the server deletes the key). A field
    // that was never set and is still empty stays absent (no change). Emptying
    // every detail, every responsible-party field or every duty-holder row
    // clears the whole node the same way. On create empties are simply absent.
    const record = editing ? existing.data : undefined;
    const building: ClearableFields<Building> = { name: trimmedName, customerId };
    const trimmedAddress = address.trim();
    if (trimmedAddress) building.address = trimmedAddress;
    else if (record?.address) building.address = null;

    const details: BuildingDetails = {};
    if (areaParsed.value !== undefined) details.area = areaParsed.value;
    if (floorsParsed.value !== undefined) details.floors = floorsParsed.value;
    if (occupiedParsed.value !== undefined) {
      details.occupiedFloors = occupiedParsed.value;
    }
    if (occupantsParsed.value !== undefined) {
      details.occupants = occupantsParsed.value;
    }
    if (isLandlord) details.isLandlord = true;
    const trimmedAlarmType = alarmType.trim();
    if (trimmedAlarmType) details.alarmType = trimmedAlarmType;
    if (alarmCategory) details.alarmCategory = alarmCategory;
    if (Object.keys(details).length > 0) building.details = details;
    else if (record?.details) building.details = null;

    if (rpContactId && rpContact) {
      // A fresh pick: snapshot the contact onto the party, keeping the link.
      const party: ResponsibleParty = {
        name: rpContact.name,
        contactId: rpContactId,
      };
      if (rpContact.jobTitle) party.role = rpContact.jobTitle;
      if (rpContact.email) party.email = rpContact.email;
      if (rpContact.phone) party.phone = rpContact.phone;
      building.responsibleParty = party;
    } else if (!rpContactId && record?.responsibleParty) {
      building.responsibleParty = null;
    }
    // An untouched preselection (rpContactId set, rpContact null) sends
    // nothing: the stored party stands.

    const persons = article53.map((p) => p.trim()).filter(Boolean);
    if (persons.length > 0) building.article53Persons = persons;
    else if (record?.article53Persons) building.article53Persons = null;

    const result = editing
      ? await manageBuilding.call({
          action: 'update',
          siteId,
          buildingId,
          building,
        })
      : await manageBuilding.call({ action: 'create', siteId, building });
    if (result) {
      navigate(urls.building(customerId, siteId, result.buildingId));
    }
  };

  const customerName = customer.data?.name ?? 'Customer';
  const siteName = sites.data?.[siteId]?.name ?? 'Site';
  const crumbs: Crumb[] = [
    { label: 'Customers', to: urls.customers },
    { label: customerName, to: urls.customer(customerId) },
    { label: siteName, to: urls.site(customerId, siteId) },
    ...(editing && buildingId
      ? [
          {
            label: existing.data?.name ?? 'Building',
            to: urls.building(customerId, siteId, buildingId),
          },
          { label: 'Edit' },
        ]
      : [{ label: 'New building' }]),
  ];

  if (editing && existing.isLoading) {
    return <LoadingNote>Loading building</LoadingNote>;
  }

  return (
    <div className={styles.root}>
      <PageHeader
        title={editing ? 'Edit building' : 'New building'}
        lede={
          editing
            ? `Update this building at ${siteName}.`
            : `Add a building at ${siteName}. Its risk rating comes from assessments, not this form.`
        }
        crumbs={crumbs}
      />

      <form className={shared.form} onSubmit={(event) => void onSubmit(event)}>
        <fieldset className={shared.fieldset}>
          <legend className={shared.legend}>Identity</legend>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="building-name">
              Name
            </label>
            <input
              id="building-name"
              className={shared.input}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className={shared.field}>
            {/* No `geo`: the point that matters for navigation is the site's,
                so a building keeps the address alone. */}
            <AddressField
              id="building-address"
              label="Address (optional)"
              value={address}
              onChange={setAddress}
            />
          </div>
        </fieldset>

        <fieldset className={shared.fieldset}>
          <legend className={shared.legend}>Details</legend>
          <div className={shared.fieldRow}>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="building-area">
                Floor area, m² (optional)
              </label>
              <input
                id="building-area"
                className={shared.input}
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                value={area}
                onChange={(event) => setArea(event.target.value)}
              />
            </div>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="building-floors">
                Floors (optional)
              </label>
              <input
                id="building-floors"
                className={shared.input}
                type="number"
                inputMode="numeric"
                step={1}
                min={0}
                value={floors}
                onChange={(event) => setFloors(event.target.value)}
              />
            </div>
          </div>
          <div className={shared.fieldRow}>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="building-occupied-floors">
                Occupied floors (optional)
              </label>
              <input
                id="building-occupied-floors"
                className={shared.input}
                type="number"
                inputMode="numeric"
                step={1}
                min={0}
                value={occupiedFloors}
                onChange={(event) => setOccupiedFloors(event.target.value)}
              />
            </div>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="building-occupants">
                Occupants (optional)
              </label>
              <input
                id="building-occupants"
                className={shared.input}
                type="number"
                inputMode="numeric"
                step={1}
                min={0}
                value={occupants}
                onChange={(event) => setOccupants(event.target.value)}
              />
            </div>
          </div>
          <div className={shared.checkboxRow}>
            <input
              id="building-landlord"
              type="checkbox"
              className={shared.checkbox}
              checked={isLandlord}
              onChange={(event) => setIsLandlord(event.target.checked)}
            />
            <label className={shared.label} htmlFor="building-landlord">
              The customer is the landlord of this building
            </label>
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="building-alarm-type">
              Fire alarm type (optional)
            </label>
            <input
              id="building-alarm-type"
              className={shared.input}
              type="text"
              autoComplete="off"
              value={alarmType}
              onChange={(event) => setAlarmType(event.target.value)}
            />
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="building-alarm-category">
              Alarm category, BS 5839-1 (optional)
            </label>
            <select
              id="building-alarm-category"
              className={shared.select}
              value={alarmCategory}
              onChange={(event) =>
                setAlarmCategory(event.target.value as '' | AlarmCategory)
              }
            >
              <option value="">Not recorded</option>
              {ALARM_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        <fieldset className={shared.fieldset}>
          <legend className={shared.legend}>Responsible people</legend>
          <p className={shared.hint}>
            The responsible party is the default contact for assessments and
            remedial actions on this building. Safentia emails this person when
            an assessment is released and when their actions fall due, so they
            must be one of the customer’s contacts — add them below if they are
            not listed yet.
          </p>
          {/* A party recorded before the contact linkage (or brought in by an
              import) has a name but nothing to email. Name them plainly so the
              admin knows what saving this form is about to replace. */}
          {editing &&
            existing.data?.responsibleParty &&
            !existing.data.responsibleParty.contactId && (
              <p className={shared.hint}>
                This building currently records{' '}
                <strong>{existing.data.responsibleParty.name}</strong> as the
                responsible party, but they are not linked to a contact, so
                nothing is emailed to them. Choose them from the list below to
                fix that.
              </p>
            )}
          <div className={shared.field}>
            <ContactPicker
              customerId={customerId}
              label="Responsible party"
              value={rpContactId ?? undefined}
              onChange={(nextId, contact) => {
                setRpContactId(nextId);
                setRpContact(contact);
              }}
              allowNone
            />
          </div>

          <div className={shared.field}>
            <span className={shared.label} id="article53-label">
              Article 5(3) persons (optional)
            </span>
            <p className={shared.hint}>
              Anyone with duties under Article 5(3) of the Regulatory Reform
              (Fire Safety) Order 2005.
            </p>
            {article53.length > 0 && (
              <ul className={shared.stringList} aria-labelledby="article53-label">
                {article53.map((person, index) => (
                  // Index keys are safe here: rows are only appended/removed
                  // and carry no identity beyond their position.
                  <li key={index} className={shared.stringListRow}>
                    <input
                      className={shared.input}
                      type="text"
                      aria-label={`Article 5(3) person ${index + 1}`}
                      value={person}
                      onChange={(event) =>
                        setArticle53((current) =>
                          current.map((value, i) =>
                            i === index ? event.target.value : value,
                          ),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setArticle53((current) =>
                          current.filter((_, i) => i !== index),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div>
              <Button
                variant="secondary"
                onClick={() => setArticle53((current) => [...current, ''])}
              >
                Add person
              </Button>
            </div>
          </div>
        </fieldset>

        {fieldError && <ErrorNotice message={fieldError} />}
        {manageBuilding.error && <ErrorNotice message={manageBuilding.error} />}

        <div className={shared.formActions}>
          <Button type="submit" disabled={manageBuilding.pending}>
            {manageBuilding.pending
              ? 'Saving'
              : editing
                ? 'Save changes'
                : 'Create building'}
          </Button>
          <Button
            variant="secondary"
            to={
              editing && buildingId
                ? urls.building(customerId, siteId, buildingId)
                : urls.site(customerId, siteId)
            }
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
