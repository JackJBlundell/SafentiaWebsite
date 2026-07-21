// ============================================================================
// Shared harness for the security-rules matrix (brief 4.4).
//
// Wraps @firebase/rules-unit-testing so each test reads as "this actor, this path,
// allow or deny". We model actors by their custom claims (orgId, roles, testMode),
// exactly the claims onMembershipChange writes, so the matrix proves the deployed
// rules against the real claim shape. seedAsAdmin() writes fixture data with rules
// BYPASSED (withSecurityRulesDisabled) so a test's setup never depends on the rule
// being tested.
// ============================================================================

import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  RulesTestContext,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/** The single test project id, matching the emulator namespace. */
export const PROJECT_ID = 'safentia-tech';

let testEnv: RulesTestEnvironment | undefined;

/** The custom claims an actor carries; mirrors SafentiaClaims on the token.
 *  Staff carry orgId+roles; PORTAL users carry portalOrgId+customerId and NEVER
 *  orgId (onCustomerMembershipChange writes those claims); platform operators
 *  carry superAdmin. Modelling all three shapes lets the matrix prove each
 *  boundary against the exact token the rules read. */
export interface Actor {
  uid: string;
  orgId?: string;
  roles?: Record<string, true>;
  testMode?: boolean;
  /** Portal claims - a customer-portal user's org grant (never combined with orgId). */
  portalOrgId?: string;
  customerId?: string;
  /** Platform operator claim (read-everything, write-nothing). */
  superAdmin?: boolean;
}

/** Boot the shared test environment once, loading the REAL rules files. */
export async function getTestEnv(): Promise<RulesTestEnvironment> {
  if (testEnv) {
    return testEnv;
  }
  // The rules files live at the Firebase root (one level up from functions/).
  const dbRules = readFileSync(
    resolve(__dirname, '..', '..', '..', '..', 'database.rules.json'),
    'utf8',
  );
  const storageRules = readFileSync(
    resolve(__dirname, '..', '..', '..', '..', 'storage.rules'),
    'utf8',
  );
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: { rules: dbRules },
    storage: { rules: storageRules },
  });
  return testEnv;
}

/** A rules-applied context for an actor (or unauthenticated when uid is empty). */
export function contextFor(env: RulesTestEnvironment, actor: Actor | null): RulesTestContext {
  if (!actor) {
    return env.unauthenticatedContext();
  }
  // Custom claims (orgId, roles, testMode, customerId) ride on the token exactly
  // as the rules read them via auth.token.*.
  const { uid, ...claims } = actor;
  return env.authenticatedContext(uid, claims as Record<string, unknown>);
}

/** Write fixture data with rules disabled, so setup never depends on the SUT. */
export async function seedAsAdmin(
  env: RulesTestEnvironment,
  writes: Record<string, unknown>,
): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref().update(writes);
  });
}

/** Tear down (clears emulator data + listeners). Call in afterAll. */
export async function cleanup(): Promise<void> {
  if (testEnv) {
    await testEnv.cleanup();
    testEnv = undefined;
  }
}

/** Clear RTDB data between tests so cases do not leak into one another. */
export async function clearDb(env: RulesTestEnvironment): Promise<void> {
  await env.clearDatabase();
}
