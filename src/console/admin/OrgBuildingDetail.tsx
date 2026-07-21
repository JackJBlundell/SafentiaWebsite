// ============================================================================
// OrgBuildingDetail - super-admin oversight of ONE building (FR-E24
// drill-down). Read-only: the building's recorded facts and RAG status, its
// assessment history, and the reports released for it. Mirrors the tenant
// BuildingDetail + AssessmentHistoryPanel reads with every mutation affordance
// stripped (no edit, no regenerate, no download-that-writes).
//
// Data reads the whole environment via the superAdmin rules cascade. The
// assessment history is the SAME indexed read the tenant panel uses -
// orderByChild('buildingId') + equalTo(buildingId) over /assessments/{orgId} -
// never the whole node filtered on the client. Cache keys are platform-scoped
// (prefixed 'platform', carrying env + ids) so they never collide with a
// tenant session's own keys.
//
// REPORTS - HONEST LIMITATION: released report PDFs live in Storage, whose
// rules scope report reads to the OWNING org's staff (storage.rules: ownOrg)
// with no superAdmin bypass. So this oversight view lists each report's
// metadata (when it was generated) and states plainly that the PDF is opened
// from within the owning organisation's own console - it never fabricates a
// cross-org download link that would 403.
// ============================================================================

import { equalTo, orderByChild, query } from 'firebase/database';
import { useParams } from 'react-router-dom';
import { useTheme } from '../../design/ThemeProvider';
import { riskPresentation } from '../../design/rag';
import { forEnv } from '../../paths';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import {
  ASSESSMENT_STAGE_LABELS,
  type Assessment,
  type Building,
  type Customer,
  type CustomerContact,
  type OrgMember,
  type OrgProfile,
  type Report,
  type Site,
} from '../../types';
import { actorName } from '../lib/actorName';
import { Card, CardHeader } from '../ui/Card';
import { DataTable, type Column } from '../ui/DataTable';
import { DescriptionList, PageGrid, type DescriptionItem } from '../ui/Grid';
import { EmptyState, ErrorNotice, PageHeader } from '../ui/Page';
import { SkeletonRows } from '../ui/Skeleton';
import { formatDate, RagChip } from '../customers/shared';
import { usePlatformEnv } from './platformEnv';
import styles from './OrgBuildingDetail.module.css';

interface AssessmentRow {
  id: string;
  assessment: Assessment;
}
interface ReportRow {
  id: string;
  report: Report;
}

export function OrgBuildingDetail() {
  const {
    orgId = '',
    customerId = '',
    siteId = '',
    buildingId = '',
  } = useParams<{
    orgId: string;
    customerId: string;
    siteId: string;
    buildingId: string;
  }>();
  // The environment is the platform-wide choice from the rail toggle, no longer
  // read from the URL; only the ids come from the route.
  const { env } = usePlatformEnv();
  const paths = forEnv(env);
  const { theme } = useTheme();
  const enabled = Boolean(orgId && siteId && buildingId);

  const orgProfileQuery = useRtdbQuery<OrgProfile | null>({
    key: ['platformOrgProfile', env, orgId],
    path: paths.db.orgProfile(orgId),
    enabled: Boolean(orgId),
  });
  const customerQuery = useRtdbQuery<Customer | null>({
    key: ['platformCustomer', env, orgId, customerId],
    path: paths.db.customer(orgId, customerId),
    enabled: Boolean(orgId && customerId),
  });
  const siteQuery = useRtdbQuery<Site | null>({
    key: ['platformSite', env, orgId, customerId, siteId],
    path: paths.db.site(orgId, customerId, siteId),
    enabled: Boolean(orgId && customerId && siteId),
  });
  const buildingQuery = useRtdbQuery<Building | null>({
    key: ['platformBuilding', env, orgId, siteId, buildingId],
    path: paths.db.building(orgId, siteId, buildingId),
    enabled,
  });
  const contactsQuery = useRtdbQuery<Record<string, CustomerContact> | null>({
    key: ['platformCustomerContacts', env, orgId, customerId],
    path: paths.db.customerContacts(orgId, customerId),
    enabled: Boolean(orgId && customerId),
  });
  // The building's assessments, via the buildingId index on the org node -
  // the same honest indexed read the tenant history panel uses.
  const assessmentsQuery = useRtdbQuery<Record<string, Assessment> | null>({
    key: ['platformBuildingAssessments', env, orgId, buildingId],
    path: paths.db.assessments(orgId),
    enabled,
    build: (node) =>
      query(node, orderByChild('buildingId'), equalTo(buildingId)),
  });
  const reportsQuery = useRtdbQuery<Record<string, Report> | null>({
    key: ['platformBuildingReports', env, orgId, buildingId],
    path: paths.db.reports(orgId, 'building', buildingId),
    enabled,
  });
  // The roster, so conductedBy / releasedBy render as names, never uids.
  const membersQuery = useRtdbQuery<Record<string, OrgMember> | null>({
    key: ['platformOrgMembers', env, orgId],
    path: paths.db.orgMembers(orgId),
    enabled: Boolean(orgId),
  });
  const membersLoaded = membersQuery.data !== undefined;

  const orgName = orgProfileQuery.data?.name ?? orgId;
  const customerName = customerQuery.data?.name ?? 'Customer';
  const siteName = siteQuery.data?.name ?? 'Site';

  if (buildingQuery.isError) {
    return (
      <ErrorNotice message="Could not load this building. Please try again." />
    );
  }
  if (!buildingQuery.isLoading && !buildingQuery.data) {
    return (
      <EmptyState
        title="Building not found"
        body="This building does not exist in this environment."
      />
    );
  }

  const building = buildingQuery.data;
  const rag = riskPresentation(theme, building?.riskLevel ?? 'pending');

  // Building facts, mirroring the tenant BuildingDetail (only recorded fields;
  // the responsible party resolves to the LIVE customer contact when linked).
  const details = building?.details;
  const party = building?.responsibleParty;
  const linkedContact = party?.contactId
    ? contactsQuery.data?.[party.contactId]
    : undefined;
  const partyName = linkedContact?.name ?? party?.name;
  const partyRole = linkedContact ? linkedContact.jobTitle : party?.role;
  const partyEmail = linkedContact ? linkedContact.email : party?.email;
  const partyPhone = linkedContact ? linkedContact.phone : party?.phone;
  const facts: DescriptionItem[] = [
    { label: 'Address', value: building?.address },
    {
      label: 'Floor area',
      value: details?.area !== undefined ? `${details.area} m²` : undefined,
    },
    {
      label: 'Floors',
      value: details?.floors !== undefined ? String(details.floors) : undefined,
    },
    {
      label: 'Occupants',
      value:
        details?.occupants !== undefined
          ? String(details.occupants)
          : undefined,
    },
    { label: 'Fire alarm type', value: details?.alarmType },
    { label: 'Alarm category', value: details?.alarmCategory },
    {
      label: 'Responsible party',
      value: party
        ? [
            partyRole ? `${partyName} (${partyRole})` : partyName,
            partyEmail,
            partyPhone,
          ]
            .filter(Boolean)
            .join(' · ')
        : undefined,
    },
  ];

  const assessmentRows: AssessmentRow[] = Object.entries(
    assessmentsQuery.data ?? {},
  )
    .map(([id, assessment]) => ({ id, assessment }))
    .sort((a, b) => b.assessment.conductedAt - a.assessment.conductedAt);

  const reportRows: ReportRow[] = Object.entries(reportsQuery.data ?? {})
    .map(([id, report]) => ({ id, report }))
    .sort((a, b) => b.report.generatedAt - a.report.generatedAt);

  const assessmentColumns: Array<Column<AssessmentRow>> = [
    {
      header: 'Conducted',
      cell: (row) => formatDate(row.assessment.conductedAt),
    },
    {
      header: 'Stage',
      cell: (row) => (
        <span className={styles.stageChip}>
          {ASSESSMENT_STAGE_LABELS[row.assessment.status]}
        </span>
      ),
    },
    {
      header: 'Risk level',
      desktopOnly: true,
      cell: (row) =>
        row.assessment.manualRiskLevel ? (
          <RagChip level={row.assessment.manualRiskLevel.level} />
        ) : (
          <span className={styles.muted}>Not recorded</span>
        ),
    },
    {
      header: 'Conducted by',
      desktopOnly: true,
      cell: (row) =>
        actorName(membersQuery.data, row.assessment.conductedBy, membersLoaded),
    },
    {
      header: 'Released by',
      desktopOnly: true,
      cell: (row) =>
        row.assessment.workflow?.releasedBy
          ? actorName(
              membersQuery.data,
              row.assessment.workflow.releasedBy,
              membersLoaded,
            )
          : '—',
    },
  ];

  const crumbs = [
    { label: 'Platform', to: '/app/admin' },
    { label: orgName, to: `/app/admin/${orgId}` },
    {
      label: customerName,
      to: `/app/admin/${orgId}/customers/${customerId}`,
    },
    { label: building?.name ?? buildingId },
  ];

  return (
    <div className={styles.stack}>
      <PageHeader
        title={building?.name ?? buildingId}
        crumbs={crumbs}
        lede="Read-only oversight. Nothing on this screen changes the building."
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
                {building?.lastAssessedAt
                  ? `Last assessed ${formatDate(building.lastAssessedAt)}`
                  : 'This building has not been assessed yet.'}
              </p>
            </Card>
            <Card>
              <CardHeader title="Building facts" />
              <DescriptionList items={facts} />
            </Card>
            <Card>
              <CardHeader title="Location" />
              <DescriptionList
                items={[
                  { label: 'Site', value: siteName },
                  { label: 'Customer', value: customerName },
                  { label: 'Building id', value: buildingId },
                ]}
              />
            </Card>
          </>
        }
      >
        <Card>
          <CardHeader
            title="Assessment history"
            hint="Every assessment conducted for this building, most recent first."
          />
          {assessmentsQuery.isError && (
            <ErrorNotice message="Could not load the assessment history. Please try again." />
          )}
          {assessmentsQuery.isLoading ? (
            <SkeletonRows rows={3} label="Loading assessment history" />
          ) : assessmentRows.length === 0 ? (
            <p className={styles.emptyNote}>
              No assessments recorded for this building.
            </p>
          ) : (
            <DataTable
              columns={assessmentColumns}
              rows={assessmentRows}
              rowKey={(row) => row.id}
              label="Assessment history"
            />
          )}
        </Card>

        <Card>
          <CardHeader
            title="Released reports"
            hint="Reports generated when an assessment is released."
          />
          {reportsQuery.isError && (
            <ErrorNotice message="Could not load the released reports. Please try again." />
          )}
          {reportsQuery.isLoading ? (
            <SkeletonRows rows={2} label="Loading released reports" />
          ) : reportRows.length === 0 ? (
            <p className={styles.emptyNote}>
              No reports have been released for this building.
            </p>
          ) : (
            <ul className={styles.reportList}>
              {reportRows.map((row) => (
                <li key={row.id} className={styles.reportRow}>
                  <span className={styles.reportDate}>
                    Generated {formatDate(row.report.generatedAt)}
                  </span>
                  <span className={styles.reportNote}>
                    The report PDF is opened from within the owning
                    organisation&rsquo;s console.
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageGrid>
    </div>
  );
}
