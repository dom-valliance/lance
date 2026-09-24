import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, scopedDb, type Db } from './client.js';
import { resolveSinglePrincipal } from './principal.js';
import { runMigrations } from './migrate.js';
import { SEED_PRINCIPAL_ID, seed } from './seed.js';
import { startPostgresContainer } from './testing.js';

/**
 * Row-level security across principals (ADR 0015, docs/plans/ontology.md
 * section 4.5). The sessions under test log in as a member of lance_app,
 * because a superuser bypasses row-level security even when it is forced.
 *
 * Fixture rows are built from the catalogue, so a principal-bearing table
 * added later is covered without editing this file.
 */

const OTHER_PRINCIPAL_ID = '01K5S9V6QW3SWCCPVB0N0E3Q7H';

/** Tables that deliberately carry no principal. */
const UNSCOPED_TABLES = ['principals', 'system_state', 'users'];

/**
 * insufficient_privilege: what a failed WITH CHECK raises, including for an
 * unscoped insert, whose principal_id defaults to null.
 */
const PERMISSION_DENIED = '42501';

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let appDb: Db;
let principalTables: string[];
let columns: ColumnRow[];
let enumFirstValue: Map<string, string>;
let counter = 0;

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A well-formed, unique ULID for fixture rows. */
const fixtureUlid = (): string => {
  counter += 1;
  let suffix = '';
  let n = counter;
  for (let i = 0; i < 6; i += 1) {
    suffix = ULID_ALPHABET[n % 32] + suffix;
    n = Math.floor(n / 32);
  }
  return `01K5S9V6QW3SWCCPVB0N${suffix}`;
};

const fixtureValue = (column: ColumnRow): unknown => {
  if (column.data_type === 'character') return fixtureUlid();
  if (column.data_type === 'text') return `fixture-${fixtureUlid()}`;
  if (column.data_type === 'timestamp with time zone') return new Date();
  if (column.data_type === 'jsonb') return '{}';
  if (column.data_type === 'boolean') return false;
  if (['integer', 'numeric', 'real', 'double precision'].includes(column.data_type)) return 1;
  if (column.data_type === 'ARRAY') return [];
  if (column.data_type === 'USER-DEFINED') {
    const value = enumFirstValue.get(column.udt_name);
    if (value === undefined) throw new Error(`No enum values for ${column.udt_name}`);
    return value;
  }
  throw new Error(
    `No fixture for ${column.table_name}.${column.column_name} (${column.data_type})`,
  );
};

/**
 * Insert one row into `table` through `db`. principal_id is left to the
 * scope unless `principalId` names one explicitly.
 */
const insertFixture = async (db: Db, table: string, principalId?: string): Promise<void> => {
  const required = columns.filter(
    (column) =>
      column.table_name === table &&
      column.column_name !== 'principal_id' &&
      column.is_nullable === 'NO' &&
      column.column_default === null,
  );
  const names = required.map((column) => `"${column.column_name}"`);
  const values: unknown[] = required.map(fixtureValue);
  if (principalId !== undefined) {
    names.push('"principal_id"');
    values.push(principalId);
  }
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  const text =
    names.length === 0
      ? `INSERT INTO "${table}" DEFAULT VALUES`
      : `INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders})`;
  await db.$client.query(text, values);
};

const principalsIn = async (db: Db, table: string): Promise<string[]> => {
  const result = await db.$client.query(`SELECT DISTINCT principal_id FROM "${table}"`);
  return result.rows.map((row: { principal_id: string }) => row.principal_id).sort();
};

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error.code ?? 'unknown';
    throw error;
  }
  throw new Error('Expected the database to refuse the statement, and it succeeded.');
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const superuserUrl = container.getConnectionUri();
  await runMigrations({ connectionString: superuserUrl });

  const setupDb = createDb({ connectionString: superuserUrl });
  await seed(setupDb);
  await setupDb.$client.end();

  admin = new pg.Client({ connectionString: superuserUrl });
  await admin.connect();
  await admin.query("CREATE ROLE isolation_app LOGIN PASSWORD 'isolation'");
  await admin.query('GRANT lance_app TO isolation_app');
  await admin.query(
    "INSERT INTO principals (id, upn) VALUES ($1, 'second.principal@example.test')",
    [OTHER_PRINCIPAL_ID],
  );

  const tables = await admin.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'principal_id'
     ORDER BY table_name`,
  );
  principalTables = tables.rows.map((row) => row.table_name);

  const columnRows = await admin.query<ColumnRow>(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
     FROM information_schema.columns WHERE table_schema = 'public'`,
  );
  columns = columnRows.rows;

  const enums = await admin.query<{ typname: string; label: string }>(
    `SELECT DISTINCT ON (t.typname) t.typname, e.enumlabel AS label
     FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
     ORDER BY t.typname, e.enumsortorder`,
  );
  enumFirstValue = new Map(enums.rows.map((row) => [row.typname, row.label]));

  const url = new URL(superuserUrl);
  url.username = 'isolation_app';
  url.password = 'isolation';
  appDb = createDb({ connectionString: url.toString() });

  // principal_state already holds the seeded principal's row.
  const other = scopedDb(appDb, { principalId: OTHER_PRINCIPAL_ID });
  const seeded = scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID });
  for (const table of principalTables) {
    if (table !== 'principal_state') {
      await insertFixture(seeded, table);
    }
    await insertFixture(other, table);
  }
});

afterAll(async () => {
  await appDb?.$client.end();
  await admin?.end();
  await container?.stop();
});

describe('row-level security across principals', () => {
  it('puts every table except the principal lookups under forced row-level security', async () => {
    const result = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname`,
    );
    const unprotected = result.rows.filter(
      (row) => !row.relrowsecurity || !row.relforcerowsecurity || row.policies === '0',
    );
    expect(unprotected.map((row) => row.relname)).toEqual(UNSCOPED_TABLES);
    expect(principalTables).toEqual(
      result.rows.map((row) => row.relname).filter((name) => !UNSCOPED_TABLES.includes(name)),
    );
  });

  it('never gives lance_app the right to bypass row-level security', async () => {
    const result = await admin.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname IN ('lance_app', 'isolation_app')",
    );
    expect(result.rows).toEqual([{ rolbypassrls: false }, { rolbypassrls: false }]);
  });

  it("shows each principal only their own rows, and the other principal's rows to neither", async () => {
    const seeded = scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID });
    const other = scopedDb(appDb, { principalId: OTHER_PRINCIPAL_ID });
    for (const table of principalTables) {
      if (table === 'policy_rules') continue;
      expect({ table, seen: await principalsIn(seeded, table) }).toEqual({
        table,
        seen: [SEED_PRINCIPAL_ID],
      });
      expect({ table, seen: await principalsIn(other, table) }).toEqual({
        table,
        seen: [OTHER_PRINCIPAL_ID],
      });
    }
  });

  it("refuses an insert that names another principal's id", async () => {
    const seeded = scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID });
    for (const table of principalTables) {
      const code = await codeOf(() => insertFixture(seeded, table, OTHER_PRINCIPAL_ID));
      expect({ table, code }).toEqual({ table, code: PERMISSION_DENIED });
    }
  });

  it('refuses to move a row to another principal', async () => {
    const seeded = scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID });
    const code = await codeOf(() =>
      seeded.$client.query('UPDATE commitments SET principal_id = $1', [OTHER_PRINCIPAL_ID]),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it('shows an unscoped session no rows and refuses its inserts', async () => {
    for (const table of principalTables) {
      const result = await appDb.$client.query(`SELECT count(*)::int AS n FROM "${table}"`);
      const row = result.rows[0] as { n: number } | undefined;
      expect({ table, row }).toEqual({ table, row: { n: 0 } });
    }
    const code = await codeOf(() => insertFixture(appDb, 'cursors'));
    expect(code).toBe(PERMISSION_DENIED);
  });
});

describe('organisation rows in policy_rules', () => {
  const insertRule = (db: Db, principal: string | null): Promise<unknown> =>
    db.$client.query(
      `INSERT INTO policy_rules
         (id, principal_id, version, action_class, counterparty_class, system, decision,
          created_by, rationale)
       VALUES ($1, $2, 1, 'read', '*', '*', 'auto', 'user:dom', 'fixture')`,
      [fixtureUlid(), principal],
    );

  it('lets an admin scope write an organisation default that every principal reads', async () => {
    await insertRule(scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID, admin: true }), null);
    for (const principalId of [SEED_PRINCIPAL_ID, OTHER_PRINCIPAL_ID]) {
      const result = await scopedDb(appDb, { principalId }).$client.query(
        'SELECT count(*)::int AS n FROM policy_rules WHERE principal_id IS NULL',
      );
      expect(result.rows[0]).toEqual({ n: 1 });
    }
  });

  it('refuses an organisation default from a scope that is not admin', async () => {
    const code = await codeOf(() =>
      insertRule(scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID }), null),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it('lets no scope but an admin one change or remove an organisation default', async () => {
    const seeded = scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID });
    const taken = await seeded.$client.query(
      "UPDATE policy_rules SET principal_id = $1, decision = 'auto' WHERE principal_id IS NULL",
      [SEED_PRINCIPAL_ID],
    );
    expect(taken.rowCount).toBe(0);
    const removed = await seeded.$client.query(
      'DELETE FROM policy_rules WHERE principal_id IS NULL',
    );
    expect(removed.rowCount).toBe(0);

    const admin = scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID, admin: true });
    const changed = await admin.$client.query(
      "UPDATE policy_rules SET rationale = 'admin edit' WHERE principal_id IS NULL",
    );
    expect(changed.rowCount).toBe(1);
  });

  it("hides one principal's own rules from the other", async () => {
    const other = scopedDb(appDb, { principalId: OTHER_PRINCIPAL_ID });
    const result = await other.$client.query(
      'SELECT count(*)::int AS n FROM policy_rules WHERE principal_id = $1',
      [SEED_PRINCIPAL_ID],
    );
    expect(result.rows[0]).toEqual({ n: 0 });
  });
});

describe('the principal lookup', () => {
  it('lets the apps read principals and write none', async () => {
    const seeded = scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID });
    const read = await seeded.$client.query('SELECT count(*)::int AS n FROM principals');
    expect(read.rows[0]).toEqual({ n: 2 });
    const inserted = await codeOf(() =>
      seeded.$client.query(
        "INSERT INTO principals (id, upn) VALUES ($1, 'intruder@example.test')",
        ['01K5S9V6QW3SWCCPVB0N0E3Z9Z'],
      ),
    );
    expect(inserted).toBe(PERMISSION_DENIED);
    const updated = await codeOf(() =>
      seeded.$client.query("UPDATE principals SET slack_user_id = 'U0INTRUDER'"),
    );
    expect(updated).toBe(PERMISSION_DENIED);
  });
});

describe('scopedDb', () => {
  it('refuses a principal id that is not a ULID', () => {
    expect(() => scopedDb(appDb, { principalId: 'dom' })).toThrow(/ULID/);
  });

  it('keeps each transaction on its own scope when two scopes share the pool', async () => {
    const seeded = scopedDb(appDb, { principalId: SEED_PRINCIPAL_ID });
    const other = scopedDb(appDb, { principalId: OTHER_PRINCIPAL_ID });
    const [a, b] = await Promise.all([
      seeded.transaction((tx) => tx.execute('SELECT app_principal() AS p')),
      other.transaction((tx) => tx.execute('SELECT app_principal() AS p')),
    ]);
    expect([a.rows[0], b.rows[0]]).toEqual([{ p: SEED_PRINCIPAL_ID }, { p: OTHER_PRINCIPAL_ID }]);
    const unscoped = await appDb.execute('SELECT app_principal() AS p');
    expect(unscoped.rows[0]).toEqual({ p: null });
  });
});

describe('resolveSinglePrincipal', () => {
  it('refuses to choose between two active principals', async () => {
    await expect(resolveSinglePrincipal(appDb, 'dom@valliance.ai')).rejects.toThrow(
      /Found 2 active principals/,
    );
  });

  it('returns the one active principal when the configured UPN matches, whatever its case', async () => {
    await admin.query("UPDATE principals SET status = 'paused' WHERE id = $1", [
      OTHER_PRINCIPAL_ID,
    ]);
    try {
      const principal = await resolveSinglePrincipal(appDb, 'Dom@Valliance.ai');
      expect(principal.id).toBe(SEED_PRINCIPAL_ID);
      await expect(resolveSinglePrincipal(appDb, 'someone.else@valliance.ai')).rejects.toThrow(
        /configured for someone.else@valliance.ai/,
      );
    } finally {
      await admin.query("UPDATE principals SET status = 'active' WHERE id = $1", [
        OTHER_PRINCIPAL_ID,
      ]);
    }
  });
});
