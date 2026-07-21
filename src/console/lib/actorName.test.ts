// ============================================================================
// actorName tests - the three honest states of uid -> name resolution: a live
// member's name, "Former staff member" once the map is loaded without the uid,
// and the neutral ellipsis while the map is still in flight (or unreadable).
// ============================================================================

import { describe, expect, it } from 'vitest';
import { FORMER_STAFF_LABEL, actorName } from './actorName';

const members = {
  'uid-dana': { name: 'Dana Field' },
  'uid-rob': { name: 'Rob Marsh' },
};

describe('actorName', () => {
  it('returns the member name when the uid is present', () => {
    expect(actorName(members, 'uid-dana', true)).toBe('Dana Field');
  });

  it('labels a uid missing from a LOADED map as former staff', () => {
    expect(actorName(members, 'uid-gone', true)).toBe(FORMER_STAFF_LABEL);
    // A loaded-but-empty node (null from RTDB) is the same case.
    expect(actorName(null, 'uid-gone', true)).toBe(FORMER_STAFF_LABEL);
  });

  it('shows a neutral placeholder, never the raw uid, while loading', () => {
    expect(actorName(undefined, 'uid-dana', false)).toBe('…');
    expect(actorName(undefined, 'uid-dana', false)).not.toContain('uid');
  });

  it('prefers a resolved name even if the caller says still loading', () => {
    // A keepPreviousData-style caller may hold data while a refetch runs;
    // a known name always wins over both fallbacks.
    expect(actorName(members, 'uid-rob', false)).toBe('Rob Marsh');
  });

  it('treats a member record with an empty name as unresolvable, not blank', () => {
    expect(actorName({ 'uid-x': { name: '' } }, 'uid-x', true)).toBe(
      FORMER_STAFF_LABEL,
    );
  });
});
