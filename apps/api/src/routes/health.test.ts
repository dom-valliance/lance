import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { fakeDeps, fakeSystemState, type FakeDeps } from '../test-fakes.js';

let harness: FakeDeps;
let server: FastifyInstance;

beforeEach(() => {
  harness = fakeDeps();
  server = buildServer(harness.deps);
});

afterEach(async () => {
  await server.close();
});

describe('GET /health/live', () => {
  it('answers without reading the database', async () => {
    harness.control.readFails = true;

    const response = await server.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe('GET /health/ready', () => {
  it('reports the paused flag and mode from system_state', async () => {
    harness.control.state = fakeSystemState({ paused: true, mode: 'live' });

    const response = await server.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, paused: true, mode: 'live' });
  });

  it('answers 503 when system_state cannot be read', async () => {
    harness.control.readFails = true;

    const response = await server.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ ok: boolean }>().ok).toBe(false);
  });
});
