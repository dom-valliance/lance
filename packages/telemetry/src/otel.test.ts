import { describe, expect, it } from 'vitest';
import { initTelemetry } from './otel.js';

// APPLICATIONINSIGHTS_CONNECTION_STRING is deliberately left unset: these
// tests must pass with no exporter configured and no network access.

describe('initTelemetry', () => {
  it('is idempotent: a second call returns the same handle', () => {
    const config = { serviceName: 'worker', serviceVersion: '1.0.0', environment: 'test' };

    const first = initTelemetry(config);
    const second = initTelemetry(config);

    expect(second).toBe(first);
  });

  it('shutdown resolves, after which a new call starts a fresh handle', async () => {
    const config = { serviceName: 'worker', serviceVersion: '1.0.0', environment: 'test' };
    const handle = initTelemetry(config);

    await expect(handle.shutdown()).resolves.toBeUndefined();

    const next = initTelemetry(config);
    expect(next).not.toBe(handle);

    await next.shutdown();
  });
});
