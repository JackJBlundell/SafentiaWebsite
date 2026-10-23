// ============================================================================
// SpaceMark tests: the three identity tiers, and - the reason this file exists -
// what happens when tier 1 is a logo that will not load.
//
// SpaceMark reads only its props, plus the logo itself, which is fetched through
// the Storage SDK (mocked at that boundary). It is rendered directly rather than
// through the console shell, which is the altitude the behaviour lives at.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UserSpace } from '../types';
import { storageMock } from '../test/storageMock';
import { SpaceMark } from './SpaceMark';

vi.mock('../firebase', () => ({ firebase: { storage: vi.fn() } }));
vi.mock('firebase/storage', async () => (await import('../test/storageMock')).storageModule);

// Each test uses its own object: fetched files are cached for the session.
let n = 0;
let LOGO = '';
beforeEach(() => {
  n += 1;
  LOGO = `live/orgs/org-1/branding/logo-${n}.png`;
});

/** The logo <img> once it has been fetched (alt="" gives it no img role). */
async function loadedLogo(container: HTMLElement): Promise<HTMLImageElement> {
  await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
  return container.querySelector('img') as HTMLImageElement;
}

beforeEach(() => storageMock.reset());

function staffSpace(overrides: Partial<UserSpace> = {}): UserSpace {
  return {
    kind: 'staff',
    orgId: 'org-1',
    name: 'Acme Fire Safety',
    isCurrent: true,
    ...overrides,
  } as UserSpace;
}

describe('SpaceMark', () => {
  it('shows the organisation logo when it loads', async () => {
    const { container } = render(
      <SpaceMark space={staffSpace({ logoUrl: LOGO })} />,
    );
    // The monogram holds the mark while the logo is fetched.
    expect(screen.getByText('AF')).toBeInTheDocument();
    expect(await loadedLogo(container)).toHaveAttribute('src', `blob:${LOGO}`);
    // The monogram is not also rendered underneath it.
    expect(screen.queryByText('AF')).not.toBeInTheDocument();
  });

  it('keeps the monogram when the logo cannot be fetched', async () => {
    // The object was deleted from Storage, or the rules refuse it.
    storageMock.missing.add(LOGO);
    const { container } = render(
      <SpaceMark space={staffSpace({ logoUrl: LOGO, brandColor: '#0B5FA5' })} />,
    );
    await vi.waitFor(() => expect(storageMock.fetched).toContain(LOGO));
    expect(container.querySelector('img')).not.toBeInTheDocument();
    const mark = screen.getByText('AF');
    expect(mark).toHaveStyle({ background: '#0B5FA5' });
  });

  it('falls back to the monogram when the logo will not render', async () => {
    // Fetched, but the bytes are not a usable image: the browser fails it.
    const { container } = render(
      <SpaceMark space={staffSpace({ logoUrl: LOGO, brandColor: '#0B5FA5' })} />,
    );
    fireEvent.error(await loadedLogo(container));

    // Without this the browser's broken-image glyph sits inside the mark, which
    // reads as a broken product rather than broken data.
    expect(container.querySelector('img')).not.toBeInTheDocument();

    // Tier 2 takes over IN FULL - the initials and the brand tint the logo had
    // been suppressing - so the result is a designed state, not an empty box.
    const mark = screen.getByText('AF');
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveStyle({ background: '#0B5FA5' });
  });

  it('never fetches a logo from outside our own Storage bucket', () => {
    const { container } = render(
      <SpaceMark space={staffSpace({ logoUrl: 'https://example.test/logo.png' })} />,
    );
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(storageMock.fetched).toHaveLength(0);
    expect(screen.getByText('AF')).toBeInTheDocument();
  });

  it('retries a corrected logo rather than latching on the failure', async () => {
    const { container, rerender } = render(
      <SpaceMark space={staffSpace({ logoUrl: LOGO })} />,
    );
    fireEvent.error(await loadedLogo(container));
    expect(container.querySelector('img')).not.toBeInTheDocument();

    // An admin fixes the logo. The failure is remembered against the OLD url, so
    // a new one is attempted rather than being suppressed by a latched flag.
    const fixed = `${LOGO}.fixed.png`;
    rerender(<SpaceMark space={staffSpace({ logoUrl: fixed })} />);
    await vi.waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute('src', `blob:${fixed}`),
    );
  });

  it('uses the monogram when there is no logo at all', () => {
    render(<SpaceMark space={staffSpace({ brandColor: '#0B5FA5' })} />);
    expect(screen.getByText('AF')).toBeInTheDocument();
  });

  it('uses the building glyph when the name never resolved past its record id', () => {
    // A portal space the token may not read the name of: the push id stands in,
    // and a monogram of it would be meaningless letters. The test for an id is
    // deliberately narrow - 16+ unbroken characters INCLUDING a digit - so a real
    // single-word organisation name is never mistaken for a key.
    const { container } = render(
      <SpaceMark space={staffSpace({ name: '-Oy2c-9yBUMtW9lbSlV2' })} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText('-O')).not.toBeInTheDocument();
  });
});
