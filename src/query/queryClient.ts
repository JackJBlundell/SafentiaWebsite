// ============================================================================
// The shared QueryClient - the web twin of FireRite/src/query/queryClient.ts.
//
// Server data is live-by-default through the RTDB bridge (useRtdbQuery), so the
// defaults here exist to keep TanStack Query out of the bridge's way rather
// than to schedule refetching.
//
// Deliberately NO offline persistence on the web in this wave: the app's
// persist layer is native MMKV, built for a field assessor cold-starting in a
// basement. A console session runs in a connected browser tab, so persisting
// the cache would add a storage schema to maintain without a user need behind
// it. If the console ever earns an offline story, the persister slots in here.
// ============================================================================

import { QueryClient } from '@tanstack/react-query';

/** Bounds how long unused cache entries linger before garbage collection. */
const GC_TIME_MS = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // RTDB listeners push fresh data into the cache, so time-based refetching
      // is redundant and would fight the live bridge. We keep data "fresh" and
      // let the bridge own freshness; gcTime bounds how long unused data lingers.
      staleTime: Infinity,
      gcTime: GC_TIME_MS,
      // The bridge is the source of truth; window-focus/reconnect refetch would
      // duplicate work and is disabled deliberately.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});
