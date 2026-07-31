// ============================================================================
// ErrorBoundary - the console's page-level crash barrier.
//
// Wrapped around the routed page area only (see ConsoleShell), never the
// chrome: a render crash in one screen must not take down the rail, the org
// switcher or the account menu, because those are exactly how the user
// escapes the broken page. React only exposes componentDidCatch on class
// components, so this is the console's one class component.
//
// Recovery is twofold: "Try again" re-renders the same tree (transient faults
// on live data often pass on a second attempt), and any navigation resets the
// boundary via `resetKey`, so a crash on one page can never follow the user
// to the next.
// ============================================================================

import React from 'react';
import { Button } from '../../components/Button';
import {
  initGlobalErrorReporting,
  reportClientError,
} from '../lib/reportClientError';
import { Card } from './Card';
import styles from './ErrorBoundary.module.css';

/** Stable prefix on every crash log, so support can grep a console dump. */
const LOG_PREFIX = '[Safentia console] Page render failed:';

/**
 * A page chunk that could not be fetched, because the deploy it belongs to has
 * been replaced.
 *
 * Not a crash: the console is code-split per page, and every build gives its
 * chunks new content-hashed filenames. A user holding an open tab across a
 * deploy still has the OLD index in memory, so the next page they navigate to
 * asks for a filename the server no longer has. It happens on every deploy, to
 * every user who has not reloaded, and it is entirely self-healing - but only
 * by fetching the page again.
 *
 * Which is why it needs telling apart from a real crash. The generic recovery
 * offers "Try again", which re-runs the same failed import and fails the same
 * way, and "Go to dashboard", whose chunk is just as stale. Neither can work.
 *
 * Matched on the message because that is all the platform gives us: browsers
 * disagree on the wording (Chrome "Failed to fetch dynamically imported
 * module", Safari "Importing a module script failed", Firefox "error loading
 * dynamically imported module") and none of them use a distinguishable type.
 */
function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i.test(
    message,
  );
}

/** One automatic reload per session, so a chunk that is genuinely missing -
 *  a broken deploy, an offline device - cannot put the tab in a reload loop.
 *  The second occurrence falls through to the message and its button. */
const RELOAD_MARKER = 'safentia:stale-chunk-reloaded';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** When this changes (the shell passes the current pathname), an errored
   *  boundary resets itself - navigating away is recovery. */
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  /** The page is simply out of date, not broken - see isStaleChunkError. */
  staleChunk: boolean;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, staleChunk: false };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, staleChunk: isStaleChunkError(error) };
  }

  componentDidMount(): void {
    // Attach the window-level handlers once, so an uncaught error or unhandled
    // rejection OUTSIDE React's render (which no boundary can catch) is reported
    // too. Idempotent: mounting several boundaries installs them a single time.
    initGlobalErrorReporting();
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (isStaleChunkError(error)) {
      // Not a crash and not worth reporting as one - it is the expected
      // consequence of a deploy. Reload once to pick up the new index, and only
      // once: a chunk that is genuinely gone must land on the message below
      // rather than reloading forever.
      const reloadedAlready =
        typeof sessionStorage !== 'undefined' &&
        sessionStorage.getItem(RELOAD_MARKER) === '1';
      if (!reloadedAlready && typeof window !== 'undefined') {
        try {
          sessionStorage.setItem(RELOAD_MARKER, '1');
        } catch {
          // Private mode or a full quota: skip the marker and the guard with
          // it, and show the message instead of risking an unguarded loop.
          return;
        }
        window.location.reload();
      }
      return;
    }

    console.error(LOG_PREFIX, error, info.componentStack);
    // Best-effort telemetry: forward the crash so it is diagnosable after the
    // fact. reportClientError never throws, so this cannot deepen the failure.
    reportClientError({
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
      path:
        typeof window !== 'undefined' ? window.location.pathname : undefined,
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  private readonly reset = (): void => {
    this.setState({ hasError: false, staleChunk: false });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    // The page is out of date rather than broken, and the automatic reload
    // above did not run (or already had this session). Say what actually
    // happened - "something went wrong" would send someone to support over a
    // routine deploy - and offer the ONE action that fixes it.
    if (this.state.staleChunk) {
      return (
        <Card>
          <div className={styles.fallback} role="alert">
            <h1 className={styles.heading}>A newer version is available</h1>
            <p className={styles.copy}>
              This page was updated while your tab was open, so part of it could
              not be loaded. Reloading picks up the new version. Nothing has been
              lost.
            </p>
            <div className={styles.actions}>
              <Button onClick={() => window.location.reload()}>
                Reload the page
              </Button>
            </div>
          </div>
        </Card>
      );
    }

    return (
      <Card>
        <div className={styles.fallback} role="alert">
          <h1 className={styles.heading}>Something went wrong on this page</h1>
          <p className={styles.copy}>
            The rest of the console is unaffected. Try the page again, or head
            back to the dashboard.
          </p>
          <div className={styles.actions}>
            <Button onClick={this.reset}>Try again</Button>
            <Button variant="secondary" to="/app">
              Go to dashboard
            </Button>
          </div>
        </div>
      </Card>
    );
  }
}
