import { alerts, createDb, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { raiseAlert } from '../raise.js';
import { pushesInLastHour } from './budget.js';
import { deliverAlerts } from './deliver.js';

let container: StartedPostgreSqlContainer;
let db: Db;
const posts: { text: string; ts: string }[] = [];
const updates: string[] = [];
let counter = 0;

const config = {
  timeZone: 'Europe/London',
  interruption: { quietHoursStart: '19:00', quietHoursEnd: '07:00', pushBudgetPerHour: 2 },
  agentDisplayName: 'Lance',
};

const slack = {
  post: (input: { text: string }) => {
    const ts = `1.${String(++counter)}`;
    posts.push({ text: input.text, ts });
    return Promise.resolve({ channel: 'C1', ts });
  },
  update: (input: { ts: string }) => {
    updates.push(input.ts);
    return Promise.resolve({ channel: 'C1', ts: input.ts });
  },
};

const WORKING = '2026-09-22T13:00:00.000Z';
const NIGHT = '2026-09-22T21:00:00.000Z';

async function raise(
  kind: 'watcher_failed' | 'token_refresh_failed' | 'proposal_expiring',
  severity: 'P0' | 'P1' | 'P2',
  key: string,
) {
  return raiseAlert(db, {
    kind,
    severity,
    dedupeKey: key,
    title: `${kind} ${key}`,
    body: 'body',
    actor: 'system:test',
    provenance: [{ system: 'lance', recordId: key, hash: 'h', observedAt: WORKING }],
  });
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('deliverAlerts', () => {
  it('posts a P0 during quiet hours and defers a P1 until working hours', async () => {
    await raise('token_refresh_failed', 'P0', 'token:graph');
    await raise('watcher_failed', 'P1', 'watcher:a');
    const night = await deliverAlerts({ db, config, slack, webUrl: null, now: () => NIGHT });
    expect(night.posted).toHaveLength(1);
    expect(night.deferred).toHaveLength(1);
    const day = await deliverAlerts({ db, config, slack, webUrl: null, now: () => WORKING });
    expect(day.posted).toHaveLength(1);
    expect(await pushesInLastHour(db, WORKING)).toBe(2);
  });

  it('never pushes a P2', async () => {
    await raise('proposal_expiring', 'P2', 'proposal:1');
    const result = await deliverAlerts({ db, config, slack, webUrl: null, now: () => WORKING });
    expect(result.posted).toEqual([]);
    const row = (await db.select().from(alerts).where(eq(alerts.dedupeKey, 'proposal:1')))[0];
    expect(row?.slackTs).toBeNull();
  });

  it('folds pushes beyond the hourly budget into one batch post with a link', async () => {
    await raise('watcher_failed', 'P1', 'watcher:b');
    await raise('watcher_failed', 'P1', 'watcher:c');
    const before = posts.length;
    const result = await deliverAlerts({
      db,
      config,
      slack,
      webUrl: 'https://web.test',
      now: () => WORKING,
    });
    expect(result.posted).toEqual([]);
    expect(result.batched).toHaveLength(2);
    expect(posts.length - before).toBe(1);
    expect(posts.at(-1)?.text).toContain('2 more alerts');
    expect(posts.at(-1)?.text).toContain('https://web.test/alerts');
  });

  it('updates the existing card when a delivered alert repeats', async () => {
    await raise('token_refresh_failed', 'P0', 'token:graph');
    const result = await deliverAlerts({
      db,
      config,
      slack,
      webUrl: null,
      now: () => '2026-09-22T13:05:00.000Z',
    });
    expect(result.updated).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  it('does not deliver a muted alert', async () => {
    await raise('watcher_failed', 'P1', 'watcher:muted');
    await db
      .update(alerts)
      .set({ mutedUntil: new Date('2026-09-23T13:00:00.000Z') })
      .where(eq(alerts.dedupeKey, 'watcher:muted'));
    const result = await deliverAlerts({
      db,
      config,
      slack,
      webUrl: null,
      now: () => '2026-09-22T15:00:00.000Z',
    });
    expect(result.posted).not.toContain(
      (await db.select().from(alerts).where(eq(alerts.dedupeKey, 'watcher:muted')))[0]?.id,
    );
  });
});
