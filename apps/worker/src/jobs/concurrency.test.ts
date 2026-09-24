import { runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { loadConfig, newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoss, startBoss, work, type WorkQueueOptions } from '../scheduler/boss.js';
import { QUEUES } from '../scheduler/queues.js';
import { modelQueueOptions, principalQueueOptions } from './handlers.js';
import { declarationFor } from './registry.js';
import { principalJobOptions, threadJobOptions } from './scoped.js';

/**
 * Load-test option A (ADR 0034) against a real pg-boss: the mail watcher
 * and triage queues run several jobs at once, never two of one
 * principal's. The worker options and send options are the ones the
 * worker registers and sends with; the handler only records when each job
 * ran.
 */

const A = '01K5S9V6QW3SWCCPVB0N0E3AAA';
const B = '01K5S9V6QW3SWCCPVB0N0E3BBB';
const JOB_MS = 400;

let container: StartedPostgreSqlContainer;
let db: Db;
let boss: PgBoss;
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
});

interface Run {
  principalId: string;
  start: number;
  end: number;
}

const overlaps = (left: Run, right: Run): boolean =>
  left.start < right.end && right.start < left.end;

function pairs(runs: readonly Run[], same: boolean): Array<[Run, Run]> {
  const found: Array<[Run, Run]> = [];
  runs.forEach((left, index) => {
    for (const right of runs.slice(index + 1)) {
      if ((left.principalId === right.principalId) === same) found.push([left, right]);
    }
  });
  return found;
}

/** Registers a recording handler on `queue`, sends three jobs per principal and waits for all six. */
async function runSix(
  queue: string,
  options: WorkQueueOptions,
  send: (principalId: string, n: number) => Promise<string | null>,
): Promise<Run[]> {
  const runs: Run[] = [];
  await boss.createQueue(queue);
  await work<{ principalId: string }>(
    boss,
    queue,
    async (jobs) => {
      for (const job of jobs) {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, JOB_MS));
        runs.push({ principalId: job.data.principalId, start, end: Date.now() });
      }
    },
    options,
  );
  for (let n = 0; n < 3; n += 1) {
    await send(A, n);
    await send(B, n);
  }
  const deadline = Date.now() + 30_000;
  while (runs.length < 6 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(runs).toHaveLength(6);
  return runs;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  boss = createBoss(db);
  await startBoss(boss);
}, 120_000);

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.$client.end();
  await container.stop();
});

describe('model-bound queues', () => {
  it("run two principals' triage jobs at the same time and never one principal's together", async () => {
    const runs = await runSix(QUEUES.triage, modelQueueOptions(config), (principalId) =>
      boss.send(
        QUEUES.triage,
        { principalId, correlationId: newUlid() },
        threadJobOptions(principalId, newUlid()),
      ),
    );
    expect(pairs(runs, true).filter(([left, right]) => overlaps(left, right))).toEqual([]);
    expect(pairs(runs, false).some(([left, right]) => overlaps(left, right))).toBe(true);
  }, 60_000);

  it("run two principals' mail polls at the same time and never one principal's together", async () => {
    const mail = declarationFor('watcher-graph-mail');
    if (mail === undefined) throw new Error('The mail watcher is not declared.');
    const runs = await runSix(mail.slug, principalQueueOptions(mail, config), (principalId) =>
      boss.send(mail.slug, { principalId }, principalJobOptions(principalId)),
    );
    expect(pairs(runs, true).filter(([left, right]) => overlaps(left, right))).toEqual([]);
    expect(pairs(runs, false).some(([left, right]) => overlaps(left, right))).toBe(true);
  }, 60_000);
});
