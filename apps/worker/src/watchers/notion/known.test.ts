import { createDb, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { hashRecord, newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNotionTaskIds } from './known.js';

/**
 * The list the removal sweep starts from, over a real database: the latest
 * observation of each All Tasks page decides, and closed or removed pages
 * are left out.
 */

let container: StartedPostgreSqlContainer;
let db: Db;

async function observe(
  system: 'notion' | 'jamie',
  recordId: string,
  ts: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const hash = hashRecord(payload);
  await new LedgerWriter(db).append({
    ts,
    actor: 'agent:watcher-test@0.1.0',
    kind: 'observed',
    sourceSystem: system,
    sourceRecordId: recordId,
    sourceRecordHash: hash,
    idempotencyKey: `${system}:${recordId}:${hash}`,
    correlationId: newUlid(),
    payload,
  });
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);

  await observe('notion', 'open-1', '2026-09-20T09:00:00.000Z', {
    kind: 'task',
    title: 'Still open',
    status: 'In Progress',
  });
  await observe('notion', 'no-status', '2026-09-20T09:00:00.000Z', {
    kind: 'task',
    title: 'Open with no status',
  });
  await observe('notion', 'closed-1', '2026-09-20T09:00:00.000Z', {
    kind: 'task',
    title: 'Was open',
    status: 'Not Started',
  });
  await observe('notion', 'closed-1', '2026-09-21T09:00:00.000Z', {
    kind: 'task',
    title: 'Was open',
    status: 'Done',
  });
  await observe('notion', 'gone-1', '2026-09-20T09:00:00.000Z', {
    kind: 'task',
    title: 'Was open then trashed',
    status: 'Not Started',
  });
  await observe('notion', 'gone-1', '2026-09-21T09:00:00.000Z', {
    kind: 'task',
    id: 'gone-1',
    removed: true,
  });
  // Recorded second with an earlier source stamp: the later record decides.
  await observe('notion', 'stale-1', '2026-09-22T09:00:00.000Z', {
    kind: 'task',
    title: 'Open by its stamp, closed by its latest read',
    status: 'In Progress',
  });
  await observe('notion', 'stale-1', '2026-09-20T09:00:00.000Z', {
    kind: 'task',
    title: 'Open by its stamp, closed by its latest read',
    status: 'Done',
  });
  await observe('notion', 'mt-1', '2026-09-20T09:00:00.000Z', {
    kind: 'meeting',
    name: 'Not a task',
  });
  await observe('jamie', 'jt-1', '2026-09-20T09:00:00.000Z', {
    kind: 'task',
    text: 'A Jamie item',
    completed: false,
  });
}, 300000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('openNotionTaskIds', () => {
  it('returns the Notion tasks whose latest observation is open, leaving out closed, removed and non-task rows', async () => {
    const ids = await openNotionTaskIds(db);
    expect(ids.sort()).toEqual(['no-status', 'open-1']);
  });

  it('judges by the most recently recorded observation, not the latest source stamp', async () => {
    const ids = await openNotionTaskIds(db);
    expect(ids).not.toContain('stale-1');
  });
});
