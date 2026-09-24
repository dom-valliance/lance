import { startPostgresContainer } from '@lance/db/testing';
import { createDb, runMigrations, scopedDb, SEED_PRINCIPAL_ID, seed, type Db } from '@lance/db';
import { hashRecord, isUlid, newUlid, type LedgerEventInputCandidate } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerReader } from './reader.js';
import { rebuildObservations } from './rebuild.js';
import { LedgerWriter } from './writer.js';

/**
 * The ledger suite runs against the image production and CI use (ADR 0004),
 * as the migration suite in `@lance/db` does, because the guarantees under
 * test are database guarantees as much as code ones.
 *
 * Everything the writer and reader do here runs as a throwaway LOGIN role
 * holding `lance_app` and nothing else, so a case that passes proves what the
 * three Container Apps can do, not what a superuser can (non-negotiable 1).
 * Only the observations rebuild uses the superuser, which is the role the
 * migration job holds.
 */

/** insufficient_privilege: the statement was stopped by a missing grant. */
const PERMISSION_DENIED = '42501';

const APP_ROLE = 'test_ledger_app';
const APP_PASSWORD = 'test';

interface QueryFailure {
  readonly code: string;
  readonly message: string;
}

let container: StartedPostgreSqlContainer;
let superuser: pg.Client;
let app: pg.Client;
let appDb: Db;
let migratorDb: Db;
let writer: LedgerWriter;
let reader: LedgerReader;

/** Raw SQL as the application role, for the assertions Drizzle cannot make. */
const query = async <Row extends pg.QueryResultRow>(
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row[]> => {
  const result = await app.query<Row>(sql, [...values]);
  return result.rows;
};

const oneRow = async <Row extends pg.QueryResultRow>(
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row> => {
  const rows = await query<Row>(sql, values);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected exactly one row from: ${sql}`);
  }
  return row;
};

/** Run a statement that must be rejected, and return why it was rejected. */
const rejectionOf = async (sql: string, values: readonly unknown[] = []): Promise<QueryFailure> => {
  try {
    await app.query(sql, [...values]);
  } catch (error) {
    if (error instanceof pg.DatabaseError) {
      return { code: error.code ?? 'unknown', message: error.message };
    }
    throw error;
  }
  throw new Error(`Expected the database to reject this statement, and it succeeded: ${sql}`);
};

const ledgerCount = async (): Promise<number> => {
  const row = await oneRow<{ count: string }>('SELECT count(*)::text AS count FROM ledger_events');
  return Number(row.count);
};

const event = (overrides: Partial<LedgerEventInputCandidate> = {}): LedgerEventInputCandidate => ({
  ts: '2026-09-20T09:00:00.000Z',
  actor: 'agent:triage@1.4.0',
  kind: 'resolved',
  correlationId: newUlid(),
  ...overrides,
});

const observedEvent = (
  overrides: Partial<LedgerEventInputCandidate> = {},
): LedgerEventInputCandidate =>
  event({
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: 'message-1',
    sourceRecordHash: 'sha256:message-1',
    idempotencyKey: `graph:message-1:${newUlid()}`,
    ...overrides,
  });

beforeAll(async () => {
  container = await startPostgresContainer();

  await runMigrations({ connectionString: container.getConnectionUri() });

  superuser = new pg.Client({ connectionString: container.getConnectionUri() });
  await superuser.connect();

  // lance_app is NOLOGIN, so the suite runs as a throwaway login role that
  // holds membership, exactly as the Container App identities do.
  await superuser.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
  await superuser.query(`GRANT lance_app TO ${APP_ROLE}`);

  const appUri = `postgresql://${APP_ROLE}:${APP_PASSWORD}@${container.getHost()}:${String(
    container.getPort(),
  )}/${container.getDatabase()}`;

  app = new pg.Client({ connectionString: appUri });
  await app.connect();
  // Forced row-level security shows a session only its principal's rows
  // (ADR 0015); the raw client takes the same scope as the handles below.
  await app.query("SELECT set_config('app.principal', $1, false)", [SEED_PRINCIPAL_ID]);

  const migratorRoot = createDb({
    connectionString: container.getConnectionUri(),
    password: container.getPassword(),
  });
  await seed(migratorRoot);
  appDb = scopedDb(createDb({ connectionString: appUri, password: APP_PASSWORD }), {
    principalId: SEED_PRINCIPAL_ID,
  });
  migratorDb = scopedDb(migratorRoot, { principalId: SEED_PRINCIPAL_ID });

  writer = new LedgerWriter(appDb);
  reader = new LedgerReader(appDb);
});

afterAll(async () => {
  await appDb?.$client.end();
  await migratorDb?.$client.end();
  await app?.end();
  await superuser?.end();
  await container?.stop();
});

describe('LedgerWriter.append', () => {
  it('returns a new ULID and writes a row the reader finds by correlation id', async () => {
    const correlationId = newUlid();

    const result = await writer.append(event({ correlationId, payload: { note: 'first' } }));

    expect(result.inserted).toBe(true);
    expect(isUlid(result.id)).toBe(true);
    const rows = await reader.byCorrelation(correlationId);
    expect(rows.map((row) => row.id)).toEqual([result.id]);
    expect(rows[0]?.actor).toBe('agent:triage@1.4.0');
    expect(rows[0]?.kind).toBe('resolved');
  });

  it('stores payload_hash as hashRecord of the payload', async () => {
    const payload = { subject: 'Renewal', from: 'client@example.com' };

    const result = await writer.append(event({ payload }));

    const row = await oneRow<{ payload_hash: string }>(
      'SELECT payload_hash FROM ledger_events WHERE id = $1',
      [result.id],
    );
    expect(row.payload_hash).toBe(hashRecord(payload));
  });

  it('hashes the same payload identically whatever order its keys were written in', async () => {
    const first = await writer.append(
      event({ payload: { alpha: 1, nested: { x: 1, y: 2 }, zulu: 'last' } }),
    );
    const second = await writer.append(
      event({ payload: { zulu: 'last', nested: { y: 2, x: 1 }, alpha: 1 } }),
    );

    const rows = await query<{ payload_hash: string }>(
      'SELECT payload_hash FROM ledger_events WHERE id = ANY($1::char(26)[]) ',
      [[first.id, second.id]],
    );
    const hashes = rows.map((row) => row.payload_hash);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).toBe(hashRecord({ alpha: 1, nested: { x: 1, y: 2 }, zulu: 'last' }));
  });

  it('returns the first id with inserted false when the same idempotency key is appended twice', async () => {
    const idempotencyKey = `graph:message-2:${newUlid()}`;
    const input = observedEvent({ idempotencyKey, payload: { summary: 'Renewal thread' } });

    const first = await writer.append(input);
    const second = await writer.append(input);

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ id: first.id, inserted: false });
    const row = await oneRow<{ count: string }>(
      'SELECT count(*)::text AS count FROM ledger_events WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    expect(row.count).toBe('1');
  });

  it('inserts both events when neither carries an idempotency key', async () => {
    const correlationId = newUlid();

    const first = await writer.append(event({ correlationId, payload: { note: 'no key' } }));
    const second = await writer.append(event({ correlationId, payload: { note: 'no key' } }));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.id).not.toBe(first.id);
    const rows = await reader.byCorrelation(correlationId);
    expect(rows).toHaveLength(2);
  });
});

describe('an observed event', () => {
  it('materialises an observations row with the ledger id, summary and labels', async () => {
    const correlationId = newUlid();
    const input = observedEvent({
      correlationId,
      sourceRecordId: 'message-3',
      sourceRecordHash: 'sha256:message-3',
      idempotencyKey: `graph:message-3:${newUlid()}`,
      payload: {
        summary: 'Client asks for the renewal quote',
        labels: ['Deals', 'Action'],
        body: 'raw',
      },
    });

    const result = await writer.append(input);

    const row = await oneRow<{
      id: string;
      summary: string | null;
      labels: string[];
      source_system: string;
      source_record_id: string;
      source_record_hash: string;
      idempotency_key: string;
      correlation_id: string;
    }>('SELECT * FROM observations WHERE id = $1', [result.id]);
    expect(row.id).toBe(result.id);
    expect(row.summary).toBe('Client asks for the renewal quote');
    expect(row.labels).toEqual(['Deals', 'Action']);
    expect(row.source_system).toBe('graph');
    expect(row.source_record_id).toBe('message-3');
    expect(row.source_record_hash).toBe('sha256:message-3');
    expect(row.correlation_id).toBe(correlationId);
  });

  it('writes no observations row when the event is not observed', async () => {
    const result = await writer.append(
      event({
        kind: 'executed',
        sourceSystem: 'notion',
        sourceRecordId: 'page-1',
        sourceRecordHash: 'sha256:page-1',
        idempotencyKey: `notion:page-1:${newUlid()}`,
        payload: { summary: 'Task created', labels: ['Action'] },
      }),
    );

    const rows = await query<{ id: string }>('SELECT id FROM observations WHERE id = $1', [
      result.id,
    ]);
    expect(rows).toEqual([]);
  });
});

describe('an observed event without full provenance', () => {
  const base = {
    ts: '2026-09-20T09:00:00.000Z',
    actor: 'agent:inbox@1.0.0',
    kind: 'observed',
    correlationId: newUlid(),
    payload: { summary: 'Missing provenance' },
  } as const;

  const incomplete: ReadonlyArray<{ missing: string; input: LedgerEventInputCandidate }> = [
    {
      missing: 'sourceSystem',
      input: {
        ...base,
        sourceRecordId: 'message-4',
        sourceRecordHash: 'sha256:message-4',
        idempotencyKey: 'graph:message-4:sha256',
      },
    },
    {
      missing: 'sourceRecordId',
      input: {
        ...base,
        sourceSystem: 'graph',
        sourceRecordHash: 'sha256:message-4',
        idempotencyKey: 'graph:message-4:sha256',
      },
    },
    {
      missing: 'sourceRecordHash',
      input: {
        ...base,
        sourceSystem: 'graph',
        sourceRecordId: 'message-4',
        idempotencyKey: 'graph:message-4:sha256',
      },
    },
    {
      missing: 'idempotencyKey',
      input: {
        ...base,
        sourceSystem: 'graph',
        sourceRecordId: 'message-4',
        sourceRecordHash: 'sha256:message-4',
      },
    },
  ];

  for (const testCase of incomplete) {
    it(`throws without writing anything when ${testCase.missing} is missing`, async () => {
      const before = await ledgerCount();

      await expect(writer.append(testCase.input)).rejects.toThrow(
        /needs sourceSystem, sourceRecordId, sourceRecordHash and idempotencyKey/,
      );

      expect(await ledgerCount()).toBe(before);
    });
  }
});

describe('the ledger as lance_app', () => {
  let guardEventId: string;

  beforeAll(async () => {
    const result = await writer.append(event({ payload: { body: 'raw' } }));
    guardEventId = result.id;
  });

  it('cannot null a payload, because the role holds no UPDATE grant', async () => {
    const failure = await rejectionOf('UPDATE ledger_events SET payload = NULL WHERE id = $1', [
      guardEventId,
    ]);

    expect(failure.code).toBe(PERMISSION_DENIED);
    expect(failure.message).toContain('permission denied');
    const row = await oneRow<{ payload: Record<string, unknown> | null }>(
      'SELECT payload FROM ledger_events WHERE id = $1',
      [guardEventId],
    );
    expect(row.payload).toEqual({ body: 'raw' });
  });

  it('cannot DELETE a ledger event', async () => {
    const before = await ledgerCount();

    const failure = await rejectionOf('DELETE FROM ledger_events WHERE id = $1', [guardEventId]);

    expect(failure.code).toBe(PERMISSION_DENIED);
    expect(await ledgerCount()).toBe(before);
  });
});

describe('LedgerReader.query', () => {
  const correlationId = newUlid();
  const ACTOR_A = 'agent:reader-a@1.0.0';
  const ACTOR_B = 'agent:reader-b@2.0.0';
  const specs = [
    { ts: '2026-03-01T09:00:00.000Z', kind: 'resolved', actor: ACTOR_A, sourceSystem: 'graph' },
    { ts: '2026-03-02T09:00:00.000Z', kind: 'proposed', actor: ACTOR_B, sourceSystem: 'notion' },
    { ts: '2026-03-03T09:00:00.000Z', kind: 'executed', actor: ACTOR_B, sourceSystem: 'graph' },
    { ts: '2026-03-04T09:00:00.000Z', kind: 'decided', actor: ACTOR_A, sourceSystem: 'notion' },
  ] as const;
  const ids: string[] = [];

  beforeAll(async () => {
    for (const spec of specs) {
      const result = await writer.append(event({ ...spec, correlationId }));
      ids.push(result.id);
    }
  });

  it('filters by kind', async () => {
    const rows = await reader.query({ correlationId, kind: 'executed' });
    expect(rows.map((row) => row.id)).toEqual([ids[2]]);
  });

  it('filters by actor', async () => {
    const rows = await reader.query({ correlationId, actor: ACTOR_B });
    expect(rows.map((row) => row.id)).toEqual([ids[2], ids[1]]);
  });

  it('filters by source system', async () => {
    const rows = await reader.query({ correlationId, sourceSystem: 'notion' });
    expect(rows.map((row) => row.id)).toEqual([ids[3], ids[1]]);
  });

  it('filters by correlation id', async () => {
    const rows = await reader.query({ correlationId });
    expect(rows.map((row) => row.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
  });

  it('filters by from, inclusive of the boundary', async () => {
    const rows = await reader.query({ correlationId, from: '2026-03-03T09:00:00.000Z' });
    expect(rows.map((row) => row.id)).toEqual([ids[3], ids[2]]);
  });

  it('filters by to, inclusive of the boundary', async () => {
    const rows = await reader.query({ correlationId, to: '2026-03-02T09:00:00.000Z' });
    expect(rows.map((row) => row.id)).toEqual([ids[1], ids[0]]);
  });

  it('filters by from and to together', async () => {
    const rows = await reader.query({
      correlationId,
      from: '2026-03-02T00:00:00.000Z',
      to: '2026-03-03T12:00:00.000Z',
    });
    expect(rows.map((row) => row.id)).toEqual([ids[2], ids[1]]);
  });

  it('honours limit and returns the newest rows first', async () => {
    const rows = await reader.query({ correlationId, limit: 2 });
    expect(rows.map((row) => row.id)).toEqual([ids[3], ids[2]]);
  });

  it('counts every row the filters match, to included, with no limit', async () => {
    expect(await reader.count({ correlationId })).toBe(4);
    expect(await reader.count({ correlationId, actor: ACTOR_B })).toBe(2);
    expect(await reader.count({ correlationId, to: '2026-03-02T09:00:00.000Z' })).toBe(2);
    expect(
      await reader.count({
        correlationId,
        kind: 'decided',
        sourceSystem: 'notion',
        from: '2026-03-04T00:00:00.000Z',
      }),
    ).toBe(1);
  });

  it('returns the oldest row first for byCorrelation', async () => {
    const rows = await reader.byCorrelation(correlationId);
    expect(rows.map((row) => row.id)).toEqual([ids[0], ids[1], ids[2], ids[3]]);
  });
});

describe('LedgerReader.query keyset paging', () => {
  const correlationId = newUlid();
  const ids: string[] = [];

  beforeAll(async () => {
    // Two events stamped with the same instant, either side of one older one.
    const specs = [
      { ts: '2026-04-01T09:00:00.000Z', kind: 'resolved', actor: 'agent:pager@1.0.0' },
      { ts: '2026-04-02T09:00:00.000Z', kind: 'resolved', actor: 'agent:pager@1.0.0' },
      { ts: '2026-04-02T09:00:00.000Z', kind: 'resolved', actor: 'agent:pager@1.0.0' },
    ] as const;
    for (const spec of specs) {
      const result = await writer.append(event({ ...spec, sourceSystem: 'lance', correlationId }));
      ids.push(result.id);
    }
  });

  it('orders events that share an instant by id, newest first', async () => {
    const tied = [ids[1]!, ids[2]!].sort().reverse();

    const rows = await reader.query({ correlationId });

    expect(rows.map((row) => row.id)).toEqual([...tied, ids[0]]);
  });

  it('neither repeats nor skips an event that shares an instant across a page boundary', async () => {
    const all = (await reader.query({ correlationId })).map((row) => row.id);

    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const rows = await reader.query({
        correlationId,
        limit: 1,
        ...(after === undefined ? {} : { after }),
      });
      if (rows.length === 0) break;
      seen.push(...rows.map((row) => row.id));
      after = rows.at(-1)?.id;
    }

    expect(seen).toEqual(all);
  });

  it('counts every event the filters match, whatever page is being read', async () => {
    expect(await reader.count({ correlationId })).toBe(3);
  });

  it('reads one event by id, and nothing for an id no event carries', async () => {
    expect((await reader.get(ids[0]!))?.correlationId).toBe(correlationId);
    expect(await reader.get(newUlid())).toBeNull();
  });
});

describe('LedgerReader.query row limits', () => {
  const correlationId = newUlid();

  beforeAll(async () => {
    // The cap only shows above 2000 rows, and the writer appends one at a
    // time, so these go in as one statement under the same lance_app grant
    // the writer uses. `cost_recorded` keeps them out of the observations
    // rebuild, which only reads observed events.
    await query(
      `INSERT INTO ledger_events (id, ts, actor, kind, correlation_id, payload_hash)
       SELECT '01K5S9V6QW3SWCCPVB0N0E' || to_char(g, 'FM0000'),
              timestamptz '2026-05-01 00:00:00+00' + (g * interval '1 second'),
              'system:bulk', 'cost_recorded', $1, 'sha256:bulk'
       FROM generate_series(1, 2001) AS g`,
      [correlationId],
    );
  });

  it('returns 200 rows when no limit is given', async () => {
    const rows = await reader.query({ correlationId });
    expect(rows).toHaveLength(200);
  });

  it('caps a larger limit at 2000 rows', async () => {
    const rows = await reader.query({ correlationId, limit: 5000 });
    expect(rows).toHaveLength(2000);
  });

  it('counts past the row cap', async () => {
    expect(await reader.count({ correlationId })).toBe(2001);
  });
});

describe('malformed input', () => {
  it('is rejected by Zod before any write when the actor does not match the pattern', async () => {
    const before = await ledgerCount();

    await expect(writer.append(event({ actor: 'Dom' }))).rejects.toThrow(/agent:name@x\.y\.z/);

    expect(await ledgerCount()).toBe(before);
  });

  it('is rejected by Zod before any write when the correlation id is not a ULID', async () => {
    const before = await ledgerCount();

    await expect(writer.append(event({ correlationId: 'not-a-ulid' }))).rejects.toThrow(
      /26-character Crockford base32 ULID/,
    );

    expect(await ledgerCount()).toBe(before);
  });
});

describe('rebuildObservations', () => {
  interface ObservationShape {
    id: string;
    summary: string | null;
    labels: string[];
  }

  it('restores exactly the rows the writer created', async () => {
    const before = await query<ObservationShape>(
      'SELECT id, summary, labels FROM observations ORDER BY id',
    );
    expect(before.length).toBeGreaterThan(0);
    const observed = await oneRow<{ count: string }>(
      "SELECT count(*)::text AS count FROM ledger_events WHERE kind = 'observed'",
    );
    // The application role cannot delete observations, so the migrator does.
    await superuser.query('DELETE FROM observations');
    expect(
      await oneRow<{ count: string }>('SELECT count(*)::text AS count FROM observations'),
    ).toEqual({ count: '0' });

    const { rebuilt } = await rebuildObservations(migratorDb);

    expect(rebuilt).toBe(Number(observed.count));
    const after = await query<ObservationShape>(
      'SELECT id, summary, labels FROM observations ORDER BY id',
    );
    expect(after).toEqual(before);
  });
});
