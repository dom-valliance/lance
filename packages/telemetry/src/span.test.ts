import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ATTR_AGENT,
  ATTR_CORRELATION_ID,
  ATTR_PRINCIPAL,
  currentTraceIds,
  PrincipalSpanProcessor,
  withPrincipal,
  withSpan,
} from './span.js';

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncHooksContextManager();

// A context manager must be registered explicitly here: in production
// NodeSDK (see otel.ts) sets one up, but a test wiring its own
// BasicTracerProvider has no SDK to do that, and without one
// `trace.getActiveSpan()` cannot see the span `startActiveSpan` set active.
beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
});

afterAll(() => {
  trace.disable();
  context.disable();
});

describe('withSpan', () => {
  it('sets the given attributes on the span', async () => {
    await withSpan(
      'triage.run',
      { [ATTR_CORRELATION_ID]: 'corr-1', [ATTR_AGENT]: 'triage' },
      () => undefined,
    );

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('triage.run');
    expect(span?.attributes[ATTR_CORRELATION_ID]).toBe('corr-1');
    expect(span?.attributes[ATTR_AGENT]).toBe('triage');
  });

  it('passes the return value of fn through unchanged', async () => {
    const result = await withSpan('planner.run', {}, () => 42);

    expect(result).toBe(42);
  });

  it('passes through an awaited async return value', async () => {
    const result = await withSpan('planner.run', {}, () => Promise.resolve('done'));

    expect(result).toBe('done');
  });

  it('records the exception and sets an error status when fn throws', async () => {
    const failure = new Error('boom');

    await expect(
      withSpan('executor.run', {}, () => {
        throw failure;
      }),
    ).rejects.toThrow(failure);

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('boom');
    expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
  });

  it('ends the span even when fn throws', async () => {
    await expect(
      withSpan('executor.run', {}, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow();

    const [span] = exporter.getFinishedSpans();
    expect(span?.endTime).toBeDefined();
  });
});

describe('currentTraceIds', () => {
  it('is empty outside a span', () => {
    expect(currentTraceIds()).toEqual({});
  });

  it('is populated inside a span', async () => {
    const ids = await withSpan('ontology.lookup', {}, () => currentTraceIds());

    expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('withPrincipal', () => {
  it('stamps the principal on its own span and on every withSpan beneath it', async () => {
    await withPrincipal(
      '01K5S9V6QW3SWCCPVB0N0E3T01',
      'job.triage',
      { 'lance.queue': 'triage' },
      () => withSpan('agent.triage', { [ATTR_AGENT]: 'triage@1' }, () => undefined),
    );

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => [span.name, span.attributes[ATTR_PRINCIPAL]])).toEqual([
      ['agent.triage', '01K5S9V6QW3SWCCPVB0N0E3T01'],
      ['job.triage', '01K5S9V6QW3SWCCPVB0N0E3T01'],
    ]);
  });

  it('leaves a span outside any principal unstamped', async () => {
    await withSpan('planner.run', {}, () => undefined);

    expect(exporter.getFinishedSpans()[0]?.attributes[ATTR_PRINCIPAL]).toBeUndefined();
  });

  it('stamps spans an instrumentation opens beneath it through the span processor', async () => {
    const processor = new PrincipalSpanProcessor();
    const tracer = trace.getTracer('instrumentation-under-test');

    await withPrincipal('01K5S9V6QW3SWCCPVB0N0E3T02', 'job.execute', {}, () => {
      const span = tracer.startSpan('pg.query');
      processor.onStart(span, context.active());
      span.end();
    });

    const pg = exporter.getFinishedSpans().find((span) => span.name === 'pg.query');
    expect(pg?.attributes[ATTR_PRINCIPAL]).toBe('01K5S9V6QW3SWCCPVB0N0E3T02');
  });
});
