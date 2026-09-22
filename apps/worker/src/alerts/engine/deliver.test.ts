import { alerts, createDb, proposals, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { newUlid } from '@lance/shared';
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

  it('does not redraw an alert that was folded into a batch post when it repeats', async () => {
    const before = updates.length;
    await raise('watcher_failed', 'P1', 'watcher:b');
    const result = await deliverAlerts({
      db,
      config,
      slack,
      webUrl: null,
      now: () => '2026-09-22T13:06:00.000Z',
    });
    const row = (await db.select().from(alerts).where(eq(alerts.dedupeKey, 'watcher:b')))[0];
    expect(row?.count).toBe(2);
    expect(row?.slackTs).toBeNull();
    expect(row?.batchTs).not.toBeNull();
    expect(result.updated).not.toContain(row?.id);
    expect(result.posted).not.toContain(row?.id);
    expect(updates.length).toBe(before);
  });

  it('redraws an acked card when the alert repeats', async () => {
    const row = (await db.select().from(alerts).where(eq(alerts.dedupeKey, 'token:graph')))[0]!;
    await db
      .update(alerts)
      .set({ status: 'acked', ackedBy: 'user:dom', ackedAt: new Date(WORKING) })
      .where(eq(alerts.id, row.id));
    await raise('token_refresh_failed', 'P0', 'token:graph');
    const result = await deliverAlerts({
      db,
      config,
      slack,
      webUrl: null,
      now: () => '2026-09-22T13:07:00.000Z',
    });
    expect(result.updated).toContain(row.id);
    expect(updates.at(-1)).toBe(row.slackTs);
  });

  it('reopens a resolved alert with a fresh card when the condition returns', async () => {
    const before = (await db.select().from(alerts).where(eq(alerts.dedupeKey, 'watcher:a')))[0]!;
    await db.update(alerts).set({ status: 'resolved' }).where(eq(alerts.id, before.id));
    const raised = await raise('watcher_failed', 'P1', 'watcher:a');
    expect(raised).toMatchObject({ alertId: before.id, created: false, reopened: true });
    const reopened = (await db.select().from(alerts).where(eq(alerts.id, before.id)))[0];
    expect(reopened).toMatchObject({ status: 'open', slackTs: null, count: before.count + 1 });
    const result = await deliverAlerts({
      db,
      config,
      slack,
      webUrl: null,
      now: () => '2026-09-23T10:00:00.000Z',
    });
    expect(result.posted).toContain(before.id);
    const posted = (await db.select().from(alerts).where(eq(alerts.id, before.id)))[0];
    expect(posted?.slackTs).not.toBe(before.slackTs);
  });

  it('keeps a muted alert muted when it repeats, and reopens it once the mute has lapsed', async () => {
    await raise('watcher_failed', 'P1', 'watcher:lapsed');
    const row = (await db.select().from(alerts).where(eq(alerts.dedupeKey, 'watcher:lapsed')))[0]!;
    await db
      .update(alerts)
      .set({ status: 'suppressed', mutedUntil: new Date('2026-09-24T00:00:00.000Z') })
      .where(eq(alerts.id, row.id));
    const stillMuted = await raiseAlert(db, {
      kind: 'watcher_failed',
      severity: 'P1',
      dedupeKey: 'watcher:lapsed',
      title: 'again',
      body: 'again',
      actor: 'system:test',
      now: () => '2026-09-23T12:00:00.000Z',
    });
    expect(stillMuted.reopened).toBe(false);
    expect((await db.select().from(alerts).where(eq(alerts.id, row.id)))[0]?.status).toBe(
      'suppressed',
    );
    const lapsed = await raiseAlert(db, {
      kind: 'watcher_failed',
      severity: 'P1',
      dedupeKey: 'watcher:lapsed',
      title: 'again',
      body: 'again',
      actor: 'system:test',
      now: () => '2026-09-24T09:00:00.000Z',
    });
    expect(lapsed.reopened).toBe(true);
    expect((await db.select().from(alerts).where(eq(alerts.id, row.id)))[0]).toMatchObject({
      status: 'open',
      count: 3,
    });
  });

  it('delivers only P0 while the system is paused', async () => {
    await raise('token_refresh_failed', 'P0', 'token:paused');
    await raise('watcher_failed', 'P1', 'watcher:paused');
    const result = await deliverAlerts({
      db,
      config,
      slack,
      webUrl: null,
      paused: true,
      now: () => '2026-09-24T12:00:00.000Z',
    });
    const p0 = (await db.select().from(alerts).where(eq(alerts.dedupeKey, 'token:paused')))[0];
    const p1 = (await db.select().from(alerts).where(eq(alerts.dedupeKey, 'watcher:paused')))[0];
    expect(result.posted).toEqual([p0?.id]);
    expect(result.deferred).toContain(p1?.id);
  });

  it('posts a proposal card the budget held back once the hour allows', async () => {
    // Flush the alerts earlier tests left pending so the next hour starts clear.
    await deliverAlerts({ db, config, slack, webUrl: null, now: () => '2026-09-25T12:00:00.000Z' });
    const id = newUlid();
    await db.insert(proposals).values({
      id,
      correlationId: newUlid(),
      actionClass: 'draft_email',
      counterpartyClass: 'client',
      targetSystem: 'graph',
      reversibility: 'reversible',
      payload: { input: { subject: 'Revised SOW' } },
      preview: 'Draft a reply to Ann Example about the revised SOW.',
      rationale: 'Ann asked for the revised SOW on Monday.',
      provenance: [{ system: 'graph', recordId: 'm1', hash: 'h', observedAt: WORKING }],
      policyDecision: 'propose',
      status: 'pending',
      expiresAt: new Date('2026-09-26T12:00:00.000Z'),
    });
    const result = await deliverAlerts({
      db,
      config,
      slack,
      webUrl: null,
      now: () => '2026-09-25T13:30:00.000Z',
    });
    expect(result.proposalCards).toEqual([id]);
    const row = (await db.select().from(proposals).where(eq(proposals.id, id)))[0];
    expect(row?.slackTs).toBe(posts.at(-1)?.ts);
    expect(posts.at(-1)?.text).toContain('Draft a reply to Ann');
    expect(await pushesInLastHour(db, '2026-09-25T13:30:00.000Z')).toBe(1);
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
