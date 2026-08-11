// ============================================================================
// Onboarding setup-step marks - Phase 3 setup wizard piggyback (plan §5.4).
//
// Pins the best-effort contract of markOnboardingStep: it writes
// setupDone/{step}=true ONLY when the caller's onboarding node exists, is at
// the setup stage, and belongs to the org the business write touched - and it
// NEVER throws, because the business write it piggybacks on has already
// committed. The admin module is mocked with a settable path -> value map,
// the customerLimits.test pattern, extended with an update spy.
// ============================================================================

const mockDbData: Record<string, unknown> = {};
const updateCalls: Array<{ path: string; value: unknown }> = [];
let failNextUpdate = false;

jest.mock('../admin', () => ({
  db: {
    ref: (path: string) => ({
      get: async () => ({
        val: () => (path in mockDbData ? mockDbData[path] : null),
      }),
      child: (segment: string) => ({
        update: async (value: unknown) => {
          if (failNextUpdate) throw new Error('rtdb write refused');
          updateCalls.push({ path: `${path}/${segment}`, value });
        },
      }),
    }),
  },
}));

import { markOnboardingStep } from '../lib/onboardingMarks';
import type { Logger } from '../lib/logging';

const UID = 'user-1';
const ORG = 'org-1';
const NODE = `usersOnboarding/${UID}`;

const logs: Array<{ level: string; message: string }> = [];
const logger: Logger = {
  correlationId: 'test',
  debug: (message) => logs.push({ level: 'debug', message }),
  info: (message) => logs.push({ level: 'info', message }),
  warn: (message) => logs.push({ level: 'warn', message }),
  error: (message) => logs.push({ level: 'error', message }),
  child: () => logger,
};

beforeEach(() => {
  for (const key of Object.keys(mockDbData)) delete mockDbData[key];
  updateCalls.length = 0;
  logs.length = 0;
  failNextUpdate = false;
});

describe('markOnboardingStep', () => {
  it('marks the step done when the node is live, at setup, and org-matched', async () => {
    mockDbData[NODE] = { step: 'setup', orgId: ORG };
    await markOnboardingStep(UID, ORG, 'customer', logger);
    expect(updateCalls).toEqual([
      { path: `${NODE}/setupDone`, value: { customer: true } },
    ]);
  });

  it('is silent when no onboarding node exists (the everyday case)', async () => {
    await markOnboardingStep(UID, ORG, 'profile', logger);
    expect(updateCalls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('is silent when the node belongs to a different organisation', async () => {
    mockDbData[NODE] = { step: 'setup', orgId: 'other-org' };
    await markOnboardingStep(UID, ORG, 'team', logger);
    expect(updateCalls).toEqual([]);
  });

  it('is silent outside the setup stage (payment, done)', async () => {
    mockDbData[NODE] = { step: 'payment', orgId: ORG };
    await markOnboardingStep(UID, ORG, 'profile', logger);
    mockDbData[NODE] = { step: 'done', orgId: ORG };
    await markOnboardingStep(UID, ORG, 'customer', logger);
    expect(updateCalls).toEqual([]);
  });

  it('swallows write failures - never throws, logs a warning', async () => {
    mockDbData[NODE] = { step: 'setup', orgId: ORG };
    failNextUpdate = true;
    await expect(
      markOnboardingStep(UID, ORG, 'customer', logger),
    ).resolves.toBeUndefined();
    expect(updateCalls).toEqual([]);
    expect(logs).toEqual([
      {
        level: 'warn',
        message: 'Onboarding step mark failed (ignored - best effort)',
      },
    ]);
  });
});
