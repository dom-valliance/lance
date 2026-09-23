import { observations, SEED_PRINCIPAL_ID, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import { hashRecord, idempotencyKey, stableUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calendarConflictDetector } from './calendarConflict.js';
import type { DetectedAlert, DetectorContext } from './types.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;

/** Tuesday morning; 22 September is today and 23 September is tomorrow. */
const NOW = '2026-09-22T08:00:00.000Z';
const OBSERVED_AT = '2026-09-22T07:30:00.000Z';

const config = {
  timeZone: 'Europe/London',
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.8 },
  dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
  proposals: { expiryHours: 24 },
  briefs: { minFreeBlockHours: 2 },
};

const context = (): DetectorContext => ({ db, config, ontology, now: () => NOW });

const dom = (responseStatus: string) => ({
  name: 'Dom Selvon',
  address: 'dom@valliance.ai',
  type: 'required',
  responseStatus,
});

function event(
  id: string,
  start: string,
  end: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    subject: `Meeting ${id}`,
    start: { dateTime: start, timeZone: 'UTC' },
    end: { dateTime: end, timeZone: 'UTC' },
    isAllDay: false,
    isCancelled: false,
    removed: false,
    attendees: [dom('accepted')],
    ...overrides,
  };
}

/** Records an observation exactly as the graph-calendar watcher would. */
async function observe(record: Record<string, unknown>): Promise<string> {
  const id = record['id'] as string;
  const hash = hashRecord(record);
  await new LedgerWriter(db).append({
    ts: OBSERVED_AT,
    actor: 'agent:watcher-graph-calendar@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: id,
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey('graph', id, hash),
    correlationId: stableUlid(`graph:${id}`),
    payload: { ...record, watcher: 'graph-calendar', labels: ['Calendar'] },
  });
  return hash;
}

/** Only the alerts this test's own events produced. */
async function conflictsFor(prefix: string): Promise<DetectedAlert[]> {
  const alerts = await calendarConflictDetector.run(context());
  return alerts.filter((alert) => alert.dedupeKey.includes(prefix));
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  ontology = new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID });
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

// The ledger keeps every event; the detectors read observations, so each
// test starts from an empty calendar.
beforeEach(async () => {
  await db.delete(observations);
});

describe('calendarConflictDetector', () => {
  it('runs every fifteen minutes', () => {
    expect(calendarConflictDetector.schedule).toBe('*/15 * * * *');
  });

  it('raises a P1 for an overlapping pair, keyed on the sorted event ids and carrying both observations', async () => {
    const hashA = await observe(
      event('over-a', '2026-09-22T10:00:00.0000000', '2026-09-22T11:00:00.0000000'),
    );
    const hashB = await observe(
      event('over-b', '2026-09-22T10:30:00.0000000', '2026-09-22T11:30:00.0000000'),
    );

    const alerts = await conflictsFor('over-');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'calendar_conflict',
      severity: 'P1',
      dedupeKey: 'events:over-a:over-b',
    });
    expect(alerts[0]?.body).toContain('Suggested action');
    expect(alerts[0]?.provenance).toEqual([
      { system: 'graph', recordId: 'over-a', hash: hashA, observedAt: OBSERVED_AT },
      { system: 'graph', recordId: 'over-b', hash: hashB, observedAt: OBSERVED_AT },
    ]);
  });

  it('sorts the ids in the key however the events are ordered in time', async () => {
    await observe(event('sort-z', '2026-09-22T14:00:00.0000000', '2026-09-22T15:00:00.0000000'));
    await observe(event('sort-a', '2026-09-22T14:30:00.0000000', '2026-09-22T15:30:00.0000000'));
    expect((await conflictsFor('sort-'))[0]?.dedupeKey).toBe('events:sort-a:sort-z');
  });

  it('does not treat back-to-back meetings as a clash', async () => {
    await observe(event('touch-a', '2026-09-22T09:00:00.0000000', '2026-09-22T10:00:00.0000000'));
    await observe(event('touch-b', '2026-09-22T10:00:00.0000000', '2026-09-22T11:00:00.0000000'));
    expect(await conflictsFor('touch-')).toEqual([]);
  });

  it('ignores a meeting Dom has declined', async () => {
    await observe(event('decl-a', '2026-09-22T16:00:00.0000000', '2026-09-22T17:00:00.0000000'));
    await observe(
      event('decl-b', '2026-09-22T16:30:00.0000000', '2026-09-22T17:30:00.0000000', {
        attendees: [dom('declined')],
      }),
    );
    expect(await conflictsFor('decl-')).toEqual([]);
  });

  it('ignores an all-day marker and a cancelled or removed event', async () => {
    await observe(
      event('skip-day', '2026-09-22T00:00:00.0000000', '2026-09-23T00:00:00.0000000', {
        isAllDay: true,
      }),
    );
    await observe(
      event('skip-cancelled', '2026-09-22T11:00:00.0000000', '2026-09-22T12:00:00.0000000', {
        isCancelled: true,
      }),
    );
    await observe(
      event('skip-removed', '2026-09-22T11:15:00.0000000', '2026-09-22T12:15:00.0000000', {
        removed: true,
      }),
    );
    await observe(event('skip-live', '2026-09-22T11:30:00.0000000', '2026-09-22T12:30:00.0000000'));
    expect(await conflictsFor('skip-')).toEqual([]);
  });

  it('resolves a Windows zone name before comparing the times', async () => {
    // 10:00 "GMT Standard Time" in September is 09:00 UTC, so it overlaps.
    await observe(
      event('zone-a', '2026-09-22T10:00:00.0000000', '2026-09-22T11:00:00.0000000', {
        start: { dateTime: '2026-09-22T10:00:00.0000000', timeZone: 'GMT Standard Time' },
        end: { dateTime: '2026-09-22T11:00:00.0000000', timeZone: 'GMT Standard Time' },
      }),
    );
    await observe(event('zone-b', '2026-09-22T09:30:00.0000000', '2026-09-22T10:30:00.0000000'));
    expect((await conflictsFor('zone-'))[0]?.dedupeKey).toBe('events:zone-a:zone-b');
  });

  it('covers tomorrow but nothing beyond it', async () => {
    await observe(event('near-a', '2026-09-23T10:00:00.0000000', '2026-09-23T11:00:00.0000000'));
    await observe(event('near-b', '2026-09-23T10:30:00.0000000', '2026-09-23T11:30:00.0000000'));
    await observe(event('far-a', '2026-09-25T10:00:00.0000000', '2026-09-25T11:00:00.0000000'));
    await observe(event('far-b', '2026-09-25T10:30:00.0000000', '2026-09-25T11:30:00.0000000'));

    expect((await conflictsFor('near-'))[0]?.dedupeKey).toBe('events:near-a:near-b');
    expect(await conflictsFor('far-')).toEqual([]);
  });

  it('reads the newest observation of an event, so a move clears the clash', async () => {
    await observe(event('move-a', '2026-09-22T13:00:00.0000000', '2026-09-22T14:00:00.0000000'));
    await observe(event('move-b', '2026-09-22T13:30:00.0000000', '2026-09-22T14:30:00.0000000'));
    expect(await conflictsFor('move-')).toHaveLength(1);

    await new LedgerWriter(db).append({
      ts: '2026-09-22T07:45:00.000Z',
      actor: 'agent:watcher-graph-calendar@0.1.0',
      kind: 'observed',
      sourceSystem: 'graph',
      sourceRecordId: 'move-b',
      sourceRecordHash: hashRecord(
        event('move-b', '2026-09-22T15:00:00.0000000', '2026-09-22T16:00:00.0000000'),
      ),
      idempotencyKey: idempotencyKey(
        'graph',
        'move-b',
        hashRecord(event('move-b', '2026-09-22T15:00:00.0000000', '2026-09-22T16:00:00.0000000')),
      ),
      correlationId: stableUlid('graph:move-b'),
      payload: {
        ...event('move-b', '2026-09-22T15:00:00.0000000', '2026-09-22T16:00:00.0000000'),
        watcher: 'graph-calendar',
        labels: ['Calendar'],
      },
    });

    expect(await conflictsFor('move-')).toEqual([]);
  });
});
