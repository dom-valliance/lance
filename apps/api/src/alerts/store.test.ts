import { alerts, createDb, runMigrations, seed, type Db, type NewAlert } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAlertStore, type AlertStoreLike } from './store.js';

/** The Alerts reads and the one status write, over a real database. */

let container: StartedPostgreSqlContainer;
let db: Db;
let store: AlertStoreLike;

const insert = async (overrides: Partial<NewAlert> = {}): Promise<string> => {
  const id = newUlid();
  await db.insert(alerts).values({
    id,
    severity: 'P1',
    kind: 'client_mail_unanswered',
    dedupeKey: `thread:${id}`,
    title: 'No reply in three working days',
    body: 'The thread "the pilot" has had no reply since Tuesday.',
    provenance: [
      { system: 'graph', recordId: 'AAMk3', hash: 'h3', observedAt: '2026-09-20T09:00:00.000Z' },
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
  store = createAlertStore(db);
}, 300000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('createAlertStore', () => {
  it('reads one alert by id and nothing for an id it does not hold', async () => {
    const id = await insert();

    expect((await store.get(id))?.kind).toBe('client_mail_unanswered');
    expect(await store.get(newUlid())).toBeNull();
  });

  it('reads only the status, severity and kind it was asked for', async () => {
    const wanted = await insert({ severity: 'P0', kind: 'token_refresh_failed' });
    await insert({ severity: 'P0', kind: 'breaker_open' });
    await insert({ severity: 'P0', kind: 'token_refresh_failed', status: 'resolved' });

    const rows = await store.list({
      limit: 50,
      status: 'open',
      severity: 'P0',
      kind: 'token_refresh_failed',
    });

    expect(rows.map((row) => row.id)).toEqual([wanted]);
  });

  it('continues from the cursor it was given, newest first', async () => {
    const page = await store.list({ limit: 1 });
    const next = await store.list({ limit: 50, cursor: page[0]?.id ?? '' });

    expect(next.every((row) => row.id < (page[0]?.id ?? ''))).toBe(true);
  });

  it('records who acknowledged an alert and when', async () => {
    const id = await insert();
    const at = new Date('2026-09-21T09:00:00.000Z');

    const updated = await store.setStatus({
      id,
      from: ['open'],
      to: 'acked',
      at,
      ackedBy: 'user:dom',
    });

    expect(updated?.status).toBe('acked');
    expect(updated?.ackedBy).toBe('user:dom');
    expect(updated?.ackedAt?.toISOString()).toBe('2026-09-21T09:00:00.000Z');
  });

  it('suppresses an alert until the moment the mute names', async () => {
    const id = await insert();
    const mutedUntil = new Date('2026-09-22T09:00:00.000Z');

    const updated = await store.setStatus({
      id,
      from: ['open', 'acked', 'suppressed'],
      to: 'suppressed',
      at: new Date('2026-09-21T09:00:00.000Z'),
      mutedUntil,
    });

    expect(updated?.status).toBe('suppressed');
    expect(updated?.mutedUntil?.toISOString()).toBe('2026-09-22T09:00:00.000Z');
    expect(updated?.ackedBy).toBeNull();
  });

  it('changes nothing when the alert has left the statuses it may move from', async () => {
    const id = await insert({ status: 'resolved' });

    expect(
      await store.setStatus({
        id,
        from: ['open'],
        to: 'acked',
        at: new Date('2026-09-21T09:00:00.000Z'),
      }),
    ).toBeNull();
    expect((await store.get(id))?.status).toBe('resolved');
  });
});
