// ============================================================================
// platformEnv tests: the ONE platform environment source (FR-E24). Proves the
// context defaults to 'live' with no provider (so pages and AdminRoutes render
// on their own exactly as before), that setEnv updates every reader under one
// provider, and that the choice round-trips through localStorage so it survives
// a reload.
// ============================================================================

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { PlatformEnvProvider, usePlatformEnv } from './platformEnv';

const STORAGE_KEY = 'safentia:platformEnv';

afterEach(() => {
  window.localStorage.clear();
});

function withProvider({ children }: { children: ReactNode }) {
  return <PlatformEnvProvider>{children}</PlatformEnvProvider>;
}

describe('usePlatformEnv', () => {
  it('defaults to live with no provider, and its setter is a safe no-op', () => {
    const { result } = renderHook(() => usePlatformEnv());
    expect(result.current.env).toBe('live');
    // Calling the default setter must not throw: a page rendered without a
    // provider (as the tests do) still reads live and stays inert.
    expect(() => result.current.setEnv('test')).not.toThrow();
    expect(result.current.env).toBe('live');
  });

  it('updates every reader when setEnv is called under a provider', () => {
    const { result } = renderHook(() => usePlatformEnv(), {
      wrapper: withProvider,
    });
    expect(result.current.env).toBe('live');
    act(() => result.current.setEnv('test'));
    expect(result.current.env).toBe('test');
    act(() => result.current.setEnv('live'));
    expect(result.current.env).toBe('live');
  });

  it('persists the choice to localStorage so it survives a reload', () => {
    const first = renderHook(() => usePlatformEnv(), { wrapper: withProvider });
    act(() => first.result.current.setEnv('test'));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('test');

    // A fresh mount (a reload) reads the stored value back rather than the
    // 'live' default.
    first.unmount();
    const second = renderHook(() => usePlatformEnv(), { wrapper: withProvider });
    expect(second.result.current.env).toBe('test');
  });

  it('falls back to live when nothing valid is stored', () => {
    window.localStorage.setItem(STORAGE_KEY, 'nonsense');
    const { result } = renderHook(() => usePlatformEnv(), {
      wrapper: withProvider,
    });
    expect(result.current.env).toBe('live');
  });
});
