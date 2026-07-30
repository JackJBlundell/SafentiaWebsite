// ============================================================================
// Wizard tests: the AddressSearch combobox (debounce, selection, silent
// degradation) and the site / building creation wizards. Mocked at the same
// module boundaries as customers.test.tsx: auth, the RTDB bridge, the theme
// and the callable hook. Mapbox is a stubbed global fetch - no sockets.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import { forEnv } from '../../paths';
import type { SessionClaims } from '../../auth/claims';
import type { CustomerContact } from '../../types';

// --- Module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    auth: {
      status: 'member' as string,
      user: { uid: 'user-1', email: 'admin@example.com' } as unknown,
      claims: null as unknown,
      paths: null as unknown,
    },
    fixtures: {
      contacts: {} as Record<string, CustomerContact>,
    },
    // Resolves like the real callables so the wizards can advance on the ids.
    callableCall: vi.fn(async (input: Record<string, unknown>) => {
      if ('site' in input) return { siteId: 's-new' };
      if ('building' in input) return { buildingId: 'b-new' };
      if ('plan' in input) return { planId: 'p-new' };
      return null;
    }),
  };
});

vi.mock('../../firebase', () => ({
  startFirebase: vi.fn(),
  firebase: { functions: vi.fn() },
}));

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../query/useRtdbQuery', () => ({
  useRtdbQuery: ({ key }: { key: readonly unknown[] }) => {
    let data: unknown = null;
    if (key[0] === 'customerContacts') {
      data = mocks.fixtures.contacts;
    }
    return { data, isLoading: false, isError: false };
  },
  subscribeToQuery: vi.fn(() => () => undefined),
}));

vi.mock('../ui/useCallable', () => ({
  useCallable: () => ({
    call: mocks.callableCall,
    pending: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import { AddressField } from '../ui/AddressField';
import { AddressSearch } from '../ui/AddressSearch';
import { SiteWizard } from './SiteWizard';
import { BuildingWizard } from './BuildingWizard';

// --- Fixtures -----------------------------------------------------------------

const adminClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

const geocodePayload = {
  features: [
    {
      id: 'address.1',
      place_name: '10 Downing Street, London, SW1A 2AA',
      center: [-0.1276, 51.5034],
    },
  ],
};

function stubFetchWith(payload: unknown) {
  const fetchMock = vi.fn(async (_input: string | URL) => ({
    ok: true,
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Harness giving AddressSearch its controlled value like a real form does. */
function AddressHarness({
  onSelect,
}: {
  onSelect: (selection: { address: string; geo: { lat: number; lng: number } }) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <AddressSearch
      id="test-address"
      label="Address"
      value={value}
      onChange={setValue}
      onSelect={onSelect}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.claims = adminClaims;
  mocks.auth.paths = forEnv(adminClaims.environment);
  mocks.fixtures.contacts = {
    k1: {
      name: 'Kate Porter',
      jobTitle: 'Facilities Director',
      email: 'kate@acme.example',
      phone: '01234 567890',
      createdAt: 1,
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- AddressSearch --------------------------------------------------------------

describe('AddressSearch', () => {
  it('debounces typing into a single geocoding request', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetchWith(geocodePayload);
    render(<AddressHarness onSelect={vi.fn()} />);

    // Three keystroke-style edits inside the debounce window: only the settled
    // query fires. fireEvent (not userEvent) because fake timers stall
    // userEvent's own internal waits.
    const input = screen.getByLabelText('Address');
    fireEvent.change(input, { target: { value: '10 D' } });
    fireEvent.change(input, { target: { value: '10 Down' } });
    fireEvent.change(input, { target: { value: '10 Downing' } });
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('api.mapbox.com');
  });

  it('returns the address and coordinates when a suggestion is picked', async () => {
    const user = userEvent.setup();
    stubFetchWith(geocodePayload);
    const onSelect = vi.fn();
    render(<AddressHarness onSelect={onSelect} />);

    await user.type(screen.getByLabelText('Address'), '10 Downing');
    const option = await screen.findByRole('option', {
      name: '10 Downing Street, London, SW1A 2AA',
    });
    await user.click(option);

    expect(onSelect).toHaveBeenCalledWith({
      address: '10 Downing Street, London, SW1A 2AA',
      geo: { lat: 51.5034, lng: -0.1276 },
    });
    expect(screen.getByLabelText('Address')).toHaveValue(
      '10 Downing Street, London, SW1A 2AA',
    );
  });

  it('degrades silently to a plain text input when the network fails', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddressHarness onSelect={vi.fn()} />);

    await user.type(screen.getByLabelText('Address'), '10 Downing');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // No listbox, no error - the typed text simply stands.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toHaveValue('10 Downing');
  });
});

// --- SiteWizard -------------------------------------------------------------------

function renderSiteWizard() {
  return render(
    <MemoryRouter initialEntries={['/app/customers/c1/sites/new']}>
      <Routes>
        <Route
          path="/app/customers/:customerId/sites/new"
          element={<SiteWizard />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SiteWizard', () => {
  it('includes the pinned coordinates in the create payload after a selection', async () => {
    const user = userEvent.setup();
    stubFetchWith(geocodePayload);
    renderSiteWizard();

    await user.type(screen.getByLabelText('Name'), 'Head Office');
    await user.type(screen.getByLabelText('Address (optional)'), '10 Downing');
    await user.click(
      await screen.findByRole('option', {
        name: '10 Downing Street, London, SW1A 2AA',
      }),
    );
    // The point is derived from the pick and reported back, with no coordinate
    // field anywhere for it to disagree with.
    expect(
      screen.getByText(/Location pinned at 51\.50340, -0\.12760/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create site' }));

    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'create',
      customerId: 'c1',
      site: {
        name: 'Head Office',
        address: '10 Downing Street, London, SW1A 2AA',
        geo: { lat: 51.5034, lng: -0.1276 },
      },
    });
    // Step 2 is live, with the site address as the quick-add default.
    expect(await screen.findByLabelText('Building name')).toBeInTheDocument();
    expect(screen.getByLabelText('Address (optional)')).toHaveValue(
      '10 Downing Street, London, SW1A 2AA',
    );
  });

  it('omits geo once the location is removed, keeping the address', async () => {
    const user = userEvent.setup();
    stubFetchWith(geocodePayload);
    renderSiteWizard();

    await user.type(screen.getByLabelText('Name'), 'Head Office');
    await user.type(screen.getByLabelText('Address (optional)'), '10 Downing');
    await user.click(
      await screen.findByRole('option', {
        name: '10 Downing Street, London, SW1A 2AA',
      }),
    );
    // Removing the location is the one way a point leaves a record now that
    // there are no coordinate fields to empty.
    await user.click(screen.getByRole('button', { name: 'Remove location' }));

    await user.click(screen.getByRole('button', { name: 'Create site' }));
    const [input] = mocks.callableCall.mock.calls[0] as unknown as [
      { site: Record<string, unknown> },
    ];
    expect('geo' in input.site).toBe(false);
    expect(input.site.address).toBe('10 Downing Street, London, SW1A 2AA');
  });

  it('keeps a confirmed point when the address is refined by hand', async () => {
    const user = userEvent.setup();
    stubFetchWith(geocodePayload);
    renderSiteWizard();

    await user.type(screen.getByLabelText('Name'), 'Head Office');
    await user.type(screen.getByLabelText('Address (optional)'), '10 Downing');
    await user.click(
      await screen.findByRole('option', {
        name: '10 Downing Street, London, SW1A 2AA',
      }),
    );
    // A sub-unit typed in front of a geocoded street is the same place; the
    // point survives, and the field says which address it was confirmed against.
    await user.type(screen.getByLabelText('Address (optional)'), ' (rear gate)');
    expect(
      screen.getByText(/from “10 Downing Street, London, SW1A 2AA”/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create site' }));
    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'create',
      customerId: 'c1',
      site: {
        name: 'Head Office',
        address: '10 Downing Street, London, SW1A 2AA (rear gate)',
        geo: { lat: 51.5034, lng: -0.1276 },
      },
    });
  });
});

// --- AddressField -----------------------------------------------------------
// The map half is not exercised here: mapbox-gl needs WebGL, which jsdom has
// not got, so it reports itself unavailable exactly as a failed chunk would -
// which is precisely the degradation these tests care about.

function AddressFieldHarness() {
  const [address, setAddress] = useState('Somewhere in Leeds');
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  return (
    <AddressField
      id="test-address-field"
      label="Address"
      value={address}
      onChange={setAddress}
      geo={geo}
      onGeoChange={setGeo}
    />
  );
}

describe('AddressField', () => {
  it('leaves the typed address untouched when map mode is cancelled', async () => {
    const user = userEvent.setup();
    stubFetchWith(geocodePayload);
    render(<AddressFieldHarness />);

    await user.click(screen.getByRole('button', { name: 'Pick on map' }));
    // The map edits a draft, so typing in it commits nothing.
    await user.type(screen.getByLabelText('Address'), ' - unit 9');
    await user.click(screen.getByRole('button', { name: 'Cancel map' }));

    expect(screen.getByLabelText('Address')).toHaveValue('Somewhere in Leeds');
    expect(screen.getByRole('button', { name: 'Pick on map' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

// --- BuildingWizard ---------------------------------------------------------------

function renderBuildingWizard() {
  return render(
    <MemoryRouter initialEntries={['/app/customers/c1/sites/s1/buildings/new']}>
      <Routes>
        <Route
          path="/app/customers/:customerId/sites/:siteId/buildings/new"
          element={<BuildingWizard />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BuildingWizard', () => {
  it('sends the chosen contact as the responsible party with its contactId', async () => {
    const user = userEvent.setup();
    stubFetchWith(geocodePayload);
    renderBuildingWizard();

    // Step 1: create the building.
    await user.type(screen.getByLabelText('Name'), 'Main Block');
    await user.click(screen.getByRole('button', { name: 'Create building' }));
    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'create',
      siteId: 's1',
      building: { name: 'Main Block', customerId: 'c1' },
    });

    // Step 2: skip floor plans.
    await user.click(await screen.findByRole('button', { name: 'Skip this step' }));

    // Step 3: pick the contact and save.
    await user.click(
      await screen.findByRole('radio', { name: /Kate Porter/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Save contact' }));

    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'update',
      siteId: 's1',
      buildingId: 'b-new',
      building: {
        responsibleParty: {
          name: 'Kate Porter',
          role: 'Facilities Director',
          email: 'kate@acme.example',
          phone: '01234 567890',
          contactId: 'k1',
        },
      },
    });

    // The finish screen sums it up.
    expect(await screen.findByText('Building created')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to building' })).toHaveAttribute(
      'href',
      '/app/customers/c1/sites/s1/buildings/b-new',
    );
  });
});
