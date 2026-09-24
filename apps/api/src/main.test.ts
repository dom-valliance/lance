import { openAppTestDb, openFixtureDb, startPostgresContainer } from '@lance/db/testing';
import {
  SEED_PRINCIPAL_ID,
  agentRuns,
  alerts,
  cursors,
  principalState,
  proposals,
  runMigrations,
  scopedDb,
  type Db,
} from '@lance/db';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEntraVerifier, entraIssuer } from './auth/entra.js';
import { createExecuteQueue, type ExecuteQueue } from './executeQueue.js';
import { createServerDeps } from './main.js';
import { buildServer } from './server.js';
import { slackSignature } from './slack/verify.js';
import {
  createTestJwks,
  testConfig,
  TEST_INGEST_SECRET,
  TEST_OID,
  TEST_SIGNING_SECRET,
  TEST_SLACK_USER_ID,
  TEST_UPN,
  type TestJwks,
} from './test-fakes.js';

/**
 * The api over a real database (ADR 0004, same image as CI and
 * production), logged in as a lance_app member so row-level security and
 * the principals policies apply as they do in production. Everything else
 * in this suite uses fakes; this proves the wiring in `createServerDeps`:
 * role-gated sign-in, first sign-in, the per-principal dependency cache,
 * the admin reads, and a pause from the api and a resume from Slack both
 * landing in the ledger.
 */

const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = '66666666-7777-8888-9999-000000000000';

const ANN_ID = '01K5S9V6QW3SWCCPVB0N0E3A01';
const ANN_OID = 'ann-object-id';
const ANN_UPN = 'ann@valliance.ai';
const STRANGER_OID = 'stranger-object-id';
const STRANGER_UPN = 'new.person@valliance.ai';

let container: StartedPostgreSqlContainer;
let root: Db;
let db: Db;
let fixture: Db;
let server: FastifyInstance;
let keys: TestJwks;
let domBearer: string;
let annBearer: string;
let strangerBearer: string;
let noRoleBearer: string;
let executeQueue: ExecuteQueue;

const PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E301A';
const CORRELATION_ID = '01K5S9V6QW3SWCCPVB0N0E301B';
const ANN_PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E3A02';

/** Words planted in content columns; no admin response may carry them. */
const CONTENT_MARKER = 'CONFIDENTIAL-CONTENT';

const auth = (bearer: string): Record<string, string> => ({ authorization: `Bearer ${bearer}` });

const trpcGet = (path: string, bearer: string) =>
  server.inject({ method: 'GET', url: `/trpc/${path}`, headers: auth(bearer) });

const dataOf = <T>(response: { json: <U>() => U }): T =>
  response.json<{ result: { data: T } }>().result.data;

const slashCommand = async (
  text: string,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> => {
  const body = new URLSearchParams({
    command: '/lance',
    text,
    user_id: TEST_SLACK_USER_ID,
    channel_id: 'C0BU7P278N5',
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));

  return server.inject({
    method: 'POST',
    url: '/slack/commands',
    payload: body,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': slackSignature(TEST_SIGNING_SECRET, timestamp, body),
    },
  });
};

const proposalRow = (id: string, preview: string) => ({
  id,
  correlationId: newUlid(),
  actionClass: 'draft_email' as const,
  counterpartyClass: 'client' as const,
  targetSystem: 'graph' as const,
  targetRecordId: `AAMk-${id}`,
  reversibility: 'compensatable' as const,
  payload: { subject: `Re: ${CONTENT_MARKER}`, bodyText: CONTENT_MARKER },
  preview,
  rationale: `They asked. ${CONTENT_MARKER}`,
  provenance: [
    { system: 'graph', recordId: 'AAMk1', hash: 'h1', observedAt: '2026-09-21T09:00:00.000Z' },
  ],
  policyDecision: 'propose' as const,
  status: 'pending' as const,
  expiresAt: new Date(Date.now() + 3600 * 1000),
});

const principalsSnapshot = async (): Promise<Record<string, unknown>[]> => {
  const result = await fixture.$client.query(
    'SELECT id, entra_oid, upn, slack_user_id, notion_user_id, status, time_zone, created_at FROM principals ORDER BY id',
  );
  return result.rows as Record<string, unknown>[];
};

beforeAll(async () => {
  container = await startPostgresContainer();

  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });

  root = await openAppTestDb(connectionString);
  db = scopedDb(root, { principalId: SEED_PRINCIPAL_ID });
  fixture = openFixtureDb(connectionString);

  // Dom's row as the migration left it: no Entra object id yet, and the
  // Slack id the kill switch trusts. Ann is a second, already bound principal.
  await fixture.$client.query('UPDATE principals SET slack_user_id = $1 WHERE id = $2', [
    TEST_SLACK_USER_ID,
    SEED_PRINCIPAL_ID,
  ]);
  await fixture.$client.query(
    "INSERT INTO principals (id, entra_oid, upn, status) VALUES ($1, $2, $3, 'active')",
    [ANN_ID, ANN_OID, ANN_UPN],
  );
  await scopedDb(root, { principalId: ANN_ID }).insert(principalState).values({});

  await db.insert(cursors).values({ watcher: 'graph-mail', key: 'inbox', value: 'delta-token' });
  await db.insert(agentRuns).values({
    id: newUlid(),
    agent: 'triage',
    version: '1.0.0',
    model: 'claude-sonnet-5',
    status: 'succeeded',
    estimatedCostUsd: '2.000000',
  });

  keys = await createTestJwks(entraIssuer(TENANT_ID), CLIENT_ID);
  domBearer = await keys.sign({
    oid: TEST_OID,
    preferred_username: TEST_UPN,
    roles: ['Lance.User', 'Lance.Admin'],
  });
  annBearer = await keys.sign({ oid: ANN_OID, preferred_username: ANN_UPN, roles: ['Lance.User'] });
  strangerBearer = await keys.sign({
    oid: STRANGER_OID,
    preferred_username: STRANGER_UPN,
    roles: ['Lance.User'],
  });
  noRoleBearer = await keys.sign({
    oid: 'no-role-oid',
    preferred_username: 'no.role@valliance.ai',
  });

  executeQueue = createExecuteQueue(root);
  server = buildServer(
    createServerDeps({
      config: testConfig(),
      root,
      executeQueue,
      auth: createEntraVerifier({ tenantId: TENANT_ID, clientId: CLIENT_ID, jwks: keys.jwks }),
      slack: { signingSecret: TEST_SIGNING_SECRET, fallbackUserId: null },
      ingestSecret: TEST_INGEST_SECRET,
    }),
  );
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await executeQueue?.stop();
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

describe('sign-in over a real database', () => {
  it("binds Dom's oid on his first sign-in and changes no other row", async () => {
    const before = await principalsSnapshot();

    const response = await trpcGet('me', domBearer);

    expect(response.statusCode).toBe(200);
    expect(dataOf<{ principalId: string; status: string }>(response)).toMatchObject({
      principalId: SEED_PRINCIPAL_ID,
      status: 'active',
    });
    const after = await principalsSnapshot();
    expect(after).toEqual(
      before.map((row) =>
        row['id'] === SEED_PRINCIPAL_ID ? { ...row, entra_oid: TEST_OID } : row,
      ),
    );
    const events = await new LedgerReader(db).query({ kind: 'state_changed' });
    expect(events.map((event) => event.payload)).toEqual([
      { change: 'principal_bound', principalId: SEED_PRINCIPAL_ID, entraOid: TEST_OID },
    ]);
    expect(events[0]?.actor).toBe('user:dom');
  });

  it('finds Dom by his oid on every later request without writing again', async () => {
    await trpcGet('me', domBearer);
    const events = await new LedgerReader(db).query({ kind: 'state_changed' });
    expect(events).toHaveLength(1);
  });

  it('refuses a token with neither Lance role and creates no principal', async () => {
    const before = await principalsSnapshot();
    const response = await trpcGet('me', noRoleBearer);

    expect(response.statusCode).toBe(403);
    expect(await principalsSnapshot()).toEqual(before);
  });

  it("creates an onboarding principal on a stranger's first sign-in, who reaches nothing else", async () => {
    const me = await trpcGet('me', strangerBearer);
    const summary = await trpcGet('proposals.summary', strangerBearer);
    const pause = await server.inject({
      method: 'POST',
      url: '/admin/pause',
      headers: auth(strangerBearer),
      payload: { reason: 'curious' },
    });

    const created = dataOf<{ principalId: string; status: string; upn: string }>(me);
    expect(created).toMatchObject({ status: 'onboarding', upn: STRANGER_UPN });
    expect([summary.statusCode, pause.statusCode]).toEqual([403, 403]);
    const stranger = scopedDb(root, { principalId: created.principalId });
    const events = await new LedgerReader(stranger).query({ kind: 'state_changed' });
    expect(events.map((event) => event.payload)).toEqual([
      {
        change: 'principal_created',
        principalId: created.principalId,
        entraOid: STRANGER_OID,
        status: 'onboarding',
      },
    ]);
  });
});

describe('the api over a real database', () => {
  it('reports itself ready from the global system_state row', async () => {
    const response = await server.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, paused: false, mode: 'live' });
  });

  it('pauses through POST /admin/pause with a test-signed Entra token', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/pause',
      headers: auth(domBearer),
      payload: { reason: 'container test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ changed: boolean }>().changed).toBe(true);
  });

  it('shows the pause, the live cursor and today cost through /lance status', async () => {
    const response = await slashCommand('status');

    expect(response.statusCode).toBe(200);
    const text = response.json<{ text: string }>().text;

    expect(text).toContain('Paused: yes. Reason: container test. By: user:dom.');
    expect(text).toContain('Mode: dry_run.');
    expect(text).toContain('graph-mail (inbox): updated less than a minute ago.');
    expect(text).toContain('Cost today: GBP 1.56.');
  });

  it('resumes through POST /admin/resume', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/resume',
      headers: auth(domBearer),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ changed: boolean }>().changed).toBe(true);
  });

  it('leaves one state_changed event for the pause and one for the resume', async () => {
    const events = await new LedgerReader(db).query({ kind: 'state_changed' });
    const switches = events.filter((event) =>
      ['pause', 'resume'].includes((event.payload as { change: string }).change),
    );

    expect(switches.map((event) => (event.payload as { change: string }).change).sort()).toEqual([
      'pause',
      'resume',
    ]);
    expect(switches.every((event) => event.actor === 'user:dom')).toBe(true);
  });

  it('approves a pending proposal through tRPC and queues it for execution', async () => {
    await db.insert(proposals).values({
      ...proposalRow(PROPOSAL_ID, 'Reply to "the pilot"'),
      correlationId: CORRELATION_ID,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/trpc/proposals.decide',
      headers: auth(domBearer),
      payload: { proposalId: PROPOSAL_ID, action: 'approve' },
    });

    expect(response.statusCode).toBe(200);

    const decided = await new LedgerReader(db).query({ kind: 'decided' });
    const forProposal = decided.filter(
      (event) => (event.payload as { proposalId?: string }).proposalId === PROPOSAL_ID,
    );
    expect(forProposal).toHaveLength(1);
    expect(forProposal[0]?.actor).toBe('user:dom');
    expect((forProposal[0]?.payload as { to: string }).to).toBe('approved');

    const queued = await db.execute<{ name: string; data: { proposalId: string } }>(
      sql`select name, data from pgboss.job where name = 'execute'`,
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]?.data.proposalId).toBe(PROPOSAL_ID);
  });

  it('appends an observed agent log through the ingest webhook', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/ingest/agent-log',
      headers: { 'x-lance-ingest-secret': TEST_INGEST_SECRET },
      payload: {
        agent: 'inbox-agent',
        recordId: 'slack-1758351600.123456',
        observedAt: '2026-09-20T09:00:00.000Z',
        level: 'info',
        message: 'Posted the morning digest.',
      },
    });

    expect(response.statusCode).toBe(202);

    const observed = await new LedgerReader(db).query({ kind: 'observed' });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.actor).toBe('agent:inbox-agent@0.0.0');
    expect(observed[0]?.idempotencyKey).toContain('webhook:slack-1758351600.123456:');
  });
});

describe('two principals', () => {
  it('each read only their own rows through the dependency cache', async () => {
    await scopedDb(root, { principalId: ANN_ID })
      .insert(proposals)
      .values(proposalRow(ANN_PROPOSAL_ID, "Ann's reply"));

    const dom = await trpcGet('proposals.list', domBearer);
    const ann = await trpcGet('proposals.list', annBearer);
    const annReadsDoms = await server.inject({
      method: 'GET',
      url: `/trpc/proposals.get?input=${encodeURIComponent(JSON.stringify({ proposalId: PROPOSAL_ID }))}`,
      headers: auth(annBearer),
    });

    const ids = (response: typeof dom): string[] =>
      dataOf<{ items: { id: string }[] }>(response).items.map((item) => item.id);
    expect(ids(dom)).toEqual([PROPOSAL_ID]);
    expect(ids(ann)).toEqual([ANN_PROPOSAL_ID]);
    expect(dataOf<unknown>(annReadsDoms)).toBeNull();
  });
});

describe('the admin procedures over a real database', () => {
  it('answer 403 to a principal without Lance.Admin', async () => {
    const responses = await Promise.all([
      trpcGet('admin.principals', annBearer),
      trpcGet('admin.health', annBearer),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([403, 403]);
  });

  it("return each principal's health, read in its own scope, and no content", async () => {
    const annDb = scopedDb(root, { principalId: ANN_ID });
    await annDb.insert(alerts).values({
      id: newUlid(),
      severity: 'P1',
      kind: 'breaker_open',
      dedupeKey: 'breaker:graph',
      title: CONTENT_MARKER,
      body: CONTENT_MARKER,
      provenance: [],
    });
    await new LedgerWriter(annDb).append({
      ts: new Date().toISOString(),
      actor: 'user:ann',
      kind: 'state_changed',
      sourceSystem: 'lance',
      correlationId: newUlid(),
      payload: { change: 'note', text: CONTENT_MARKER },
    });

    const principalsResponse = await trpcGet('admin.principals', domBearer);
    const healthResponse = await trpcGet('admin.health', domBearer);

    expect([principalsResponse.statusCode, healthResponse.statusCode]).toEqual([200, 200]);
    const health = dataOf<
      {
        principalId: string;
        watchers: { watcher: string }[];
        breakers: { connector: string }[];
        costTodayGbp: number;
      }[]
    >(healthResponse);
    const domHealth = health.find((row) => row.principalId === SEED_PRINCIPAL_ID);
    const annHealth = health.find((row) => row.principalId === ANN_ID);
    expect(domHealth).toMatchObject({
      watchers: [{ watcher: 'graph-mail' }],
      breakers: [],
      costTodayGbp: 1.56,
    });
    expect(annHealth).toMatchObject({
      watchers: [],
      breakers: [{ connector: 'graph', state: 'open' }],
    });

    for (const response of [principalsResponse, healthResponse]) {
      expect(response.body).not.toContain(CONTENT_MARKER);
      expect(response.body).not.toMatch(
        /"(payload|preview|rationale|body|title|description|bodyText|subject)"/,
      );
    }
  });
});
