// ============================================================================
// useRecordPlatformAccess - log a super admin's read-only drill-down into a
// tenant, once per mount (story 2069 AC2).
//
// The three platform drill-down screens (organisation, customer, building) call
// this on mount so the tenant's own /activity trail records that the platform
// operator looked. The write goes through the recordPlatformAccess callable,
// which is where the super-admin gate and the audit entry actually live; this
// hook only fires it, honestly and once.
//
// Best-effort by design: the oversight views are READ-ONLY and must render
// whether or not the note lands, so a failed log never surfaces an error or
// blocks the page. useCallable resolves with null rather than throwing, so
// swallowing the outcome is all that is needed. The ref guard makes "once" true
// under React's development double-invocation of effects (the same pattern as
// InviteRoute's one-shot preview), and env comes from the shared platform
// toggle so the note lands in the SAME environment the operator is viewing.
// ============================================================================

import { useEffect, useRef } from 'react';
import type {
  Environment,
  RecordPlatformAccessInput,
  RecordPlatformAccessResult,
} from '../../types';
import { useCallable } from '../ui/useCallable';
import { usePlatformEnv } from './platformEnv';

/** What was opened, matching the callable's server-side allow-list. */
type AccessScope = 'organisation' | 'customer' | 'building';

// The env is a console-view choice, not part of the stored input contract, so
// the call site carries it as an extra field the callable validates.
type RecordPlatformAccessRequest = RecordPlatformAccessInput & {
  env: Environment;
};

export function useRecordPlatformAccess(
  scope: AccessScope,
  orgId: string,
  targetId?: string,
): void {
  const { env } = usePlatformEnv();
  const { call } = useCallable<
    RecordPlatformAccessRequest,
    RecordPlatformAccessResult
  >('recordPlatformAccess');

  // One note per mount. env is captured at fire time; toggling the environment
  // while on the page does not re-log, matching the "once on open" intent.
  const logged = useRef(false);
  useEffect(() => {
    if (logged.current || !orgId) {
      return;
    }
    // The customer and building scopes name a specific record, so hold the note
    // until that id is resolved from the route; the organisation scope names no
    // child and logs as soon as the org is known.
    if (scope !== 'organisation' && !targetId) {
      return;
    }
    logged.current = true;
    // Fire and forget: call never throws (it resolves null on failure), so the
    // read-only view is untouched by an audit-write hiccup.
    void call({ env, orgId, scope, targetId });
  }, [call, env, orgId, scope, targetId]);
}
