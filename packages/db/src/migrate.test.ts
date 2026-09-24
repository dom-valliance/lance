import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import { startPostgresContainer } from './testing.js';

/**
 * The migration suite runs against the same image production and CI use
 * (ADR 0004) because the guarantees under test are database guarantees:
 * extensions, roles, grants and the `ledger_immutable` trigger.
 */

/** insufficient_privilege: the statement was stopped by a missing grant. */
const PERMISSION_DENIED = '42501';
/** raise_exception: the statement was stopped by the trigger. */
const RAISED_BY_TRIGGER = 'P0001';
/** check_violation. */
const CHECK_VIOLATION = '23514';

const EXPECTED_TABLES = [
  'agent_runs',
  'alerts',
  'briefs',
  'commitments',
  'cursors',
  'jobs',
  'ledger_events',
  'observations',
  'policy_decisions',
  'policy_rules',
  'principal_state',
  'principals',
  'proposals',
  'slack_link_tokens',
  'slack_links',
  'slack_request_nonces',
  'system_state',
  'users',
] as const;

const ULID_PREFIX = '01K5S9V6QW3SWCCPVB0N0E30';
const LEDGER_APP_ROW = `${ULID_PREFIX}1A`;
const LEDGER_GUARD_ROW = `${ULID_PREFIX}1B`;
const LEDGER_RETENTION_ROW = `${ULID_PREFIX}1C`;
const LEDGER_RETENTION_LOCKED_ROW = `${ULID_PREFIX}1D`;
const CORRELATION = `${ULID_PREFIX}9Z`;
const PRINCIPAL = `${ULID_PREFIX}0P`;

const INSERT_LEDGER_EVENT = `
  INSERT INTO ledger_events (id, ts, actor, kind, correlation_id, payload, payload_hash)
  VALUES ($1, now(), 'agent:triage@1.4.0', 'observed', $2, $3::jsonb, 'sha256:fixture')
`;

interface QueryFailure {
  readonly code: string;
  readonly message: string;
}

let container: StartedPostgreSqlContainer;
let client: pg.Client;

const query = async <Row extends pg.QueryResultRow>(
  sql: string,
  values: readonly unknown[] = [],
): Promise<Row[]> => {
  const result = await client.query<Row>(sql, [...values]);
  return result.rows;
};

/** Run a statement that must be rejected, and return why it was rejected. */
const rejectionOf = async (sql: string, values: readonly unknown[] = []): Promise<QueryFailure> => {
  try {
    await client.query(sql, [...values]);
  } catch (error) {
    if (error instanceof pg.DatabaseError) {
      return { code: error.code ?? 'unknown', message: error.message };
    }
    throw error;
  }
  throw new Error(`Expected the database to reject this statement, and it succeeded: ${sql}`);
};

/** Run work with the session role narrowed, then restore the superuser. */
const asRole = async <T>(role: string, work: () => Promise<T>): Promise<T> => {
  await client.query(`SET ROLE ${role}`);
  try {
    return await work();
  } finally {
    await client.query('RESET ROLE');
  }
};

beforeAll(async () => {
  container = await startPostgresContainer();

  await runMigrations({ connectionString: container.getConnectionUri() });

  client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();

  // The group roles are NOLOGIN, so the matrix runs as throwaway login roles
  // that hold membership, exactly as the Container App identities do.
  await client.query("CREATE ROLE test_app LOGIN PASSWORD 'test'");
  await client.query('GRANT lance_app TO test_app');
  await client.query("CREATE ROLE test_retention LOGIN PASSWORD 'test'");
  await client.query('GRANT lance_retention TO test_retention');

  // Ledger rows belong to a principal, and forced row-level security shows
  // a non-superuser only the rows of the principal its session is scoped to
  // (ADR 0015). The setting survives SET ROLE, so every role below is scoped.
  await client.query("INSERT INTO principals (id, upn) VALUES ($1, 'principal@example.test')", [
    PRINCIPAL,
  ]);
  await client.query("SELECT set_config('app.principal', $1, false)", [PRINCIPAL]);

  for (const id of [LEDGER_GUARD_ROW, LEDGER_RETENTION_ROW, LEDGER_RETENTION_LOCKED_ROW]) {
    await client.query(INSERT_LEDGER_EVENT, [id, CORRELATION, JSON.stringify({ body: 'raw' })]);
  }
});

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe('the migration history', () => {
  it('installs the age and vector extensions', async () => {
    const rows = await query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector') ORDER BY extname",
    );
    expect(rows.map((row) => row.extname)).toEqual(['age', 'vector']);
  });

  it('creates the lance_ontology graph', async () => {
    const rows = await query<{ name: string }>(
      "SELECT name::text AS name FROM ag_catalog.ag_graph WHERE name = 'lance_ontology'",
    );
    expect(rows).toHaveLength(1);
  });

  it('creates the three group roles', async () => {
    const rows = await query<{ rolname: string; rolcanlogin: boolean }>(
      `SELECT rolname, rolcanlogin FROM pg_roles
       WHERE rolname IN ('lance_app', 'lance_migrator', 'lance_retention')
       ORDER BY rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'lance_app', rolcanlogin: false },
      { rolname: 'lance_migrator', rolcanlogin: false },
      { rolname: 'lance_retention', rolcanlogin: false },
    ]);
  });

  it('creates every table in spec section 5.1', async () => {
    const rows = await query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(rows.map((row) => row.tablename)).toEqual([...EXPECTED_TABLES]);
  });

  it('creates no Lance-native tasks table, because tasks live in Notion', async () => {
    const rows = await query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'tasks%'",
    );
    expect(rows).toEqual([]);
  });

  it('gives lance_migrator ownership of every relational table', async () => {
    const rows = await query<{ tableowner: string }>(
      `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`,
    );
    expect(rows).toEqual([{ tableowner: 'lance_migrator' }]);
  });

  it('rejects a second system_state row', async () => {
    const failure = await rejectionOf('INSERT INTO system_state (id) VALUES (2)');
    expect(failure.code).toBe(CHECK_VIOLATION);
    expect(failure.message).toContain('system_state_single_row');
  });

  it('applies nothing on a second run', async () => {
    const before = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    );

    await expect(
      runMigrations({ connectionString: container.getConnectionUri() }),
    ).resolves.toBeUndefined();

    const after = await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    );
    expect(after).toEqual(before);
  });
});

describe('the ledger as lance_app', () => {
  it('accepts an INSERT', async () => {
    await asRole('test_app', async () => {
      await query(INSERT_LEDGER_EVENT, [
        LEDGER_APP_ROW,
        CORRELATION,
        JSON.stringify({ body: 'raw' }),
      ]);
    });

    const rows = await query<{ id: string }>('SELECT id FROM ledger_events WHERE id = $1', [
      LEDGER_APP_ROW,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('cannot null a payload, because the role holds no UPDATE grant', async () => {
    const failure = await asRole('test_app', () =>
      rejectionOf('UPDATE ledger_events SET payload = NULL WHERE id = $1', [LEDGER_GUARD_ROW]),
    );
    expect(failure.code).toBe(PERMISSION_DENIED);
  });

  it('cannot DELETE', async () => {
    const failure = await asRole('test_app', () =>
      rejectionOf('DELETE FROM ledger_events WHERE id = $1', [LEDGER_GUARD_ROW]),
    );
    expect(failure.code).toBe(PERMISSION_DENIED);
  });
});

describe('the ledger as the superuser', () => {
  // A superuser is implicitly a member of every role, so the trigger clears
  // its retention check and stops the statement on the changed-column check
  // instead. Either way the ledger row is unchanged.
  it('rejects an UPDATE on the trigger', async () => {
    const failure = await rejectionOf(
      "UPDATE ledger_events SET actor = 'user:attacker' WHERE id = $1",
      [LEDGER_GUARD_ROW],
    );
    expect(failure.code).toBe(RAISED_BY_TRIGGER);
    expect(failure.message).toContain('ADR 0011');
  });

  it('rejects a DELETE on the trigger', async () => {
    const failure = await rejectionOf('DELETE FROM ledger_events WHERE id = $1', [
      LEDGER_GUARD_ROW,
    ]);
    expect(failure.code).toBe(RAISED_BY_TRIGGER);
    expect(failure.message).toContain('append-only');
  });

  it('rejects a TRUNCATE on the trigger', async () => {
    const failure = await rejectionOf('TRUNCATE ledger_events');
    expect(failure.code).toBe(RAISED_BY_TRIGGER);
    expect(failure.message).toContain('TRUNCATE is rejected');
  });
});

describe('the ledger as lance_retention', () => {
  it('nulls a payload and leaves payload_hash intact', async () => {
    await asRole('test_retention', async () => {
      await query('UPDATE ledger_events SET payload = NULL WHERE id = $1', [LEDGER_RETENTION_ROW]);
    });

    const rows = await query<{ payload: unknown; payload_hash: string }>(
      'SELECT payload, payload_hash FROM ledger_events WHERE id = $1',
      [LEDGER_RETENTION_ROW],
    );
    expect(rows).toEqual([{ payload: null, payload_hash: 'sha256:fixture' }]);
  });

  it('cannot rewrite a payload to a value', async () => {
    const failure = await asRole('test_retention', () =>
      rejectionOf(`UPDATE ledger_events SET payload = '{"body":"edited"}'::jsonb WHERE id = $1`, [
        LEDGER_RETENTION_LOCKED_ROW,
      ]),
    );
    expect(failure.code).toBe(RAISED_BY_TRIGGER);
    expect(failure.message).toContain('only set payload to NULL');
  });

  it('cannot change another column alongside the payload', async () => {
    const failure = await asRole('test_retention', () =>
      rejectionOf(
        "UPDATE ledger_events SET payload = NULL, actor = 'system:retention' WHERE id = $1",
        [LEDGER_RETENTION_LOCKED_ROW],
      ),
    );
    expect(failure.code).toBe(PERMISSION_DENIED);
  });

  it('cannot DELETE', async () => {
    const failure = await asRole('test_retention', () =>
      rejectionOf('DELETE FROM ledger_events WHERE id = $1', [LEDGER_RETENTION_LOCKED_ROW]),
    );
    expect(failure.code).toBe(PERMISSION_DENIED);
  });

  it('cannot INSERT', async () => {
    const failure = await asRole('test_retention', () =>
      rejectionOf(INSERT_LEDGER_EVENT, [
        `${ULID_PREFIX}2A`,
        CORRELATION,
        JSON.stringify({ body: 'raw' }),
      ]),
    );
    expect(failure.code).toBe(PERMISSION_DENIED);
  });
});
