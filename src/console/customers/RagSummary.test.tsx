// ============================================================================
// RagSummary tests - the compact one-line icon+number strip and the overdue
// indicator list rows carry. Theme mocked at the same boundary as the other
// console suites; everything else renders for real.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../design/ThemeProvider', () => ({
  useTheme: () => ({
    theme: {
      colors: { textMuted: '#666', surfaceSunken: '#eee' },
      rag: {
        red: '#b00',
        amber: '#a60',
        green: '#060',
        redSurface: '#fdd',
        amberSurface: '#fed',
        greenSurface: '#dfd',
      },
    },
  }),
}));

import { OverdueBadge, overdueLabel, RagSummary } from './RagSummary';

describe('RagSummary', () => {
  it('renders one glyph+count pair per non-zero level and omits zeros', () => {
    render(
      <RagSummary counts={{ high: 2, medium: 0, low: 1, pending: 3 }} />,
    );
    // Each pair is the level's riskPresentation glyph plus its count; the
    // glyph differs per level, so colour never stands alone.
    expect(screen.getByText('!')).toBeInTheDocument(); // high
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument(); // low
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('–')).toBeInTheDocument(); // pending
    expect(screen.getByText('3')).toBeInTheDocument();
    // The zero-count level's glyph is omitted, not rendered with a 0.
    expect(screen.queryByText('~')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('speaks ONE combined sentence, hiding the glyph pairs from the reader', () => {
    render(
      <RagSummary
        counts={{ high: 2, medium: 0, low: 0, pending: 1 }}
        overdue={{ overdue: 3, lifeProtectionOverdue: 1 }}
      />,
    );
    expect(
      screen.getByRole('img', {
        name: 'Buildings: 2 high risk, 1 not yet assessed; 3 overdue actions, 1 Life Protection',
      }),
    ).toBeInTheDocument();
    // The overdue pair renders as alert glyph + count, not wording.
    expect(screen.getByText('⚠︎')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('states the all-zero case in words rather than rendering nothing', () => {
    render(<RagSummary counts={{ high: 0, medium: 0, low: 0, pending: 0 }} />);
    expect(screen.getByText('No buildings')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('omits the overdue pair when nothing is overdue', () => {
    render(
      <RagSummary
        counts={{ high: 1, medium: 0, low: 0, pending: 0 }}
        overdue={{ overdue: 0, lifeProtectionOverdue: 0 }}
      />,
    );
    expect(screen.queryByText('⚠︎')).toBeNull();
    expect(
      screen.getByRole('img', { name: 'Buildings: 1 high risk' }),
    ).toBeInTheDocument();
  });
});

describe('OverdueBadge', () => {
  it('renders an honest quiet zero, not a blank', () => {
    render(<OverdueBadge counts={{ overdue: 0, lifeProtectionOverdue: 0 }} />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('⚠︎')).toBeNull();
  });

  it('renders glyph + count with the escalated wording as its accessible name', () => {
    render(<OverdueBadge counts={{ overdue: 4, lifeProtectionOverdue: 2 }} />);
    expect(
      screen.getByRole('img', { name: '4 overdue actions, 2 Life Protection' }),
    ).toBeInTheDocument();
    expect(screen.getByText('⚠︎')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });
});

describe('overdueLabel', () => {
  it('pluralises the noun form and escalates Life Protection', () => {
    expect(overdueLabel({ overdue: 1, lifeProtectionOverdue: 0 }, true)).toBe(
      '1 overdue action',
    );
    expect(overdueLabel({ overdue: 2, lifeProtectionOverdue: 1 }, true)).toBe(
      '2 overdue actions, 1 Life Protection',
    );
    expect(overdueLabel({ overdue: 2, lifeProtectionOverdue: 0 })).toBe('2 overdue');
  });
});
