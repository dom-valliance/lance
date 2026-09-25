import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { grantRetentionMember } from './grants.js';
import { runMigrations } from './migrate.js';
import { startPostgresContainer } from './testing.js';

/**
 * Runs the migrations the way Azure Flexible Server runs them: as a
 * non-superuser that holds CREATEROLE and membership of the group owning the
 * public schema and the database, with the extensions already allowed. A
 * superuser bypasses every privilege check these migrations depend on, so the
 * main suite cannot catch a grant that Azure enforces.
 */

let container: StartedPostgreSqlContainer;
let superuser: pg.Client;

const query = async (client: pg.Client, sql: string): Promise<Record<string, unknown>[]> =>
  (await client.query<Record<string, unknown>>(sql)).rows;

const connectAs = (user: string): string =>
  `postgres://${user}:test@${container.getHost()}:${container.getMappedPort(5432)}/lance`;

beforeAll(async () => {
  container = await startPostgresContainer();
  superuser = new pg.Client({ connectionString: container.getConnectionUri() });
  await superuser.connect();

  // Azure: azure_pg_admin owns public and the database; the migrate identity
  // is a CREATEROLE member of it; extensions are created by that member.
  await superuser.query('CREATE ROLE azure_like_pg_admin NOLOGIN');
  await superuser.query('ALTER SCHEMA public OWNER TO azure_like_pg_admin');
  await superuser.query('ALTER DATABASE lance OWNER TO azure_like_pg_admin');
  await superuser.query("CREATE ROLE migrate_identity LOGIN PASSWORD 'test' CREATEROLE");
  await superuser.query('GRANT azure_like_pg_admin TO migrate_identity');
  // Locally only a superuser may create these; on Azure the admin member creates
  // them and therefore owns ag_catalog, which the graph creation reads and writes.
  await superuser.query('CREATE EXTENSION IF NOT EXISTS age');
  await superuser.query('CREATE EXTENSION IF NOT EXISTS vector');
  await superuser.query('ALTER SCHEMA ag_catalog OWNER TO azure_like_pg_admin');
  await superuser.query('GRANT ALL ON ALL TABLES IN SCHEMA ag_catalog TO azure_like_pg_admin');
  await superuser.query('GRANT ALL ON ALL SEQUENCES IN SCHEMA ag_catalog TO azure_like_pg_admin');
});

afterAll(async () => {
  await superuser.end();
  await container.stop();
});

describe('migrations run by a non-superuser admin member', () => {
  it('apply every migration without a superuser', async () => {
    await runMigrations({ connectionString: connectAs('migrate_identity') });
    const rows = await query(
      superuser,
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    expect(rows[0]?.['n']).toBeGreaterThanOrEqual(6);
  });

  it('leave lance_migrator owning the ledger and holding CREATE on public', async () => {
    const owner = await query(
      superuser,
      "SELECT tableowner FROM pg_tables WHERE tablename = 'ledger_events'",
    );
    expect(owner[0]?.['tableowner']).toBe('lance_migrator');
    const create = await query(
      superuser,
      "SELECT has_schema_privilege('lance_migrator', 'public', 'CREATE') AS ok",
    );
    expect(create[0]?.['ok']).toBe(true);
  });

  it('let a lance_app member pass the schema check pg-boss runs at start', async () => {
    await superuser.query("CREATE ROLE worker_identity LOGIN PASSWORD 'test'");
    await superuser.query('GRANT lance_app TO worker_identity');
    const worker = new pg.Client({ connectionString: connectAs('worker_identity') });
    await worker.connect();
    try {
      await worker.query('CREATE SCHEMA IF NOT EXISTS pgboss');
      await worker.query('CREATE TABLE pgboss.smoke (id int)');
      const rows = await query(worker, 'SELECT current_user AS who');
      expect(rows[0]?.['who']).toBe('worker_identity');
    } finally {
      await worker.end();
    }
  });
});

describe('the retention membership the migration job grants', () => {
  const PRINCIPAL = '01K5S9V6QW3SWCCPVB0N0E3R01';
  const EVENT = '01K5S9V6QW3SWCCPVB0N0E3R02';

  beforeAll(async () => {
    await superuser.query("CREATE ROLE retention_worker LOGIN PASSWORD 'test'");
    await superuser.query('GRANT lance_app TO retention_worker');
    await superuser.query(
      "INSERT INTO principals (id, upn) VALUES ($1, 'retention@example.test')",
      [PRINCIPAL],
    );
    await superuser.query("SELECT set_config('app.principal', $1, false)", [PRINCIPAL]);
    await superuser.query(
      `INSERT INTO ledger_events (id, ts, actor, kind, correlation_id, payload, payload_hash)
       VALUES ($1, now(), 'watcher:test', 'observed', $1, '{"body":"raw"}', 'sha256:fixture')`,
      [EVENT],
    );
  });

  it('is granted by the non-superuser migrate identity, which created the role', async () => {
    const migrate = createDb({ connectionString: connectAs('migrate_identity'), password: 'test' });
    try {
      await expect(grantRetentionMember(migrate, 'retention_worker')).resolves.toEqual({
        status: 'granted',
        role: 'retention_worker',
      });
      // A second run, as every migration job makes, changes nothing.
      await expect(grantRetentionMember(migrate, 'retention_worker')).resolves.toMatchObject({
        status: 'granted',
      });
    } finally {
      await migrate.$client.end();
    }
    const rows = await query(
      superuser,
      `SELECT m.inherit_option AS inherit, m.set_option AS set
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles u ON u.oid = m.member
        WHERE r.rolname = 'lance_retention' AND u.rolname = 'retention_worker'`,
    );
    expect(rows).toEqual([{ inherit: false, set: true }]);
  });

  const asWorker = async <T>(run: (client: pg.Client) => Promise<T>): Promise<T> => {
    const worker = new pg.Client({
      connectionString: connectAs('retention_worker'),
      options: '-c role=lance_app',
    });
    await worker.connect();
    try {
      await worker.query("SELECT set_config('app.principal', $1, false)", [PRINCIPAL]);
      return await run(worker);
    } finally {
      await worker.end();
    }
  };

  it('leaves an ordinary worker session, which runs as lance_app, unable to null a payload', async () => {
    const failure = await asWorker((worker) =>
      worker
        .query('UPDATE ledger_events SET payload = NULL WHERE id = $1', [EVENT])
        .then(() => null)
        .catch((error: unknown) => error as { code?: string }),
    );
    expect(failure?.code).toBe('42501');
  });

  it('lets the worker null a payload only after SET LOCAL ROLE lance_retention', async () => {
    const nulled = await asWorker(async (worker) => {
      await worker.query('BEGIN');
      await worker.query('SET LOCAL ROLE lance_retention');
      const result = await worker.query('UPDATE ledger_events SET payload = NULL WHERE id = $1', [
        EVENT,
      ]);
      await worker.query('COMMIT');
      const after = await worker.query<{ who: string }>('SELECT current_user AS who');
      return { count: result.rowCount, roleAfter: after.rows[0]?.who };
    });
    expect(nulled).toEqual({ count: 1, roleAfter: 'lance_app' });
  });

  it('refuses to grant the role to lance_app', async () => {
    const migrate = createDb({ connectionString: connectAs('migrate_identity'), password: 'test' });
    try {
      await expect(grantRetentionMember(migrate, 'lance_app')).rejects.toThrow(/only the worker/);
      await expect(grantRetentionMember(migrate, 'no_such_identity')).rejects.toThrow(/step 7/);
    } finally {
      await migrate.$client.end();
    }
  });
});
