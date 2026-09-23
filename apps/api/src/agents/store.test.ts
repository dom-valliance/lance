import { agentRuns, cursors, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentsStore, type AgentsStoreLike } from './store.js';

/** The Agents page's reads, over a real database. */

let container: StartedPostgreSqlContainer;
let db: Db;
let store: AgentsStoreLike;

const SINCE = new Date('2026-09-15T00:00:00.000Z');

const insertRun = async (
  agent: string,
  startedAt: string,
  overrides: { status?: 'running' | 'succeeded' | 'failed'; costUsd?: string; error?: string } = {},
): Promise<void> => {
  await db.insert(agentRuns).values({
    id: newUlid(),
    agent,
    version: '0.1.0',
    model: 'claude-sonnet-5',
    startedAt: new Date(startedAt),
    status: overrides.status ?? 'succeeded',
    estimatedCostUsd: overrides.costUsd ?? '0.010000',
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
  });
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  store = createAgentsStore(db);

  await db.insert(cursors).values([
    {
      watcher: 'graph-mail',
      key: '__started_at',
      value: '2026-09-01T06:00:00.000Z',
      updatedAt: new Date('2026-09-01T06:00:00.000Z'),
    },
    {
      watcher: 'graph-mail',
      key: 'inbox',
      value: 'delta-token',
      updatedAt: new Date('2026-09-22T07:50:00.000Z'),
    },
  ]);

  await insertRun('triage', '2026-09-22T07:00:00.000Z', { costUsd: '0.200000' });
  await insertRun('triage', '2026-09-20T07:00:00.000Z', {
    status: 'failed',
    error: 'overloaded_error',
  });
  await insertRun('planner', '2026-09-01T05:30:00.000Z');
}, 300000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('createAgentsStore', () => {
  it('returns the start marker and every partition of a watcher', async () => {
    const rows = await store.listCursors();

    expect([...rows.map((row) => row.key)].sort()).toEqual(['__started_at', 'inbox']);
    expect(rows.find((row) => row.key === 'inbox')?.value).toBe('delta-token');
    expect(rows.every((row) => row.watcher === 'graph-mail')).toBe(true);
  });

  it('returns only the runs started since the window opened', async () => {
    const rows = await store.runsSince(SINCE);

    expect(rows.map((row) => row.agent)).toEqual(['triage', 'triage']);
  });

  it('returns the cost of a run as a number', async () => {
    const rows = await store.runsSince(new Date('2026-09-22T00:00:00.000Z'));

    expect(rows[0]?.costUsd).toBe(0.2);
  });

  it('returns the most recent run of every agent, however long ago it was', async () => {
    const rows = await store.lastRuns();

    expect(rows.map((row) => row.agent)).toEqual(['planner', 'triage']);
    expect(rows[1]?.startedAt.toISOString()).toBe('2026-09-22T07:00:00.000Z');
    expect(rows[1]?.error).toBeNull();
  });

  it('counts only the pushes recorded in the window', async () => {
    const writer = new LedgerWriter(db);
    await writer.append({
      ts: '2026-09-22T07:30:00.000Z',
      actor: 'system:interruption',
      kind: 'resolved',
      sourceSystem: 'slack',
      correlationId: newUlid(),
      payload: { kind: 'slack_push', reason: 'proposal_card' },
    });
    await writer.append({
      ts: '2026-09-22T05:00:00.000Z',
      actor: 'system:interruption',
      kind: 'resolved',
      sourceSystem: 'slack',
      correlationId: newUlid(),
      payload: { kind: 'slack_push', reason: 'alert' },
    });
    await writer.append({
      ts: '2026-09-22T07:40:00.000Z',
      actor: 'user:dom',
      kind: 'resolved',
      sourceSystem: 'lance',
      correlationId: newUlid(),
      payload: { kind: 'alert_status', to: 'resolved' },
    });

    expect(await store.pushesSince(new Date('2026-09-22T07:00:00.000Z'))).toBe(1);
  });
});
