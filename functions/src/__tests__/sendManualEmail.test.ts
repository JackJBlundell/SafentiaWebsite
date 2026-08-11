// ============================================================================
// sendManualEmail - the recipient slot planner (H3/L4 fix).
//
// The callable itself is an onCall wrapper (attestation, auth, rate limit,
// plan gate, quota charge, provider dispatch), so its contract-critical,
// testable-in-isolation part is planRecipientSlots: EXACTLY one slot per input
// recipient, in input order, with case-insensitive first-wins dedupe. The
// slots drive BOTH the honest 1:1 results array the client renders and the
// daily-cap charge (only 'ok' slots are dispatched, so only they are charged -
// duplicates and unresolvables spend nothing). admin is stubbed so importing
// the module stays a pure unit test with no SDK init - the
// reportClientError.test.ts pattern.
// ============================================================================

jest.mock('../admin', () => ({
  db: { ref: jest.fn() },
  auth: {},
  storage: {},
}));

import { planRecipientSlots } from '../functions/sendManualEmail';

const ok = (name: string, email: string) => ({ name, email, valid: true });
const unresolved = () => ({ name: '', email: '', valid: false });

describe('planRecipientSlots', () => {
  it('returns exactly one slot per input entry, in input order, indexed 1:1', () => {
    const slots = planRecipientSlots([
      ok('Ann', 'ann@example.com'),
      unresolved(),
      ok('Bob', 'bob@example.com'),
    ]);
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.recipient)).toEqual([0, 1, 2]);
    expect(slots.map((s) => s.status)).toEqual([
      'ok',
      'invalid-recipient',
      'ok',
    ]);
  });

  it('marks a repeated address duplicate, first occurrence wins and keeps the send', () => {
    const slots = planRecipientSlots([
      ok('Ann', 'ann@example.com'),
      ok('Ann again', 'ann@example.com'),
      ok('Bob', 'bob@example.com'),
      ok('Ann thrice', 'ann@example.com'),
    ]);
    expect(slots.map((s) => s.status)).toEqual([
      'ok',
      'duplicate',
      'ok',
      'duplicate',
    ]);
    // The duplicate slot still names its address (redacted downstream) so the
    // client can show WHICH row was the repeat.
    expect(slots[1]).toEqual({
      recipient: 1,
      name: 'Ann again',
      email: 'ann@example.com',
      status: 'duplicate',
    });
  });

  it('dedupes case-insensitively - the same person typed twice differs only in case', () => {
    const slots = planRecipientSlots([
      ok('Ann', 'Ann@Example.com'),
      ok('Ann', 'ann@example.com'),
    ]);
    expect(slots.map((s) => s.status)).toEqual(['ok', 'duplicate']);
  });

  it('an unresolvable entry never occupies the dedupe set: a later real address still sends', () => {
    const slots = planRecipientSlots([
      unresolved(),
      ok('Ann', 'ann@example.com'),
    ]);
    expect(slots.map((s) => s.status)).toEqual(['invalid-recipient', 'ok']);
    // The invalid slot carries no address at all - not even an empty-string
    // "match" that could mark a real one duplicate.
    expect(slots[0].email).toBe('');
  });

  it('the ok-slot count is the exact daily-cap charge: duplicates and invalids cost nothing', () => {
    const slots = planRecipientSlots([
      ok('Ann', 'ann@example.com'),
      ok('Ann again', 'ANN@example.com'),
      unresolved(),
      ok('Bob', 'bob@example.com'),
      ok('Bob again', 'bob@example.com'),
    ]);
    const deliverable = slots.filter((s) => s.status === 'ok');
    expect(deliverable).toHaveLength(2);
    expect(deliverable.map((s) => s.email)).toEqual([
      'ann@example.com',
      'bob@example.com',
    ]);
  });
});
