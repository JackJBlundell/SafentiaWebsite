// ============================================================================
// Structured logging (brief 18.6).
//
// Cloud Logging ingests stdout JSON and promotes a top-level `severity` field to
// the log level, so we emit a single JSON line per event with a consistent shape.
// A correlation id threads every line of one Function invocation together, which
// is what makes a multi-write flow diagnosable after the fact without reproducing
// it (brief 18.6 "correlation where a flow spans calls").
//
// PII discipline (brief 18.4 / 18.6): callers pass a `context` object, but this
// module strips anything that looks like an email, token or raw secret before it
// is written, so a careless caller cannot leak personal data into the logs. The
// allow-list approach (only known-safe keys) would be stricter, but a fire-safety
// audit trail benefits from arbitrary diagnostic context, so we scrub instead.
// ============================================================================

type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

/** Arbitrary structured context attached to a log line. Values are scrubbed. */
export type LogContext = Record<string, unknown>;

/** Keys whose values must never be written verbatim - they carry PII or secrets. */
const SENSITIVE_KEY = /(email|token|password|secret|authorization|apikey|api_key|phone)/i;

/** Matches a bare email address so it can be redacted even inside a string value. */
const EMAIL_IN_VALUE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * Recursively redact sensitive content. Sensitive keys are dropped to `[redacted]`
 * entirely; string values anywhere have embedded emails masked. Depth is bounded
 * so a pathological cyclic-ish object cannot stall a log call.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[truncated]';
  }
  if (typeof value === 'string') {
    return value.replace(EMAIL_IN_VALUE, '[redacted-email]');
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(severity: Severity, message: string, context?: LogContext): void {
  const line = {
    severity,
    message,
    time: new Date().toISOString(),
    ...(context ? { context: scrub(context) } : {}),
  };
  // Single JSON line so Cloud Logging parses it as a structured entry. WARNING
  // and ERROR go to stderr so they surface as such in the emulator console too.
  const serialised = JSON.stringify(line);
  if (severity === 'ERROR' || severity === 'WARNING') {
    process.stderr.write(serialised + '\n');
  } else {
    process.stdout.write(serialised + '\n');
  }
}

/**
 * A logger bound to one correlation id. Create one per Function invocation with
 * `createLogger()` so every line of that call shares the id.
 */
export interface Logger {
  correlationId: string;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Derive a child that keeps the same correlation id and adds fixed context. */
  child(base: LogContext): Logger;
}

function buildLogger(correlationId: string, base: LogContext): Logger {
  const withBase = (context?: LogContext): LogContext => ({
    correlationId,
    ...base,
    ...(context ?? {}),
  });
  return {
    correlationId,
    debug: (m, c) => emit('DEBUG', m, withBase(c)),
    info: (m, c) => emit('INFO', m, withBase(c)),
    warn: (m, c) => emit('WARNING', m, withBase(c)),
    error: (m, c) => emit('ERROR', m, withBase(c)),
    child: (extra) => buildLogger(correlationId, { ...base, ...extra }),
  };
}

/**
 * Create a request-scoped logger. The correlation id is random per call (we do
 * not use the App Check / auth token as the id, since that is sensitive); it only
 * needs to be unique enough to group one invocation's lines.
 */
export function createLogger(base: LogContext = {}): Logger {
  const correlationId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return buildLogger(correlationId, base);
}
