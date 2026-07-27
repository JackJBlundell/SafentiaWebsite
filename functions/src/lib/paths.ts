// ============================================================================
// Functions-side path facade.
//
// The canonical, mirrored path builders live in shared/paths and MUST NOT be
// edited here (they are kept byte-for-byte identical with the mobile app's copy
// by the CI diff gate - see SCHEMA_CHANGES.md). This module re-exports them and
// adds ONLY server-internal locations that the mobile app never addresses, so the
// shared contract stays clean while the Functions still have one import for every
// path they need.
//
// The token-refresh marker is the one such location: it is a global (non-env)
// signal the client watches to know it should refresh its ID token after a claim
// change (brief 4.1). It is not tenant data, it never appears in the section 6
// schema, and the app only ever READS it, so it correctly lives outside the
// mirrored builders.
// ============================================================================

import {
  forEnv,
  platform as sharedPlatform,
  envFromTestMode,
  portalSpaceKey,
  type EnvPaths,
  type RtdbPath,
} from '../shared/paths';
import type { Environment } from '../shared/types';

/** Re-exported as-is so callers import everything paths-related from one place. */
export { forEnv, envFromTestMode, portalSpaceKey };
export type { EnvPaths, RtdbPath };

/**
 * Platform (global, non-env) paths: the shared ones plus the server-only token
 * refresh marker. Spreading the shared object keeps every existing builder while
 * adding the marker, so there is still exactly one `platform` surface.
 */
export const platform = {
  ...sharedPlatform,
  /** Per-user metadata the client listens to; bumping it forces a token refresh. */
  metadata: (): RtdbPath => 'metadata',
  tokenRefresh: (uid: string): RtdbPath => `metadata/${uid}/refreshAt`,
} as const;

/**
 * Server-internal operational state the mobile app never addresses: abuse-control
 * counters that the Admin SDK alone reads and writes. These are deliberately NOT
 * in the mirrored shared/paths contract (they are not tenant data and never appear
 * in the section 6 schema), and rules default-deny them so no client can read or
 * tamper with them. The path segments are all server-controlled (uid from a
 * verified token, action a literal, env a fixed enum), so the template form is
 * injection-safe.
 */
export const ops = {
  /** Sliding-window rate-limit bucket for one user + action (lib/rateLimit). */
  rateLimit: (uid: string, action: string): RtdbPath =>
    `ops/rateLimits/${uid}/${action}`,
  /** Per-env, per-org monthly notification counter, for plan-quota enforcement. */
  notificationCount: (
    env: Environment,
    orgId: string,
    yyyyMm: string,
  ): RtdbPath => `ops/notificationCounts/${env}/${orgId}/${yyyyMm}`,
} as const;

/** Grouped facade so a caller writes `paths.platform.plan(...)` or `paths.forEnv(env)`. */
export const paths = {
  forEnv,
  envFromTestMode,
  platform,
  ops,
} as const;
