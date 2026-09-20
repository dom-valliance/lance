import { context, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { DestinationStream } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { withSpan } from './span.js';

interface CapturedLines {
  readonly destination: DestinationStream;
  readonly lines: () => Record<string, unknown>[];
}

function captureLines(): CapturedLines {
  const chunks: string[] = [];
  return {
    destination: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const originalNodeEnv = process.env.NODE_ENV;
const originalLogContent = process.env.LOG_CONTENT;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (originalLogContent === undefined) {
    delete process.env.LOG_CONTENT;
  } else {
    process.env.LOG_CONTENT = originalLogContent;
  }
});

describe('createLogger redaction', () => {
  it('redacts secret keys at info level', () => {
    const captured = captureLines();
    const logger = createLogger({ name: 'test', destination: captured.destination });

    logger.info({ password: 'sw0rdfish', ok: true }, 'login attempt');

    const [line] = captured.lines();
    expect(line?.password).toBe('[redacted]');
    expect(line?.ok).toBe(true);
  });

  it('redacts nested secret keys', () => {
    const captured = captureLines();
    const logger = createLogger({ name: 'test', destination: captured.destination });

    logger.info(
      { request: { headers: { authorization: 'Bearer xyz' }, apiKey: 'k1' } },
      'outbound call',
    );

    const [line] = captured.lines();
    const request = line?.request as Record<string, unknown>;
    const headers = request.headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[redacted]');
    expect(request.apiKey).toBe('[redacted]');
  });

  it('redacts every listed secret key', () => {
    const captured = captureLines();
    const logger = createLogger({ name: 'test', destination: captured.destination });

    logger.info(
      {
        authorization: 'a',
        cookie: 'b',
        password: 'c',
        token: 'd',
        apiKey: 'e',
        api_key: 'f',
        secret: 'g',
        refreshToken: 'h',
        refresh_token: 'i',
      },
      'secrets everywhere',
    );

    const [line] = captured.lines();
    for (const key of [
      'authorization',
      'cookie',
      'password',
      'token',
      'apiKey',
      'api_key',
      'secret',
      'refreshToken',
      'refresh_token',
    ]) {
      expect(line?.[key]).toBe('[redacted]');
    }
  });

  it('removes content keys by default', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.LOG_CONTENT;
    const captured = captureLines();
    const logger = createLogger({ name: 'test', destination: captured.destination });

    logger.info({ body: 'the full mail body', transcript: 'meeting text' }, 'ingested');

    const [line] = captured.lines();
    expect(line).not.toHaveProperty('body');
    expect(line).not.toHaveProperty('transcript');
  });

  it('keeps content keys when LOG_CONTENT=true in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.LOG_CONTENT = 'true';
    const captured = captureLines();
    const logger = createLogger({ name: 'test', destination: captured.destination });

    logger.info({ preview: 'first line of the mail' }, 'ingested');

    const [line] = captured.lines();
    expect(line?.preview).toBe('first line of the mail');
  });

  it('removes content keys when LOG_CONTENT=true in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_CONTENT = 'true';
    const captured = captureLines();
    const logger = createLogger({ name: 'test', destination: captured.destination });

    logger.info({ content: 'raw content' }, 'ingested');

    const [line] = captured.lines();
    expect(line).not.toHaveProperty('content');
  });
});

describe('createLogger trace correlation', () => {
  const exporter = new InMemorySpanExporter();
  const contextManager = new AsyncHooksContextManager();

  beforeAll(() => {
    // See the equivalent note in span.test.ts: without a registered context
    // manager, the mixin's `trace.getActiveSpan()` call never sees a span.
    contextManager.enable();
    context.setGlobalContextManager(contextManager);

    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(() => {
    trace.disable();
    context.disable();
  });

  it('has no trace ids outside a span', () => {
    const captured = captureLines();
    const logger = createLogger({ name: 'test', destination: captured.destination });

    logger.info('no span here');

    const [line] = captured.lines();
    expect(line).not.toHaveProperty('trace_id');
    expect(line).not.toHaveProperty('span_id');
  });

  it('adds trace ids inside a span', async () => {
    const captured = captureLines();
    const logger = createLogger({ name: 'test', destination: captured.destination });

    await withSpan('watcher.poll', {}, () => {
      logger.info('inside a span');
    });

    const [line] = captured.lines();
    expect(line?.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(line?.span_id).toMatch(/^[0-9a-f]{16}$/);
  });
});
