import { alerts, scopedDb, SEED_PRINCIPAL_ID, runMigrations, type Db } from '@lance/db';
import { openAppTestDb, openFixtureDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOSS_SCHEMA, createBoss, startBoss } from '../scheduler/boss.js';
import { adoptUnscopedJobs, PRINCIPAL_QUEUES } from './adoptUnscoped.js';

/**
 * Adoption over a real pg-boss and database, as a lance_app member. The
 * jobs are queued the way a Phase 4 image queued them: no principal in the
 * payload and no group.
 */

const DOM = 'dom@valliance.ai';
const QUEUE_NAMES = ['execute', 'brief-morning', 'chase'];

let container: StartedPostgreSqlContainer;
let root: Db;
let fixture: Db;
let boss: PgBoss;

interface JobRow {
  id: string;
  name: string;
  state: string;
  data: Record<string, unknown> | null;
  group_id: string | null;
  output: Record<string, unknown> | null;
}

const jobsOn = async (queue: string): Promise<JobRow[]> =>
  (
    await fixture.$client.query(
      `SELECT id, name, state, data, group_id, output FROM ${BOSS_SCHEMA}.job WHERE name = $1 ORDER BY created_on`,
      [queue],
    )
  ).rows as JobRow[];

const payloads = async (principalId: string): Promise<Record<string, unknown>[]> =>
  (await new LedgerReader(scopedDb(root, { principalId })).query({}))
    .map((event) => (event.payload ?? {}) as Record<string, unknown>)
    .filter((payload) => payload['change'] === 'jobs_adopted');

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  root = await openAppTestDb(url);
  fixture = openFixtureDb(url);
  boss = createBoss(root);
  await startBoss(boss);
  for (const queue of QUEUE_NAMES) await boss.createQueue(queue);
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

beforeEach(async () => {
  await fixture.$client.query(`DELETE FROM ${BOSS_SCHEMA}.job`);
});

describe('adopting jobs queued without a principal', () => {
  it('covers every per-principal queue', () => {
    expect(PRINCIPAL_QUEUES).toEqual(
      expect.arrayContaining(['execute', 'triage', 'bulk-mail', 'chase', 'brief-morning']),
    );
  });

  it('re-sends each waiting job for the only principal, in their group, and completes the original', async () => {
    const execute = await boss.send('execute', { proposalId: '01K5S9V6QW3SWCCPVB0N0E3P01' });
    const brief = await boss.send('brief-morning', {});

    const result = await adoptUnscopedJobs({ boss, root, fallbackAdminUpn: DOM });

    expect(result.held).toEqual([]);
    expect(result.adopted.map((adopted) => adopted.from).sort()).toEqual([execute, brief].sort());
    const [original, replacement] = await jobsOn('execute');
    expect(original?.state).toBe('completed');
    expect(original?.output).toMatchObject({ principalId: SEED_PRINCIPAL_ID });
    expect(replacement?.state).toBe('created');
    expect(replacement?.data).toEqual({
      proposalId: '01K5S9V6QW3SWCCPVB0N0E3P01',
      principalId: SEED_PRINCIPAL_ID,
    });
    expect(replacement?.group_id).toBe(SEED_PRINCIPAL_ID);
    expect((await jobsOn('brief-morning'))[1]?.data).toEqual({ principalId: SEED_PRINCIPAL_ID });
  });

  it('records what it adopted in the owner ledger', async () => {
    const execute = await boss.send('execute', { proposalId: '01K5S9V6QW3SWCCPVB0N0E3P02' });

    const result = await adoptUnscopedJobs({ boss, root, fallbackAdminUpn: DOM });

    const recorded = (await payloads(SEED_PRINCIPAL_ID)).at(0);
    expect(recorded?.['jobs']).toEqual([
      { queue: 'execute', from: execute, to: result.adopted[0]?.to },
    ]);
  });

  it('leaves jobs that already name a principal alone', async () => {
    await boss.send('chase', { principalId: SEED_PRINCIPAL_ID, commitmentId: 'c1' });

    const result = await adoptUnscopedJobs({ boss, root, fallbackAdminUpn: DOM });

    expect(result).toEqual({ adopted: [], held: [] });
    expect((await jobsOn('chase')).map((job) => job.state)).toEqual(['created']);
  });

  describe('with a second principal', () => {
    let second: string;

    beforeEach(async () => {
      second = newUlid();
      await fixture.$client.query(
        "INSERT INTO principals (id, upn, status) VALUES ($1, $2, 'active')",
        [second, `second.${second.toLowerCase()}@example.test`],
      );
    });

    it('adopts a job queued before the second principal existed for the first', async () => {
      const job = await boss.send('execute', { proposalId: '01K5S9V6QW3SWCCPVB0N0E3P03' });
      await fixture.$client.query(
        `UPDATE ${BOSS_SCHEMA}.job SET created_on = (SELECT created_at FROM principals WHERE id = $1) WHERE id = $2`,
        [SEED_PRINCIPAL_ID, job],
      );

      const result = await adoptUnscopedJobs({ boss, root, fallbackAdminUpn: DOM });

      expect(result.adopted).toEqual([
        expect.objectContaining({ from: job, principalId: SEED_PRINCIPAL_ID }),
      ]);
    });

    it('refuses to guess for a job queued once two principals existed, and alerts the admin', async () => {
      const job = await boss.send('execute', { proposalId: '01K5S9V6QW3SWCCPVB0N0E3P04' });

      const result = await adoptUnscopedJobs({ boss, root, fallbackAdminUpn: DOM });

      expect(result.adopted).toEqual([]);
      expect(result.held).toEqual([{ queue: 'execute', jobId: job }]);
      expect((await jobsOn('execute')).map((row) => row.state)).toEqual(['created']);
      const raised = await scopedDb(root, { principalId: SEED_PRINCIPAL_ID }).select().from(alerts);
      expect(raised.some((alert) => alert.kind === 'unscoped_jobs_held')).toBe(true);
      const elsewhere = await scopedDb(root, { principalId: second }).select().from(alerts);
      expect(elsewhere).toEqual([]);
    });
  });
});
