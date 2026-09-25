import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scopedDb, type Db } from './client.js';
import { runMigrations } from './migrate.js';
import { SEED_PRINCIPAL_ID } from './seed.js';
import { openFixtureDb, openSeededTestDb, startPostgresContainer } from './testing.js';

/**
 * What the apps may write to `principals` (migration 0011, ADR 0020). Every
 * case runs as a member of lance_app, as the apps do; the superuser handle
 * only sets fixtures up and reads the result back.
 */

const PERMISSION_DENIED = '42501';
/** RAISE EXCEPTION in the guard trigger. */
const RAISED = 'P0001';

const NEWCOMER_ID = '01K5S9V6QW3SWCCPVB0N0E3N01';
const BOUND_ID = '01K5S9V6QW3SWCCPVB0N0E3N02';
const DOM_OID = '19fb2afd-6814-4600-8697-eb798ec5691f';

let container: StartedPostgreSqlContainer;
let app: Db;
let fixture: Db;

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error.code ?? 'unknown';
    throw error;
  }
  throw new Error('Expected the database to refuse the statement, and it succeeded.');
};

const row = async (id: string): Promise<Record<string, unknown> | undefined> => {
  const result = await fixture.$client.query(
    'SELECT id, entra_oid, upn, slack_user_id, status FROM principals WHERE id = $1',
    [id],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  app = await openSeededTestDb(url);
  fixture = openFixtureDb(url);
});

afterAll(async () => {
  await app?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

beforeEach(async () => {
  await fixture.$client.query('DELETE FROM principals WHERE id <> $1', [SEED_PRINCIPAL_ID]);
  await fixture.$client.query(
    "UPDATE principals SET entra_oid = NULL, status = 'active', slack_user_id = 'U0DOM' WHERE id = $1",
    [SEED_PRINCIPAL_ID],
  );
  await fixture.$client.query(
    "INSERT INTO principals (id, entra_oid, upn, status) VALUES ($1, 'oid-bound', 'bound@example.test', 'active')",
    [BOUND_ID],
  );
});

describe('principals writes as lance_app', () => {
  it('lets a first sign-in create an onboarding principal carrying its Entra object id', async () => {
    await app.$client.query(
      "INSERT INTO principals (id, entra_oid, upn, status) VALUES ($1, 'oid-new', 'new@example.test', 'onboarding')",
      [NEWCOMER_ID],
    );
    expect(await row(NEWCOMER_ID)).toMatchObject({ entra_oid: 'oid-new', status: 'onboarding' });
  });

  it('refuses to create a principal in any status but onboarding', async () => {
    const code = await codeOf(() =>
      app.$client.query(
        "INSERT INTO principals (id, entra_oid, upn, status) VALUES ($1, 'oid-new', 'new@example.test', 'active')",
        [NEWCOMER_ID],
      ),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it('refuses to create a principal without an Entra object id', async () => {
    const code = await codeOf(() =>
      app.$client.query(
        "INSERT INTO principals (id, upn, status) VALUES ($1, 'new@example.test', 'onboarding')",
        [NEWCOMER_ID],
      ),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it('refuses to create a principal that names a Slack user id', async () => {
    const code = await codeOf(() =>
      app.$client.query(
        "INSERT INTO principals (id, entra_oid, upn, status, slack_user_id) VALUES ($1, 'oid-new', 'new@example.test', 'onboarding', 'U0NEW')",
        [NEWCOMER_ID],
      ),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it("binds an Entra object id to Dom's unbound row and changes nothing else", async () => {
    const before = await row(SEED_PRINCIPAL_ID);
    const result = await app.$client.query(
      'UPDATE principals SET entra_oid = $1, updated_at = now() WHERE upn = $2 AND entra_oid IS NULL',
      [DOM_OID, 'dom@valliance.ai'],
    );
    expect(result.rowCount).toBe(1);
    expect(await row(SEED_PRINCIPAL_ID)).toEqual({ ...before, entra_oid: DOM_OID });
  });

  it('refuses to change the status in the same statement as a binding', async () => {
    const code = await codeOf(() =>
      app.$client.query(
        "UPDATE principals SET entra_oid = 'oid-x', status = 'paused' WHERE id = $1",
        [SEED_PRINCIPAL_ID],
      ),
    );
    expect(code).toBe(RAISED);
    expect(await row(SEED_PRINCIPAL_ID)).toMatchObject({ entra_oid: null, status: 'active' });
  });

  it('leaves a principal that is already bound untouched when asked to rebind it', async () => {
    const result = await app.$client.query(
      "UPDATE principals SET entra_oid = 'oid-stolen' WHERE id = $1",
      [BOUND_ID],
    );
    expect(result.rowCount).toBe(0);
    expect(await row(BOUND_ID)).toMatchObject({ entra_oid: 'oid-bound' });
  });

  it('refuses a status change outside an admin scope', async () => {
    const bound = await app.$client.query("UPDATE principals SET status = 'paused' WHERE id = $1", [
      BOUND_ID,
    ]);
    expect(bound.rowCount).toBe(0);
    const unbound = await codeOf(() =>
      app.$client.query("UPDATE principals SET status = 'paused' WHERE id = $1", [
        SEED_PRINCIPAL_ID,
      ]),
    );
    // The guard trigger runs before the policy's check and refuses first.
    expect(unbound).toBe(RAISED);
    expect(await row(BOUND_ID)).toMatchObject({ status: 'active' });
    expect(await row(SEED_PRINCIPAL_ID)).toMatchObject({ status: 'active' });
  });

  it('lets an admin scope pause a principal', async () => {
    const admin = scopedDb(app, { principalId: SEED_PRINCIPAL_ID, admin: true });
    const result = await admin.$client.query(
      "UPDATE principals SET status = 'paused', updated_at = now() WHERE id = $1",
      [BOUND_ID],
    );
    expect(result.rowCount).toBe(1);
    expect(await row(BOUND_ID)).toMatchObject({ status: 'paused' });
  });

  it('stamps status_changed_at on a status change and on nothing else (migration 0020)', async () => {
    const admin = scopedDb(app, { principalId: SEED_PRINCIPAL_ID, admin: true });
    const stamp = async (): Promise<unknown> => {
      const result = await fixture.$client.query(
        'SELECT status_changed_at FROM principals WHERE id = $1',
        [BOUND_ID],
      );
      return (result.rows as { status_changed_at: Date | null }[])[0]?.status_changed_at;
    };

    const before = await stamp();
    await admin.$client.query("UPDATE principals SET status = 'paused' WHERE id = $1", [BOUND_ID]);
    const paused = await stamp();
    await admin.$client.query('UPDATE principals SET updated_at = now() WHERE id = $1', [BOUND_ID]);
    const untouched = await stamp();

    expect(paused).toBeInstanceOf(Date);
    expect(paused).not.toEqual(before);
    expect(untouched).toEqual(paused);
  });

  it('refuses to set status_changed_at directly, even from an admin scope', async () => {
    const admin = scopedDb(app, { principalId: SEED_PRINCIPAL_ID, admin: true });
    const code = await codeOf(() =>
      admin.$client.query(
        "UPDATE principals SET status_changed_at = now() - interval '30 days' WHERE id = $1",
        [BOUND_ID],
      ),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it('refuses a change to the UPN or the Slack user id, even from an admin scope', async () => {
    const admin = scopedDb(app, { principalId: SEED_PRINCIPAL_ID, admin: true });
    const upn = await codeOf(() =>
      admin.$client.query("UPDATE principals SET upn = 'someone@example.test' WHERE id = $1", [
        BOUND_ID,
      ]),
    );
    const slack = await codeOf(() =>
      app.$client.query("UPDATE principals SET slack_user_id = 'U0INTRUDER' WHERE id = $1", [
        SEED_PRINCIPAL_ID,
      ]),
    );
    expect([upn, slack]).toEqual([PERMISSION_DENIED, PERMISSION_DENIED]);
  });

  it('refuses to delete a principal', async () => {
    const code = await codeOf(() =>
      app.$client.query('DELETE FROM principals WHERE id = $1', [BOUND_ID]),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });
});

describe('recording a Notion user id as lance_app (migration 0015, ADR 0022)', () => {
  const notionOf = async (id: string): Promise<unknown> => {
    const result = await fixture.$client.query(
      'SELECT notion_user_id FROM principals WHERE id = $1',
      [id],
    );
    return (result.rows[0] as { notion_user_id: unknown } | undefined)?.notion_user_id;
  };

  it('lets a principal record their own Notion user id when it is missing', async () => {
    const own = scopedDb(app, { principalId: BOUND_ID });
    const result = await own.$client.query(
      'UPDATE principals SET notion_user_id = $1, updated_at = now() WHERE id = $2 AND notion_user_id IS NULL',
      ['notion-bound', BOUND_ID],
    );
    expect(result.rowCount).toBe(1);
    expect(await notionOf(BOUND_ID)).toBe('notion-bound');
  });

  it("leaves another principal's row alone", async () => {
    const result = await app.$client.query(
      'UPDATE principals SET notion_user_id = $1 WHERE id = $2',
      ['notion-stolen', BOUND_ID],
    );
    expect(result.rowCount).toBe(0);
    expect(await notionOf(BOUND_ID)).toBeNull();
  });

  it('never overwrites a Notion user id that is already recorded', async () => {
    const before = await notionOf(SEED_PRINCIPAL_ID);
    expect(before).not.toBeNull();
    // Dom's row is in the caller's own scope, so principals_self_update admits
    // the row and the guard trigger is what refuses the change.
    const code = await codeOf(() =>
      app.$client.query('UPDATE principals SET notion_user_id = $1 WHERE id = $2', [
        'notion-other',
        SEED_PRINCIPAL_ID,
      ]),
    );
    expect(code).toBe(RAISED);
    expect(await notionOf(SEED_PRINCIPAL_ID)).toBe(before);
  });

  it('refuses to change the status in the same statement', async () => {
    const own = scopedDb(app, { principalId: BOUND_ID });
    const code = await codeOf(() =>
      own.$client.query(
        "UPDATE principals SET notion_user_id = 'notion-bound', status = 'paused' WHERE id = $1",
        [BOUND_ID],
      ),
    );
    expect(code).toBe(RAISED);
    expect(await row(BOUND_ID)).toMatchObject({ status: 'active' });
    expect(await notionOf(BOUND_ID)).toBeNull();
  });
});
