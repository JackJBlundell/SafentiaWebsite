// ============================================================================
// actionPlan unit tests - the contract-critical facts of manageAction (story
// 2043/2044) without an emulator: create defaults, the server-side sign-off
// stamp, and the update whitelist that can never move `status`.
// ============================================================================

import {
  createActionRecord,
  MANUAL_ASSESSMENT_ID,
  reopenFragment,
  signOffFragment,
  UPDATABLE_ACTION_FIELDS,
} from '../lib/actionPlan';
import { DUE_WINDOW_DAYS } from '../shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 6, 1);

describe('createActionRecord', () => {
  it('defaults dueBy from DUE_WINDOW_DAYS for the severity', () => {
    const record = createActionRecord(
      { observation: 'Wedged fire door', severity: 'H' },
      NOW,
    );
    expect(record.dueBy).toBe(NOW + DUE_WINDOW_DAYS.H * DAY_MS);
  });

  it('is born open, not life protection, with manual provenance', () => {
    const record = createActionRecord(
      { observation: 'Blocked escape route', severity: 'M' },
      NOW,
    );
    expect(record.status).toBe('open');
    expect(record.lifeProtection).toBe(false);
    expect(record.assessmentId).toBe(MANUAL_ASSESSMENT_ID);
    expect(record.sectionCode).toBe(MANUAL_ASSESSMENT_ID);
    expect(record.question).toBe('');
    expect(record.signedOffBy).toBeUndefined();
  });

  it('honours an explicit dueBy, responsible and lifeProtection', () => {
    const dueBy = NOW + 3 * DAY_MS;
    const record = createActionRecord(
      {
        observation: 'Missing signage',
        severity: 'L',
        dueBy,
        responsible: 'Site manager',
        lifeProtection: true,
      },
      NOW,
    );
    expect(record.dueBy).toBe(dueBy);
    expect(record.responsible).toBe('Site manager');
    expect(record.lifeProtection).toBe(true);
  });
});

describe('sign-off and reopen fragments', () => {
  const path = 'test/actions/org-1/bld-1/act-1';

  it('stamps status, who and when server-side on sign off', () => {
    expect(signOffFragment(path, 'uid-1', NOW)).toEqual({
      [`${path}/status`]: 'signedOff',
      [`${path}/signedOffBy`]: 'uid-1',
      [`${path}/signedOffAt`]: NOW,
    });
  });

  it('reopen clears the provenance pair and returns to open', () => {
    expect(reopenFragment(path)).toEqual({
      [`${path}/status`]: 'open',
      [`${path}/signedOffBy`]: null,
      [`${path}/signedOffAt`]: null,
    });
  });
});

describe('update whitelist', () => {
  it('never admits status or the sign-off provenance fields', () => {
    const fields: readonly string[] = UPDATABLE_ACTION_FIELDS;
    expect(fields).toEqual([
      'observation',
      'severity',
      'responsible',
      'dueBy',
      'lifeProtection',
    ]);
    expect(fields).not.toContain('status');
    expect(fields).not.toContain('signedOffBy');
    expect(fields).not.toContain('signedOffAt');
  });
});
