import { commitments, createDb, runMigrations, seed, type Db, type NewCommitment } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommitmentStore, type CommitmentStoreLike } from './store.js';

/** The Commitments reads and the one status write, over a real database. */

let container: StartedPostgreSqlContainer;
let db: Db;
let store: CommitmentStoreLike;

const insert = async (overrides: Partial<NewCommitment> = {}): Promise<string> => {
  const id = newUlid();
  await db.insert(commitments).values({
    id,
    direction: 'inbound',
    ownerPersonId: 'per-ann',
    counterpartyPersonId: 'per-ann',
    description: 'Send the signed order form',
    dueAt: new Date('2026-09-18T17:00:00.000Z'),
    dueConfidence: 0.8,
    evidenceQuote: 'I will get the order form over to you by Friday',
    sourceRefs: [
      { system: 'graph', recordId: 'AAMk2', hash: 'h2', observedAt: '2026-09-14T09:00:00.000Z' },
    ],
    status: 'open',
    ...overrides,
  });
  return id;
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  store = createCommitmentStore(db);
}, 300000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('createCommitmentStore', () => {
  it('reads one commitment by id and nothing for an id it does not hold', async () => {
    const id = await insert();

    expect((await store.get(id))?.description).toBe('Send the signed order form');
    expect(await store.get(newUlid())).toBeNull();
  });

  it('reads only the direction and status it was asked for', async () => {
    const outbound = await insert({ direction: 'outbound', description: 'Send the SOW' });
    await insert({ status: 'done', description: 'Confirm the start date' });

    const rows = await store.list({ limit: 50, direction: 'outbound', status: 'open' });

    expect(rows.map((row) => row.id)).toEqual([outbound]);
  });

  it('continues from the cursor it was given, newest first', async () => {
    const page = await store.list({ limit: 1 });
    const next = await store.list({ limit: 50, cursor: page[0]?.id ?? '' });

    expect(next.every((row) => row.id < (page[0]?.id ?? ''))).toBe(true);
  });

  it('sets the status and stamps the row as updated', async () => {
    const id = await insert();
    const at = new Date('2026-09-21T09:00:00.000Z');

    const updated = await store.setStatus({ id, from: ['open', 'chased'], to: 'done', at });

    expect(updated?.status).toBe('done');
    expect(updated?.updatedAt.toISOString()).toBe('2026-09-21T09:00:00.000Z');
  });

  it('changes nothing when the commitment has left the statuses it may move from', async () => {
    const id = await insert({ status: 'dropped' });

    expect(
      await store.setStatus({
        id,
        from: ['open', 'chased'],
        to: 'done',
        at: new Date('2026-09-21T09:00:00.000Z'),
      }),
    ).toBeNull();
    expect((await store.get(id))?.status).toBe('dropped');
  });
});
