import type { AccessToken, TokenCredential } from '@azure/identity';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../core/errors.js';
import { FakeClock } from '../core/testing.js';
import {
  createAppInsightsClient,
  logAnalyticsQueryUrl,
  rowsFromResponse,
  LOG_ANALYTICS_SCOPE,
} from './client.js';

const WORKSPACE_ID = '00000000-0000-0000-0000-00000000dead';
const QUERY = 'AppDependencies | where Success == false';

const credential = (token = 'stub-token-never-logged'): TokenCredential => ({
  getToken: (): Promise<AccessToken> =>
    Promise.resolve({ token, expiresOnTimestamp: Date.now() + 60_000 }),
});

interface SeenRequest {
  url: string;
  authorization: string | null;
  body: unknown;
}

function stubFetch(body: unknown, seen: SeenRequest[], status = 200): typeof fetch {
  return (input, init) => {
    seen.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

const ONE_TABLE = {
  tables: [
    {
      name: 'PrimaryResult',
      columns: [
        { name: 'TimeGenerated', type: 'datetime' },
        { name: 'OperationId', type: 'string' },
        { name: 'Success', type: 'bool' },
      ],
      rows: [
        ['2026-09-22T08:00:00Z', 'op-1', false],
        ['2026-09-22T08:05:00Z', 'op-2', false],
      ],
    },
  ],
};

function client(seen: SeenRequest[], body: unknown = ONE_TABLE) {
  return createAppInsightsClient({
    workspaceId: WORKSPACE_ID,
    credential: credential(),
    fetchImpl: stubFetch(body, seen),
    clock: new FakeClock(),
  });
}

describe('createAppInsightsClient', () => {
  it('posts the query and the timespan to the workspace query endpoint', async () => {
    const seen: SeenRequest[] = [];
    await client(seen).query('failedSpans', { query: QUERY, timespan: 'PT10M' });
    expect(seen[0]?.url).toBe(logAnalyticsQueryUrl(WORKSPACE_ID));
    expect(seen[0]?.body).toEqual({ query: QUERY, timespan: 'PT10M' });
  });

  it('sends the credential token as a bearer for the Log Analytics audience', async () => {
    const seen: SeenRequest[] = [];
    const scopes: unknown[] = [];
    const watched: TokenCredential = {
      getToken: (scope): Promise<AccessToken> => {
        scopes.push(scope);
        return Promise.resolve({ token: 'stub-token-never-logged', expiresOnTimestamp: 0 });
      },
    };
    const instance = createAppInsightsClient({
      workspaceId: WORKSPACE_ID,
      credential: watched,
      fetchImpl: stubFetch(ONE_TABLE, seen),
      clock: new FakeClock(),
    });
    await instance.query('failedSpans', { query: QUERY });
    expect(scopes).toEqual([LOG_ANALYTICS_SCOPE]);
    expect(seen[0]?.authorization).toBe('Bearer stub-token-never-logged');
  });

  it('omits the timespan when the caller gives none', async () => {
    const seen: SeenRequest[] = [];
    await client(seen).query('failedSpans', { query: QUERY });
    expect(seen[0]?.body).toEqual({ query: QUERY });
  });

  it('keys each row of the first table by its column name', async () => {
    const rows = await client([]).query('failedSpans', { query: QUERY });
    expect(rows).toEqual([
      { TimeGenerated: '2026-09-22T08:00:00Z', OperationId: 'op-1', Success: false },
      { TimeGenerated: '2026-09-22T08:05:00Z', OperationId: 'op-2', Success: false },
    ]);
  });

  it('returns no rows when the query matched nothing', async () => {
    const empty = { tables: [{ name: 'PrimaryResult', columns: [{ name: 'X' }], rows: [] }] };
    await expect(client([], empty).query('failedSpans', { query: QUERY })).resolves.toEqual([]);
  });

  it('fails without quoting the body when the reply is not a query result', async () => {
    const error = await client([], { error: { code: 'BadArgumentError' } })
      .query('failedSpans', { query: QUERY })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).message).toContain('not a query result');
    expect((error as ConnectorError).message).not.toContain('BadArgumentError');
  });

  it('says what to grant when the credential hands back no token', async () => {
    const instance = createAppInsightsClient({
      workspaceId: WORKSPACE_ID,
      credential: { getToken: () => Promise.resolve(null) },
      fetchImpl: stubFetch(ONE_TABLE, []),
      clock: new FakeClock(),
    });
    await expect(instance.query('failedSpans', { query: QUERY })).rejects.toThrow(
      /Log Analytics Reader/,
    );
  });
});

describe('rowsFromResponse', () => {
  it('reads nothing from a reply with no tables', () => {
    expect(rowsFromResponse({ tables: [] })).toEqual([]);
  });

  it('gives a missing cell as null rather than undefined', () => {
    const rows = rowsFromResponse({
      tables: [{ columns: [{ name: 'a' }, { name: 'b' }], rows: [['one']] }],
    });
    expect(rows).toEqual([{ a: 'one', b: null }]);
  });
});
