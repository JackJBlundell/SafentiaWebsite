// ============================================================================
// BuildingDetail - one building's live record in the kit's master-and-aside
// layout. The main column carries the working panels (floor plans, documents,
// service schedule, log book); the sticky aside holds what a visitor needs at
// a glance: the RAG status, the recorded facts (only the fields that exist -
// no dash-for-everything grids), and the admin's actions.
// ============================================================================

import { useParams } from 'react-router-dom';
import { equalTo, orderByChild, query } from 'firebase/database';
import { Button } from '../../components/Button';
import { useTheme } from '../../design/ThemeProvider';
import { riskPresentation } from '../../design/rag';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import { Link } from 'react-router-dom';
import type {
  Action,
  Assessment,
  Building,
  Customer,
  CustomerContact,
  OrgMember,
  OrgSettings,
  Site,
} from '../../types';
import { actorName } from '../lib/actorName';
import { RAG_CONFIG_DEFAULTS } from '../settings/ragDerivation';
import { Card, CardHeader } from '../ui/Card';
import { RiskReasonDisclosure } from '../ui/RiskExplanation';
import { buildRiskExplanation, type RiskManualOverride } from '../ui/riskReasons';
import { ComplianceGlance } from '../ui/ComplianceGlance';
import { DescriptionList, PageGrid, type DescriptionItem } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { FloorPlansPanel } from '../buildings/FloorPlansPanel';
import { DocumentsPanel } from '../buildings/DocumentsPanel';
import { ServiceSchedulePanel } from '../buildings/ServiceSchedulePanel';
import { ActionsPanel } from '../buildings/ActionsPanel';
import { AssessmentHistoryPanel } from '../buildings/AssessmentHistoryPanel';
import { LogBookPanel } from '../activity/LogBookPanel';
import { formatDate, LoadingNote, urls, useOrgScope } from './shared';
import styles from './BuildingDetail.module.css';

export function BuildingDetail() {
  const {
    customerId = '',
    siteId = '',
    buildingId = '',
  } = useParams<{ customerId: string; siteId: string; buildingId: string }>();
  const { ready, orgId, db, isAdmin } = useOrgScope();
  const { theme } = useTheme();

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
  const building = useRtdbQuery<Building | null>({
    key: keys.building(orgId, siteId, buildingId),
    path: ready ? db!.building(orgId, siteId, buildingId) : '',
    enabled: ready && Boolean(siteId && buildingId),
  });
  // This building's action plan, for the compliance-at-a-glance band's tiles.
  // Same cache key as the ActionsPanel below (keys.actions), so the two share
  // one subscription rather than reading the node twice.
  const actions = useRtdbQuery<Record<string, Action> | null>({
    key: keys.actions(orgId, buildingId),
    path: ready ? db!.actions(orgId, buildingId) : '',
    enabled: ready && Boolean(buildingId),
  });
  // The roster, so a linked responsible party renders from the LIVE contact
  // record rather than the snapshot taken when it was assigned.
  const contacts = useRtdbQuery<Record<string, CustomerContact> | null>({
    key: keys.customerContacts(orgId, customerId),
    path: ready ? db!.customerContacts(orgId, customerId) : '',
    enabled: ready && Boolean(customerId),
  });
  // The three reads behind the risk explanation. The organisation's OWN RAG
  // thresholds (never hardcoded ones), and the building's assessments via the
  // buildingId index - the same cache key the history panel below uses, so the
  // two share one subscription - so a manual risk override set at release is
  // named as an override instead of being explained as a derivation.
  const orgSettings = useRtdbQuery<OrgSettings | null>({
    key: keys.orgSettings(orgId),
    path: ready ? db!.orgSettings(orgId) : '',
    enabled: ready,
  });
  const assessments = useRtdbQuery<Record<string, Assessment> | null>({
    key: keys.buildingAssessments(orgId, buildingId),
    path: ready ? db!.assessments(orgId) : '',
    enabled: ready && Boolean(buildingId),
    build: (node) =>
      query(node, orderByChild('buildingId'), equalTo(buildingId)),
  });
  const members = useRtdbQuery<Record<string, OrgMember> | null>({
    key: keys.orgMembers(orgId),
    path: ready ? db!.orgMembers(orgId) : '',
    enabled: ready,
  });

  if (building.isLoading) {
    return <LoadingNote>Loading building</LoadingNote>;
  }
  if (building.isError) {
    return (
      <ErrorNotice message="Could not load this building. Please try again." />
    );
  }
  if (!building.data) {
    return (
      <EmptyState
        title="Building not found"
        body="This building does not exist, or the link is out of date."
        action={
          <Button to={urls.site(customerId, siteId)}>Back to site</Button>
        }
      />
    );
  }

  const record = building.data;
  const customerName = customer.data?.name ?? 'Customer';
  const siteName = sites.data?.[siteId]?.name ?? 'Site';

  // The big status chip: fixed safety colour plus label and icon, so colour is
  // never the sole carrier. `pending` reads honestly as "Not yet assessed".
  const rag = riskPresentation(theme, record.riskLevel ?? 'pending');

  // WHY the chip says what it says. Everything the release pipeline fed into
  // the shared derivation is re-stated here from live data: the organisation's
  // thresholds, the finding counts stored on the building, and the action-plan
  // state. `dueBy < now` matches releaseAssessment's own overdue test rather
  // than the dashboards' one-day grace, so the account matches the calculation
  // that actually ran.
  const now = Date.now();
  const openActions = Object.values(actions.data ?? {}).filter(
    (action) => action.status === 'open',
  );
  const actionState =
    actions.data === undefined
      ? undefined
      : {
          hasOpenHighAction: openActions.some(
            (action) => action.severity === 'H' || action.lifeProtection === true,
          ),
          hasOverdueAction: openActions.some(
            (action) => typeof action.dueBy === 'number' && action.dueBy < now,
          ),
        };
  // The override that drove the headline risk is the one on the assessment
  // whose release set it: the most recently released assessment. `null` once
  // the read has landed and there is no override, which is what lets the
  // explanation claim to be complete.
  const latestRelease = Object.values(assessments.data ?? {})
    .filter(
      (assessment) =>
        assessment.status === 'released' &&
        assessment.workflow?.releasedAt !== undefined,
    )
    .sort(
      (a, b) => (b.workflow?.releasedAt ?? 0) - (a.workflow?.releasedAt ?? 0),
    )[0];
  const override = latestRelease?.manualRiskLevel;
  const manualOverride: RiskManualOverride | null | undefined =
    assessments.data === undefined
      ? undefined
      : override
        ? {
            level: override.level,
            byName: actorName(
              members.data,
              override.byUid,
              members.data !== undefined,
            ),
            at: override.at,
          }
        : null;
  const riskExplanation = buildRiskExplanation({
    level: record.riskLevel ?? 'pending',
    distribution: record.ragDistribution,
    lastAssessedAt: record.lastAssessedAt,
    config: orgSettings.data?.ragConfig ?? RAG_CONFIG_DEFAULTS,
    actions: actionState,
    manualOverride,
    formatDate,
  });

  // Only the recorded facts; DescriptionList drops the absent ones.
  const details = record.details;
  const party = record.responsibleParty;
  // A linked party displays the LIVE contact; the stored snapshot stands in
  // for manual (unlinked) parties or while the roster loads.
  const linkedContact = party?.contactId
    ? contacts.data?.[party.contactId]
    : undefined;
  const partyName = linkedContact?.name ?? party?.name;
  const partyRole = linkedContact ? linkedContact.jobTitle : party?.role;
  const partyEmail = linkedContact ? linkedContact.email : party?.email;
  const partyPhone = linkedContact ? linkedContact.phone : party?.phone;
  const facts: DescriptionItem[] = [
    { label: 'Address', value: record.address },
    {
      label: 'Floor area',
      value: details?.area !== undefined ? `${details.area} m²` : undefined,
    },
    {
      label: 'Floors',
      value: details?.floors !== undefined ? String(details.floors) : undefined,
    },
    {
      label: 'Occupied floors',
      value:
        details?.occupiedFloors !== undefined
          ? String(details.occupiedFloors)
          : undefined,
    },
    {
      label: 'Occupants',
      value:
        details?.occupants !== undefined
          ? String(details.occupants)
          : undefined,
    },
    {
      label: 'Customer is landlord',
      value:
        details?.isLandlord !== undefined
          ? details.isLandlord
            ? 'Yes'
            : 'No'
          : undefined,
    },
    { label: 'Fire alarm type', value: details?.alarmType },
    { label: 'Alarm category', value: details?.alarmCategory },
    {
      label: 'Responsible party',
      value: party ? (
        <>
          {partyRole ? `${partyName} (${partyRole})` : partyName}
          {partyEmail ? ` · ${partyEmail}` : ''}
          {partyPhone ? ` · ${partyPhone}` : ''}
          {party.contactId && (
            <>
              {' '}
              <Link to={urls.customer(customerId)}>View contacts</Link>
            </>
          )}
        </>
      ) : undefined,
    },
    {
      label: 'Article 5(3) persons',
      value: record.article53Persons?.length
        ? record.article53Persons.join(', ')
        : undefined,
    },
  ];
  const hasFacts = facts.some(
    (item) =>
      item.value !== undefined && item.value !== null && item.value !== '',
  );

  return (
    <div>
      <PageHeader
        title={record.name}
        crumbs={[
          { label: 'Customers', to: urls.customers },
          { label: customerName, to: urls.customer(customerId) },
          { label: siteName, to: urls.site(customerId, siteId) },
          { label: record.name },
        ]}
      />

      <PageGrid
        aside={
          <>
            <Card>
              <CardHeader title="Status" />
              <span
                className={styles.ragChipLarge}
                style={{ color: rag.color, background: rag.surface }}
              >
                <span aria-hidden="true">{rag.icon}</span>
                {rag.label}
              </span>
              <p className={styles.lastAssessed}>
                {record.lastAssessedAt
                  ? `Last assessed ${formatDate(record.lastAssessedAt)}`
                  : 'This building has not been assessed yet.'}
              </p>
              {/* The reasoning lives HERE, in flow, rather than in a floating
                  tooltip: the aside is a scroll box of its own above 1024px, and
                  an expanding region cannot be clipped by it or missed by a
                  keyboard or touch user. */}
              {orgSettings.data !== undefined && (
                <RiskReasonDisclosure explanation={riskExplanation} />
              )}
            </Card>

            <Card>
              <CardHeader title="Building facts" />
              {hasFacts ? (
                <div className={styles.facts}>
                  <DescriptionList items={facts} />
                </div>
              ) : (
                <p className={styles.noFacts}>
                  No details recorded yet.
                  {isAdmin && ' Add them by editing the building.'}
                </p>
              )}
            </Card>

            {isAdmin && (
              <Card>
                <CardHeader title="Actions" />
                <Button
                  variant="secondary"
                  to={urls.buildingEdit(customerId, siteId, buildingId)}
                  block
                >
                  Edit building
                </Button>
              </Card>
            )}
          </>
        }
      >
        {/* The compliance-at-a-glance band in its single-building form: this
            building's own RAG status stands in for the proportional bar, and
            the tiles read its own action plan. The action counts share the
            ActionsPanel's read below, and every tile drills through to that
            panel (its heading anchor) so the band stays clickable and
            consistent with the customer and site pages. */}
        <ComplianceGlance
          single
          heading="Building risk status"
          riskSummary={
            orgSettings.data === undefined
              ? undefined
              : riskExplanation.summary
          }
          buildings={[{ siteId, buildingId, building: record }]}
          actions={
            actions.data === undefined
              ? undefined
              : Object.values(actions.data ?? {})
          }
          overdueHref={`${urls.building(customerId, siteId, buildingId)}#actions-panel-heading`}
        />

        <ActionsPanel siteId={siteId} buildingId={buildingId} />
        <AssessmentHistoryPanel buildingId={buildingId} />
        <FloorPlansPanel buildingId={buildingId} />
        <DocumentsPanel buildingId={buildingId} />
        <ServiceSchedulePanel siteId={siteId} buildingId={buildingId} />
        <LogBookPanel buildingId={buildingId} />
      </PageGrid>
    </div>
  );
}
