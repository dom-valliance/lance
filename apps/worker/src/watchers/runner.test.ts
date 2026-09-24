import { alerts, cursors, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, SystemControl } from '@lance/ledger';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PauseGate } from '../scheduler/gate.js';
import { resetPartitionBreaker, runWatcher, watcherStartedAt, type TriageJob } from './runner.js';
import type { SourceRecord, Watcher } from './types.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let control: SystemControl;
const triaged: TriageJob[] = [];

function fakeWatcher(overrides: Partial<Watcher> & { records: SourceRecord[] }): Watcher {
  return {
    name: overrides.name ?? 'fake-mail',
    sourceSystem: 'graph',
    schedules: ['*/10 * * * *'],
    partitions: () => Promise.resolve(['inbox']),
    poll: (_partition, cursor) =>
      Promise.resolve({
        records: overrides.records,
        nextCursor: `cursor-after-${cursor ?? 'start'}`,
      }),
    normalise: (record) =>
      Promise.resolve({
        sourceSystem: 'graph' as const,
        recordId: record.id,
        observedAt: record.observedAt,
        record: record.raw as Record<string, unknown>,
        correlationKey: (record.raw as { conversationId: string }).conversationId,
        summary: `subject of ${record.id}`,
        labels: ['Internal'],
      }),
    ...overrides,
  };
}

const records: SourceRecord[] = [
  { id: 'm1', observedAt: '2026-09-21T08:00:00.000Z', raw: { conversationId: 'c1', subject: 'a' } },
  { id: 'm2', observedAt: '2026-09-21T08:01:00.000Z', raw: { conversationId: 'c1', subject: 'b' } },
  { id: 'm3', observedAt: '2026-09-21T08:02:00.000Z', raw: { conversationId: 'c2', subject: 'c' } },
];

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  control = new SystemControl(db);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

const deps = () => ({
  db,
  gate: new PauseGate(control),
  control,
  enqueueTriage: (job: TriageJob) => {
    triaged.push(job);
    return Promise.resolve();
  },
});

describe('runWatcher', () => {
  it('records one observed event per record, groups triage by conversation and saves the cursor', async () => {
    const summary = await runWatcher(deps(), fakeWatcher({ records }));
    expect(summary.status).toBe('ran');
    expect(summary.partitions[0]).toMatchObject({
      status: 'ok',
      polled: 3,
      inserted: 3,
      duplicates: 0,
    });
    const observed = await new LedgerReader(db).query({ kind: 'observed' });
    expect(observed).toHaveLength(3);
    expect(new Set(observed.map((event) => event.correlationId)).size).toBe(2);
    expect(triaged).toHaveLength(2);
    expect(triaged.find((job) => job.observationEventIds.length === 2)).toBeDefined();
    const saved = await db.select().from(cursors).where(eq(cursors.watcher, 'fake-mail'));
    expect(saved.map((row) => row.key).sort()).toEqual(['__started_at', 'inbox']);
    expect(saved.find((row) => row.key === 'inbox')?.value).toBe('cursor-after-start');
    expect(await watcherStartedAt(db, 'fake-mail')).not.toBeNull();
  });

  it('inserts nothing when the same window is polled again', async () => {
    triaged.length = 0;
    const summary = await runWatcher(deps(), fakeWatcher({ records }));
    expect(summary.partitions[0]).toMatchObject({
      status: 'ok',
      polled: 3,
      inserted: 0,
      duplicates: 3,
    });
    expect(triaged).toHaveLength(0);
    expect(await new LedgerReader(db).query({ kind: 'observed' })).toHaveLength(3);
  });

  it('records a changed record as a new observation under the same correlation id', async () => {
    const changed: SourceRecord[] = [
      {
        id: 'm1',
        observedAt: '2026-09-21T09:00:00.000Z',
        raw: { conversationId: 'c1', subject: 'a (edited)' },
      },
    ];
    const summary = await runWatcher(deps(), fakeWatcher({ records: changed }));
    expect(summary.partitions[0]).toMatchObject({ inserted: 1 });
    const events = await new LedgerReader(db).query({ kind: 'observed', sourceSystem: 'graph' });
    const m1 = events.filter((event) => event.sourceRecordId === 'm1');
    expect(m1).toHaveLength(2);
    expect(new Set(m1.map((event) => event.correlationId)).size).toBe(1);
  });

  it('triages the records it could normalise and keeps the cursor when one record fails', async () => {
    triaged.length = 0;
    const watcher = fakeWatcher({
      name: 'partial-mail',
      records: [
        { id: 'ok-1', observedAt: '2026-09-21T09:00:00.000Z', raw: { conversationId: 'p1' } },
        { id: 'bad-1', observedAt: '2026-09-21T09:01:00.000Z', raw: { conversationId: 'p2' } },
        { id: 'ok-2', observedAt: '2026-09-21T09:02:00.000Z', raw: { conversationId: 'p3' } },
      ],
      normalise: (record) =>
        record.id.startsWith('bad')
          ? Promise.reject(new Error('schema drift'))
          : Promise.resolve({
              sourceSystem: 'graph' as const,
              recordId: record.id,
              observedAt: record.observedAt,
              record: record.raw as Record<string, unknown>,
              correlationKey: (record.raw as { conversationId: string }).conversationId,
              summary: record.id,
              labels: ['Internal'],
            }),
    });

    const summary = await runWatcher(deps(), watcher);

    expect(summary.partitions[0]).toMatchObject({ status: 'failed' });
    expect(triaged.map((job) => job.observationEventIds.length)).toEqual([1, 1]);
    const saved = await db
      .select({ value: cursors.value })
      .from(cursors)
      .where(eq(cursors.watcher, 'partial-mail'));
    expect(saved.map((row) => row.value)).not.toContain('cursor-after-start');
    resetPartitionBreaker('partial-mail', 'inbox');
  });

  it('records observations without enqueuing triage for a watcher that opts out', async () => {
    const before = triaged.length;
    const summary = await runWatcher(
      deps(),
      fakeWatcher({
        name: 'fake-logs',
        triage: false,
        records: [
          { id: 'log-1', observedAt: '2026-09-21T09:00:00.000Z', raw: { conversationId: 'l1' } },
        ],
      }),
    );
    expect(summary.partitions[0]).toMatchObject({ status: 'ok', inserted: 1 });
    expect(triaged).toHaveLength(before);
  });

  it('does nothing while paused', async () => {
    await control.pause({ reason: 'drill', actor: 'user:dom' });
    const summary = await runWatcher(deps(), fakeWatcher({ name: 'paused-watcher', records }));
    expect(summary).toEqual({ watcher: 'paused-watcher', status: 'paused', partitions: [] });
    await control.resume({ actor: 'user:dom' });
  });

  it('opens the partition breaker after three failures, raises one alert and skips the partition afterwards', async () => {
    const failing = fakeWatcher({
      name: 'broken',
      records: [],
      poll: () => Promise.reject(new Error('remote exploded')),
    });
    for (let i = 0; i < 3; i += 1) {
      const summary = await runWatcher(deps(), failing);
      expect(summary.partitions[0]?.status).toBe('failed');
    }
    const skipped = await runWatcher(deps(), failing);
    expect(skipped.partitions[0]?.status).toBe('skipped_breaker');
    const rows = await db.select().from(alerts).where(eq(alerts.dedupeKey, 'watcher:broken:inbox'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'watcher_failed',
      severity: 'P1',
      status: 'open',
      count: 1,
    });
    expect(rows[0]?.body).toContain('remote exploded');
    const raised = await new LedgerReader(db).query({ kind: 'alert_raised' });
    expect(raised).toHaveLength(1);
    resetPartitionBreaker('broken', 'inbox');
    expect((await runWatcher(deps(), failing)).partitions[0]?.status).toBe('failed');
  });
});
