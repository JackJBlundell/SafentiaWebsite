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

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** When this changes (the shell passes the current pathname), an errored
   *  boundary resets itself - navigating away is recovery. */
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidMount(): void {
    // Attach the window-level handlers once, so an uncaught error or unhandled
    // rejection OUTSIDE React's render (which no boundary can catch) is reported
    // too. Idempotent: mounting several boundaries installs them a single time.
    initGlobalErrorReporting();
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
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
    this.setState({ hasError: false });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
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
