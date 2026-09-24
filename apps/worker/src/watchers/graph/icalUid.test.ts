import { runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { icalUidOfGraphEvent } from './icalUid.js';

let container: StartedPostgreSqlContainer;
let db: Db;

async function observe(recordId: string, payload: Record<string, unknown>): Promise<void> {
  await new LedgerWriter(db).append({
    ts: '2026-09-21T08:00:00.000Z',
    actor: 'agent:watcher-graph-calendar@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: recordId,
    sourceRecordHash: newUlid(),
    idempotencyKey: `graph:${recordId}:${newUlid()}`,
    correlationId: newUlid(),
    payload,
  });
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('icalUidOfGraphEvent', () => {
  it("returns the iCalUId the principal's calendar recorded for a Graph event id", async () => {
    await observe('evt-1', { id: 'evt-1', iCalUId: 'ical-1', watcher: 'graph-calendar' });
    expect(await icalUidOfGraphEvent(db, 'evt-1')).toBe('ical-1');
  });

  it('keeps the iCalUId after a later removal observation that carries none', async () => {
    await observe('evt-2', { id: 'evt-2', iCalUId: 'ical-2', watcher: 'graph-calendar' });
    await observe('evt-2', {
      id: 'evt-2',
      iCalUId: null,
      removed: true,
      watcher: 'graph-calendar',
    });
    expect(await icalUidOfGraphEvent(db, 'evt-2')).toBe('ical-2');
  });

  it('returns null for an event the calendar never observed or a mail record with the same id', async () => {
    await observe('msg-1', { id: 'msg-1', iCalUId: 'not-a-calendar', watcher: 'graph-mail' });
    expect(await icalUidOfGraphEvent(db, 'msg-1')).toBeNull();
    expect(await icalUidOfGraphEvent(db, 'evt-unknown')).toBeNull();
  });
});
