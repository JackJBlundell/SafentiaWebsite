// The "security check blocked" notice: shown only when App Check cannot get a
// token while the browser is online, and cleared as soon as one arrives.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const appCheck = vi.hoisted(() => ({
  getToken: vi.fn(),
  tokenListener: null as null | ((t: { token: string }) => void),
}));

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn(() => ({})),
  ReCaptchaV3Provider: vi.fn(),
  getToken: () => appCheck.getToken(),
  onTokenChanged: (_i: unknown, next: (t: { token: string }) => void) => {
    appCheck.tokenListener = next;
    return () => undefined;
  },
}));
vi.mock('firebase/app', () => ({
  getApps: () => [],
  getApp: vi.fn(),
  initializeApp: vi.fn(() => ({})),
}));
vi.mock('../config/env', () => ({
  firebaseConfig: {},
  webConfig: { recaptchaV3SiteKey: 'site-key' },
  hasUnfilledConfig: () => false,
  isPrerender: false,
}));

async function boot() {
  vi.resetModules();
  const firebase = await import('./index');
  const { AppCheckNotice } = await import('../components/AppCheckNotice');
  render(<AppCheckNotice />);
  await act(async () => {
    firebase.startFirebase();
    await Promise.resolve();
  });
  // Let the token probe settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return firebase;
}

const online = vi.spyOn(navigator, 'onLine', 'get');

beforeEach(() => {
  appCheck.getToken.mockReset();
  appCheck.tokenListener = null;
  online.mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.mocked(console.error).mockRestore();
});

describe('App Check notice', () => {
  it('stays hidden when a token is issued', async () => {
    appCheck.getToken.mockResolvedValue({ token: 't' });
    const firebase = await boot();
    expect(firebase.getAppCheckStatus()).toBe('ok');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('explains the blocked security check when no token can be had online', async () => {
    appCheck.getToken.mockRejectedValue(new Error('appCheck/recaptcha-error'));
    await boot();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your browser is blocking a security check',
    );
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeInTheDocument();
  });

  it('does not blame the security check while offline', async () => {
    online.mockReturnValue(false);
    appCheck.getToken.mockRejectedValue(new Error('appCheck/fetch-network-error'));
    const firebase = await boot();
    expect(firebase.getAppCheckStatus()).toBe('checking');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears itself once a token arrives', async () => {
    appCheck.getToken.mockRejectedValue(new Error('appCheck/recaptcha-error'));
    await boot();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => appCheck.tokenListener?.({ token: 'late' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
