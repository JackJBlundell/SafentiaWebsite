// ============================================================================
// humaniseActivity tests - the audit-code phrasing map and its guarantees:
// every static write-site code phrases cleanly, detail suffixes split off,
// unknown codes degrade honestly, and target links exist only where the
// console genuinely has a route.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  activityTargetUrl,
  humaniseAction,
  isReleaseAction,
  sentenceCase,
} from './humaniseActivity';

describe('humaniseAction', () => {
  it('phrases the static codes the Functions write', () => {
    expect(humaniseAction('customer.created').phrase).toBe('created a customer');
    expect(humaniseAction('assessment.released').phrase).toBe(
      'released an assessment',
    );
    expect(humaniseAction('action.signedOff').phrase).toBe(
      'signed off an action item',
    );
    expect(humaniseAction('orgSettings.ragConfig.updated').phrase).toBe(
      'updated the risk-banding settings',
    );
    expect(humaniseAction('building.serviceSchedule updated').phrase).toBe(
      "updated a building's service schedule",
    );
  });

  it('splits a parenthesised detail suffix off the phrase', () => {
    expect(humaniseAction('member.updated (roles, name)')).toEqual({
      phrase: 'updated a staff member',
      detail: 'roles, name',
    });
    expect(humaniseAction('assessment.released (manual risk: high)')).toEqual({
      phrase: 'released an assessment',
      detail: 'manual risk: high',
    });
    expect(humaniseAction('document.created (insurance)')).toEqual({
      phrase: 'uploaded a building document',
      detail: 'insurance',
    });
    expect(humaniseAction('template.published (v3)')).toEqual({
      phrase: 'published a template',
      detail: 'v3',
    });
  });

  it('phrases the assessment.stage.* family by stage', () => {
    expect(humaniseAction('assessment.stage.released').phrase).toBe(
      'released an assessment',
    );
    expect(humaniseAction('assessment.stage.readyForValidation').phrase).toBe(
      'marked an assessment ready for validation',
    );
    expect(humaniseAction('assessment.stage.infoRequired').phrase).toBe(
      'flagged an assessment as needing more information',
    );
    // A stage the map has never seen still reads as English.
    expect(humaniseAction('assessment.stage.someNewStage').phrase).toBe(
      'moved an assessment to some new stage',
    );
  });

  it('degrades unknown codes to spaced, lowercased words', () => {
    expect(humaniseAction('widgetGroup.frobbed').phrase).toBe(
      'widget group frobbed',
    );
    expect(humaniseAction('thing.done (twice)')).toEqual({
      phrase: 'thing done',
      detail: 'twice',
    });
  });
});

describe('sentenceCase', () => {
  it('capitalises the first letter only', () => {
    expect(sentenceCase('released an assessment')).toBe(
      'Released an assessment',
    );
  });
});

describe('isReleaseAction', () => {
  it('matches both the plain and the manual-risk release codes', () => {
    expect(isReleaseAction('assessment.released')).toBe(true);
    expect(isReleaseAction('assessment.released (manual risk: medium)')).toBe(
      true,
    );
    expect(isReleaseAction('assessment.stage.released')).toBe(false);
    expect(isReleaseAction('customer.created')).toBe(false);
  });
});

describe('activityTargetUrl', () => {
  it('links customer and job targets to their real console routes', () => {
    expect(activityTargetUrl('customer.updated', 'cust-1')).toBe(
      '/app/customers/cust-1',
    );
    expect(activityTargetUrl('customer.archived', 'cust-2')).toBe(
      '/app/customers/cust-2',
    );
    expect(activityTargetUrl('job.rescheduled (scheduledFor)', 'job-9')).toBe(
      '/app/jobs/job-9',
    );
  });

  it('never links targets the console has no route for', () => {
    // Released assessments have no console view yet; buildings and sites need
    // ancestor ids the entry does not carry; templates are admin-gated.
    expect(activityTargetUrl('assessment.released', 'asm-1')).toBeUndefined();
    expect(activityTargetUrl('building.created', 'b-1')).toBeUndefined();
    expect(activityTargetUrl('site.updated', 's-1')).toBeUndefined();
    expect(activityTargetUrl('template.published (v2)', 't-1')).toBeUndefined();
    expect(activityTargetUrl('customer.created', '')).toBeUndefined();
  });
});
