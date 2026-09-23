import { createDb, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { hashRecord, newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestObservations } from './support.js';

/**
 * The detectors' "newest observation per record" read over a real
 * database, in the shape that bit the calendar: the delta first sent an
 * occurrence cut down to id, start and end, stamped with the poll time
 * because it carried no lastModifiedDateTime; the resync then recorded the
 * full event, stamped with its real, earlier modification time.
 */

let container: StartedPostgreSqlContainer;
let db: Db;

async function observe(recordId: string, ts: string, payload: Record<string, unknown>) {
  const hash = hashRecord(payload);
  await new LedgerWriter(db).append({
    ts,
    actor: 'agent:watcher-graph-calendar@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: recordId,
    sourceRecordHash: hash,
    idempotencyKey: `graph:${recordId}:${hash}`,
    correlationId: newUlid(),
    payload: { ...payload, watcher: 'graph-calendar' },
  });
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);

  await observe('occ-1', '2026-09-21T18:30:09.049Z', {
    id: 'occ-1',
    subject: null,
    start: { dateTime: '2026-09-23T11:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-23T11:15:00.0000000', timeZone: 'UTC' },
    attendees: [],
    lastModifiedDateTime: null,
    removed: false,
  });
  await observe('occ-1', '2026-09-21T10:37:21.702Z', {
    id: 'occ-1',
    subject: '[Viavi] Daily Sync',
    start: { dateTime: '2026-09-23T11:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-23T11:15:00.0000000', timeZone: 'UTC' },
    attendees: [{ name: 'Dom Selvon', address: 'dom@valliance.ai' }],
    lastModifiedDateTime: '2026-09-21T10:37:21.702897Z',
    removed: false,
  });
}, 300000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('latestObservations', () => {
  it('returns the most recently recorded observation even when its source stamp is older', async () => {
    const rows = await latestObservations(db, { sourceSystem: 'graph', watcher: 'graph-calendar' });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload['subject']).toBe('[Viavi] Daily Sync');
  });
});
