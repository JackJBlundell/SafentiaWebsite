// ============================================================================
// useRtdbQuery - the real hook (not the per-test mock the screens use).
//
// The regression this pins: the bridge caches the RAW node value under the key
// and each observer applies its OWN `select`. Two screens reading the same path
// in different shapes (a members LIST and a members COUNT) must therefore not
// corrupt each other in the cache - the bug that rendered an object as a React
// child on the admin and staff pages. Before the fix the cache stored the
// shaped value, so whichever observer wrote last won and the other read the
// wrong shape.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A tiny in-memory RTDB: onValue fires once with the value registered for the
// ref's path, then holds the handler so nothing leaks. get() resolves the same.
const store: Record<string, unknown> = {};

vi.mock('../firebase', () => ({
  firebase: { db: () => ({}) },
}));

vi.mock('firebase/database', () => ({
  ref: (_db: unknown, path: string) => ({ path }),
  // The screens narrow with build(); the identity passthrough keeps the ref's path.
  onValue: (
    target: { path: string },
    onNext: (snapshot: { val: () => unknown }) => void,
  ) => {
    onNext({ val: () => store[target.path] ?? null });
    return () => undefined;
  },
  get: async (target: { path: string }) => ({ val: () => store[target.path] ?? null }),
}));

// Imported after the mocks are declared.
import { useRtdbQuery } from './useRtdbQuery';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useRtdbQuery', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it('applies each observer\'s own select to the same key without colliding', async () => {
    store['test/orgMembers/org-a'] = { u1: {}, u2: {}, u3: {} };
    const Wrapper = wrapper();

    // Two observers, SAME key, different shapes: a raw map and a count.
    const raw = renderHook(
      () =>
        useRtdbQuery<Record<string, unknown> | null>({
          key: ['orgMembers', 'org-a'],
          path: 'test/orgMembers/org-a',
        }),
      { wrapper: Wrapper },
    );
    const count = renderHook(
      () =>
        useRtdbQuery<number>({
          key: ['orgMembers', 'org-a'],
          path: 'test/orgMembers/org-a',
          select: (value) =>
            value && typeof value === 'object' ? Object.keys(value).length : 0,
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(raw.result.current.data).toBeDefined());
    await waitFor(() => expect(count.result.current.data).toBeDefined());

    // Each observer sees its OWN shape, not the other's.
    expect(raw.result.current.data).toEqual({ u1: {}, u2: {}, u3: {} });
    expect(count.result.current.data).toBe(3);
    expect(typeof count.result.current.data).toBe('number');
  });

  it('shapes an absent node through select rather than crashing', async () => {
    const Wrapper = wrapper();
    const { result } = renderHook(
      () =>
        useRtdbQuery<number>({
          key: ['orgMembers', 'empty'],
          path: 'test/orgMembers/empty',
          select: (value) =>
            value && typeof value === 'object' ? Object.keys(value).length : 0,
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toBe(0);
  });
});
