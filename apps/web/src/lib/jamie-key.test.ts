import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitJamieKey } from './jamie-key';

/**
 * Onboarding step 3's form (ADR 0022). Every case captures everything the
 * console was given, as the api's credential test does with its log, and
 * proves the key is in no line and no message.
 */

const KEY = 'jk_live_a-very-secret-jamie-key-0002';
const API = 'https://api.lance.test';

let consoleLines: string[];

beforeEach(() => {
  consoleLines = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const respond =
  (status: number, body: unknown, seen: RequestInit[] = []): typeof fetch =>
  (_url, init) => {
    seen.push(init ?? {});
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

describe('submitJamieKey', () => {
  it("posts the key to the api's credential route with the principal's bearer", async () => {
    const seen: RequestInit[] = [];
    const urls: string[] = [];
    const fetchImpl: typeof fetch = (url, init) => {
      urls.push(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
      return respond(200, { connected: true }, seen)(url, init);
    };

    const failure = await submitJamieKey({
      apiKey: KEY,
      idToken: 'id-token',
      apiBaseUrl: API,
      fetchImpl,
    });

    expect(failure).toBeNull();
    expect(urls).toEqual([`${API}/credentials/jamie`]);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toBe(JSON.stringify({ apiKey: KEY }));
    expect((seen[0]?.headers as Record<string, string>).authorization).toBe('Bearer id-token');
    expect(consoleLines.join('\n')).not.toContain(KEY);
  });

  it("shows the api's own advice when Jamie refuses the key, and never the key", async () => {
    const advice =
      'Jamie did not accept this key. Create a personal key in Jamie under Settings, Developers, API Keys (a workspace key cannot read your meetings) and try again. Nothing was stored.';

    const failure = await submitJamieKey({
      apiKey: KEY,
      idToken: 'id-token',
      apiBaseUrl: API,
      fetchImpl: respond(400, { error: advice }),
    });

    expect(failure).toBe(advice);
    expect(consoleLines.join('\n')).not.toContain(KEY);
  });

  it('says the api could not be reached without repeating the error, which could quote the request', async () => {
    const failure = await submitJamieKey({
      apiKey: KEY,
      idToken: 'id-token',
      apiBaseUrl: API,
      fetchImpl: () => Promise.reject(new Error(`connect ECONNREFUSED while sending ${KEY}`)),
    });

    expect(failure).toBe(
      'The Lance api could not be reached. Nothing was stored. Try again in a minute.',
    );
    expect(failure).not.toContain(KEY);
    expect(consoleLines.join('\n')).not.toContain(KEY);
  });

  it('words a fault in the api without passing its body on', async () => {
    const failure = await submitJamieKey({
      apiKey: KEY,
      idToken: 'id-token',
      apiBaseUrl: API,
      fetchImpl: respond(500, { error: `something with ${KEY}` }),
    });

    expect(failure).toContain('a fault in the api');
    expect(failure).not.toContain(KEY);
  });

  it('asks for a key before calling the api when the field is empty', async () => {
    const seen: RequestInit[] = [];
    const failure = await submitJamieKey({
      apiKey: '   ',
      idToken: 'id-token',
      apiBaseUrl: API,
      fetchImpl: respond(200, {}, seen),
    });
    expect(failure).toBe('Paste your personal Jamie API key before saving. Nothing was stored.');
    expect(seen).toEqual([]);
  });
});
