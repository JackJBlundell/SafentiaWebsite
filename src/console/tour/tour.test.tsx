// ============================================================================
// Guided tour tests.
//
// The storage seam (tourStorage) and the auth context are mocked at the module
// boundary, so the tests drive the trigger and the overlay directly: which
// script the breakpoint selects, that absent targets are skipped silently,
// that Escape closes AND records the run, and that the Getting Started replay
// event starts a run the done flag would otherwise suppress. jsdom has no
// layout, so getBoundingClientRect, matchMedia and ResizeObserver are stubbed.
// ============================================================================

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ConsoleTourMount } from './ConsoleTour';
import { START_TOUR_EVENT } from './useTourTrigger';
import { DESKTOP_MEDIA_QUERY } from './tourSteps';
import type { TourDone } from './tourStorage';

// --- module mocks -----------------------------------------------------------

const mocks = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<TourDone | null> => null),
  markDone: vi.fn(async (): Promise<void> => {}),
}));

vi.mock('./tourStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tourStorage')>();
  return {
    ...actual,
    createTourStorage: () => ({ read: mocks.read, markDone: mocks.markDone }),
  };
});

// The trigger needs only the uid; the tour itself reads no auth at all.
vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-1' } }),
}));

// --- jsdom stubs ------------------------------------------------------------

function stubMatchMedia(desktop: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: query === DESKTOP_MEDIA_QUERY ? desktop : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const originalGetRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  // jsdom lays nothing out; a fixed plausible box exercises the geometry maths.
  Element.prototype.getBoundingClientRect = () =>
    ({
      top: 10,
      left: 10,
      width: 120,
      height: 40,
      right: 130,
      bottom: 50,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    }) as DOMRect;
  stubMatchMedia(true);
  mocks.read.mockResolvedValue(null);
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetRect;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  // The setup-celebration flag is session-scoped; never let it leak between tests.
  window.sessionStorage.clear();
});

// --- harness ----------------------------------------------------------------

/** Stand-in chrome carrying the same data-tour anchors ConsoleShell sets.
 *  `admin: false` omits the role-gated items, as a member's shell would.
 *  `suppressAutoStart` mirrors the shell's item-18b decision (a super admin in
 *  a tenant org). */
function Harness({
  admin = true,
  suppressAutoStart = false,
}: {
  admin?: boolean;
  suppressAutoStart?: boolean;
}) {
  return (
    <div>
      <a href="/app" data-tour="nav-home">
        Home
      </a>
      <a href="/app/customers" data-tour="nav-customers">
        Customers
      </a>
      <a href="/app/jobs" data-tour="nav-jobs">
        Jobs
      </a>
      {admin && (
        <>
          <a href="/app/validation" data-tour="nav-validation">
            Validation
          </a>
          <a href="/app/templates" data-tour="nav-templates">
            Templates
          </a>
        </>
      )}
      <div data-tour="search" />
      <div data-tour="actions" />
      <ConsoleTourMount suppressAutoStart={suppressAutoStart} />
    </div>
  );
}

/** Replay contract: exactly the event the Getting Started card dispatches. */
function startTour() {
  act(() => {
    window.dispatchEvent(new CustomEvent(START_TOUR_EVENT));
  });
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));

// --- tests ------------------------------------------------------------------

describe('ConsoleTour', () => {
  it('selects the desktop script at the rail breakpoint', () => {
    stubMatchMedia(true);
    render(<Harness />);
    startTour();
    expect(
      screen.getByRole('heading', { name: 'Welcome to your console' }),
    ).toBeInTheDocument();
    next();
    expect(screen.getByText(/rail on the left/)).toBeInTheDocument();
  });

  it('selects the mobile script below the breakpoint', () => {
    stubMatchMedia(false);
    render(<Harness />);
    startTour();
    next();
    expect(screen.getByText(/bar along the top/)).toBeInTheDocument();
  });

  it('silently skips steps whose target is absent', () => {
    render(<Harness admin={false} />);
    startTour();
    // Nine scripted steps minus validation and templates = seven shown.
    expect(screen.getByText('Step 1 of 7')).toBeInTheDocument();
    for (let i = 0; i < 6; i += 1) {
      expect(
        screen.queryByRole('heading', { name: 'Templates' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Validation' }),
      ).not.toBeInTheDocument();
      next();
    }
    // The walk ends on the closing step without ever meeting the gated ones.
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('closes on Escape and records the run for the current device class', () => {
    render(<Harness />);
    startTour();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.markDone).toHaveBeenCalledWith('desktop');
  });

  it('completing the tour records the run too', () => {
    render(<Harness admin={false} />);
    startTour();
    for (let i = 0; i < 6; i += 1) {
      next();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.markDone).toHaveBeenCalledWith('desktop');
  });

  it('starts by itself on first run, but not once the class is done', async () => {
    vi.useFakeTimers();
    mocks.read.mockResolvedValue({ desktop: true });
    render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    // The desktop flag is set, so the settle-delay path stays quiet...
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // ...while the replay event starts a run regardless of the flag.
    startTour();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('starts by itself when the device class has not seen the tour', async () => {
    vi.useFakeTimers();
    mocks.read.mockResolvedValue({ mobile: true });
    render(<Harness />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Welcome to your console' }),
    ).toBeInTheDocument();
  });

  it('does not auto-start on a setup-celebration arrival, but replay still does', async () => {
    vi.useFakeTimers();
    // The flag SetupCompleteScreen's CTA sets; the checklist's expand takes the
    // welcome instead, so the auto-tour stands down for this landing (item 11).
    window.sessionStorage.setItem('safentia.arrivedFromSetup', '1');
    render(<Harness />);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The flag never records the class as done, and replay is untouched.
    expect(mocks.markDone).not.toHaveBeenCalled();
    startTour();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not auto-start when suppressAutoStart is set (super admin in a tenant org), but replay still does', async () => {
    vi.useFakeTimers();
    render(<Harness suppressAutoStart />);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    // Item 18b: an operator inside a customer workspace already knows the
    // console, so the org auto-tour holds - without marking the class done.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mocks.markDone).not.toHaveBeenCalled();
    startTour();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
