// ============================================================================
// Staff area tests: the admin gate, the live directory as a linked list, the
// invite form's client-side requirements, and the member PROFILE - its facts,
// its three history strands, and the role/status editor that moved here from
// the directory (with its last-administrator guard intact). Auth, the RTDB
// bridge and the callable hook are mocked at their module boundaries (the same
// pattern as console.test.tsx); these are rendering/validation tests.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { forEnv } from '../../paths';
import type {
  Assessment,
  ActivityEntry,
  InvitationSummary,
  Job,
  OrgMember,
} from '../../types';

const mocks = vi.hoisted(() => ({
  auth: {
    status: 'authenticated' as string,
    user: { uid: 'admin-1', email: 'admin@example.com' } as unknown,
    claims: null as unknown,
    paths: null as unknown,
    refreshSession: vi.fn(),
    signOut: vi.fn(),
  },
  /** Data served by the useRtdbQuery mock, keyed by the key's first segment.
   *  The mock ignores `select`/`build`, so entries are the POST-shape a screen
   *  reads (activity is already the sorted row array, the rest are raw nodes). */
  rtdb: {} as Record<string, unknown>,
  callable: vi.fn(async (_name: string, _input: unknown) => ({}) as unknown),
}));

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn(), storage: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly (string | number)[] }) => ({
    data: mocks.rtdb[String(key[0])],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../ui/useCallable', () => ({
  useCallable: (name: string) => ({
    call: (input: unknown) => mocks.callable(name, input),
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import { StaffRoutes } from './StaffRoutes';

const adminClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

const members: Record<string, OrgMember> = {
  'uid-dana': {
    name: 'Dana Field',
    email: 'dana@example.com',
    roles: { admin: true, assessor: true },
    status: 'active',
  },
  'uid-rob': {
    name: 'Rob Marsh',
    email: 'rob@example.com',
    roles: { viewer: true },
    status: 'locked',
  },
};

/** A second active admin, so lock/archive/demote on Dana are legitimate rather
 *  than actions the last-administrator pre-guard disables. */
const membersWithSecondAdmin: Record<string, OrgMember> = {
  ...members,
  'uid-other': {
    name: 'Other Admin',
    email: 'other@example.com',
    roles: { admin: true },
    status: 'active',
  },
};

const invitations: Record<string, InvitationSummary> = {
  'inv-1': {
    email: 'newstarter@example.com',
    roles: { assessor: true },
    status: 'pending',
    expiresAt: Date.UTC(2026, 5, 14),
    createdAt: Date.UTC(2026, 5, 7),
    invitedBy: 'admin-1',
  },
};

const buildingsRoot = {
  s1: { b1: { name: 'Beacon Tower', customerId: 'c1', riskLevel: 'low' } },
};
const customers = {
  c1: { name: 'Riverside Housing', status: 'active' },
};
const activityRows: Array<ActivityEntry & { id: string }> = [
  {
    id: 'a1',
    actorUid: 'uid-dana',
    action: 'assessment.released',
    target: 'job-1',
    at: Date.UTC(2026, 5, 10, 9, 0),
  },
];
const assessments: Record<string, Assessment> = {
  'job-1': {
    jobId: 'job-1',
    buildingId: 'b1',
    customerId: 'c1',
    conductedBy: 'uid-dana',
    conductedAt: Date.UTC(2026, 5, 10),
    status: 'released',
    templateSnapshot: {} as Assessment['templateSnapshot'],
  },
};
const jobs: Record<string, Job> = {
  'job-1': {
    templateId: 't1',
    templateVersion: 1,
    customerId: 'c1',
    siteId: 's1',
    buildingId: 'b1',
    assessorUid: 'uid-dana',
    scheduledFor: Date.UTC(2026, 5, 20, 9, 0),
    status: 'scheduled',
  },
};

function renderStaffAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <StaffRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.auth.claims = adminClaims;
  mocks.auth.user = { uid: 'admin-1', email: 'admin@example.com' };
  mocks.auth.paths = forEnv('test');
  mocks.rtdb = {
    orgMembers: members,
    orgInvitations: invitations,
    buildings: buildingsRoot,
    customers,
    activity: activityRows,
    assessments,
    jobs,
  };
  mocks.callable.mockClear();
  mocks.callable.mockResolvedValue({});
});

describe('StaffRoutes gate', () => {
  it('shows the calm admin gate to a non-admin at the directory URL', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { assessor: true }, environment: 'test' };
    renderStaffAt('/');
    expect(
      screen.getByRole('heading', { name: 'Administrator access required' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Dana Field')).not.toBeInTheDocument();
  });
});

describe('approaching-limit nudge (staff seats)', () => {
  // A Bronze plan whose staff ceiling (5) the org is nearing. `usage.staffCount`
  // is the seat count the nudge and the at-limit gate both read; the fixture
  // invitation is long expired, so it reserves no seat here.
  const bronzePlan = {
    name: 'Bronze',
    stripePriceId: 'price_bronze_test',
    priceMonthlyPence: 4900,
    currency: 'gbp',
    features: { branding: false, emailTemplates: false, prioritySupport: false },
    limits: {
      orgStaff: 5,
      customers: 10,
      notificationsPerMonth: 100,
      assessmentTemplates: 2,
    },
    order: 1,
  };

  const seedBilling = (staffCount: number) => {
    mocks.rtdb.orgSubscription = { planId: 'bronze', status: 'active' };
    mocks.rtdb.platformPlans = bronzePlan;
    mocks.rtdb.orgUsage = { staffCount, customerCount: 0, notificationsThisMonth: 0 };
  };

  it('nudges at >=80% of the staff ceiling, before the wall', () => {
    seedBilling(4); // 4 of 5 is exactly 80%.
    renderStaffAt('/');
    expect(screen.getByText(/4 of 5 team members used/)).toBeInTheDocument();
    // Still below the wall: the invite action stays, not the at-limit upsell.
    expect(
      screen.getByRole('link', { name: 'Invite staff' }),
    ).toBeInTheDocument();
  });

  it('stays quiet below 80%', () => {
    seedBilling(3); // 3 of 5 is under the threshold.
    renderStaffAt('/');
    expect(screen.queryByText(/team members used/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Invite staff' }),
    ).toBeInTheDocument();
  });

  it('gives way to the at-limit notice at the ceiling, not the nudge', () => {
    seedBilling(5); // At the wall.
    renderStaffAt('/');
    expect(screen.queryByText(/team members used/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Invite staff' }),
    ).not.toBeInTheDocument();
  });
});

describe('StaffDirectory', () => {
  it('renders members with readable role chips and status badges', () => {
    renderStaffAt('/');
    expect(screen.getByText('Dana Field')).toBeInTheDocument();
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
    const danaRoles = screen.getByRole('list', { name: 'Roles for Dana Field' });
    expect(danaRoles).toHaveTextContent('Administrator');
    expect(danaRoles).toHaveTextContent('Assessor');
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Locked')).toBeInTheDocument();
  });

  it('links each member row to their profile (master/detail)', () => {
    renderStaffAt('/');
    expect(screen.getByRole('link', { name: /Dana Field/ })).toHaveAttribute(
      'href',
      '/app/staff/uid-dana',
    );
    expect(screen.getByRole('link', { name: /Rob Marsh/ })).toHaveAttribute(
      'href',
      '/app/staff/uid-rob',
    );
  });

  it('filters by name or email through the search box', async () => {
    const user = userEvent.setup();
    renderStaffAt('/');
    await user.type(screen.getByLabelText('Search staff'), 'rob@');
    expect(screen.queryByText('Dana Field')).not.toBeInTheDocument();
    expect(screen.getByText('Rob Marsh')).toBeInTheDocument();
  });

  it('renders a member with no roles field without crashing (regression)', () => {
    // A malformed or part-provisioned record can omit `roles`; the directory
    // must render the row (with no role chips) rather than throw.
    mocks.rtdb.orgMembers = {
      'uid-sparse': {
        name: 'Sparse Sam',
        email: 'sam@example.com',
        status: 'active',
      } as unknown as OrgMember,
    };
    mocks.rtdb.orgInvitations = {};
    renderStaffAt('/');
    expect(screen.getByText('Sparse Sam')).toBeInTheDocument();
    const roles = screen.getByRole('list', { name: 'Roles for Sparse Sam' });
    expect(roles).toBeEmptyDOMElement();
  });

  it('filters by role, combining with search and the archived toggle (story 2013)', async () => {
    const user = userEvent.setup();
    mocks.rtdb.orgMembers = {
      ...members,
      'uid-ana': {
        name: 'Ana Vale',
        email: 'ana@example.com',
        roles: { assessor: true },
        status: 'archived',
      },
    };
    renderStaffAt('/');

    const roleFilter = screen.getByLabelText('Role');
    expect(roleFilter).toHaveTextContent('All roles');
    expect(roleFilter).toHaveTextContent('Administrator');
    expect(roleFilter).toHaveTextContent('Viewer');

    await user.selectOptions(roleFilter, 'assessor');
    expect(screen.getByText('Dana Field')).toBeInTheDocument();
    expect(screen.queryByText('Rob Marsh')).not.toBeInTheDocument();
    expect(screen.queryByText('Ana Vale')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText(/Show archived/));
    expect(screen.getByText('Ana Vale')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search staff'), 'vale');
    expect(screen.queryByText('Dana Field')).not.toBeInTheDocument();
    expect(screen.getByText('Ana Vale')).toBeInTheDocument();

    await user.selectOptions(roleFilter, 'finance');
    expect(screen.getByText('No staff match the current filters.')).toBeInTheDocument();
  });

  it('lists pending invitations with resend and revoke', async () => {
    const user = userEvent.setup();
    renderStaffAt('/');
    expect(screen.getByText('newstarter@example.com')).toBeInTheDocument();
    expect(screen.getByText('14 Jun 2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resend' }));
    expect(mocks.callable).toHaveBeenCalledWith('resendInvitation', {
      inviteId: 'inv-1',
    });
    expect(
      await screen.findByText(/Invitation re-sent to newstarter@example.com/),
    ).toBeInTheDocument();
  });
});

describe('StaffProfile', () => {
  it('shows the member facts, and their actions, assessments and jobs', () => {
    renderStaffAt('/uid-dana');
    // Facts.
    expect(
      screen.getByRole('heading', { level: 1, name: 'Dana Field' }),
    ).toBeInTheDocument();
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
    const roles = screen.getByRole('list', { name: 'Roles for Dana Field' });
    expect(roles).toHaveTextContent('Administrator');
    expect(roles).toHaveTextContent('Assessor');

    // Actions history: the audit code becomes a sentence.
    expect(screen.getByText('Released an assessment')).toBeInTheDocument();

    // Assessment conducted: building, stage, and a link to the review page.
    const assessmentRow = screen.getByRole('link', { name: /Beacon Tower/ });
    expect(assessmentRow).toHaveAttribute('href', '/app/validation/job-1');
    expect(screen.getByText('Released')).toBeInTheDocument();

    // Job assigned: linked to the job, its customer named, its status shown.
    const jobRow = screen
      .getAllByRole('link')
      .find((el) => el.getAttribute('href') === '/app/jobs/job-1');
    expect(jobRow).toBeDefined();
    expect(screen.getByText('Riverside Housing')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('states honest empty history for a member with no activity', () => {
    mocks.rtdb.activity = [];
    mocks.rtdb.assessments = {};
    mocks.rtdb.jobs = {};
    renderStaffAt('/uid-rob');
    expect(screen.getByText(/No recorded actions for Rob Marsh yet/)).toBeInTheDocument();
    expect(
      screen.getByText('Rob Marsh has not conducted any assessments yet.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No jobs are assigned to Rob Marsh right now.'),
    ).toBeInTheDocument();
  });

  it('shows a calm not-found notice when the member is not in the org', () => {
    renderStaffAt('/uid-missing');
    expect(
      screen.getByRole('heading', { name: 'Member not found' }),
    ).toBeInTheDocument();
  });

  it('denies a viewer calmly, showing no member data', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { viewer: true }, environment: 'test' };
    renderStaffAt('/uid-dana');
    expect(
      screen.getByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('dana@example.com')).not.toBeInTheDocument();
  });

  it('denies a finance member calmly', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { finance: true }, environment: 'test' };
    renderStaffAt('/uid-dana');
    expect(
      screen.getByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
  });

  it('lets an auditor open a profile and click through to a job, but not manage', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { auditor: true }, environment: 'test' };
    renderStaffAt('/uid-dana');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Dana Field' }),
    ).toBeInTheDocument();
    // The jobs-assigned card links each job to its detail page.
    const jobLink = screen
      .getAllByRole('link')
      .find((el) => el.getAttribute('href') === '/app/jobs/job-1');
    expect(jobLink).toBeDefined();
    // Auditors do not get the admin editor.
    expect(screen.queryByRole('button', { name: 'Save roles' })).not.toBeInTheDocument();
  });

  it('denies an assessor calmly (viewing history is admin/auditor oversight)', () => {
    mocks.auth.claims = { orgId: 'org-1', roles: { assessor: true }, environment: 'test' };
    renderStaffAt('/uid-dana');
    expect(
      screen.getByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('dana@example.com')).not.toBeInTheDocument();
  });

  it('saves an edited role set through the updateMember callable', async () => {
    const user = userEvent.setup();
    // Second admin present, so no role is locked by the sole-admin guard.
    mocks.rtdb.orgMembers = membersWithSecondAdmin;
    renderStaffAt('/uid-dana');
    await user.click(screen.getByLabelText('Auditor'));
    await user.click(screen.getByRole('button', { name: 'Save roles' }));
    expect(mocks.callable).toHaveBeenCalledWith('updateMember', {
      memberUid: 'uid-dana',
      roles: { admin: true, assessor: true, auditor: true },
    });
  });

  it('locks a member only after the confirm step, with the consequence spelt out', async () => {
    mocks.rtdb.orgMembers = membersWithSecondAdmin;
    const user = userEvent.setup();
    renderStaffAt('/uid-dana');
    await user.click(screen.getByRole('button', { name: 'Lock' }));
    expect(mocks.callable).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Lock Dana Field? They will be signed out on their next token refresh.',
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lock account' }));
    expect(mocks.callable).toHaveBeenCalledWith('updateMember', {
      memberUid: 'uid-dana',
      status: 'locked',
    });
  });

  it('stops the only active administrator unchecking their own admin role', async () => {
    // Signed in AS Dana, the sole active admin; her Administrator box is
    // disabled with the explanation. The server rejects this anyway.
    mocks.auth.user = { uid: 'uid-dana', email: 'dana@example.com' };
    renderStaffAt('/uid-dana');
    expect(screen.getByLabelText('Administrator')).toBeDisabled();
    expect(screen.getByLabelText('Assessor')).toBeEnabled();
    expect(screen.getByText(/only active administrator/)).toBeInTheDocument();
  });

  it('guards the sole active administrator for ANY admin viewer', () => {
    // Signed in as admin-1 (not Dana), yet Dana - the only active admin - has
    // her demote and lockout controls disabled with the reason stated.
    renderStaffAt('/uid-dana');
    expect(screen.getByLabelText('Administrator')).toBeDisabled();
    expect(screen.getByLabelText('Assessor')).toBeEnabled();
    expect(
      screen.getByText(/Dana Field is the only active administrator/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lock' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(
      screen.getByText(
        'The last administrator cannot be removed, locked or archived.',
      ),
    ).toBeInTheDocument();
  });

  it('leaves lock and archive live on an admin once another active admin exists', () => {
    mocks.rtdb.orgMembers = membersWithSecondAdmin;
    renderStaffAt('/uid-dana');
    expect(screen.getByLabelText('Administrator')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Lock' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
    expect(
      screen.queryByText(
        'The last administrator cannot be removed, locked or archived.',
      ),
    ).not.toBeInTheDocument();
  });

  it('lets an admin edit their own roles when another active admin exists', () => {
    mocks.auth.user = { uid: 'uid-dana', email: 'dana@example.com' };
    mocks.rtdb.orgMembers = membersWithSecondAdmin;
    renderStaffAt('/uid-dana');
    expect(screen.getByLabelText('Administrator')).toBeEnabled();
    expect(
      screen.queryByText(/only active administrator/),
    ).not.toBeInTheDocument();
  });
});

describe('InviteStaffPage', () => {
  it('requires at least one role before calling createInvitation', async () => {
    const user = userEvent.setup();
    renderStaffAt('/invite');
    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one role.');
    expect(mocks.callable).not.toHaveBeenCalled();
  });

  it('sends the invitation and shows the success state', async () => {
    const user = userEvent.setup();
    mocks.callable.mockResolvedValue({ inviteId: 'inv-2', expiresAt: 1 });
    renderStaffAt('/invite');
    await user.type(screen.getByLabelText('Email address'), 'new@example.com');
    await user.click(screen.getByLabelText('Assessor'));
    await user.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(mocks.callable).toHaveBeenCalledWith('createInvitation', {
      email: 'new@example.com',
      roles: { assessor: true },
    });
    expect(
      await screen.findByRole('heading', { name: 'Invitation sent' }),
    ).toBeInTheDocument();
  });
});
