import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
