import { startPostgresContainer } from '@lance/db/testing';
import { agentRuns, createDb, cursors, proposals, runMigrations, seed, type Db } from '@lance/db';
import { LedgerReader } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEntraVerifier, entraIssuer } from './auth/entra.js';
import { createExecuteQueue, type ExecuteQueue } from './executeQueue.js';
import { createApiDeps } from './main.js';
import { buildServer } from './server.js';
import { slackSignature } from './slack/verify.js';
import {
  createTestJwks,
  testConfig,
  TEST_INGEST_SECRET,
  TEST_SIGNING_SECRET,
  TEST_SLACK_USER_ID,
  TEST_UPN,
  type TestJwks,
} from './test-fakes.js';

/**
 * The one test that runs the api over a real database (ADR 0004, same
 * image as CI and production). Everything else in this suite uses fakes;
 * this proves the wiring in `createApiDeps` and that a pause from the api
 * and a resume from Slack both land in the ledger.
 */

const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = '66666666-7777-8888-9999-000000000000';

let container: StartedPostgreSqlContainer;
let db: Db;
let server: FastifyInstance;
let keys: TestJwks;
let bearer: string;
let executeQueue: ExecuteQueue;

const PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E301A';
const CORRELATION_ID = '01K5S9V6QW3SWCCPVB0N0E301B';

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

beforeAll(async () => {
  container = await startPostgresContainer();

  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });

  db = createDb({ connectionString });
  await seed(db);

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
  bearer = await keys.sign({ preferred_username: TEST_UPN });

  executeQueue = createExecuteQueue(db);
  server = buildServer(
    createApiDeps({
      config: testConfig(),
      db,
      executeQueue,
      auth: createEntraVerifier({
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        allowedUpn: TEST_UPN,
        jwks: keys.jwks,
      }),
      slack: { signingSecret: TEST_SIGNING_SECRET, allowedUserId: TEST_SLACK_USER_ID },
      ingestSecret: TEST_INGEST_SECRET,
    }),
  );
  await server.ready();
});

afterAll(async () => {
  await server?.close();
  await executeQueue?.stop();
  await db?.$client.end();
  await container?.stop();
});

describe('the api over a real database', () => {
  it('reports itself ready once the schema is migrated and seeded', async () => {
    const response = await server.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, paused: false, mode: 'dry_run' });
  });

  it('pauses through POST /admin/pause with a test-signed Entra token', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/pause',
      headers: { authorization: `Bearer ${bearer}` },
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
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ changed: boolean }>().changed).toBe(true);

    const ready = await server.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.json<{ paused: boolean }>().paused).toBe(false);
  });

  it('leaves one state_changed event for the pause and one for the resume', async () => {
    const events = await new LedgerReader(db).query({ kind: 'state_changed' });

    expect(events).toHaveLength(2);
    expect(events.map((event) => (event.payload as { change: string }).change).sort()).toEqual([
      'pause',
      'resume',
    ]);
    expect(events.every((event) => event.actor === 'user:dom')).toBe(true);
  });

  it('approves a pending proposal through tRPC and queues it for execution', async () => {
    await db.insert(proposals).values({
      id: PROPOSAL_ID,
      correlationId: CORRELATION_ID,
      actionClass: 'draft_email',
      counterpartyClass: 'client',
      targetSystem: 'graph',
      targetRecordId: 'AAMk1',
      reversibility: 'compensatable',
      payload: { subject: 'Re: the pilot', bodyText: 'Tuesday suits.' },
      preview: 'Reply to "the pilot"',
      rationale: 'They asked for a date.',
      provenance: [
        { system: 'graph', recordId: 'AAMk1', hash: 'h1', observedAt: '2026-09-21T09:00:00.000Z' },
      ],
      policyDecision: 'propose',
      status: 'pending',
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const response = await server.inject({
      method: 'POST',
      url: '/trpc/proposals.decide',
      headers: { authorization: `Bearer ${bearer}` },
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
