// ============================================================================
// ThemeProvider - the web twin of FireRite/src/design/ThemeProvider.tsx.
//
// It resolves the active colour scheme, builds the fully-resolved `Theme` with
// the SAME `buildTheme()` the app uses (that module is shared byte-for-byte), and
// publishes the per-organisation brand accent as CSS custom properties so plain
// stylesheets can read it without a component subscribing to context.
//
// Division of labour with tokens.css, which matters:
//   - tokens.css owns everything knowable at BUILD time: neutrals, RAG, status,
//     spacing, the default brand. Pre-rendered pages paint correctly with zero
//     JavaScript because of it.
//   - This provider owns only what is knowable at RUN time: the visitor's chosen
//     scheme, and the signed-in organisation's brand accent (contrast-corrected
//     by buildTheme, never shipped raw - brief 18.5).
//
// Scheme resolution order: an explicit user choice beats the OS preference, and
// the OS preference beats light. The choice persists in localStorage under one
// key, and `data-theme` on <html> is the single switch the stylesheet reads.
// ============================================================================

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { buildTheme, type ColorScheme, type Theme } from './theme';
import { resolveFontStack } from './tokens/typography';
import type { OrgBrand } from '../types';

/** What the visitor asked for. `system` defers to the OS. */
export type SchemePreference = ColorScheme | 'system';

/** One key, one place. Changing it orphans existing visitors' preferences. */
const STORAGE_KEY = 'safentia.theme';

export interface ThemeContextValue {
  theme: Theme;
  /** The visitor's stored preference, which may be `system`. */
  preference: SchemePreference;
  /** The scheme actually in force after resolving `system`. */
  scheme: ColorScheme;
  setPreference: (preference: SchemePreference) => void;
  /** Convenience for a two-state toggle: flips to the opposite of what is shown,
   *  which pins the preference away from `system`. That is the behaviour a user
   *  expects from a toggle they just pressed. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function readStoredPreference(): SchemePreference {
  if (typeof window === 'undefined') {
    return 'system';
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // Private browsing or a blocked storage partition. Not an error worth
    // surfacing: the visitor simply gets the OS preference this session.
    return 'system';
  }
}

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** The signed-in organisation's brand, once its profile has loaded. Absent on
   *  every public page and until the profile resolves, in which case the default
   *  accent from the palette applies. */
  brand?: OrgBrand;
  fontFamily?: string;
  logoUrl?: string;
}

export function ThemeProvider({
  children,
  brand,
  fontFamily,
  logoUrl,
}: ThemeProviderProps) {
  // Server/pre-render pass: `system` and light, matching the stylesheet defaults
  // exactly so hydration never has to correct the first paint.
  const [preference, setPreferenceState] = useState<SchemePreference>('system');
  const [systemDark, setSystemDark] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  // Adopt the visitor's real environment after mount. Doing this in an effect
  // (rather than in useState's initialiser) keeps the server and client render
  // identical, which is what prevents a hydration mismatch on the pre-rendered
  // marketing pages.
  useEffect(() => {
    setPreferenceState(readStoredPreference());
    setSystemDark(prefersDark());
    setReduceMotion(prefersReducedMotion());
  }, []);

  // Track live OS changes: a visitor who flips their system theme while reading
  // should see the page follow, unless they have pinned a preference.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onDark = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    const onMotion = (event: MediaQueryListEvent) => setReduceMotion(event.matches);
    darkQuery.addEventListener('change', onDark);
    motionQuery.addEventListener('change', onMotion);
    return () => {
      darkQuery.removeEventListener('change', onDark);
      motionQuery.removeEventListener('change', onMotion);
    };
  }, []);

  const scheme: ColorScheme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  const setPreference = useCallback((next: SchemePreference) => {
    setPreferenceState(next);
    try {
      if (next === 'system') {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Storage unavailable. The preference still applies for this session.
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(scheme === 'dark' ? 'light' : 'dark');
  }, [scheme, setPreference]);

  // Mirror the resolved scheme onto <html> so the stylesheet - and therefore any
  // markup that never mounts a React component - reads the same source of truth.
  // The inline boot script in index.html sets this before first paint; here we
  // keep it in step with later changes.
  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', preference);
    }
  }, [preference]);

  const theme = useMemo(
    () =>
      buildTheme({
        scheme,
        reduceMotion,
        brand,
        // Org fonts arrive as bare family names; resolve to a full stack so a
        // missing font degrades to the platform default, never the browser's.
        fontFamily: resolveFontStack(fontFamily),
        logoUrl,
      }),
    [scheme, reduceMotion, brand, fontFamily, logoUrl],
  );

  // Publish the RUN-time values as custom properties. Only the brand accent and
  // the org font are written: everything else already lives in tokens.css, and
  // re-writing it here would create the second source of truth the token test
  // exists to prevent.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--brand-primary', theme.brand.primary);
    root.style.setProperty('--brand-on-primary', theme.brand.onPrimary);
    root.style.setProperty('--brand-secondary', theme.brand.secondary);
    root.style.setProperty('--brand-on-secondary', theme.brand.onSecondary);
    root.style.setProperty('--font-family', theme.fontFamily);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, preference, scheme, setPreference, toggle }),
    [theme, preference, scheme, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Read the theme. Throws outside the provider so a wiring mistake is loud at
 *  development time rather than a confusing null at runtime. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider.');
  }
  return ctx;
}
