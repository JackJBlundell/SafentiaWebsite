// ============================================================================
// Organisation offboarding - the PURE parts (DECISIONS §8).
//
// The destructive deleteOrgData core is glue over the Admin SDK; what must be
// exactly right, and is unit-testable in isolation, is:
//   - the retention-elapsed predicate (only an explicit, stamped, past clock
//     authorises reaping - the opposite default to the billing-marker sweeps);
//   - the expired-org selection + per-run cap (blast-radius bound);
//   - the report-only deletion gate (armed ONLY by the exact string 'true'); and
//   - the RTDB deletion enumeration (env-scoped, orgId-bearing, no sentinel
//     leakage, complete).
// '../admin' is mocked so importing the module never initialises firebase-admin
// (the cleanupBilling precedent).
// ============================================================================

import {
  ORG_RETENTION_MS,
  RETENTION_DELETE_BATCH,
  retentionDeletionEnabled,
  retentionElapsed,
  selectExpiredOrgs,
} from '../lib/orgRetention';
import { orgRtdbRoots, orgStoragePrefix } from '../lib/deleteOrgData';
import type { Organisation } from '../shared/types';

jest.mock('../admin', () => ({ db: {}, auth: {}, storage: {} }));

const NOW = 2_000_000_000_000; // fixed clock

function orgWith(retentionUntil?: number | 'nan'): Organisation {
  return {
    profile: { name: 'Org', brand: { primary: '#000', secondary: '#111' } },
    subscription: {
      status: 'canceled',
      ...(retentionUntil === 'nan'
        ? { retentionUntil: 'soon' as unknown as number }
        : retentionUntil !== undefined
          ? { retentionUntil }
          : {}),
    },
  };
}

describe('ORG_RETENTION_MS', () => {
  it('is 12 months expressed as 365 days', () => {
    expect(ORG_RETENTION_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });
});

describe('retentionElapsed', () => {
  it('is true only for a real number strictly in the past', () => {
    expect(retentionElapsed({ retentionUntil: NOW - 1 }, NOW)).toBe(true);
  });

  it('is false at the exact boundary (not yet elapsed)', () => {
    expect(retentionElapsed({ retentionUntil: NOW }, NOW)).toBe(false);
  });

  it('is false for a future clock', () => {
    expect(retentionElapsed({ retentionUntil: NOW + 1 }, NOW)).toBe(false);
  });

  it('NEVER reaps an org with no clock (opposite default to the marker sweeps)', () => {
    expect(retentionElapsed({}, NOW)).toBe(false);
    expect(retentionElapsed(null, NOW)).toBe(false);
    expect(retentionElapsed(undefined, NOW)).toBe(false);
  });

  it('NEVER reaps an org whose clock is non-numeric', () => {
    expect(
      retentionElapsed({ retentionUntil: 'later' as unknown as number }, NOW),
    ).toBe(false);
  });
});

describe('selectExpiredOrgs', () => {
  it('selects only orgs whose clock has elapsed', () => {
    const ids = selectExpiredOrgs(
      {
        o_expired: orgWith(NOW - 1),
        o_boundary: orgWith(NOW),
        o_future: orgWith(NOW + 1),
        o_noclock: orgWith(),
        o_bad: orgWith('nan'),
      },
      NOW,
    );
    expect(ids).toEqual(['o_expired']);
  });

  it('caps the result at the per-run batch limit', () => {
    const orgs: Record<string, Organisation> = {};
    for (let i = 0; i < 5; i += 1) {
      orgs[`o_${i}`] = orgWith(NOW - 1);
    }
    expect(selectExpiredOrgs(orgs, NOW, 3)).toHaveLength(3);
  });

  it('tolerates malformed org records without widening the blast radius', () => {
    expect(
      selectExpiredOrgs(
        { o_null: null, o_undef: undefined, o_hit: orgWith(NOW - 1) },
        NOW,
      ),
    ).toEqual(['o_hit']);
  });

  it('has a sane per-run batch default', () => {
    expect(RETENTION_DELETE_BATCH).toBeGreaterThan(0);
  });
});

describe('retentionDeletionEnabled (report-only gate)', () => {
  it('arms ONLY on the exact string "true"', () => {
    expect(retentionDeletionEnabled('true')).toBe(true);
  });

  it('stays report-only for every other value', () => {
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes', 'True']) {
      expect(retentionDeletionEnabled(v)).toBe(false);
    }
  });
});

describe('orgRtdbRoots enumeration', () => {
  const ROOTS = orgRtdbRoots('live', 'ORG123');

  it('addresses every root under the correct env, carrying the orgId', () => {
    for (const { path } of ROOTS) {
      expect(path.startsWith('live/') || path.startsWith('ops/')).toBe(true);
      expect(path).toContain('ORG123');
    }
  });

  it('leaks no sentinel and no malformed separators', () => {
    for (const { path } of ROOTS) {
      expect(path).not.toContain('_sentinel_');
      expect(path).not.toContain('//');
      expect(path.endsWith('/')).toBe(false);
    }
  });

  it('uses unique labels and unique paths', () => {
    const labels = ROOTS.map((r) => r.label);
    const paths = ROOTS.map((r) => r.path);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('truncates deep builders to the org subtree root', () => {
    const byLabel = Object.fromEntries(ROOTS.map((r) => [r.label, r.path]));
    // A deep, multi-arg builder (documents/{orgId}/{buildingId}/{category}) must
    // truncate to the org node so the whole subtree is reaped.
    expect(byLabel.documents).toBe('live/documents/ORG123');
    // emailSettings is nested one below its builder (…/kinds/{kindId}); the org
    // root, not the kinds node, is what gets deleted.
    expect(byLabel.emailSettings).toBe('live/emailSettings/ORG123');
    expect(byLabel.organisation).toBe('live/organisations/ORG123');
    // Per-org ops counters live outside the env root, under the global ops tree.
    expect(byLabel.notificationCounts).toBe('ops/notificationCounts/live/ORG123');
  });

  it('scopes to the requested env', () => {
    for (const { path } of orgRtdbRoots('test', 'ORG9')) {
      expect(path.startsWith('test/') || path.startsWith('ops/')).toBe(true);
    }
  });
});

describe('orgStoragePrefix', () => {
  it('is the env-scoped org prefix with a trailing slash', () => {
    expect(orgStoragePrefix('live', 'ORG123')).toBe('live/orgs/ORG123/');
    expect(orgStoragePrefix('test', 'ORG9')).toBe('test/orgs/ORG9/');
  });
});
