import { runMigrations, SEED_PRINCIPAL_ID, type Db } from '@lance/db';
import { openAppTestDb, openFixtureDb, startPostgresContainer } from '@lance/db/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExecuteQueue, type ExecuteQueue } from './executeQueue.js';

/**
 * The api's sends over a real pg-boss schema, as a lance_app member. The
 * worker runs one job of a principal's group at a time on each queue
 * (`localGroupConcurrency: 1`), which holds only for jobs sent in that
 * group, so every per-principal send from the api carries it.
 */

let container: StartedPostgreSqlContainer;
let root: Db;
let fixture: Db;
let queue: ExecuteQueue;

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  root = await openAppTestDb(connectionString);
  fixture = openFixtureDb(connectionString);
  queue = createExecuteQueue(root);
}, 120000);

afterAll(async () => {
  await queue?.stop();
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

const groupsOf = async (name: string): Promise<(string | null)[]> => {
  const result = await fixture.$client.query('SELECT group_id FROM pgboss.job WHERE name = $1', [
    name,
  ]);
  return (result.rows as { group_id: string | null }[]).map((row) => row.group_id);
};

describe('the api queue', () => {
  it("sends an execute job in the principal's group", async () => {
    await queue.enqueueExecute(SEED_PRINCIPAL_ID, '01K5S9V6QW3SWCCPVB0N0E3P01');
    expect(await groupsOf('execute')).toEqual([SEED_PRINCIPAL_ID]);
  });

  it("sends a brief in the principal's group, so it never runs beside the scheduled one", async () => {
    await queue.enqueueBrief(SEED_PRINCIPAL_ID);
    expect(await groupsOf('brief-morning')).toEqual([SEED_PRINCIPAL_ID]);
  });

  it("sends a chase in the principal's group", async () => {
    await queue.enqueueChase(SEED_PRINCIPAL_ID, '01K5S9V6QW3SWCCPVB0N0E3C01');
    expect(await groupsOf('chase')).toEqual([SEED_PRINCIPAL_ID]);
  });
});
