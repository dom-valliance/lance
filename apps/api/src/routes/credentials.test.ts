import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JamieKeyDeps } from '../deps.js';
import { buildServer } from '../server.js';
import {
  fakeDeps,
  fakeIdentity,
  fakeVerifier,
  TEST_PRINCIPAL_ID,
  type FakeDeps,
} from '../test-fakes.js';

/**
 * `POST /credentials/jamie` (ADR 0022). The key travels from the request
 * body to a test call and then to Key Vault. Every case reads back the
 * whole server log, captured at trace level with the production redaction,
 * and the console, and proves the key is in neither.
 */

const KEY = 'jk_live_a-very-secret-jamie-key-0001';
const BEARER = { authorization: 'Bearer good-token' };

class FakeJamieKeys implements JamieKeyDeps {
  accepts = true;
  readonly checked: string[] = [];
  readonly stored: { principalId: string; apiKey: string }[] = [];
  /** The ledger changes recorded when each store happened. */
  readonly ledgerAtStore: string[][] = [];
  ledger: () => string[] = () => [];

  check = (apiKey: string): Promise<void> => {
    this.checked.push(apiKey);
    return this.accepts
      ? Promise.resolve()
      : Promise.reject(new Error('jamie checkAccess: the API key was refused with HTTP 401'));
  };

  store = (principalId: string, apiKey: string): Promise<void> => {
    this.stored.push({ principalId, apiKey });
    this.ledgerAtStore.push(this.ledger());
    return Promise.resolve();
  };
}

let harness: FakeDeps;
let jamie: FakeJamieKeys;
let server: FastifyInstance;
let logLines: string[];
let consoleLines: string[];

const everythingLogged = (): string => [...logLines, ...consoleLines].join('\n');

const build = (deps: FakeDeps['server']): FastifyInstance =>
  buildServer(deps, {
    logStream: {
      write: (line) => {
        logLines.push(line);
      },
    },
  });

beforeEach(() => {
  logLines = [];
  consoleLines = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(' '));
    });
  }
  harness = fakeDeps();
  jamie = new FakeJamieKeys();
  jamie.ledger = () =>
    harness.writer.appended.map((event) => String((event.payload as { change?: unknown }).change));
  server = build({ ...harness.server, jamieKeys: jamie });
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

describe('POST /credentials/jamie', () => {
  it('answers 401 without an Entra bearer token and stores nothing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      payload: { apiKey: KEY },
    });

    expect(response.statusCode).toBe(401);
    expect(jamie.checked).toEqual([]);
    expect(jamie.stored).toEqual([]);
  });

  it("stores the key in the caller's own secret after the test call succeeds", async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: BEARER,
      payload: { apiKey: KEY },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ connected: true });
    expect(jamie.checked).toEqual([KEY]);
    expect(jamie.stored).toEqual([{ principalId: TEST_PRINCIPAL_ID, apiKey: KEY }]);
    expect(harness.writer.appended).toHaveLength(2);
    expect(harness.writer.appended[1]).toMatchObject({
      kind: 'state_changed',
      sourceSystem: 'jamie',
      payload: { change: 'jamie_connected' },
    });
  });

  it('records the intent before the key is written and the connection after', async () => {
    await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: BEARER,
      payload: { apiKey: KEY },
    });

    expect(jamie.ledgerAtStore).toEqual([['jamie_key_storing']]);
    expect(harness.writer.appended.map((event) => event.payload)).toEqual([
      { change: 'jamie_key_storing' },
      { change: 'jamie_connected' },
    ]);
  });

  it('stores nothing and says what to do when Jamie refuses the key', async () => {
    jamie.accepts = false;
    const response = await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: BEARER,
      payload: { apiKey: KEY },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toContain('Settings, Developers, API Keys');
    expect(jamie.stored).toEqual([]);
    expect(harness.writer.appended).toEqual([]);
  });

  it('lets an onboarding principal store their key, which is what onboarding step 3 does', async () => {
    const onboarding = fakeDeps({
      auth: fakeVerifier({
        'new-token': fakeIdentity({ oid: 'oid-new', upn: 'new.principal@example.test' }),
      }),
    });
    const app = build({ ...onboarding.server, jamieKeys: jamie });

    const response = await app.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: { authorization: 'Bearer new-token' },
      payload: { apiKey: KEY },
    });

    expect(response.statusCode).toBe(200);
    const created = onboarding.directory.principals.get('oid-new');
    expect(created?.status).toBe('onboarding');
    expect(jamie.stored).toEqual([{ principalId: created?.id, apiKey: KEY }]);
    await app.close();
  });

  it('answers 503 on an api without the principal vault', async () => {
    const bare = build(fakeDeps().server);
    const response = await bare.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: BEARER,
      payload: { apiKey: KEY },
    });

    expect(response.statusCode).toBe(503);
    await bare.close();
  });
});

describe('the Jamie key never reaches a log line', () => {
  it('after a successful store', async () => {
    await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: BEARER,
      payload: { apiKey: KEY },
    });

    expect(logLines.length).toBeGreaterThan(0);
    expect(everythingLogged()).not.toContain(KEY);
    expect(JSON.stringify(harness.writer.appended)).not.toContain(KEY);
  });

  it('after Jamie refuses it', async () => {
    jamie.accepts = false;
    const response = await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: BEARER,
      payload: { apiKey: KEY },
    });

    expect(everythingLogged()).toContain('Request rejected');
    expect(everythingLogged()).not.toContain(KEY);
    expect(response.body).not.toContain(KEY);
  });

  it('after a body that is not JSON, whose parse error would otherwise quote it', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: { ...BEARER, 'content-type': 'application/json' },
      payload: `{"apiKey": "${KEY}"`,
    });

    expect(response.statusCode).toBe(400);
    expect(everythingLogged()).not.toContain(KEY);
    expect(response.body).not.toContain(KEY);
    expect(jamie.checked).toEqual([]);
  });

  it('after a body with the key under the wrong name', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: BEARER,
      payload: { key: KEY },
    });

    expect(response.statusCode).toBe(400);
    expect(everythingLogged()).not.toContain(KEY);
    expect(response.body).not.toContain(KEY);
  });

  it('when the vault write fails', async () => {
    jamie.store = () => Promise.reject(new Error('Key Vault answered 403 for jamie-api-key--x'));
    const response = await server.inject({
      method: 'POST',
      url: '/credentials/jamie',
      headers: BEARER,
      payload: { apiKey: KEY },
    });

    expect(response.statusCode).toBe(500);
    expect(everythingLogged()).toContain('Request failed');
    expect(everythingLogged()).not.toContain(KEY);
    expect(response.body).not.toContain(KEY);
  });
});
