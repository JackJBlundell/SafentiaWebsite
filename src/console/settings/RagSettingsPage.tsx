// ============================================================================
// RagSettingsPage - the organisation's configurable RAG roll-up (story 2012).
//
// The two share thresholds are edited as percentages and stored 0..1; the two
// action-plan levers are plain toggles. The LIVE PREVIEW runs the same pure
// deriveRiskLevel the release pipeline will use (see ragDerivation.ts) against
// real buildings, so an admin sees the consequence of a threshold before
// saving it. Buildings are keyed per site in RTDB, so the preview reads one
// chosen customer's chosen site rather than fanning out across the whole
// estate - the copy says exactly what it covers.
// ============================================================================

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button';
import { riskPresentation } from '../../design/rag';
import { useTheme } from '../../design/ThemeProvider';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type {
  Building,
  Customer,
  OrgSettings,
  RagConfig,
  RiskLevel,
  Site,
  UpdateOrgSettingsInput,
  UpdateOrgSettingsResult,
} from '../../types';
import { Card, CardHeader } from '../ui/Card';
import { PageGrid } from '../ui/Grid';
import { ErrorNotice, PageHeader } from '../ui/Page';
import { useCallable } from '../ui/useCallable';
import { RAG_CONFIG_DEFAULTS, deriveRiskLevel } from './ragDerivation';
import styles from './RagSettingsPage.module.css';

/** 0..1 share -> "10" style percent text (one decimal place at most). */
function shareToPercentText(share: number): string {
  return String(Math.round(share * 1000) / 10);
}

/** "10" style percent text -> 0..1 share, or null when empty or out of range.
 *  An empty or whitespace field is INVALID, not zero: Number('') is 0, which
 *  would silently save a blanked threshold as 0%. */
function percentTextToShare(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  return value / 100;
}

export function RagSettingsPage() {
  const { claims, paths } = useAuth();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(claims && paths);

  const settings = useRtdbQuery<OrgSettings | null>({
    key: keys.orgSettings(orgId),
    path: paths ? paths.db.orgSettings(orgId) : '',
    enabled,
  });

  const update = useCallable<UpdateOrgSettingsInput, UpdateOrgSettingsResult>(
    'updateOrgSettings',
  );

  // Percent fields are held as TEXT so a half-typed number is not fought by a
  // formatter; the toggles are plain booleans. Seeded once from the first
  // snapshot (saved config or the proposed defaults).
  const [seeded, setSeeded] = useState(false);
  const [redShareText, setRedShareText] = useState(
    shareToPercentText(RAG_CONFIG_DEFAULTS.redShareForHigh),
  );
  const [amberRedShareText, setAmberRedShareText] = useState(
    shareToPercentText(RAG_CONFIG_DEFAULTS.amberRedShareForMedium),
  );
  const [openHighForcesHigh, setOpenHighForcesHigh] = useState(
    RAG_CONFIG_DEFAULTS.openHighActionForcesHigh,
  );
  const [overdueEscalates, setOverdueEscalates] = useState(
    RAG_CONFIG_DEFAULTS.overdueActionEscalates,
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (seeded || settings.data === undefined) {
      return;
    }
    const stored = settings.data?.ragConfig ?? RAG_CONFIG_DEFAULTS;
    setRedShareText(shareToPercentText(stored.redShareForHigh));
    setAmberRedShareText(shareToPercentText(stored.amberRedShareForMedium));
    setOpenHighForcesHigh(stored.openHighActionForcesHigh);
    setOverdueEscalates(stored.overdueActionEscalates);
    setSeeded(true);
  }, [seeded, settings.data]);

  const redShare = percentTextToShare(redShareText);
  const amberRedShare = percentTextToShare(amberRedShareText);
  // A red threshold of exactly zero would classify EVERY building as high risk
  // (0% of findings red always "reaches" 0%), which no organisation means; it
  // is a hard error, distinct from the parse error below.
  const redShareIsZero = redShare !== null && redShare <= 0;
  const valid = redShare !== null && !redShareIsZero && amberRedShare !== null;
  // Informational only: the medium bar measures the COMBINED amber+red share
  // (always >= the red share for any distribution), so the proposed defaults
  // put it above the red bar (10% red -> high, 25% amber+red -> medium). A
  // medium bar BELOW the red bar is still logically sound - the derivation
  // checks the red bar first, so the high band always wins - but it often
  // signals transposed numbers; flag it, don't block it.
  const unusualThresholdOrder =
    redShare !== null && amberRedShare !== null && amberRedShare < redShare;

  const draftConfig: RagConfig | null = valid
    ? {
        redShareForHigh: redShare,
        amberRedShareForMedium: amberRedShare,
        openHighActionForcesHigh: openHighForcesHigh,
        overdueActionEscalates: overdueEscalates,
      }
    : null;

  const resetToDefaults = () => {
    setSaved(false);
    setRedShareText(shareToPercentText(RAG_CONFIG_DEFAULTS.redShareForHigh));
    setAmberRedShareText(
      shareToPercentText(RAG_CONFIG_DEFAULTS.amberRedShareForMedium),
    );
    setOpenHighForcesHigh(RAG_CONFIG_DEFAULTS.openHighActionForcesHigh);
    setOverdueEscalates(RAG_CONFIG_DEFAULTS.overdueActionEscalates);
  };

  const onSave = async () => {
    if (!draftConfig) {
      return;
    }
    setSaved(false);
    const result = await update.call({ ragConfig: draftConfig });
    if (result) {
      setSaved(true);
    }
  };

  return (
    <div>
      <PageHeader
        title="Risk scoring"
        lede="How a building's red-amber-green risk level is derived from its released findings and action plan."
      />

      <PageGrid aside={<LivePreview config={draftConfig} />}>
      <Card>
        <CardHeader title="Thresholds" />
        <div className={styles.cardBody}>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="rag-red-share">
            High risk when red findings reach (%)
          </label>
          <input
            id="rag-red-share"
            className={styles.input}
            type="number"
            min={0}
            max={100}
            step={0.5}
            inputMode="decimal"
            value={redShareText}
            onChange={(event) => {
              setSaved(false);
              setRedShareText(event.target.value);
            }}
            aria-describedby="rag-red-share-hint"
            aria-invalid={redShare === null || redShareIsZero}
          />
          <p id="rag-red-share-hint" className={styles.note}>
            The share of findings that are red (high severity) at or above which
            the building is high risk.
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="rag-amber-share">
            Medium risk when amber and red findings reach (%)
          </label>
          <input
            id="rag-amber-share"
            className={styles.input}
            type="number"
            min={0}
            max={100}
            step={0.5}
            inputMode="decimal"
            value={amberRedShareText}
            onChange={(event) => {
              setSaved(false);
              setAmberRedShareText(event.target.value);
            }}
            aria-describedby="rag-amber-share-hint"
            aria-invalid={amberRedShare === null}
          />
          <p id="rag-amber-share-hint" className={styles.note}>
            The combined share of amber and red findings at or above which the
            building is at least medium risk.
          </p>
        </div>

        <label className={styles.toggle} htmlFor="rag-open-high">
          <input
            id="rag-open-high"
            type="checkbox"
            checked={openHighForcesHigh}
            onChange={(event) => {
              setSaved(false);
              setOpenHighForcesHigh(event.target.checked);
            }}
          />
          <span>An open high-severity action holds the building at high risk</span>
        </label>

        <label className={styles.toggle} htmlFor="rag-overdue">
          <input
            id="rag-overdue"
            type="checkbox"
            checked={overdueEscalates}
            onChange={(event) => {
              setSaved(false);
              setOverdueEscalates(event.target.checked);
            }}
          />
          <span>An overdue action raises the risk level by one band</span>
        </label>

        {redShareIsZero ? (
          <ErrorNotice message="The red threshold must be above zero." />
        ) : (
          !valid && (
            <ErrorNotice message="Thresholds must be percentages between 0 and 100." />
          )
        )}
        {valid && unusualThresholdOrder && (
          <p className={styles.note} role="note">
            Most organisations set the medium bar below the red bar.
          </p>
        )}
        {update.error && <ErrorNotice message={update.error} />}
        {saved && (
          <p role="status" className={styles.success}>
            Risk scoring settings saved.
          </p>
        )}

        <div className={styles.actions}>
          <Button
            disabled={!valid || update.pending || !seeded}
            onClick={() => void onSave()}
          >
            {update.pending ? 'Saving' : 'Save settings'}
          </Button>
          <Button variant="ghost" disabled={update.pending} onClick={resetToDefaults}>
            Reset to defaults
          </Button>
        </div>

        </div>
      </Card>

      <p className={styles.note}>
        These thresholds take effect for newly released assessments; existing
        scores are not rewritten.
      </p>
      </PageGrid>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Live preview: real buildings, stored level beside the level the edited
// thresholds would derive. Buildings are keyed per site, so the preview reads
// one customer's one site (chosen below) instead of downloading the estate.
// ----------------------------------------------------------------------------

function LivePreview({ config }: { config: RagConfig | null }) {
  const { claims, paths } = useAuth();
  const { theme } = useTheme();
  const orgId = claims?.orgId ?? '';
  const enabled = Boolean(claims && paths);

  const customers = useRtdbQuery<Record<string, Customer> | null>({
    key: claims ? keys.customers(claims.orgId) : ['customers', 'none'],
    path: paths ? paths.db.customers(orgId) : '',
    enabled,
  });

  const customerOptions = useMemo(
    () =>
      Object.entries(customers.data ?? {})
        .map(([id, customer]) => ({ id, name: customer.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [customers.data],
  );

  const [customerId, setCustomerId] = useState('');
  useEffect(() => {
    if (customerOptions.length > 0 && !customerOptions.some((c) => c.id === customerId)) {
      setCustomerId(customerOptions[0].id);
    }
  }, [customerOptions, customerId]);

  const sites = useRtdbQuery<Record<string, Site> | null>({
    key: claims && customerId ? keys.sites(claims.orgId, customerId) : ['sites', 'none'],
    path: paths && customerId ? paths.db.sites(orgId, customerId) : '',
    enabled: enabled && Boolean(customerId),
  });

  const siteOptions = useMemo(
    () =>
      Object.entries(sites.data ?? {})
        .map(([id, site]) => ({ id, name: site.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [sites.data],
  );

  const [siteId, setSiteId] = useState('');
  useEffect(() => {
    if (siteOptions.length === 0) {
      setSiteId('');
      return;
    }
    if (!siteOptions.some((s) => s.id === siteId)) {
      setSiteId(siteOptions[0].id);
    }
  }, [siteOptions, siteId]);

  const buildings = useRtdbQuery<Record<string, Building> | null>({
    key: claims && siteId ? keys.buildings(claims.orgId, siteId) : ['buildings', 'none'],
    path: paths && siteId ? paths.db.buildings(orgId, siteId) : '',
    enabled: enabled && Boolean(siteId),
  });

  const rows = useMemo(
    () =>
      Object.entries(buildings.data ?? {})
        .map(([id, building]) => ({ id, building }))
        .sort((a, b) => a.building.name.localeCompare(b.building.name)),
    [buildings.data],
  );

  return (
    <Card>
      <CardHeader title="Live preview" />
      <div className={styles.cardBody}>
      <p className={styles.note}>
        Pick a customer and site to compare each building&apos;s current stored
        risk level with the level your edited thresholds would derive from its
        recorded finding distribution. The preview covers the chosen site only,
        and reflects finding shares alone; action-plan escalations apply when an
        assessment is released.
      </p>

      {customerOptions.length === 0 ? (
        <p className={styles.note}>
          No customers yet, so there is nothing to preview. The thresholds still
          save and will apply to your first released assessment.
        </p>
      ) : (
        <>
          <div className={styles.pickerRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="rag-preview-customer">
                Customer
              </label>
              <select
                id="rag-preview-customer"
                className={styles.select}
                value={customerId}
                onChange={(event) => setCustomerId(event.target.value)}
              >
                {customerOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="rag-preview-site">
                Site
              </label>
              <select
                id="rag-preview-site"
                className={styles.select}
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
                disabled={siteOptions.length === 0}
              >
                {siteOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {siteOptions.length === 0 ? (
            <p className={styles.note}>This customer has no sites yet.</p>
          ) : rows.length === 0 ? (
            <p className={styles.note}>This site has no buildings yet.</p>
          ) : (
            <ul className={styles.previewList} aria-label="Building risk preview">
              {rows.map(({ id, building }) => {
                const derived: RiskLevel = config
                  ? deriveRiskLevel({ distribution: building.ragDistribution }, config)
                  : building.riskLevel;
                const storedLook = riskPresentation(theme, building.riskLevel);
                const derivedLook = riskPresentation(theme, derived);
                return (
                  <li key={id} className={styles.previewRow}>
                    <span className={styles.previewName}>{building.name}</span>
                    <span className={styles.previewChips}>
                      <span
                        className={styles.riskChip}
                        style={{ color: storedLook.color, backgroundColor: storedLook.surface }}
                      >
                        <span aria-hidden="true">{storedLook.icon}</span> Stored:{' '}
                        {storedLook.label}
                      </span>
                      <span className={styles.arrow} aria-hidden="true">
                        &rarr;
                      </span>
                      <span
                        className={styles.riskChip}
                        style={{ color: derivedLook.color, backgroundColor: derivedLook.surface }}
                      >
                        <span aria-hidden="true">{derivedLook.icon}</span> With these
                        settings: {derivedLook.label}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      </div>
    </Card>
  );
}
