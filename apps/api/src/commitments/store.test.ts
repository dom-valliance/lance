import { commitments, observations, runMigrations, type Db, type NewCommitment } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCommitmentStore, type CommitmentStoreLike } from './store.js';

/** The Commitments reads and writes, over a real database. */

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
  db = await openSeededTestDb(connectionString);
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

  it('counts every commitment the filters match, the same rows the list would page through', async () => {
    const rows = await store.list({ limit: 1000, direction: 'inbound', status: 'open' });

    expect(await store.count({ direction: 'inbound', status: 'open' })).toBe(rows.length);
    expect(await store.count({})).toBe((await store.list({ limit: 1000 })).length);
  });

  it('summarises open and overdue commitments per direction, overdue being open and past due', async () => {
    const now = new Date('2026-09-21T09:00:00.000Z');
    const before = await store.summary(now);

    await insert({ direction: 'outbound', dueAt: new Date('2026-09-20T09:00:00.000Z') });
    await insert({ direction: 'outbound', dueAt: new Date('2026-09-22T09:00:00.000Z') });
    await insert({ direction: 'outbound', dueAt: null });
    await insert({ direction: 'outbound', status: 'chased', dueAt: new Date('2026-09-01') });
    await insert({ direction: 'inbound', dueAt: new Date('2026-09-19T09:00:00.000Z') });

    const after = await store.summary(now);

    expect(after.outbound.open - before.outbound.open).toBe(3);
    expect(after.outbound.overdue - before.outbound.overdue).toBe(1);
    expect(after.inbound.open - before.inbound.open).toBe(1);
    expect(after.inbound.overdue - before.inbound.overdue).toBe(1);
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

  it('applies an edit to a row unchanged since it was read', async () => {
    const id = await insert();
    const read = await store.get(id);
    const at = new Date('2026-09-22T09:00:00.000Z');

    const updated = await store.update({
      id,
      set: { description: 'Send the countersigned order form', dueAt: null, dueConfidence: null },
      unchangedSince: read?.updatedAt ?? new Date(0),
      at,
    });

    expect(updated?.description).toBe('Send the countersigned order form');
    expect(updated?.dueAt).toBeNull();
    expect(updated?.updatedAt.toISOString()).toBe(at.toISOString());
  });

  it('refuses an edit to a row that changed after it was read', async () => {
    const id = await insert();
    const read = await store.get(id);
    await store.setStatus({
      id,
      from: ['open'],
      to: 'chased',
      at: new Date('2026-09-22T10:00:00Z'),
    });

    const updated = await store.update({
      id,
      set: { description: 'Overwritten' },
      unchangedSince: read?.updatedAt ?? new Date(0),
      at: new Date('2026-09-22T11:00:00.000Z'),
    });

    expect(updated).toBeNull();
    expect((await store.get(id))?.description).toBe('Send the signed order form');
  });

  it('adds notes and reads them back oldest first', async () => {
    const id = await insert();
    const first = newUlid();
    await store.addNote({ id: first, commitmentId: id, body: 'Asked Ann', author: 'user:dom' });
    const second = newUlid();
    await store.addNote({ id: second, commitmentId: id, body: 'Ann replied', author: 'user:dom' });

    const notes = await store.notes(id);

    expect(notes.map((note) => note.body)).toEqual(['Asked Ann', 'Ann replied']);
    expect(notes[0]?.author).toBe('user:dom');
  });

  it('reads the newest observation of each cited record, skipping a removal', async () => {
    const observe = async (recordId: string, payload: unknown): Promise<void> => {
      const id = newUlid();
      await db.insert(observations).values({
        id,
        ts: new Date('2026-09-14T09:00:00.000Z'),
        sourceSystem: 'graph',
        sourceRecordId: recordId,
        sourceRecordHash: `hash-${id}`,
        idempotencyKey: `graph:${recordId}:${id}`,
        correlationId: newUlid(),
        summary: 'Dom: The order form',
        payload,
      });
    };
    await observe('AAMk-ctx', { subject: 'first read', bodyText: 'short' });
    await observe('AAMk-ctx', { subject: 'fuller read', bodyText: 'longer body' });
    await observe('AAMk-ctx', { id: 'AAMk-ctx', removed: true });
    await observe('AAMk-other', { subject: 'not cited' });

    const sources = await store.sources([
      { system: 'graph', recordId: 'AAMk-ctx' },
      { system: 'jamie', recordId: 'never-seen' },
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.payload).toEqual({ subject: 'fuller read', bodyText: 'longer body' });
  });

  it('reads no sources when none are cited', async () => {
    expect(await store.sources([])).toEqual([]);
  });
});
