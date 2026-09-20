import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes, Span } from '@opentelemetry/api';

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
  return tracer.startActiveSpan(name, async (span) => {
    span.setAttributes(attributes);
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

/** Trace and span id of the currently active span, or empty outside one. */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (!span) {
    return {};
  }
  const spanContext = span.spanContext();
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
