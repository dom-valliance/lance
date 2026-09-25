import { ledgerEvents, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobControl } from './jobs.js';

/**
 * The job rows behind the registry (ADR 0025), against a real container
 * and as a lance_app member, so row-level security applies as it does in
 * the apps.
 */

const ACTOR = { actor: 'system:scheduler' };
const DECLARED = [
  { slug: 'brief-morning', locked: false },
  { slug: 'alerts-deliver', locked: true },
];

let container: StartedPostgreSqlContainer;
let db: Db;
let control: JobControl;

const jobEvents = async (): Promise<Record<string, unknown>[]> => {
  const rows = await db
    .select({ payload: ledgerEvents.payload })
    .from(ledgerEvents)
    .where(eq(ledgerEvents.kind, 'state_changed'));
  return rows
    .map((row) => row.payload as Record<string, unknown>)
    .filter((payload) => payload['change'] === 'job' || payload['change'] === 'jobs_declared');
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  control = new JobControl(db);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('JobControl', () => {
  it('creates each declared job once, enabled, and records the creation', async () => {
    const first = await control.ensure(DECLARED, ACTOR);
    expect(first.created.sort()).toEqual(['alerts-deliver', 'brief-morning']);
    const second = await control.ensure(DECLARED, ACTOR);
    expect(second).toEqual({ created: [], relocked: [] });

    const rows = await control.list();
    expect(rows.map((row) => [row.slug, row.enabled, row.locked, row.origin])).toEqual([
      ['alerts-deliver', true, true, 'system'],
      ['brief-morning', true, false, 'system'],
    ]);
    expect((await jobEvents()).filter((event) => event['change'] === 'jobs_declared')).toHaveLength(
      1,
    );
  });

  it('disables a job and records the old and new values', async () => {
    const result = await control.setEnabled('brief-morning', false, { actor: 'user:dom' });
    expect(result.status).toBe('changed');
    const events = (await jobEvents()).filter((event) => event['change'] === 'job');
    expect(events.at(-1)).toEqual({
      change: 'job',
      slug: 'brief-morning',
      old: { enabled: true, scheduleOverride: null },
      new: { enabled: false, scheduleOverride: null },
    });
    const again = await control.setEnabled('brief-morning', true, { actor: 'user:dom' });
    expect(again.status).toBe('changed');
  });

  it('refuses to disable a locked job and leaves it enabled', async () => {
    const result = await control.setEnabled('alerts-deliver', false, { actor: 'user:dom' });
    expect(result.status).toBe('locked');
    const row = (await control.list()).find((job) => job.slug === 'alerts-deliver');
    expect(row?.enabled).toBe(true);
  });

  it('says a slug is unknown rather than creating a row for it', async () => {
    const result = await control.setEnabled('no-such-job', false, { actor: 'user:dom' });
    expect(result).toEqual({ status: 'unknown', slug: 'no-such-job' });
  });

  it('brings a row whose lock changed in the registry back into line', async () => {
    const result = await control.ensure([{ slug: 'brief-morning', locked: true }], ACTOR);
    expect(result.relocked).toEqual(['brief-morning']);
    const row = (await control.list()).find((job) => job.slug === 'brief-morning');
    expect(row?.locked).toBe(true);
  });
});
