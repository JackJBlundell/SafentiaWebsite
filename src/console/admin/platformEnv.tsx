// ============================================================================
// platformEnv - the ONE source of truth for the platform console's live/test
// environment (FR-E24).
//
// The super-admin oversight area used to repeat a live/test toggle on every
// page and thread the choice through the URL, so each screen tracked its own
// environment and a drill-down inherited whatever segment the link happened to
// carry. This context replaces all of that: the environment is chosen ONCE, in
// the platform navigation rail, and every platform screen - dashboard, lists,
// drill-down and activity - reads it from here. Flip it once and the whole
// platform area agrees.
//
// The default value is 'live' with a no-op setter, so a component consuming the
// context WITHOUT a provider (a page or AdminRoutes rendered directly, as the
// tests do) reads 'live' and behaves exactly as the old per-page default did.
// The provider persists the choice to localStorage so it survives a reload,
// guarded for the prerender pass where `window` is absent.
// ============================================================================

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Environment } from '../../types';

interface PlatformEnvValue {
  env: Environment;
  setEnv: (env: Environment) => void;
}

/** localStorage key the operator's environment choice persists under. */
const STORAGE_KEY = 'safentia:platformEnv';

/** Default 'live', no-op setter: a consumer without a provider reads 'live', so
 *  pages and AdminRoutes rendered on their own keep the old default behaviour. */
const PlatformEnvContext = createContext<PlatformEnvValue>({
  env: 'live',
  setEnv: () => {},
});

/** The stored choice, or 'live' when nothing valid is stored or the prerender
 *  pass has no `window`. Only the two known values are honoured. */
function readStoredEnv(): Environment {
  if (typeof window === 'undefined') {
    return 'live';
  }
  return window.localStorage.getItem(STORAGE_KEY) === 'test' ? 'test' : 'live';
}

/**
 * Holds the single platform environment and persists it. Mount it high enough
 * to enclose BOTH the platform nav (where the toggle lives) and the routed page
 * area, so the toggle and every screen share one value.
 */
export function PlatformEnvProvider({ children }: { children: ReactNode }) {
  const [env, setEnv] = useState<Environment>(readStoredEnv);

  // Persist on change, guarded for the prerender pass with no `window`.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, env);
    }
  }, [env]);

  const value = useMemo<PlatformEnvValue>(() => ({ env, setEnv }), [env]);

  return (
    <PlatformEnvContext.Provider value={value}>
      {children}
    </PlatformEnvContext.Provider>
  );
}

/** Read the shared platform environment and its setter. */
export function usePlatformEnv(): PlatformEnvValue {
  return useContext(PlatformEnvContext);
}
