// ============================================================================
// ContactPicker tests - the one way a screen attaches a person. Mocked at the
// same module boundaries as customers.test.tsx: the auth contract, the RTDB
// bridge (fixture data, no sockets) and the callable hook.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
    contacts: {} as Record<string, CustomerContact>,
    callableCall: vi.fn(async () => null as unknown),
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
  useRtdbQuery: () => ({
    data: mocks.contacts,
    isLoading: false,
    isError: false,
  }),
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

import { ContactPicker } from './ContactPicker';

// --- Fixtures ----------------------------------------------------------------

const adminClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { admin: true },
  environment: 'test',
};

const viewerClaims: SessionClaims = {
  orgId: 'org-1',
  roles: { viewer: true },
  environment: 'test',
};

function setClaims(claims: SessionClaims) {
  mocks.auth.claims = claims;
  mocks.auth.paths = forEnv(claims.environment);
}

function renderPicker(props: Partial<Parameters<typeof ContactPicker>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <ContactPicker
        customerId="c1"
        label="Site contact"
        onChange={onChange}
        allowNone
        {...props}
      />
    </MemoryRouter>,
  );
  return onChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  setClaims(adminClaims);
  mocks.contacts = {
    p1: {
      name: 'Amy Archer',
      email: 'amy@acme.example',
      jobTitle: 'Facilities Director',
      isPrimary: true,
      createdAt: 1,
    },
    p2: { name: 'Ben Brook', email: 'ben@acme.example', createdAt: 2 },
  };
});

describe('ContactPicker', () => {
  it('renders every contact with job title and primary badge, plus None', async () => {
    const user = userEvent.setup();
    const onChange = renderPicker();

    const group = screen.getByRole('radiogroup', { name: 'Site contact' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'None' })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /Amy Archer Primary Facilities Director/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Primary')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /Ben Brook/ }));
    expect(onChange).toHaveBeenCalledWith(
      'p2',
      expect.objectContaining({ name: 'Ben Brook' }),
    );
  });

  it('creates a contact inline and auto-selects it', async () => {
    const user = userEvent.setup();
    mocks.callableCall.mockResolvedValue({ contactId: 'p-new' } as unknown);
    const onChange = renderPicker();

    await user.click(screen.getByRole('button', { name: 'Add new contact' }));
    await user.type(screen.getByLabelText('Name'), 'Cara Cole');
    await user.type(screen.getByLabelText('Email (optional)'), 'cara@acme.example');
    await user.click(screen.getByRole('button', { name: 'Add contact' }));

    expect(mocks.callableCall).toHaveBeenCalledWith({
      action: 'create',
      customerId: 'c1',
      contact: { name: 'Cara Cole', email: 'cara@acme.example' },
    });
    expect(onChange).toHaveBeenCalledWith(
      'p-new',
      expect.objectContaining({ name: 'Cara Cole', email: 'cara@acme.example' }),
    );
  });

  it('blocks the inline creator without a name', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('button', { name: 'Add new contact' }));
    await user.click(screen.getByRole('button', { name: 'Add contact' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the contact name.');
    expect(mocks.callableCall).not.toHaveBeenCalled();
  });

  it('is a read-only display for non-admins', () => {
    setClaims(viewerClaims);
    renderPicker({ value: 'p1' });
    expect(
      screen.getByText('Amy Archer, Facilities Director'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add new contact' }),
    ).not.toBeInTheDocument();
  });
});
