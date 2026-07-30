// ============================================================================
// actionPlan unit tests - the contract-critical facts of manageAction (story
// 2043/2044) without an emulator: create defaults, the server-side sign-off
// stamp, and the update whitelist that can never move `status`.
// ============================================================================

import {
  createActionRecord,
  customerResponseFragment,
  MANUAL_ASSESSMENT_ID,
  reopenFragment,
  signOffFragment,
  UPDATABLE_ACTION_FIELDS,
} from '../lib/actionPlan';
import { DUE_WINDOW_DAYS, type ActionCustomerResponse } from '../shared/types';

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
        responsibleContactId: 'contact-1',
        lifeProtection: true,
      },
      NOW,
    );
    expect(record.dueBy).toBe(dueBy);
    expect(record.responsible).toBe('Site manager');
    // The link travels with the name: it is what every automated email resolves.
    expect(record.responsibleContactId).toBe('contact-1');
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

  it('carries the optional note and evidence only when supplied', () => {
    const evidence = {
      fileName: 'certificate.pdf',
      storagePath: 'test/orgs/org-1/buildings/bld-1/actionEvidence/e1',
      uploadedBy: 'uid-1',
      uploadedAt: NOW,
    };
    expect(signOffFragment(path, 'uid-1', NOW, 'Door replaced', evidence)).toEqual(
      {
        [`${path}/status`]: 'signedOff',
        [`${path}/signedOffBy`]: 'uid-1',
        [`${path}/signedOffAt`]: NOW,
        [`${path}/completionNote`]: 'Door replaced',
        [`${path}/completionEvidence`]: evidence,
      },
    );
  });

  // The customer's own progress claim goes with them: a reopened action is work
  // the organisation has just judged unfinished, so a standing "this is done"
  // from the duty-holder would contradict the record it sits on.
  it('reopen clears the provenance, the note, its evidence and the customer claim', () => {
    expect(reopenFragment(path)).toEqual({
      [`${path}/status`]: 'open',
      [`${path}/signedOffBy`]: null,
      [`${path}/signedOffAt`]: null,
      [`${path}/completionNote`]: null,
      [`${path}/completionEvidence`]: null,
      [`${path}/customerResponse`]: null,
    });
  });
});

describe('customerResponseFragment', () => {
  const path = 'test/actions/org-1/bld-1/act-1';
  const response: ActionCustomerResponse = {
    state: 'completed',
    note: 'Contractor replaced the closer on 12 July.',
    byUid: 'portal-uid-1',
    at: NOW,
  };

  // THE contract of the portal write: a duty-holder reports progress, and can
  // never close their own compliance record. If this ever admits 'signedOff' or
  // a provenance stamp, the customer has signed off their own fire safety.
  it('never writes a sign-off, however the customer responds', () => {
    const fragment = customerResponseFragment(path, response, true);
    expect(fragment).toEqual({
      [`${path}/customerResponse`]: response,
      [`${path}/status`]: 'inProgress',
    });
    expect(fragment[`${path}/signedOffBy`]).toBeUndefined();
    expect(fragment[`${path}/signedOffAt`]).toBeUndefined();
  });

  it('leaves the status of an already in-progress action alone', () => {
    expect(customerResponseFragment(path, response, false)).toEqual({
      [`${path}/customerResponse`]: response,
    });
  });
});

describe('update whitelist', () => {
  it('never admits status or the sign-off provenance fields', () => {
    const fields: readonly string[] = UPDATABLE_ACTION_FIELDS;
    expect(fields).toEqual([
      'observation',
      'severity',
      'responsibleContactId',
      'dueBy',
      'lifeProtection',
    ]);
    // Free text can no longer be written onto an action: re-assignment names a
    // contact, and the callable derives the name from that contact's record.
    expect(fields).not.toContain('responsible');
    expect(fields).not.toContain('status');
    expect(fields).not.toContain('signedOffBy');
    expect(fields).not.toContain('signedOffAt');
  });
});
