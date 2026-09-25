import { ModeChangeRefusedError } from '@lance/ledger';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { fakeDeps, fakeSnapshot, type FakeDeps } from '../test-fakes.js';

const BEARER = { authorization: 'Bearer good-token' };

let harness: FakeDeps;
let server: FastifyInstance;

beforeEach(() => {
  harness = fakeDeps();
  server = buildServer(harness.server);
});

afterEach(async () => {
  await server.close();
});

describe('the Entra guard on /admin', () => {
  it('answers 401 when no Authorization header is sent', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/pause',
      payload: { reason: 'deploying' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toContain('No Authorization header');
    expect(harness.control.pauseCalls).toEqual([]);
  });

  it('answers 401 when the header is not a bearer token', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/resume',
      headers: { authorization: 'Basic ZG9tOnNlY3JldA==' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toContain('not a bearer token');
  });

  it('answers 401 when the token does not verify', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: 'Bearer a-forged-token' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /admin/pause', () => {
  it('pauses as user:dom and mirrors the PauseResult', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/pause',
      headers: BEARER,
      payload: { reason: 'rotating the Graph refresh token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      changed: true,
      heldProposalIds: ['01K5S9V6QW3SWCCPVB0N0E301A'],
      eventId: '01K5S9V6QW3SWCCPVB0N0E30E1',
    });
    expect(harness.control.pauseCalls).toEqual([
      { reason: 'rotating the Graph refresh token', actor: 'user:dom' },
    ]);
  });

  it('answers 400 when no reason is supplied', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/pause',
      headers: BEARER,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(harness.control.pauseCalls).toEqual([]);
  });
});

describe('POST /admin/resume', () => {
  it('resumes as user:dom and mirrors the ResumeResult', async () => {
    harness.control.state = { ...harness.control.state, paused: true };

    const response = await server.inject({
      method: 'POST',
      url: '/admin/resume',
      headers: BEARER,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      changed: true,
      releasedProposalIds: ['01K5S9V6QW3SWCCPVB0N0E301A'],
      eventId: '01K5S9V6QW3SWCCPVB0N0E30E2',
    });
    expect(harness.control.resumeCalls).toEqual([{ actor: 'user:dom' }]);
  });

  it('re-queues every proposal the resume released', async () => {
    harness.control.state = { ...harness.control.state, paused: true };

    await server.inject({ method: 'POST', url: '/admin/resume', headers: BEARER });

    expect(harness.enqueued).toEqual(['01K5S9V6QW3SWCCPVB0N0E301A']);
  });
});

describe('POST /admin/mode', () => {
  it('switches to live as user:dom and reports the change', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/mode',
      headers: BEARER,
      payload: { mode: 'live' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ changed: true });
    expect(harness.control.modeCalls).toEqual([{ mode: 'live', actor: 'user:dom' }]);
  });

  it("answers 409 with the date live opens inside a new principal's dry run", async () => {
    harness.control.refuseLive = new ModeChangeRefusedError(
      'Live mode opens on Monday 5 October 2026.',
      new Date('2026-10-04T23:00:00.000Z'),
    );
    const response = await server.inject({
      method: 'POST',
      url: '/admin/mode',
      headers: BEARER,
      payload: { mode: 'live' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe(
      'Live mode opens on Monday 5 October 2026.',
    );
  });

  it('rejects a mode that does not exist', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/mode',
      headers: BEARER,
      payload: { mode: 'shadow' },
    });

    expect(response.statusCode).toBe(400);
    expect(harness.control.modeCalls).toEqual([]);
  });
});

describe('GET /admin/status', () => {
  it('returns the status snapshot', async () => {
    harness.status.current = fakeSnapshot({ costTodayGbp: 3.5 });

    const response = await server.inject({
      method: 'GET',
      url: '/admin/status',
      headers: BEARER,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ costTodayGbp: number }>().costTodayGbp).toBe(3.5);
  });
});

describe('the Entra guard on /trpc', () => {
  it('answers 401 without a bearer token', async () => {
    const response = await server.inject({ method: 'GET', url: '/trpc/systemState.get' });

    expect(response.statusCode).toBe(401);
  });

  it('answers a systemState.get query with a bearer token', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/trpc/systemState.get',
      headers: BEARER,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ result: { data: { mode: string } } }>().result.data.mode).toBe(
      'dry_run',
    );
  });

  it('passes the ledger query filters through to the reader', async () => {
    const input = encodeURIComponent(JSON.stringify({ kind: 'state_changed', limit: 5 }));
    const response = await server.inject({
      method: 'GET',
      url: `/trpc/ledger.query?input=${input}`,
      headers: BEARER,
    });

    expect(response.statusCode).toBe(200);
    expect(harness.ledger.queries).toEqual([{ kind: 'state_changed', limit: 5 }]);
  });
});
