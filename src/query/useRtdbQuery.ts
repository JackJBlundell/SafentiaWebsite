// ============================================================================
// useRtdbQuery - the live-by-default backbone, the web twin of
// FireRite/src/query/useRtdbQuery.ts (CONVENTIONS section 2, brief 4.2 / 1027 /
// 18.7). The only platform difference is the SDK import surface: the modular
// `firebase/database` types replace @react-native-firebase's namespace types.
//
// It subscribes to ONE RTDB path, writes every snapshot into the TanStack Query
// cache under the supplied key, and - critically - DETACHES the listener on
// unmount. No screen attaches a raw listener itself; this is the only place a
// listener is created, so leak auditing happens in one file. A long console
// session must not accumulate listeners (brief 18.7).
//
// Why bridge into Query rather than useState: screens share one cached value by
// key instead of each re-subscribing (no N+1 listeners), and the cache survives
// route changes so returning to a screen paints instantly.
// ============================================================================

import { useEffect, useState } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  ref,
  onValue,
  type DatabaseReference,
  type Query,
} from 'firebase/database';
import { firebase } from '../firebase';
import type { QueryKey } from './keys';

/**
 * Optionally narrow a path subscription to an indexed query. The callback
 * receives the node reference and returns a constrained query, e.g.
 *   build: (node) => query(node, orderByChild('assessorUid'), equalTo(uid))
 * Use this for every list so the listener pulls only the rows a screen needs via
 * an `.indexOn` index, never the whole subtree filtered on the client (brief
 * 18.7). The query builders are imported from firebase/database at the call
 * site.
 */
export type RtdbQueryBuilder = (node: DatabaseReference) => Query;

/** Map a raw RTDB node value into the typed value a screen wants. RTDB returns
 *  object maps (not arrays) and `null` for an absent node; the selector decides
 *  how to shape that, so the bridge stays type-agnostic.
 *
 *  The selector receives the VALUE only, never the DataSnapshot: the raw value
 *  is what is cached (see useRtdbQuery), and the selector runs PER OBSERVER off
 *  that shared cache. A selector must therefore not depend on snapshot-iteration
 *  order - derive any ordering from a field in the value (e.g. sort by `at`). */
export type SnapshotSelector<T> = (value: unknown) => T;

const identity = <T,>(value: unknown): T => value as T;

/** Pause before re-attaching a cancelled listener (see the retry nonce). */
const RETRY_DELAY_MS = 5_000;

// ----------------------------------------------------------------------------
// First-delivery registry: how queryFn learns what the listener saw.
//
// This exists to give the bridge ONE source of truth. Previously queryFn ran its
// own one-shot get() alongside the listener, and the two could disagree: if that
// read failed while the listener had already delivered, react-query flipped the
// entry to `error` even though `data` held a perfectly good value. A node with
// rows healed itself on the next child event; an ABSENT node fires once with
// null and never again, so the false error was permanent. That is why a
// never-assessed building showed "could not be loaded" while every seeded one
// looked fine.
//
// Now the listener is the only reader. queryFn waits for its first snapshot, so
// loading means "no snapshot yet", error means "the listener was denied", and
// null means "this node is empty" - three states that can no longer contradict
// each other. It also halves the reads: every path used to be fetched twice.
// ----------------------------------------------------------------------------

interface FirstDelivery {
  /** True once the listener has produced a snapshot for this subscription. */
  delivered: boolean;
  /** The most recent raw value, replayed to a queryFn that arrives late. */
  value: unknown;
  /** queryFn callers waiting for the first snapshot. */
  waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;
}

/** Keyed by cache key AND path: the same key must never replay a value that was
 *  delivered for a different node (an org switch reuses keys under new ids). */
const deliveries = new Map<string, FirstDelivery>();

function deliveryId(key: QueryKey, path: string): string {
  return `${JSON.stringify(key)}|${path}`;
}

function deliveryFor(id: string): FirstDelivery {
  const existing = deliveries.get(id);
  if (existing) {
    return existing;
  }
  const created: FirstDelivery = { delivered: false, value: undefined, waiters: [] };
  deliveries.set(id, created);
  return created;
}

export interface RtdbQueryOptions<T> {
  /** The hierarchical cache key (from the `keys` factory). */
  key: QueryKey;
  /** The RTDB path (from a `paths` builder). Never a hand-typed string. */
  path: string;
  /** Shapes the raw snapshot value into T. Defaults to passing it through. */
  select?: SnapshotSelector<T>;
  /** When false, the listener is not attached (e.g. before a claim resolves).
   *  Defaults to true. */
  enabled?: boolean;
  /** Narrow the subscription to an indexed query (lists). When omitted the whole
   *  node is read. The builder identity is not a re-subscription dependency, so
   *  pass a stable one or accept that the path/key/enabled triple drives it. */
  build?: RtdbQueryBuilder;
}

/**
 * Subscribe a screen to an RTDB path and read it live from the Query cache.
 * Returns the standard UseQueryResult so screens branch on isLoading / isError
 * / data exactly as they would for any query.
 */
export function useRtdbQuery<T>(
  options: RtdbQueryOptions<T>,
): UseQueryResult<T, Error> {
  const { key, path, select = identity, enabled = true, build } = options;
  const client = useQueryClient();

  // Bumped after a listener error to force one re-subscription. RTDB CANCELS a
  // listener on a rules denial; without this the effect's deps never change, so
  // a single transient denial (a token-expiry blip, a membership flip mid org
  // switch) would leave the screen dead until a full remount. The delay keeps a
  // persistent denial from becoming a hammering loop.
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const node = ref(firebase.db(), path);
    // Apply the optional index constraint so a list pulls only its rows.
    const target = build ? build(node) : node;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const id = deliveryId(key, path);
    const delivery = deliveryFor(id);

    // onValue fires immediately with the current value, then on every change,
    // and returns an unsubscribe function. We push the RAW node value into the
    // cache under `key`; each observer applies its own `select` (react-query,
    // per-observer). Caching raw - not the shaped result - is what lets two
    // screens read the same path in different shapes (e.g. a members list and a
    // members COUNT) without one overwriting the other's shape in the cache.
    const unsubscribe = onValue(
      target,
      (snapshot) => {
        const value = snapshot.val();
        // Record BEFORE writing the cache: a queryFn that resolves off this must
        // never see a value the registry has not caught up with.
        delivery.delivered = true;
        delivery.value = value;
        const waiting = delivery.waiters.splice(0);
        client.setQueryData<unknown>(key, value);
        waiting.forEach((waiter) => waiter.resolve(value));
      },
      (error: Error) => {
        // A denial is the one case where the listener genuinely has nothing, so
        // anyone waiting on the first snapshot is failed rather than left hanging.
        delivery.delivered = false;
        delivery.value = undefined;
        delivery.waiters.splice(0).forEach((waiter) => waiter.reject(error));
        // Surface the failure to the query so the screen's error state shows,
        // rather than swallowing it (CONVENTIONS section 4: no silent catches).
        // The cache entry can be absent when the denial lands before useQuery
        // materialises it (or after a clear()); `build` returns the existing
        // entry or creates it - public QueryCache API, not a data write - so
        // the error is never dropped on the floor.
        const cache = client.getQueryCache();
        const query =
          cache.find({ queryKey: key as readonly unknown[] }) ??
          cache.build(client, { queryKey: key as readonly unknown[] });
        query.setState({
          ...query.state,
          status: 'error',
          error,
          fetchStatus: 'idle',
        });
        // The listener is now dead (RTDB cancels it): schedule one re-attach.
        retryTimer = setTimeout(() => setRetryNonce((n) => n + 1), RETRY_DELAY_MS);
      },
    );

    // Detach on unmount or when key/path/enabled change. Calling the returned
    // unsubscribe removes only THIS listener, never a sibling's. The pending
    // retry (if any) is cancelled with it, so an unmounted screen never
    // resubscribes from beyond the grave.
    return () => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
      }
      unsubscribe();
      // Settle anyone still waiting before dropping the registry entry: with the
      // listener gone nothing will ever resolve them, and an unsettled queryFn
      // promise leaves the query fetching for the rest of the session. They are
      // resolved with whatever the cache holds rather than rejected, because an
      // unmount is not a failure and must not paint an error on the way out.
      delivery.waiters
        .splice(0)
        .forEach((waiter) => waiter.resolve(client.getQueryData(key) ?? null));
      deliveries.delete(id);
    };
    // `select` is intentionally not a dependency: callers pass a stable selector
    // (or an inline one whose identity changing should not re-subscribe the same
    // path). Re-subscription is driven by the path/key/enabled triple, plus the
    // error-retry nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, JSON.stringify(key), path, enabled, retryNonce]);

  return useQuery<unknown, Error, T>({
    queryKey: key as readonly unknown[],
    // Resolves off the LISTENER's first snapshot rather than reading the node
    // again. This is what keeps the two from disagreeing: there is now one
    // reader, so a fetch can no longer report failure for data the subscription
    // already holds, and `null` arrives as an ordinary success meaning the node
    // is empty. `select` shapes the cached raw value for THIS observer.
    queryFn: () => {
      const delivery = deliveryFor(deliveryId(key, path));
      if (delivery.delivered) {
        // The snapshot beat the fetch (or this is a remount against a live
        // subscription): answer straight away rather than waiting for a second
        // snapshot that an unchanging node will never send.
        return Promise.resolve(delivery.value);
      }
      return new Promise<unknown>((resolve, reject) => {
        delivery.waiters.push({ resolve, reject });
      });
    },
    select,
    enabled,
  });
}

/**
 * Imperative subscription for non-hook call sites (e.g. the auth layer loading a
 * profile before any screen mounts). Returns an unsubscribe function the caller
 * MUST invoke; it writes into the same cache by key.
 */
export function subscribeToQuery<T>(
  client: QueryClient,
  options: Omit<RtdbQueryOptions<T>, 'enabled'>,
): () => void {
  const { key, path, select = identity, build } = options;
  const node = ref(firebase.db(), path);
  // Honour the same index constraint as the hook: silently ignoring `build`
  // here would download a whole subtree the caller asked to narrow.
  const target = build ? build(node) : node;
  // This imperative surface writes the SHAPED value, because its callers read
  // the cache entry directly (a plain useQuery with no select of their own).
  // Its keys are private to that pattern (e.g. `.info/connected`) and never
  // shared with a useRtdbQuery reader, so the shape cannot collide.
  return onValue(
    target,
    (snapshot) => {
      client.setQueryData<T>(key, select(snapshot.val()));
    },
    (error: Error) => {
      // Imperative call sites have no query state machine to flip; a denied
      // path must still be loud, not an eternal silent loading state.
      console.error(`[Safentia rtdb] subscription failed for ${path}`, error);
    },
  );
}
