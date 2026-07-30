// ============================================================================
// CustomerWizard - the guided flow that provisions a customer ORGANISATION:
// org details, its people (the primary contact is invited to the portal
// server-side), a first pass at sites and buildings, and optionally the first
// job. One stepper, one bottom control bar, no data lost moving between steps.
//
// Commit point: the customer is created at the end of step 2 ("Create
// customer"); steps 3 and 4 mutate against the new record as you go. A refresh
// after step 2 therefore leaves a fully valid customer behind but loses the
// in-memory wizard state - acceptable, because everything the later steps do
// can be finished from the customer profile.
// ============================================================================

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../components/Button';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Building,
  ClearableFields,
  CreateJobInput,
  CreateJobResult,
  Customer,
  CustomerContact,
  GeoPoint,
  ManageBuildingInput,
  ManageBuildingResult,
  ManageCustomerContactInput,
  ManageCustomerContactResult,
  ManageCustomerInput,
  ManageCustomerResult,
  ManageSiteInput,
  ManageSiteResult,
  OrgMember,
  Site,
  Template,
} from '../../types';
import { AddressField } from '../ui/AddressField';
import { Card, CardHeader } from '../ui/Card';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { Stepper } from '../ui/Stepper';
import { useCallable } from '../ui/useCallable';
import { CustomerImageField, useCustomerImage } from './CustomerImageField';
import { useUnsavedGuard } from './useUnsavedGuard';
import { isValidEmail, toEntries, urls, useOrgScope } from './shared';
import shared from './shared.module.css';
import styles from './CustomerWizard.module.css';

const STEPS = ['Organisation', 'Contacts', 'Sites and buildings', 'Schedule a job'] as const;

interface ExtraContact {
  name: string;
  email: string;
  phone: string;
  jobTitle: string;
  portalAccess: boolean;
}

const emptyExtra = (): ExtraContact => ({
  name: '',
  email: '',
  phone: '',
  jobTitle: '',
  portalAccess: false,
});

interface CreatedBuilding {
  buildingId: string;
  name: string;
}

interface CreatedSite {
  siteId: string;
  name: string;
  buildings: CreatedBuilding[];
}

export function CustomerWizard() {
  const navigate = useNavigate();
  const { ready, orgId, db } = useOrgScope();

  const [step, setStep] = useState(0);
  const [finished, setFinished] = useState(false);

  // Step 1 - organisation.
  const [orgName, setOrgName] = useState('');
  const [orgAddress, setOrgAddress] = useState('');
  const [orgEmail, setOrgEmail] = useState('');
  const [orgPhone, setOrgPhone] = useState('');
  // The organisation's optional logo/photo, picked in step 1 and uploaded at
  // the commit (a new customer has no id yet, and the org asset prefix needs
  // none). No current image on create, so the hook starts empty.
  const image = useCustomerImage(null);

  // Step 2 - people.
  const [primaryName, setPrimaryName] = useState('');
  const [primaryEmail, setPrimaryEmail] = useState('');
  const [primaryPhone, setPrimaryPhone] = useState('');
  const [primaryJobTitle, setPrimaryJobTitle] = useState('');
  const [extras, setExtras] = useState<ExtraContact[]>([]);

  // Committed results.
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [inviteSent, setInviteSent] = useState(false);
  const [contactsCreated, setContactsCreated] = useState(1);
  const [contactWarnings, setContactWarnings] = useState<string[]>([]);

  // Step 3 - sites and buildings created so far.
  const [createdSites, setCreatedSites] = useState<CreatedSite[]>([]);

  // Step 4 - the scheduled job.
  const [jobCreated, setJobCreated] = useState(false);

  const [fieldError, setFieldError] = useState<string | null>(null);

  // True for the WHOLE commit (customer + every extra contact), not just while
  // one callable is in flight: the pendings alone leave a gap between calls
  // where a second click would duplicate the entire customer and invitation.
  const [submitting, setSubmitting] = useState(false);

  const manageCustomer = useCallable<ManageCustomerInput, ManageCustomerResult>(
    'manageCustomer',
  );
  const manageContact = useCallable<
    ManageCustomerContactInput,
    ManageCustomerContactResult
  >('manageCustomerContact');

  const buildingCount = createdSites.reduce(
    (sum, site) => sum + site.buildings.length,
    0,
  );

  // Unsaved work: anything typed before the commit, then the whole in-flight
  // flow until the finish screen (steps 3 and 4 hold their own field state in
  // child forms, so the committed customerId keeps the guard armed for them).
  useUnsavedGuard(
    !finished &&
      Boolean(
        customerId !== null ||
          orgName.trim() ||
          orgAddress.trim() ||
          orgEmail.trim() ||
          orgPhone.trim() ||
          primaryName.trim() ||
          primaryEmail.trim() ||
          primaryPhone.trim() ||
          primaryJobTitle.trim() ||
          extras.length > 0,
      ),
  );

  // --- Step transitions -------------------------------------------------------

  const nextFromOrganisation = () => {
    if (!orgName.trim()) {
      setFieldError('Enter the organisation name.');
      return;
    }
    if (orgEmail.trim() && !isValidEmail(orgEmail.trim())) {
      setFieldError('Enter a valid switchboard email, or leave the field empty.');
      return;
    }
    setFieldError(null);
    setStep(1);
  };

  /** The commit: creates the customer with its primary contact server-side
   *  (the Function also issues the portal invitation when an email is given),
   *  then creates each additional contact. A failed extra never blocks the
   *  flow - the customer exists; the failure is reported honestly and can be
   *  retried from the profile. */
  const createCustomer = async () => {
    if (submitting) {
      return;
    }
    const name = primaryName.trim();
    if (!name) {
      setFieldError('Enter the primary contact name.');
      return;
    }
    const email = primaryEmail.trim();
    if (email && !isValidEmail(email)) {
      setFieldError('Enter a valid email for the primary contact, or leave it empty.');
      return;
    }
    for (const extra of extras) {
      if (!extra.name.trim()) {
        setFieldError('Every additional contact needs a name. Remove empty rows.');
        return;
      }
      if (extra.email.trim() && !isValidEmail(extra.email.trim())) {
        setFieldError(`Enter a valid email for ${extra.name.trim()}, or leave it empty.`);
        return;
      }
    }
    setFieldError(null);

    const customer: ClearableFields<Customer> = { name: orgName.trim() };
    if (orgAddress.trim()) customer.address = orgAddress.trim();
    if (orgEmail.trim()) customer.email = orgEmail.trim();
    if (orgPhone.trim()) customer.phone = orgPhone.trim();

    const primaryContact: NonNullable<ManageCustomerInput['primaryContact']> = {
      name,
    };
    if (email) primaryContact.email = email;
    if (primaryPhone.trim()) primaryContact.phone = primaryPhone.trim();
    if (primaryJobTitle.trim()) primaryContact.jobTitle = primaryJobTitle.trim();

    setSubmitting(true);
    try {
      // Upload any chosen image first so its URL rides in the create payload;
      // a failed upload aborts before the customer is written.
      const imageChange = await image.resolve();
      if (imageChange === 'error') {
        setFieldError('Could not upload the image. Please try again.');
        return;
      }
      if ('photoUrl' in imageChange && imageChange.photoUrl) {
        customer.photoUrl = imageChange.photoUrl;
      }
      const result = await manageCustomer.call({
        action: 'create',
        customer,
        primaryContact,
      });
      if (!result) {
        return; // manageCustomer.error renders below the form.
      }
      setCustomerId(result.customerId);
      setInviteSent(Boolean(result.inviteId));

      // Additional contacts, sequentially (the callable handle allows one
      // in-flight call). Failures are collected, not fatal.
      const failures: string[] = [];
      let created = 1;
      for (const extra of extras) {
        const contact: ClearableFields<CustomerContact> = { name: extra.name.trim() };
        if (extra.email.trim()) contact.email = extra.email.trim();
        if (extra.phone.trim()) contact.phone = extra.phone.trim();
        if (extra.jobTitle.trim()) contact.jobTitle = extra.jobTitle.trim();
        if (extra.portalAccess) contact.portalRoles = { viewer: true };
        const contactResult = await manageContact.call({
          action: 'create',
          customerId: result.customerId,
          contact,
        });
        if (contactResult) {
          created += 1;
        } else {
          failures.push(extra.name.trim());
        }
      }
      setContactsCreated(created);
      setContactWarnings(failures);
      setStep(2);
    } finally {
      setSubmitting(false);
    }
  };

  const finishFromSites = () => {
    if (buildingCount > 0) {
      setStep(3);
    } else {
      setFinished(true);
    }
  };

  // --- Render -----------------------------------------------------------------

  return (
    <div className={styles.root}>
      <PageHeader
        title="New customer"
        lede="Set up the organisation, its people, and optionally its first sites and job."
        crumbs={[{ label: 'Customers', to: urls.customers }, { label: 'New customer' }]}
      />

      <Stepper steps={STEPS} current={finished ? STEPS.length : step} />

      {finished && customerId ? (
        <FinishPanel
          customerId={customerId}
          orgName={orgName.trim()}
          contactsCreated={contactsCreated}
          siteCount={createdSites.length}
          buildingCount={buildingCount}
          jobCreated={jobCreated}
          inviteSent={inviteSent}
          primaryEmail={primaryEmail.trim()}
          primaryName={primaryName.trim()}
          onGo={() => navigate(urls.customer(customerId))}
        />
      ) : step === 0 ? (
        <Card>
          <CardHeader
            title="Organisation"
            hint="The customer is the organisation you assess - a housing association, a property group. People come next."
          />
          <div className={styles.stepBody}>
            <div className={shared.field}>
              <label className={shared.label} htmlFor="wizard-org-name">
                Organisation name
              </label>
              <input
                id="wizard-org-name"
                className={shared.input}
                type="text"
                value={orgName}
                onChange={(event) => setOrgName(event.target.value)}
              />
            </div>
            <div className={shared.field}>
              <AddressField
                id="wizard-org-address"
                label="Head office address (optional)"
                value={orgAddress}
                onChange={setOrgAddress}
              />
            </div>
            <div className={shared.fieldRow}>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="wizard-org-email">
                  Switchboard email (optional)
                </label>
                <input
                  id="wizard-org-email"
                  className={shared.input}
                  type="email"
                  autoComplete="off"
                  value={orgEmail}
                  onChange={(event) => setOrgEmail(event.target.value)}
                />
              </div>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="wizard-org-phone">
                  Phone (optional)
                </label>
                <input
                  id="wizard-org-phone"
                  className={shared.input}
                  type="tel"
                  autoComplete="off"
                  value={orgPhone}
                  onChange={(event) => setOrgPhone(event.target.value)}
                />
              </div>
            </div>
            <CustomerImageField
              image={image}
              name={orgName.trim() || 'this customer'}
              disabled={submitting}
            />
          </div>
          {fieldError && <ErrorNotice message={fieldError} />}
          <ControlBar>
            <Button variant="ghost" to={urls.customers}>
              Cancel
            </Button>
            <Button onClick={nextFromOrganisation}>Next: contacts</Button>
          </ControlBar>
        </Card>
      ) : step === 1 ? (
        <Card>
          <CardHeader
            title="Contacts"
            hint="The people at this organisation. The primary contact receives the portal invitation."
          />
          <div className={styles.stepBody}>
            <h3 className={styles.groupTitle}>Primary contact</h3>
            <div className={shared.fieldRow}>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="wizard-primary-name">
                  Name
                </label>
                <input
                  id="wizard-primary-name"
                  className={shared.input}
                  type="text"
                  value={primaryName}
                  onChange={(event) => setPrimaryName(event.target.value)}
                />
              </div>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="wizard-primary-job">
                  Job title (optional)
                </label>
                <input
                  id="wizard-primary-job"
                  className={shared.input}
                  type="text"
                  autoComplete="off"
                  value={primaryJobTitle}
                  onChange={(event) => setPrimaryJobTitle(event.target.value)}
                />
              </div>
            </div>
            <div className={shared.fieldRow}>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="wizard-primary-email">
                  Email
                </label>
                <input
                  id="wizard-primary-email"
                  className={shared.input}
                  type="email"
                  autoComplete="off"
                  value={primaryEmail}
                  onChange={(event) => setPrimaryEmail(event.target.value)}
                />
                <p className={shared.hint}>
                  The primary contact receives the portal invitation. Without an
                  email you can invite them later from the profile.
                </p>
              </div>
              <div className={shared.field}>
                <label className={shared.label} htmlFor="wizard-primary-phone">
                  Phone (optional)
                </label>
                <input
                  id="wizard-primary-phone"
                  className={shared.input}
                  type="tel"
                  autoComplete="off"
                  value={primaryPhone}
                  onChange={(event) => setPrimaryPhone(event.target.value)}
                />
              </div>
            </div>

            <h3 className={styles.groupTitle}>Additional contacts (optional)</h3>
            {extras.map((extra, index) => (
              <div key={index} className={styles.extraRow}>
                <div className={shared.fieldRow}>
                  <div className={shared.field}>
                    <label className={shared.label} htmlFor={`wizard-extra-name-${index}`}>
                      Name
                    </label>
                    <input
                      id={`wizard-extra-name-${index}`}
                      className={shared.input}
                      type="text"
                      value={extra.name}
                      onChange={(event) => updateExtra(setExtras, index, { name: event.target.value })}
                    />
                  </div>
                  <div className={shared.field}>
                    <label className={shared.label} htmlFor={`wizard-extra-job-${index}`}>
                      Job title (optional)
                    </label>
                    <input
                      id={`wizard-extra-job-${index}`}
                      className={shared.input}
                      type="text"
                      autoComplete="off"
                      value={extra.jobTitle}
                      onChange={(event) => updateExtra(setExtras, index, { jobTitle: event.target.value })}
                    />
                  </div>
                </div>
                <div className={shared.fieldRow}>
                  <div className={shared.field}>
                    <label className={shared.label} htmlFor={`wizard-extra-email-${index}`}>
                      Email (optional)
                    </label>
                    <input
                      id={`wizard-extra-email-${index}`}
                      className={shared.input}
                      type="email"
                      autoComplete="off"
                      value={extra.email}
                      onChange={(event) => updateExtra(setExtras, index, { email: event.target.value })}
                    />
                  </div>
                  <div className={shared.field}>
                    <label className={shared.label} htmlFor={`wizard-extra-phone-${index}`}>
                      Phone (optional)
                    </label>
                    <input
                      id={`wizard-extra-phone-${index}`}
                      className={shared.input}
                      type="tel"
                      autoComplete="off"
                      value={extra.phone}
                      onChange={(event) => updateExtra(setExtras, index, { phone: event.target.value })}
                    />
                  </div>
                </div>
                <div className={styles.extraFooter}>
                  <label className={shared.checkboxRow}>
                    <input
                      type="checkbox"
                      className={shared.checkbox}
                      checked={extra.portalAccess}
                      onChange={(event) =>
                        updateExtra(setExtras, index, { portalAccess: event.target.checked })
                      }
                    />
                    <span className={shared.label}>Portal access (viewer)</span>
                  </label>
                  <Button
                    variant="ghost"
                    onClick={() => setExtras((prev) => prev.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                onClick={() => setExtras((prev) => [...prev, emptyExtra()])}
              >
                Add another contact
              </Button>
            </div>
          </div>
          {fieldError && <ErrorNotice message={fieldError} />}
          {manageCustomer.error && <ErrorNotice message={manageCustomer.error} />}
          <ControlBar>
            <Button
              variant="ghost"
              onClick={() => setStep(0)}
              disabled={submitting || manageCustomer.pending}
            >
              Back
            </Button>
            <Button
              onClick={() => void createCustomer()}
              disabled={submitting || manageCustomer.pending}
            >
              {submitting || manageCustomer.pending ? 'Creating' : 'Create customer'}
            </Button>
          </ControlBar>
        </Card>
      ) : step === 2 && customerId ? (
        <SitesStep
          customerId={customerId}
          createdSites={createdSites}
          setCreatedSites={setCreatedSites}
          contactWarnings={contactWarnings}
          buildingCount={buildingCount}
          onContinue={finishFromSites}
          onSkip={() => setFinished(true)}
        />
      ) : step === 3 && customerId ? (
        <JobStep
          ready={ready}
          orgId={orgId}
          templatesPath={db ? db.templates(orgId) : ''}
          membersPath={db ? db.orgMembers(orgId) : ''}
          customerId={customerId}
          createdSites={createdSites}
          onScheduled={() => {
            setJobCreated(true);
            setFinished(true);
          }}
          onSkip={() => setFinished(true)}
        />
      ) : null}
    </div>
  );
}

function updateExtra(
  setExtras: React.Dispatch<React.SetStateAction<ExtraContact[]>>,
  index: number,
  patch: Partial<ExtraContact>,
) {
  setExtras((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
}

/** The consistent bottom control bar: quiet actions left, primary at the end. */
function ControlBar({ children }: { children: React.ReactNode }) {
  return <div className={styles.controls}>{children}</div>;
}

// ----------------------------------------------------------------------------
// Step 3 - quick-add sites and buildings. Each add commits immediately via
// manageSite / manageBuilding, growing a checklist; full details (floor plans,
// site contacts) are added later from the site and building pages.
// ----------------------------------------------------------------------------

function SitesStep({
  customerId,
  createdSites,
  setCreatedSites,
  contactWarnings,
  buildingCount,
  onContinue,
  onSkip,
}: {
  customerId: string;
  createdSites: CreatedSite[];
  setCreatedSites: React.Dispatch<React.SetStateAction<CreatedSite[]>>;
  contactWarnings: string[];
  buildingCount: number;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const manageSite = useCallable<ManageSiteInput, ManageSiteResult>('manageSite');
  const manageBuilding = useCallable<ManageBuildingInput, ManageBuildingResult>(
    'manageBuilding',
  );
  const [siteName, setSiteName] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  // Derived from the address by AddressField, never typed. A site created here
  // carries its point just as one created in the site form does.
  const [siteGeo, setSiteGeo] = useState<GeoPoint | null>(null);
  const [buildingNames, setBuildingNames] = useState<Record<string, string>>({});
  const [fieldError, setFieldError] = useState<string | null>(null);

  const addSite = async () => {
    const name = siteName.trim();
    if (!name) {
      setFieldError('Enter the site name.');
      return;
    }
    setFieldError(null);
    const site: ClearableFields<Site> = { name };
    if (siteAddress.trim()) site.address = siteAddress.trim();
    if (siteGeo) site.geo = siteGeo;
    const result = await manageSite.call({ action: 'create', customerId, site });
    if (result) {
      setCreatedSites((prev) => [...prev, { siteId: result.siteId, name, buildings: [] }]);
      setSiteName('');
      setSiteAddress('');
      setSiteGeo(null);
    }
  };

  const addBuilding = async (siteId: string) => {
    const name = (buildingNames[siteId] ?? '').trim();
    if (!name) {
      setFieldError('Enter the building name.');
      return;
    }
    setFieldError(null);
    const building: ClearableFields<Building> = { name, customerId };
    const result = await manageBuilding.call({ action: 'create', siteId, building });
    if (result) {
      setCreatedSites((prev) =>
        prev.map((site) =>
          site.siteId === siteId
            ? {
                ...site,
                buildings: [...site.buildings, { buildingId: result.buildingId, name }],
              }
            : site,
        ),
      );
      setBuildingNames((prev) => ({ ...prev, [siteId]: '' }));
    }
  };

  return (
    <Card>
      <CardHeader
        title="Sites and buildings"
        hint="A quick first pass. Full details - floor plans, site contacts - can be added from each site and building page."
      />
      {contactWarnings.length > 0 && (
        <p role="alert" className={styles.warning}>
          The customer was created, but {contactWarnings.length === 1 ? 'a contact' : 'some contacts'} could
          not be added: {contactWarnings.join(', ')}. Retry from the customer profile.
        </p>
      )}
      <div className={styles.stepBody}>
        {createdSites.length > 0 && (
          <ul className={styles.checklist}>
            {createdSites.map((site) => (
              <li key={site.siteId} className={styles.checklistSite}>
                <div className={styles.checklistSiteName}>
                  <span aria-hidden="true" className={styles.tick}>
                    {'✓'}
                  </span>
                  {site.name}
                </div>
                {site.buildings.length > 0 && (
                  <ul className={styles.checklistBuildings}>
                    {site.buildings.map((building) => (
                      <li key={building.buildingId}>
                        <span aria-hidden="true" className={styles.tick}>
                          {'✓'}
                        </span>
                        {building.name}
                      </li>
                    ))}
                  </ul>
                )}
                <div className={styles.quickAddRow}>
                  <div className={shared.field}>
                    <label
                      className={shared.label}
                      htmlFor={`wizard-building-${site.siteId}`}
                    >
                      Building name
                    </label>
                    <input
                      id={`wizard-building-${site.siteId}`}
                      className={shared.input}
                      type="text"
                      value={buildingNames[site.siteId] ?? ''}
                      onChange={(event) =>
                        setBuildingNames((prev) => ({
                          ...prev,
                          [site.siteId]: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <Button
                    variant="secondary"
                    disabled={manageBuilding.pending}
                    onClick={() => void addBuilding(site.siteId)}
                  >
                    Add building
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* The address gets its own full-width line so the Mapbox combobox has
            room to open - the one field the autocomplete rollout initially
            skipped, which read as "no autofill" to the product owner. */}
        <div className={styles.quickAddRow}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-site-name">
              Site name
            </label>
            <input
              id="wizard-site-name"
              className={shared.input}
              type="text"
              value={siteName}
              onChange={(event) => setSiteName(event.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            disabled={manageSite.pending}
            onClick={() => void addSite()}
          >
            {manageSite.pending ? 'Adding' : 'Add site'}
          </Button>
        </div>
        <div className={shared.field}>
          <AddressField
            id="wizard-site-address"
            label="Address (optional)"
            value={siteAddress}
            onChange={setSiteAddress}
            geo={siteGeo}
            onGeoChange={setSiteGeo}
          />
        </div>
      </div>
      {fieldError && <ErrorNotice message={fieldError} />}
      {manageSite.error && <ErrorNotice message={manageSite.error} />}
      {manageBuilding.error && <ErrorNotice message={manageBuilding.error} />}
      <ControlBar>
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        <Button onClick={onContinue} disabled={createdSites.length === 0}>
          {buildingCount > 0 ? 'Next: schedule a job' : 'Finish'}
        </Button>
      </ControlBar>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Step 4 - schedule the first job against a building created in step 3.
// Only rendered when at least one building exists.
// ----------------------------------------------------------------------------

function JobStep({
  ready,
  orgId,
  templatesPath,
  membersPath,
  customerId,
  createdSites,
  onScheduled,
  onSkip,
}: {
  ready: boolean;
  orgId: string;
  templatesPath: string;
  membersPath: string;
  customerId: string;
  createdSites: CreatedSite[];
  onScheduled: () => void;
  onSkip: () => void;
}) {
  const createJob = useCallable<CreateJobInput, CreateJobResult>('createJob');

  const templates = useRtdbQuery<Record<string, Template> | null>({
    key: keys.templates(orgId),
    path: templatesPath,
    enabled: ready,
  });
  const members = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: membersPath,
    enabled: ready,
  });

  // The published templates only: /templates holds one node per template whose
  // `version` is its latest PUBLISHED version (published versions are
  // immutable), so listing published templates is a status filter.
  const publishedTemplates = useMemo(
    () => toEntries(templates.data).filter(([, template]) => template.status === 'published'),
    [templates.data],
  );
  const assessors = useMemo(
    () =>
      toEntries(members.data).filter(
        ([, member]) => member.roles.assessor === true && member.status === 'active',
      ),
    [members.data],
  );

  const buildingOptions = createdSites.flatMap((site) =>
    site.buildings.map((building) => ({
      siteId: site.siteId,
      siteName: site.name,
      buildingId: building.buildingId,
      buildingName: building.name,
    })),
  );

  const [buildingId, setBuildingId] = useState(buildingOptions[0]?.buildingId ?? '');
  const [templateId, setTemplateId] = useState('');
  const [assessorUid, setAssessorUid] = useState('');
  const [date, setDate] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const schedule = async () => {
    const building = buildingOptions.find((option) => option.buildingId === buildingId);
    const template = templates.data?.[templateId];
    if (!building || !template || !assessorUid || !date) {
      setFieldError('Choose the building, template, assessor and date.');
      return;
    }
    setFieldError(null);
    const scheduledFor = new Date(`${date}T09:00:00`).getTime();
    const result = await createJob.call({
      templateId,
      templateVersion: template.version,
      customerId,
      siteId: building.siteId,
      buildingId: building.buildingId,
      assessorUid,
      scheduledFor,
    });
    if (result) {
      onScheduled();
    }
  };

  return (
    <Card>
      <CardHeader
        title="Schedule a job"
        hint="Book the first assessment for one of the buildings you just added. You can always do this later from the Jobs area."
      />
      <div className={styles.stepBody}>
        <div className={shared.fieldRow}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-job-building">
              Building
            </label>
            <select
              id="wizard-job-building"
              className={shared.select}
              value={buildingId}
              onChange={(event) => setBuildingId(event.target.value)}
            >
              {buildingOptions.map((option) => (
                <option key={option.buildingId} value={option.buildingId}>
                  {option.siteName} - {option.buildingName}
                </option>
              ))}
            </select>
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-job-template">
              Template
            </label>
            <select
              id="wizard-job-template"
              className={shared.select}
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              <option value="">Choose a template</option>
              {publishedTemplates.map(([id, template]) => (
                <option key={id} value={id}>
                  {template.name} (v{template.version})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className={shared.fieldRow}>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-job-assessor">
              Assessor
            </label>
            <select
              id="wizard-job-assessor"
              className={shared.select}
              value={assessorUid}
              onChange={(event) => setAssessorUid(event.target.value)}
            >
              <option value="">Choose an assessor</option>
              {assessors.map(([uid, member]) => (
                <option key={uid} value={uid}>
                  {member.name}
                </option>
              ))}
            </select>
          </div>
          <div className={shared.field}>
            <label className={shared.label} htmlFor="wizard-job-date">
              Date
            </label>
            <input
              id="wizard-job-date"
              className={shared.input}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
        </div>
      </div>
      {fieldError && <ErrorNotice message={fieldError} />}
      {createJob.error && <ErrorNotice message={createJob.error} />}
      <ControlBar>
        <Button variant="ghost" onClick={onSkip} disabled={createJob.pending}>
          Skip for now
        </Button>
        <Button onClick={() => void schedule()} disabled={createJob.pending}>
          {createJob.pending ? 'Scheduling' : 'Schedule job'}
        </Button>
      </ControlBar>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Finish - what was created, and where the primary contact's invitation stands.
// ----------------------------------------------------------------------------

function FinishPanel({
  customerId: _customerId,
  orgName,
  contactsCreated,
  siteCount,
  buildingCount,
  jobCreated,
  inviteSent,
  primaryEmail,
  primaryName,
  onGo,
}: {
  customerId: string;
  orgName: string;
  contactsCreated: number;
  siteCount: number;
  buildingCount: number;
  jobCreated: boolean;
  inviteSent: boolean;
  primaryEmail: string;
  primaryName: string;
  onGo: () => void;
}) {
  const lines = [
    `${contactsCreated} ${contactsCreated === 1 ? 'contact' : 'contacts'}`,
    `${siteCount} ${siteCount === 1 ? 'site' : 'sites'}`,
    `${buildingCount} ${buildingCount === 1 ? 'building' : 'buildings'}`,
  ];
  if (jobCreated) {
    lines.push('1 job scheduled');
  }
  return (
    <Card>
      <CardHeader title={`${orgName} is set up`} hint="Everything below is live on the customer profile." />
      <ul className={styles.summaryList}>
        {lines.map((line) => (
          <li key={line}>
            <span aria-hidden="true" className={styles.tick}>
              {'✓'}
            </span>
            {line}
          </li>
        ))}
      </ul>
      <p role="status" className={shared.cardCopy}>
        {inviteSent
          ? `A portal invitation has been sent to ${primaryName} at ${primaryEmail}.`
          : primaryEmail
            ? `The portal invitation to ${primaryName} could not be sent. Resend it from the customer's contacts.`
            : `${primaryName} has no email on record, so no portal invitation was sent. You can add one and invite them from the profile.`}
      </p>
      <ControlBar>
        <Button onClick={onGo}>Go to customer</Button>
      </ControlBar>
    </Card>
  );
}
