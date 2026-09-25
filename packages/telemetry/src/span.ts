import { context, createContextKey, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Context, Span } from '@opentelemetry/api';

/** Correlation id carried through watchers, planner, critic and executor. */
export const ATTR_CORRELATION_ID = 'lance.correlation_id';
/** Identifier of the proposal a span acted on or produced. */
export const ATTR_PROPOSAL_ID = 'lance.proposal_id';
/** Name of the model-backed agent running the span (triage, planner, critic). */
export const ATTR_AGENT = 'lance.agent';
/** Connector a span read from or, via the executor, wrote to. */
export const ATTR_CONNECTOR = 'lance.connector';
/** Hash of the request payload, for provenance without logging content. */
export const ATTR_REQUEST_HASH = 'lance.request_hash';
/**
 * The principal a span ran for (ADR 0015). The agent-logs watcher reads
 * each principal's telemetry back by it, so one principal's failures
 * never reach another's ledger.
 */
export const ATTR_PRINCIPAL = 'lance.principal';

const PRINCIPAL_KEY = createContextKey(ATTR_PRINCIPAL);

/** The principal the given context, or the active one, runs for; undefined outside `withPrincipal`. */
export function principalOf(ctx: Context = context.active()): string | undefined {
  const value = ctx.getValue(PRINCIPAL_KEY);
  return typeof value === 'string' ? value : undefined;
}

const tracer = trace.getTracer('@lance/telemetry');

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs `fn` inside a new span named `name`, with `attributes` set before
 * `fn` starts. An exception thrown by `fn` is recorded on the span, the
 * span status is set to error, and the exception is rethrown. The span is
 * always ended, and `fn`'s return value passes through unchanged.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const principal = principalOf();
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
    if (principal !== undefined && attributes[ATTR_PRINCIPAL] === undefined) {
      span.setAttribute(ATTR_PRINCIPAL, principal);
    }
    try {
      return await fn(span);
    } catch (error) {
      const asError = toError(error);
      span.recordException(asError);
      span.setStatus({ code: SpanStatusCode.ERROR, message: asError.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Runs `fn` for one principal: inside a span named `name` carrying
 * `lance.principal`, with the principal set on the context so every span
 * opened beneath it, by `withSpan` or by an instrumentation through
 * `PrincipalSpanProcessor`, carries it too.
 */
export async function withPrincipal<T>(
  principalId: string,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return context.with(context.active().setValue(PRINCIPAL_KEY, principalId), () =>
    withSpan(name, { ...attributes, [ATTR_PRINCIPAL]: principalId }, fn),
  );
}

/**
 * Stamps `lance.principal` on every span started inside `withPrincipal`,
 * including the HTTP and Postgres spans the instrumentations open, which
 * `withSpan` never sees. Registered by `initTelemetry`.
 */
export class PrincipalSpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const principal = principalOf(parentContext);
    if (principal !== undefined) span.setAttribute(ATTR_PRINCIPAL, principal);
  }

  onEnd(): void {
    // Nothing to do once a span ends.
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Trace and span id of the currently active span, or empty outside one. */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (!span) {
    return {};
  }
  const spanContext = span.spanContext();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
