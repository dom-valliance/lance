import { createDb, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { SystemControl } from '@lance/ledger';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, startBoss } from '../scheduler/boss.js';
import { PauseGate } from '../scheduler/gate.js';
import { registerWatcher, watcherQueue, type TriageJob } from './runner.js';
import type { Watcher } from './types.js';

/**
 * The worker's boot path registers every watcher with real pg-boss, which
 * validates queue names and schedule keys. This test runs that path so a
 * name pg-boss rejects fails here rather than at the first start in Azure.
 */

let container: StartedPostgreSqlContainer;
let db: Db;
let boss: PgBoss;

const watcher: Watcher = {
  name: 'graph-mail',
  sourceSystem: 'graph',
  schedules: ['*/10 7-19 * * 1-5', '0 */2 * * *'],
  partitions: () => Promise.resolve([]),
  poll: () => Promise.resolve({ records: [], nextCursor: null }),
  normalise: () => Promise.reject(new Error('never polled')),
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  boss = createBoss(db);
  await startBoss(boss);
}, 120000);

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.$client.end();
  await container.stop();
});

describe('registerWatcher', () => {
  it('registers a watcher with every schedule under names pg-boss accepts', async () => {
    const control = new SystemControl(db);
    await registerWatcher(
      boss,
      {
        db,
        gate: new PauseGate(control),
        control,
        enqueueTriage: () => Promise.resolve(),
      },
      watcher,
      'Europe/London',
    );

    const schedules = await boss.getSchedules();
    const registered = schedules.filter((schedule) => schedule.name === watcherQueue(watcher));
    expect(registered.map((schedule) => schedule.cron).sort()).toEqual(
      [...watcher.schedules].sort(),
    );
  }, 30000);
});
