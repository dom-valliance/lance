import { context, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineConnector, type CallRecord } from './connector.js';
import { CircuitOpenError, ConnectorError } from './errors.js';
import { FakeClock } from './testing.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncHooksContextManager();

beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  contextManager.disable();
});

beforeEach(() => exporter.reset());

const policy = {
  rateLimit: { capacity: 10, refillPerSecond: 10, maxWaitMs: 1000 },
  retry: { attempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
  breaker: { failureThreshold: 3, halfOpenAfterMs: 1000 },
};

const failure = (status: number): ConnectorError =>
  new ConnectorError(`HTTP ${status}`, {
    connector: 'notion',
    operation: 'x',
    status,
    retryable: true,
  });

describe('defineConnector', () => {
  it('runs a read, records the span attributes and the call record', async () => {
    const calls: CallRecord[] = [];
    const connector = defineConnector({
      name: 'graph',
      policy,
      clock: new FakeClock(),
      events: { onCall: (record) => void calls.push(record) },
    });
    const value = await connector.read(
      'listMessages',
      { correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', request: { folder: 'inbox' } },
      () => Promise.resolve(['m1']),
    );
    expect(value).toEqual(['m1']);
    const span = exporter.getFinishedSpans()[0];
    expect(span?.name).toBe('graph.listMessages');
    expect(span?.attributes['lance.connector']).toBe('graph');
    expect(span?.attributes['lance.correlation_id']).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(typeof span?.attributes['lance.request_hash']).toBe('string');
    expect(span?.attributes['lance.attempts']).toBe(1);
    expect(calls).toEqual([
      expect.objectContaining({
        connector: 'graph',
        operation: 'listMessages',
        kind: 'read',
        ok: true,
        attempts: 1,
      }),
    ]);
  });

  it('retries a retryable failure on an idempotent write and reports the attempts', async () => {
    const connector = defineConnector({ name: 'notion', policy, clock: new FakeClock() });
    const fn = vi.fn().mockRejectedValueOnce(failure(503)).mockResolvedValueOnce('done');
    await expect(connector.write('updatePage', {}, fn, { idempotent: true })).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(exporter.getFinishedSpans()[0]?.attributes['lance.call_kind']).toBe('write');
  });

  it('attempts a write that is not idempotent once when the remote may have committed', async () => {
    const connector = defineConnector({ name: 'notion', policy, clock: new FakeClock() });
    const fn = vi.fn().mockRejectedValueOnce(failure(503)).mockResolvedValueOnce('done');
    await expect(connector.write('createPage', {}, fn)).rejects.toThrow('HTTP 503');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a write that is not idempotent when the remote answers 429', async () => {
    const connector = defineConnector({ name: 'notion', policy, clock: new FakeClock() });
    const fn = vi.fn().mockRejectedValueOnce(failure(429)).mockResolvedValueOnce('done');
    await expect(connector.write('createPage', {}, fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a read that is not marked either way, since a read commits nothing', async () => {
    const connector = defineConnector({ name: 'notion', policy, clock: new FakeClock() });
    const fn = vi.fn().mockRejectedValueOnce(failure(503)).mockResolvedValueOnce('done');
    await expect(connector.read('getPage', {}, fn)).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('opens the breaker after repeated failures and refuses the next call', async () => {
    const onOpen = vi.fn();
    const calls: CallRecord[] = [];
    const connector = defineConnector({
      name: 'jamie',
      policy: { ...policy, retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } },
      clock: new FakeClock(),
      events: { onOpen, onCall: (record) => void calls.push(record) },
    });
    const failing = () =>
      Promise.reject(
        new ConnectorError('HTTP 500', {
          connector: 'jamie',
          operation: 'x',
          status: 500,
          retryable: true,
        }),
      );
    for (let i = 0; i < 3; i += 1) {
      await expect(connector.read('listMeetings', {}, failing)).rejects.toThrow('HTTP 500');
    }
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(connector.breakerState()).toBe('open');
    const untouched = vi.fn();
    await expect(connector.read('listMeetings', {}, untouched)).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(untouched).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({ ok: false, status: undefined });
    expect(calls[0]).toMatchObject({ ok: false, status: 500 });
  });

  it('marks the span as an error with the status when a call fails', async () => {
    const connector = defineConnector({ name: 'slack', policy, clock: new FakeClock() });
    await expect(
      connector.read('history', {}, () =>
        Promise.reject(
          new ConnectorError('HTTP 404', {
            connector: 'slack',
            operation: 'x',
            status: 404,
            retryable: false,
          }),
        ),
      ),
    ).rejects.toThrow('HTTP 404');
    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes['http.response.status_code']).toBe(404);
    expect(span?.status.code).toBe(2);
  });
});
