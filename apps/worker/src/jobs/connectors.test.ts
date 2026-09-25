import {
  createAccessTokenProvider,
  InMemorySecrets,
  PrincipalTokenStore,
  type NotionUserSummary,
} from '@lance/connectors';
import {
  SEED_PRINCIPAL_ID,
  createDb,
  principals,
  runMigrations,
  type Db,
  type Principal,
} from '@lance/db';
import { openAppTestDb, startPostgresContainer } from '@lance/db/testing';
import { loadConfig, PLACEHOLDER_SECRET_VALUE, type Config } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scopedDb } from '@lance/db';
import {
  graphRotationLock,
  principalConnectors,
  principalSlackSurface,
  type PrincipalConnectorOptions,
} from './connectors.js';

/**
 * Credentials per principal (ADR 0022) against a real Postgres: the
 * lookup, the one-time copy of Dom's legacy credentials, the Notion user
 * resolution, and the advisory lock that serialises token rotation across
 * two worker replicas. Key Vault is an in-memory double; every database
 * write runs as a lance_app member, as the worker does.
 */

const COLLEAGUE_ID = '01K5S9V6QW3SWCCPVB0N0E3C01';
const DOM_UPN = 'dom@valliance.ai';
const COLLEAGUE_UPN = 'colleague.two@example.test';
const COLLEAGUE_NOTION_ID = '2a0e1c55-0b7d-4c1e-9f0a-3c4d5e6f7a81';

const ENV = {
  ENTRA_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  ENTRA_CLIENT_ID: 'a-client-id',
  ENTRA_CLIENT_SECRET: 'a-client-secret',
  NOTION_TOKEN: 'secret_notion',
};

const NOTION_USERS: NotionUserSummary[] = [
  { id: '1fdd872b-594c-8146-b22f-00028f1f5a41', name: 'Dom', email: DOM_UPN },
  { id: COLLEAGUE_NOTION_ID, name: 'Colleague Two', email: 'Colleague.Two@example.test' },
];

let container: StartedPostgreSqlContainer;
let fixture: Db;
let root: Db;
let config: Config;

const principalRow = async (id: string) => {
  const rows = await root.select().from(principals).where(eq(principals.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new Error(`No principal ${id} in the fixture.`);
  return row;
};

const ledgerChanges = async (principalId: string): Promise<Record<string, unknown>[]> =>
  (
    await fixture.$client.query(
      "SELECT payload FROM ledger_events WHERE principal_id = $1 AND kind = 'state_changed' AND id > $2 ORDER BY id",
      [principalId, ledgerMark],
    )
  ).rows.map((row: { payload: Record<string, unknown> }) => row.payload);

const lookupWith = (overrides: Partial<PrincipalConnectorOptions>) =>
  principalConnectors({
    config,
    root,
    principalVault: new InMemorySecrets(),
    staticVault: new InMemorySecrets(),
    env: ENV,
    listNotionUsers: () => Promise.resolve(NOTION_USERS),
    ...overrides,
  });

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  fixture = createDb({ connectionString: url, password: 'postgres' });
  root = await openAppTestDb(url);
  config = loadConfig({ DATABASE_URL: url, DOM_EMAIL: DOM_UPN });
  await fixture.$client.query(
    "INSERT INTO principals (id, upn, status) VALUES ($1, $2, 'active')",
    [COLLEAGUE_ID, COLLEAGUE_UPN],
  );
}, 120_000);

afterAll(async () => {
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

// The ledger is append-only, so each case reads only the events written
// after it started; the colleague's Notion id is reset instead of the row.
let ledgerMark = '';

beforeEach(async () => {
  await fixture.$client.query('UPDATE principals SET notion_user_id = NULL WHERE id = $1', [
    COLLEAGUE_ID,
  ]);
  const newest = await fixture.$client.query('SELECT max(id) AS id FROM ledger_events');
  ledgerMark = (newest.rows[0] as { id: string | null }).id ?? '';
});

describe('the connector lookup for a principal without credentials', () => {
  it('builds no Graph or Jamie connector and names each missing secret', async () => {
    const vault = new InMemorySecrets();
    const colleague = await principalRow(COLLEAGUE_ID);
    const bundle = await lookupWith({ principalVault: vault })(
      colleague,
      scopedDb(root, { principalId: COLLEAGUE_ID }),
    );

    expect(bundle?.graph).toBeNull();
    expect(bundle?.jamie).toBeNull();
    expect(bundle?.notConnected.map((gap) => [gap.connector, gap.missing])).toEqual([
      ['graph', `graph-refresh-token--${COLLEAGUE_ID}`],
      ['jamie', `jamie-api-key--${COLLEAGUE_ID}`],
    ]);
  });

  it("never falls back to Dom's legacy credentials", async () => {
    const vault = new InMemorySecrets();
    const staticVault = new InMemorySecrets({ 'graph-refresh-token': 'doms-legacy-token' });
    const colleague = await principalRow(COLLEAGUE_ID);
    const bundle = await lookupWith({
      principalVault: vault,
      staticVault,
      env: { ...ENV, JAMIE_API_KEY: 'jk_doms_key' },
    })(colleague, scopedDb(root, { principalId: COLLEAGUE_ID }));

    expect(bundle?.graph).toBeNull();
    expect(bundle?.jamie).toBeNull();
    expect(vault.writes).toEqual([]);
    expect(staticVault.reads).toEqual([]);
  });

  it('reports the secret present once the principal has connected', async () => {
    const vault = new InMemorySecrets();
    const colleague = await principalRow(COLLEAGUE_ID);
    const bundle = await lookupWith({ principalVault: vault })(
      colleague,
      scopedDb(root, { principalId: COLLEAGUE_ID }),
    );
    const gap = bundle?.notConnected.find((entry) => entry.connector === 'jamie');
    expect(await gap?.recheck()).toBe(false);

    await vault.set(`jamie-api-key--${COLLEAGUE_ID}`, 'jk_colleague');
    expect(await gap?.recheck()).toBe(true);
  });

  it("builds both from the principal's own secrets", async () => {
    const vault = new InMemorySecrets({
      [`graph-refresh-token--${COLLEAGUE_ID}`]: 'colleague-refresh-token',
      [`jamie-api-key--${COLLEAGUE_ID}`]: 'jk_colleague',
    });
    const colleague = await principalRow(COLLEAGUE_ID);
    const bundle = await lookupWith({ principalVault: vault })(
      colleague,
      scopedDb(root, { principalId: COLLEAGUE_ID }),
    );

    expect(bundle?.graph).not.toBeNull();
    expect(bundle?.jamie).not.toBeNull();
    expect(bundle?.notConnected).toEqual([]);
  });
});

describe("the one-time copy of Dom's legacy credentials", () => {
  it('copies the static graph-refresh-token and JAMIE_API_KEY into his own secrets and records each', async () => {
    const vault = new InMemorySecrets();
    const staticVault = new InMemorySecrets({ 'graph-refresh-token': 'doms-legacy-token' });
    const dom = await principalRow(SEED_PRINCIPAL_ID);
    const bundle = await lookupWith({
      principalVault: vault,
      staticVault,
      env: { ...ENV, JAMIE_API_KEY: 'jk_doms_key' },
    })(dom, scopedDb(root, { principalId: SEED_PRINCIPAL_ID }));

    expect(bundle?.graph).not.toBeNull();
    expect(bundle?.jamie).not.toBeNull();
    expect(vault.writes).toEqual([
      { name: `graph-refresh-token--${SEED_PRINCIPAL_ID}`, value: 'doms-legacy-token' },
      { name: `jamie-api-key--${SEED_PRINCIPAL_ID}`, value: 'jk_doms_key' },
    ]);
    // The old secret is read, never written.
    await expect(staticVault.get('graph-refresh-token')).resolves.toBe('doms-legacy-token');
    expect(staticVault.writes).toEqual([]);
    const changes = await ledgerChanges(SEED_PRINCIPAL_ID);
    expect(changes).toEqual([
      {
        change: 'credential_migrated',
        connector: 'graph',
        from: 'graph-refresh-token',
        to: `graph-refresh-token--${SEED_PRINCIPAL_ID}`,
      },
      {
        change: 'credential_migrated',
        connector: 'jamie',
        from: 'JAMIE_API_KEY',
        to: `jamie-api-key--${SEED_PRINCIPAL_ID}`,
      },
    ]);
    expect(JSON.stringify(changes)).not.toContain('doms-legacy-token');
    expect(JSON.stringify(changes)).not.toContain('jk_doms_key');
  });

  it('copies nothing once his own secrets exist', async () => {
    const vault = new InMemorySecrets({
      [`graph-refresh-token--${SEED_PRINCIPAL_ID}`]: 'already-rotated',
      [`jamie-api-key--${SEED_PRINCIPAL_ID}`]: 'jk_new',
    });
    const staticVault = new InMemorySecrets({ 'graph-refresh-token': 'doms-legacy-token' });
    const dom = await principalRow(SEED_PRINCIPAL_ID);
    await lookupWith({
      principalVault: vault,
      staticVault,
      env: { ...ENV, JAMIE_API_KEY: 'jk_doms_key' },
    })(dom, scopedDb(root, { principalId: SEED_PRINCIPAL_ID }));

    expect(vault.writes).toEqual([]);
    expect(staticVault.reads).toEqual([]);
    expect(await ledgerChanges(SEED_PRINCIPAL_ID)).toEqual([]);
  });

  it('treats a placeholder legacy value as nothing to copy', async () => {
    const vault = new InMemorySecrets();
    const staticVault = new InMemorySecrets({ 'graph-refresh-token': PLACEHOLDER_SECRET_VALUE });
    const dom = await principalRow(SEED_PRINCIPAL_ID);
    const bundle = await lookupWith({
      principalVault: vault,
      staticVault,
      env: { ...ENV, JAMIE_API_KEY: PLACEHOLDER_SECRET_VALUE },
    })(dom, scopedDb(root, { principalId: SEED_PRINCIPAL_ID }));

    expect(bundle?.graph).toBeNull();
    expect(bundle?.jamie).toBeNull();
    expect(vault.writes).toEqual([]);
  });
});

describe('the Notion part of the bundle', () => {
  it("resolves a missing Notion user id by email and records it on the principal's row", async () => {
    const colleague = await principalRow(COLLEAGUE_ID);
    expect(colleague.notionUserId).toBeNull();

    const bundle = await lookupWith({})(colleague, scopedDb(root, { principalId: COLLEAGUE_ID }));

    expect(bundle?.notion?.principalUserId).toBe(COLLEAGUE_NOTION_ID);
    expect((await principalRow(COLLEAGUE_ID)).notionUserId).toBe(COLLEAGUE_NOTION_ID);
    expect(await ledgerChanges(COLLEAGUE_ID)).toEqual([
      { change: 'notion_user_resolved', notionUserId: COLLEAGUE_NOTION_ID },
    ]);
  });

  it('keeps a recorded Notion user id without listing users', async () => {
    let listed = 0;
    const dom = await principalRow(SEED_PRINCIPAL_ID);
    const bundle = await lookupWith({
      listNotionUsers: () => {
        listed += 1;
        return Promise.resolve(NOTION_USERS);
      },
    })(dom, scopedDb(root, { principalId: SEED_PRINCIPAL_ID }));

    expect(bundle?.notion?.principalUserId).toBe(dom.notionUserId);
    expect(listed).toBe(0);
  });

  it('leaves the id unset and the connector running when nobody matches', async () => {
    const colleague = await principalRow(COLLEAGUE_ID);
    const bundle = await lookupWith({ listNotionUsers: () => Promise.resolve([]) })(
      colleague,
      scopedDb(root, { principalId: COLLEAGUE_ID }),
    );

    expect(bundle?.notion).not.toBeNull();
    expect(bundle?.notion?.principalUserId).toBeNull();
    expect((await principalRow(COLLEAGUE_ID)).notionUserId).toBeNull();
  });
});

/**
 * A token endpoint that honours rotation strictly: each refresh token
 * works once, and a second use is `invalid_grant`, which is what a race
 * between two replicas looks like from Entra's side. Each answer waits a
 * moment so two unserialised refreshes both read the old token first.
 */
function singleUseTokenEndpoint(): { fetchImpl: typeof fetch; redeemed: string[] } {
  const used = new Set<string>();
  const redeemed: string[] = [];
  let issued = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const token = form.get('refresh_token') ?? '';
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (used.has(token)) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }
    used.add(token);
    redeemed.push(token);
    issued += 1;
    return new Response(
      JSON.stringify({
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: `access-${String(issued)}`,
        refresh_token: `refresh-${String(issued)}`,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, redeemed };
}

describe('refresh-token rotation across two worker replicas', () => {
  const replica = (vault: InMemorySecrets, fetchImpl: typeof fetch, locked: boolean) =>
    createAccessTokenProvider({
      store: new PrincipalTokenStore(vault, COLLEAGUE_ID),
      tenantId: ENV.ENTRA_TENANT_ID,
      clientId: ENV.ENTRA_CLIENT_ID,
      clientSecret: ENV.ENTRA_CLIENT_SECRET,
      fetchImpl,
      ...(locked ? { rotationLock: graphRotationLock(root, COLLEAGUE_ID) } : {}),
    });

  it('serialises two concurrent refreshes so each redeems a different token', async () => {
    const vault = new InMemorySecrets({ [`graph-refresh-token--${COLLEAGUE_ID}`]: 'refresh-0' });
    const entra = singleUseTokenEndpoint();

    const results = await Promise.allSettled([
      replica(vault, entra.fetchImpl, true)(),
      replica(vault, entra.fetchImpl, true)(),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(entra.redeemed).toEqual(['refresh-0', 'refresh-1']);
    await expect(vault.get(`graph-refresh-token--${COLLEAGUE_ID}`)).resolves.toBe('refresh-2');
  });

  it('races without the lock, which is the failure the lock exists for', async () => {
    const vault = new InMemorySecrets({ [`graph-refresh-token--${COLLEAGUE_ID}`]: 'refresh-0' });
    const entra = singleUseTokenEndpoint();

    const results = await Promise.allSettled([
      replica(vault, entra.fetchImpl, false)(),
      replica(vault, entra.fetchImpl, false)(),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
});

/** Delivery reads the channel from the principal (ADR 0023, package 5.4). */
describe("a principal's Slack surface", () => {
  const slackConfig = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/lance' });

  const principal = (overrides: Partial<Principal>): Principal => ({
    id: '01K5S9V6QW3SWCCPVB0N0E300H',
    entraOid: null,
    upn: 'dom@valliance.ai',
    slackUserId: null,
    slackChannelId: null,
    notionUserId: null,
    foundryEmployeeId: null,
    timeZone: 'Europe/London',
    status: 'active',
    statusChangedAt: null,
    lanceRoles: [],
    rolesRecordedAt: null,
    activatedAt: null,
    createdAt: new Date('2026-09-20T09:00:00.000Z'),
    updatedAt: new Date('2026-09-20T09:00:00.000Z'),
    ...overrides,
  });

  beforeEach(() => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("posts to each principal's own channel", () => {
    const dom = principalSlackSurface(slackConfig, principal({ slackChannelId: 'C0BU7P278N5' }));
    const tarek = principalSlackSurface(
      slackConfig,
      principal({
        id: '01K5S9V6QW3SWCCPVB0N0E3T01',
        upn: 'tarek@valliance.ai',
        slackChannelId: 'G0TAREK',
      }),
    );

    expect([dom?.channelId, tarek?.channelId]).toEqual(['C0BU7P278N5', 'G0TAREK']);
  });

  it('keeps Dom on dom-claude-agent until his link records a channel', () => {
    expect(principalSlackSurface(slackConfig, principal({}))?.channelId).toBe('C0BU7P278N5');
  });

  it("gives a principal with no channel no surface, rather than Dom's channel", () => {
    expect(principalSlackSurface(slackConfig, principal({ upn: 'tarek@valliance.ai' }))).toBeNull();
  });

  it('gives no surface without a bot token', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    expect(principalSlackSurface(slackConfig, principal({ slackChannelId: 'G0TAREK' }))).toBeNull();
  });
});
