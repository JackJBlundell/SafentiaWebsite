// ============================================================================
// useOnboardingNode - the one reader of usersOnboarding/{uid} for the gate
// ladder (PHASE3_BILLING_PLAN.md §3.1/§5.4). Two read postures, one cache key:
//
// - A membership-less session (`wantLive`) needs a LIVE listener: the node's
//   step transitions (payment -> setup -> done) are exactly what move the
//   session between gates, and the webhook writes them server-side.
// - A claimed staff session almost never has a node at all, so it gets ONE
//   cheap `get()` whose null result is cached for the session - no listener
//   is attached for the overwhelming majority who never onboarded here. Only
//   when that read reveals a mid-setup journey does the hook upgrade itself
//   to the listener, so finishing the wizard (completedAt, written by the
//   server) releases the gate without a reload.
//
// Both postures share keys.userOnboarding(uid), so the upgrade paints from a
// warm cache and a session that flips noMembership -> authenticated (claims
// minted mid-confirm) never refetches what the listener already delivered.
// ============================================================================

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { get, ref } from 'firebase/database';
import { firebase } from '../../firebase';
import { usersOnboarding } from '../../paths';
import { keys } from '../../query/keys';
import { useRtdbQuery } from '../../query/useRtdbQuery';
import type { UserOnboarding } from '../../types';

export interface UseOnboardingNodeOptions {
  /** False keeps both reads detached (no session, portal, unverified). */
  enabled: boolean;
  /** True forces the live listener (the membership-less subscribe journey). */
  wantLive: boolean;
}

/**
 * Read the caller's onboarding node in the cheapest posture the session
 * allows. Returns the standard query result shape the ladder branches on.
 */
export function useOnboardingNode(
  uid: string | null,
  { enabled, wantLive }: UseOnboardingNodeOptions,
): UseQueryResult<UserOnboarding | null, Error> {
  const key = keys.userOnboarding(uid ?? 'anonymous');
  const path = usersOnboarding(uid ?? 'anonymous');

  // The one-shot read for claimed sessions. staleTime Infinity: an absent node
  // stays absent for the session (a claimed user starts no new journey), and a
  // present one immediately hands over to the listener below.
  const once = useQuery<UserOnboarding | null>({
    queryKey: key,
    queryFn: async () => {
      const snapshot = await get(ref(firebase.db(), path));
      return (snapshot.val() as UserOnboarding | null) ?? null;
    },
    enabled: enabled && !wantLive,
    staleTime: Infinity,
  });

  // Upgrade to live while a setup journey is actually underway - the wizard's
  // step marks and completedAt land server-side and must release the gate.
  const midSetup =
    once.data != null && once.data.step === 'setup' && !once.data.completedAt;
  const live = wantLive || midSetup;
  const liveQuery = useRtdbQuery<UserOnboarding | null>({
    key,
    path,
    enabled: enabled && live,
  });

  return live ? liveQuery : once;
}
