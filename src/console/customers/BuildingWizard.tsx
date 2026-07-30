// ============================================================================
// BuildingWizard - guided creation of a building in three steps plus a finish
// screen.
//
// Step 1 mirrors BuildingForm's create case (identity + physical details, the
// same validators and payload shape); creating the building is what advances
// the wizard, so steps 2 and 3 always operate on a real id. Step 2 (SKIPPABLE)
// reuses the floor-plan upload pipeline - validate, upload with progress, then
// manageFloorPlan create. Step 3 (SKIPPABLE) assigns the responsible party
// from the customer's contact roster via ContactPicker (keeping the contactId
// link; a missing person can be added inline). A wizard only creates, so
// there is no clear protocol here.
// ============================================================================

import { useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import {
  ALARM_CATEGORIES,
  type AlarmCategory,
  type Building,
  type BuildingDetails,
  type CustomerContact,
  type ManageBuildingInput,
  type ManageBuildingResult,
  type ManageFloorPlanInput,
  type ManageFloorPlanResult,
  type ResponsibleParty,
} from '../../types';
import { fileIsFloorPlan, newObjectId, uploadFile } from '../lib/upload';
import { AddressField } from '../ui/AddressField';
import { ErrorNotice, PageHeader, type Crumb } from '../ui/Page';
import { Stepper } from '../ui/Stepper';
import { useCallable } from '../ui/useCallable';
import { ContactPicker } from './ContactPicker';
import { useUnsavedGuard } from './useUnsavedGuard';
import { NoAccessPanel, urls, useOrgScope } from './shared';
import shared from './shared.module.css';
import styles from './BuildingWizard.module.css';

const STEPS = ['Building details', 'Floor plans', 'Contact'] as const;

// Copied from BuildingForm (not exported there; that file is owned by the edit
// flow). Kept numerically identical to what manageBuilding enforces server-side.
const DETAIL_LIMITS = {
  area: 10_000_000, // m2
  floors: 200,
  occupiedFloors: 200,
  occupants: 100_000,
} as const;

/** Parse an optional numeric field: undefined for empty, an error message for
 *  nonsense, the number otherwise. (Copied from BuildingForm, see above.) */
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
    return { error: `${label} must be ${max.toLocaleString('en-GB')} or less.` };
  }
  return { value };
}

export function BuildingWizard() {
  const { customerId = '', siteId = '' } = useParams<{
    customerId: string;
    siteId: string;
  }>();
  const { isAdmin, ready } = useOrgScope();
  const manageBuilding = useCallable<ManageBuildingInput, ManageBuildingResult>(
    'manageBuilding',
  );

  // Step index: 0 details, 1 plans, 2 contact, 3 finish. Steps only move
  // forward - each one commits real records as it goes.
  const [step, setStep] = useState(0);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [buildingName, setBuildingName] = useState('');
  const [plansAdded, setPlansAdded] = useState<string[]>([]);
  const [partySet, setPartySet] = useState<string | null>(null);

  // The flow between the commit and the finish screen is unsaved context
  // (steps 1 and 2 hold their own field state; DetailsStep arms its own guard
  // for the pre-commit fields).
  useUnsavedGuard(step > 0 && step < 3);

  const crumbs: Crumb[] = [
    { label: 'Customers', to: urls.customers },
    { label: 'Customer', to: urls.customer(customerId) },
    { label: 'Site', to: urls.site(customerId, siteId) },
    { label: 'New building' },
  ];

  if (ready && !isAdmin) {
    return <NoAccessPanel />;
  }

  return (
    <div className={styles.root}>
      <PageHeader
        title="New building"
        lede="Create the building first; floor plans and a contact can follow now or later."
        crumbs={crumbs}
      />

      <div className={styles.stepper}>
        <Stepper steps={STEPS} current={step} />
      </div>

      {step === 0 && (
        <DetailsStep
          customerId={customerId}
          siteId={siteId}
          manageBuilding={manageBuilding}
          onCreated={(id, name) => {
            setBuildingId(id);
            setBuildingName(name);
            setStep(1);
          }}
        />
      )}

      {step === 1 && buildingId && (
        <PlansStep
          buildingId={buildingId}
          onPlanAdded={(name) => setPlansAdded((list) => [...list, name])}
          onContinue={() => setStep(2)}
        />
      )}

      {step === 2 && buildingId && (
        <ContactStep
          customerId={customerId}
          siteId={siteId}
          buildingId={buildingId}
          manageBuilding={manageBuilding}
          onDone={(partyName) => {
            setPartySet(partyName);
            setStep(3);
          }}
        />
      )}

      {step === 3 && buildingId && (
        <FinishStep
          customerId={customerId}
          siteId={siteId}
          buildingId={buildingId}
          buildingName={buildingName}
          plansAdded={plansAdded}
          partySet={partySet}
        />
      )}
    </div>
  );
}

// --- Step 1: identity + details, mirroring BuildingForm's create case --------

function DetailsStep({
  customerId,
  siteId,
  manageBuilding,
  onCreated,
}: {
  customerId: string;
  siteId: string;
  manageBuilding: ReturnType<
    typeof useCallable<ManageBuildingInput, ManageBuildingResult>
  >;
  onCreated: (buildingId: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [area, setArea] = useState('');
  const [floors, setFloors] = useState('');
  const [occupiedFloors, setOccupiedFloors] = useState('');
  const [occupants, setOccupants] = useState('');
  const [isLandlord, setIsLandlord] = useState(false);
  const [alarmType, setAlarmType] = useState('');
  const [alarmCategory, setAlarmCategory] = useState<'' | AlarmCategory>('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Anything typed here exists only in this form until the building commits;
  // a successful create unmounts this step, disarming the guard.
  useUnsavedGuard(
    Boolean(
      name.trim() ||
        address.trim() ||
        area.trim() ||
        floors.trim() ||
        occupiedFloors.trim() ||
        occupants.trim() ||
        isLandlord ||
        alarmType.trim() ||
        alarmCategory,
    ),
  );

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldError('Enter the building name.');
      return;
    }
    const areaParsed = parseOptionalNumber(area, 'Floor area', false, DETAIL_LIMITS.area);
    const floorsParsed = parseOptionalNumber(floors, 'Floors', true, DETAIL_LIMITS.floors);
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
      areaParsed.error ?? floorsParsed.error ?? occupiedParsed.error ?? occupantsParsed.error;
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

    // Create only: empties are simply absent.
    const building: Partial<Building> = { name: trimmedName, customerId };
    const trimmedAddress = address.trim();
    if (trimmedAddress) building.address = trimmedAddress;
    const details: BuildingDetails = {};
    if (areaParsed.value !== undefined) details.area = areaParsed.value;
    if (floorsParsed.value !== undefined) details.floors = floorsParsed.value;
    if (occupiedParsed.value !== undefined) details.occupiedFloors = occupiedParsed.value;
    if (occupantsParsed.value !== undefined) details.occupants = occupantsParsed.value;
    if (isLandlord) details.isLandlord = true;
    const trimmedAlarmType = alarmType.trim();
    if (trimmedAlarmType) details.alarmType = trimmedAlarmType;
    if (alarmCategory) details.alarmCategory = alarmCategory;
    if (Object.keys(details).length > 0) building.details = details;

    const result = await manageBuilding.call({ action: 'create', siteId, building });
    if (result) {
      onCreated(result.buildingId, trimmedName);
    }
  };

  return (
    <form className={shared.form} onSubmit={(event) => void onSubmit(event)}>
      <fieldset className={shared.fieldset}>
        <legend className={shared.legend}>Identity</legend>
        <div className={shared.field}>
          <label className={shared.label} htmlFor="wizard-building-name">
            Name
          </label>
          <input
            id="wizard-building-name"
            className={shared.input}
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div className={shared.field}>
          <AddressField
            id="wizard-building-address"
            label="Address (optional)"
            value={address}
            onChange={setAddress}
          />
        </div>
      </fieldset>

      <fieldset className={shared.fieldset}>
        <legend className={shared.legend}>Details (optional)</legend>
        <div className={shared.fieldRow}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-building-area">
              Floor area, m² (optional)
            </label>
            <input
              id="wizard-building-area"
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
            <label className={shared.label} htmlFor="wizard-building-floors">
              Floors (optional)
            </label>
            <input
              id="wizard-building-floors"
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
            <label className={shared.label} htmlFor="wizard-building-occupied">
              Occupied floors (optional)
            </label>
            <input
              id="wizard-building-occupied"
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
            <label className={shared.label} htmlFor="wizard-building-occupants">
              Occupants (optional)
            </label>
            <input
              id="wizard-building-occupants"
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
            id="wizard-building-landlord"
            type="checkbox"
            className={shared.checkbox}
            checked={isLandlord}
            onChange={(event) => setIsLandlord(event.target.checked)}
          />
          <label className={shared.label} htmlFor="wizard-building-landlord">
            The customer is the landlord of this building
          </label>
        </div>
        <div className={shared.fieldRow}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-building-alarm-type">
              Fire alarm type (optional)
            </label>
            <input
              id="wizard-building-alarm-type"
              className={shared.input}
              type="text"
              autoComplete="off"
              value={alarmType}
              onChange={(event) => setAlarmType(event.target.value)}
            />
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-building-alarm-category">
              Alarm category, BS 5839-1 (optional)
            </label>
            <select
              id="wizard-building-alarm-category"
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
        </div>
      </fieldset>

      {fieldError && <ErrorNotice message={fieldError} />}
      {manageBuilding.error && <ErrorNotice message={manageBuilding.error} />}

      <div className={shared.formActions}>
        <Button type="submit" disabled={manageBuilding.pending}>
          {manageBuilding.pending ? 'Creating' : 'Create building'}
        </Button>
        <Button variant="secondary" to={urls.site(customerId, siteId)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// --- Step 2: floor plans - the FloorPlansPanel pipeline, compacted -----------

function PlansStep({
  buildingId,
  onPlanAdded,
  onContinue,
}: {
  buildingId: string;
  onPlanAdded: (name: string) => void;
  onContinue: () => void;
}) {
  const { claims, paths } = useAuth();
  const manageFloorPlan = useCallable<ManageFloorPlanInput, ManageFloorPlanResult>(
    'manageFloorPlan',
  );
  const [file, setFile] = useState<File | null>(null);
  const [planName, setPlanName] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // Reused on a retry after a failed callable, so we never orphan an object
  // per attempt (same protocol as FloorPlansPanel).
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);
  const [inputNonce, setInputNonce] = useState(0);

  const chooseFile = (chosen: File | null) => {
    setError(null);
    setUploadedUrl(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    const check = fileIsFloorPlan(chosen);
    if (!check.ok) {
      setError(check.reason);
      setFile(null);
      return;
    }
    setFile(chosen);
    if (!planName.trim()) {
      // A friendly default: the file name without its extension.
      setPlanName(chosen.name.replace(/\.[^.]+$/, ''));
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    chooseFile(event.target.files?.[0] ?? null);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    chooseFile(event.dataTransfer.files?.[0] ?? null);
  };

  const addPlan = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmedName = planName.trim();
    if (!file) {
      setError('Choose a floor plan file to upload.');
      return;
    }
    if (!trimmedName) {
      setError('Enter a name for this floor plan.');
      return;
    }
    if (!claims || !paths) {
      return;
    }

    let downloadUrl = uploadedUrl;
    if (downloadUrl === null) {
      const storagePath = paths.storage.floorPlan(
        claims.orgId,
        buildingId,
        newObjectId(),
      );
      setProgress(0);
      try {
        downloadUrl = await uploadFile({ storagePath, file, onProgress: setProgress });
      } catch {
        setProgress(null);
        setError('The upload failed. Check your connection and try again.');
        return;
      }
      setProgress(null);
      setUploadedUrl(downloadUrl);
    }

    const result = await manageFloorPlan.call({
      action: 'create',
      buildingId,
      plan: {
        name: trimmedName,
        imageUrl: downloadUrl,
        kind: file.type === 'application/pdf' ? 'pdf' : 'image',
      },
    });
    if (result) {
      setAdded((list) => [...list, trimmedName]);
      onPlanAdded(trimmedName);
      setFile(null);
      setPlanName('');
      setUploadedUrl(null);
      setInputNonce((n) => n + 1);
    }
  };

  const busy = progress !== null || manageFloorPlan.pending;

  return (
    <form className={shared.form} onSubmit={(event) => void addPlan(event)}>
      <fieldset className={shared.fieldset}>
        <legend className={shared.legend}>Floor plans (optional)</legend>
        <p className={shared.hint}>
          Plans unlock location flagging during assessments. You can also manage
          them later from the building page.
        </p>

        <div
          className={dragOver ? styles.dropAreaActive : styles.dropArea}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <label className={styles.dropLabel} htmlFor="wizard-plan-file">
            {file
              ? file.name
              : 'Drop a plan here, or choose a file (image up to 10 MB, or PDF up to 25 MB)'}
          </label>
          <input
            key={inputNonce}
            id="wizard-plan-file"
            className={styles.fileInput}
            type="file"
            accept="image/*,application/pdf"
            onChange={onFileChange}
            disabled={busy}
          />
        </div>

        {file && (
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-plan-name">
              Plan name
            </label>
            <input
              id="wizard-plan-name"
              className={shared.input}
              type="text"
              value={planName}
              onChange={(event) => setPlanName(event.target.value)}
              disabled={busy}
            />
          </div>
        )}

        {progress !== null && (
          <div className={styles.progressWrap}>
            <progress
              className={styles.progress}
              value={progress}
              max={1}
              aria-label="Upload progress"
            />
            <span className={styles.progressLabel}>{Math.round(progress * 100)}%</span>
          </div>
        )}

        {error && <ErrorNotice message={error} />}
        {manageFloorPlan.error && <ErrorNotice message={manageFloorPlan.error} />}

        {added.length > 0 && (
          <ul className={styles.addedList} aria-label="Plans added">
            {added.map((name, index) => (
              <li key={`${name}-${index}`} className={styles.addedRow}>
                {name}
              </li>
            ))}
          </ul>
        )}

        <div>
          <Button type="submit" variant="secondary" disabled={busy}>
            {progress !== null
              ? 'Uploading'
              : manageFloorPlan.pending
                ? 'Saving'
                : 'Add plan'}
          </Button>
        </div>
      </fieldset>

      <div className={shared.formActions}>
        <Button onClick={onContinue} disabled={busy}>
          {added.length > 0 ? 'Continue' : 'Skip this step'}
        </Button>
      </div>
    </form>
  );
}

// --- Step 3: responsible party - assign one of the customer's contacts -------

function ContactStep({
  customerId,
  siteId,
  buildingId,
  manageBuilding,
  onDone,
}: {
  customerId: string;
  siteId: string;
  buildingId: string;
  manageBuilding: ReturnType<
    typeof useCallable<ManageBuildingInput, ManageBuildingResult>
  >;
  onDone: (partyName: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<CustomerContact | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId || !selected) {
      setFieldError('Choose a contact, or skip this step.');
      return;
    }
    // The picked contact is snapshotted onto the party, keeping the link.
    const party: ResponsibleParty = { name: selected.name, contactId: selectedId };
    if (selected.jobTitle) party.role = selected.jobTitle;
    if (selected.email) party.email = selected.email;
    if (selected.phone) party.phone = selected.phone;
    setFieldError(null);

    // A partial update: manageBuilding only writes the keys it is given, so
    // the details created in step 1 are untouched.
    const result = await manageBuilding.call({
      action: 'update',
      siteId,
      buildingId,
      building: { responsibleParty: party },
    });
    if (result) {
      onDone(party.name);
    }
  };

  return (
    <form className={shared.form} onSubmit={(event) => void save(event)}>
      <fieldset className={shared.fieldset}>
        <legend className={shared.legend}>Responsible party (optional)</legend>
        <p className={shared.hint}>
          The responsible party is the default contact for assessments and
          remedial actions on this building. Safentia emails this person when an
          assessment is released and when their actions fall due, so they must
          be one of the customer’s contacts — add them below if they are not
          listed yet.
        </p>

        <div className={shared.field}>
          <ContactPicker
            customerId={customerId}
            label="Choose a contact"
            value={selectedId ?? undefined}
            onChange={(nextId, contact) => {
              setSelectedId(nextId);
              setSelected(contact);
            }}
          />
        </div>
      </fieldset>

      {fieldError && <ErrorNotice message={fieldError} />}
      {manageBuilding.error && <ErrorNotice message={manageBuilding.error} />}

      <div className={shared.formActions}>
        <Button type="submit" disabled={manageBuilding.pending}>
          {manageBuilding.pending ? 'Saving' : 'Save contact'}
        </Button>
        <Button variant="secondary" onClick={() => onDone(null)}>
          Skip this step
        </Button>
      </div>
    </form>
  );
}

// --- Finish: summary + straight to the new building ---------------------------

function FinishStep({
  customerId,
  siteId,
  buildingId,
  buildingName,
  plansAdded,
  partySet,
}: {
  customerId: string;
  siteId: string;
  buildingId: string;
  buildingName: string;
  plansAdded: string[];
  partySet: string | null;
}) {
  return (
    <div className={styles.finish}>
      <h2 className={styles.finishHeading}>Building created</h2>
      <dl className={styles.summary}>
        <dt className={styles.summaryTerm}>Building</dt>
        <dd className={styles.summaryValue}>{buildingName}</dd>
        <dt className={styles.summaryTerm}>Floor plans</dt>
        <dd className={styles.summaryValue}>
          {plansAdded.length > 0 ? plansAdded.join(', ') : 'None yet - add them any time'}
        </dd>
        <dt className={styles.summaryTerm}>Responsible party</dt>
        <dd className={styles.summaryValue}>
          {partySet ?? 'Not set - add one from the building page'}
        </dd>
      </dl>
      <div className={shared.formActions}>
        <Button to={urls.building(customerId, siteId, buildingId)}>
          Go to building
        </Button>
      </div>
    </div>
  );
}
