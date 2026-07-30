// ============================================================================
// SpaceMark tests: the three identity tiers, and - the reason this file exists -
// what happens when tier 1 is a logo that will not load.
//
// No mocks. SpaceMark reads nothing but its props (the contrast helper is pure),
// so it is rendered directly rather than through the console shell, which is the
// altitude the behaviour actually lives at.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UserSpace } from '../types';
import { SpaceMark } from './SpaceMark';

const BROKEN = 'https://example.test/deleted-logo.png';

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
  it('shows the organisation logo when it loads', () => {
    const { container } = render(
      <SpaceMark space={staffSpace({ logoUrl: BROKEN })} />,
    );
    expect(container.querySelector('img')).toHaveAttribute('src', BROKEN);
    // The monogram is not also rendered underneath it.
    expect(screen.queryByText('AF')).not.toBeInTheDocument();
  });

  it('falls back to the monogram when the logo will not load', () => {
    // The object was deleted from Storage, or its url never resolved. The
    // profile still carries the url, so the mark tries it and the browser fails.
    const { container } = render(
      <SpaceMark space={staffSpace({ logoUrl: BROKEN, brandColor: '#0B5FA5' })} />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    fireEvent.error(img);

    // Without this the browser's broken-image glyph sits inside the mark, which
    // reads as a broken product rather than broken data.
    expect(container.querySelector('img')).not.toBeInTheDocument();

    // Tier 2 takes over IN FULL - the initials and the brand tint the logo had
    // been suppressing - so the result is a designed state, not an empty box.
    const mark = screen.getByText('AF');
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveStyle({ background: '#0B5FA5' });
  });

  it('retries a corrected logo rather than latching on the failure', () => {
    const space = staffSpace({ logoUrl: BROKEN });
    const { container, rerender } = render(<SpaceMark space={space} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).not.toBeInTheDocument();

    // An admin fixes the logo. The failure is remembered against the OLD url, so
    // a new one is attempted rather than being suppressed by a latched flag.
    rerender(
      <SpaceMark space={staffSpace({ logoUrl: 'https://example.test/new.png' })} />,
    );
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.test/new.png',
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
