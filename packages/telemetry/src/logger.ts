import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

const REDACTED = '[redacted]';

/** Keys whose values are always replaced with REDACTED, at any depth. */
// Matched case-insensitively: keys are lower-cased before lookup.
const SECRET_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'token',
  'apikey',
  'api_key',
  'secret',
  'refreshtoken',
  'refresh_token',
]);

/**
 * Keys carrying mail or transcript content. Removed at any depth unless
 * `LOG_CONTENT=true` outside production; spec section 13 requires no raw
 * mail or transcript content at `info` level and content only in
 * non-production debugging.
 */
const CONTENT_KEYS = new Set(['body', 'content', 'transcript', 'text', 'preview']);

function contentAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.LOG_CONTENT === 'true';
}

function redactValue(value: unknown, allowContent: boolean, seen: Set<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, allowContent, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      return '[circular]';
    }
    seen.add(value);
    return redactObject(value as Record<string, unknown>, allowContent, seen);
  }
  return value;
}

function redactObject(
  input: Record<string, unknown>,
  allowContent: boolean,
  seen: Set<object>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const lowerKey = key.toLowerCase();
    if (SECRET_KEYS.has(lowerKey)) {
      output[key] = REDACTED;
      continue;
    }
    if (CONTENT_KEYS.has(lowerKey)) {
      if (allowContent) {
        output[key] = redactValue(value, allowContent, seen);
      }
      continue;
    }
    output[key] = redactValue(value, allowContent, seen);
  }
  return output;
}

/**
 * Redacts secret-shaped keys and, outside non-production debugging, content
 * keys, at every level of nesting. Used as pino's `formatters.log` hook
 * rather than pino's built-in `redact` option, because `redact` matches
 * fixed, statically declared paths and cannot express "this key, wherever it
 * appears".
 */
function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactObject(object, contentAllowed(), new Set());
}

export interface LoggerConfig {
  readonly name: string;
  readonly level?: string;
  /**
   * Where log lines are written. Defaults to stdout. Tests pass an
   * in-memory `DestinationStream` here to capture what pino would
   * otherwise write directly to the stdout file descriptor.
   */
  readonly destination?: DestinationStream;
}

/**
 * Creates a pino logger writing plain JSON lines to stdout. Level defaults
 * to `LOG_LEVEL`, then `info`. Every log line carries `trace_id` and
 * `span_id` when called from inside an active span.
 */
export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    name: config.name,
    level: config.level ?? process.env.LOG_LEVEL ?? 'info',
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) {
        return {};
      }
      const spanContext = span.spanContext();
      return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
    },
    formatters: {
      log: redactLogObject,
    },
  };
  return config.destination ? pino(options, config.destination) : pino(options);
}
