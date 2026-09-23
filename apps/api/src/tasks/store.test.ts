import { runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { hashRecord, newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTaskStore, type TaskStoreLike } from './store.js';

/**
 * The Tasks read over a real database: the DISTINCT ON that keeps the
 * latest observation of each record, and the filters the page sends.
 */

let container: StartedPostgreSqlContainer;
let db: Db;
let store: TaskStoreLike;

const observe = async (input: {
  system: 'notion' | 'jamie';
  recordId: string;
  ts: string;
  payload: Record<string, unknown>;
}): Promise<void> => {
  const hash = hashRecord(input.payload);
  await new LedgerWriter(db).append({
    ts: input.ts,
    actor: 'agent:watcher-test@0.1.0',
    kind: 'observed',
    sourceSystem: input.system,
    sourceRecordId: input.recordId,
    sourceRecordHash: hash,
    idempotencyKey: `${input.system}:${input.recordId}:${hash}`,
    correlationId: newUlid(),
    payload: input.payload,
  });
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  store = createTaskStore(db);

  await observe({
    system: 'notion',
    recordId: 'page-1',
    ts: '2026-09-19T09:00:00.000Z',
    payload: { kind: 'task', title: 'Draft the pilot scope', status: 'Not Started' },
  });
  await observe({
    system: 'notion',
    recordId: 'page-1',
    ts: '2026-09-20T09:00:00.000Z',
    payload: { kind: 'task', title: 'Draft the pilot scope', status: 'Done' },
  });
  await observe({
    system: 'notion',
    recordId: 'page-2',
    ts: '2026-09-20T10:00:00.000Z',
    payload: { kind: 'task', title: 'Book the review', status: 'In Progress' },
  });
  await observe({
    system: 'jamie',
    recordId: 'task-1',
    ts: '2026-09-20T11:00:00.000Z',
    payload: { kind: 'task', text: 'Send the revised numbers', completed: false },
  });
  await observe({
    system: 'jamie',
    recordId: 'task-2',
    ts: '2026-09-20T12:00:00.000Z',
    payload: { kind: 'task', text: 'Share the transcript', completed: true },
  });
  // Recorded second with an earlier source stamp: a full re-read after a
  // cut-down one. The later record must win, whatever its `ts` says.
  await observe({
    system: 'notion',
    recordId: 'page-4',
    ts: '2026-09-21T18:30:00.000Z',
    payload: { kind: 'task', title: 'Stale open row', status: 'In Progress' },
  });
  await observe({
    system: 'notion',
    recordId: 'page-4',
    ts: '2026-09-20T10:37:00.000Z',
    payload: { kind: 'task', id: 'page-4', removed: true },
  });
  await observe({
    system: 'jamie',
    recordId: 'mt-1',
    ts: '2026-09-20T12:30:00.000Z',
    payload: { kind: 'meeting', title: 'Kick-off with Client Ltd' },
  });
  await observe({
    system: 'notion',
    recordId: 'page-3',
    ts: '2026-09-20T13:00:00.000Z',
    payload: { kind: 'task', title: 'Draft the agenda', status: 'Not Started' },
  });
  await observe({
    system: 'notion',
    recordId: 'page-3',
    ts: '2026-09-21T13:00:00.000Z',
    payload: { kind: 'task', id: 'page-3', removed: true },
  });
}, 300000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('createTaskStore', () => {
  it('reads one row per source record and leaves observations that are not tasks out', async () => {
    const rows = await store.list({ limit: 50 });

    expect(rows.map((row) => row.sourceRecordId).sort()).toEqual([
      'page-1',
      'page-2',
      'task-1',
      'task-2',
    ]);
  });

  it('leaves out a page whose latest observation says Notion removed it, under every filter', async () => {
    const all = await store.list({ limit: 50 });
    const open = await store.list({ limit: 50, status: 'open' });
    const done = await store.list({ limit: 50, status: 'done' });

    expect(all.map((row) => row.sourceRecordId)).not.toContain('page-3');
    expect(open.map((row) => row.sourceRecordId)).not.toContain('page-3');
    expect(done.map((row) => row.sourceRecordId)).not.toContain('page-3');
  });

  it('takes the most recently recorded observation, not the one with the latest source stamp', async () => {
    const all = await store.list({ limit: 50 });
    const open = await store.list({ limit: 50, status: 'open' });

    expect(all.map((row) => row.sourceRecordId)).not.toContain('page-4');
    expect(open.map((row) => row.sourceRecordId)).not.toContain('page-4');
  });

  it('keeps the latest observation of a record that changed', async () => {
    const rows = await store.list({ limit: 50 });
    const page = rows.find((row) => row.sourceRecordId === 'page-1');

    expect((page?.payload as { status?: string } | undefined)?.status).toBe('Done');
  });

  it('reads only the source it was asked for', async () => {
    const rows = await store.list({ limit: 50, source: 'jamie' });

    expect(rows.every((row) => row.sourceSystem === 'jamie')).toBe(true);
  });

  it('reads the open tasks of both sources', async () => {
    const rows = await store.list({ limit: 50, status: 'open' });

    expect(rows.map((row) => row.sourceRecordId).sort()).toEqual(['page-2', 'task-1']);
  });

  it('reads the done tasks of both sources', async () => {
    const rows = await store.list({ limit: 50, status: 'done' });

    expect(rows.map((row) => row.sourceRecordId).sort()).toEqual(['page-1', 'task-2']);
  });

  it('continues from the cursor it was given', async () => {
    const first = await store.list({ limit: 2 });
    const second = await store.list({ limit: 2, cursor: first[1]?.id ?? '' });

    expect(second.map((row) => row.id)).not.toContain(first[0]?.id);
    expect(second.every((row) => row.id < (first[1]?.id ?? ''))).toBe(true);
  });

  it('counts the same newest observations the list returns, under every filter', async () => {
    expect(await store.count({})).toBe(4);
    expect(await store.count({ status: 'open' })).toBe(2);
    expect(await store.count({ status: 'done' })).toBe(2);
    expect(await store.count({ source: 'jamie' })).toBe(2);
    expect(await store.count({ source: 'notion', status: 'done' })).toBe(1);
  });
});
