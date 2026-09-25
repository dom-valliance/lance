import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scopedDb, type Db } from './client.js';
import { runMigrations } from './migrate.js';
import { SEED_PRINCIPAL_ID } from './seed.js';
import { openAppTestDb, openFixtureDb, startPostgresContainer } from './testing.js';

/**
 * What onboarding may write (migration 0017, docs/plans/multi-user.md M3).
 * Every case runs as a member of lance_app, as the apps do; the superuser
 * handle only sets fixtures up and reads the result back.
 */

/** RAISE EXCEPTION in the guard trigger. */
const RAISED = 'P0001';
const INVALID_PARAMETER = '22023';

const NEWCOMER_ID = '01K5S9V6QW3SWCCPVB0N0E3N11';

let container: StartedPostgreSqlContainer;
let root: Db;
let own: Db;
let admin: Db;
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

const newcomer = async (): Promise<Record<string, unknown>> => {
  const result = await fixture.$client.query(
    'SELECT status, activated_at, time_zone FROM principals WHERE id = $1',
    [NEWCOMER_ID],
  );
  return result.rows[0] as Record<string, unknown>;
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  root = await openAppTestDb(url);
  own = scopedDb(root, { principalId: NEWCOMER_ID });
  admin = scopedDb(root, { principalId: NEWCOMER_ID, admin: true });
  fixture = openFixtureDb(url);
});

afterAll(async () => {
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

beforeEach(async () => {
  await fixture.$client.query('DELETE FROM principal_state WHERE principal_id = $1', [NEWCOMER_ID]);
  await fixture.$client.query('DELETE FROM principals WHERE id = $1', [NEWCOMER_ID]);
  await fixture.$client.query(
    "INSERT INTO principals (id, entra_oid, upn, status) VALUES ($1, 'oid-newcomer', 'newcomer@example.test', 'onboarding')",
    [NEWCOMER_ID],
  );
});

describe('activating a principal as lance_app', () => {
  it("refuses a principal's own scope marking themselves active", async () => {
    const code = await codeOf(() =>
      own.$client.query(
        "UPDATE principals SET status = 'active', activated_at = now() WHERE id = $1",
        [NEWCOMER_ID],
      ),
    );
    expect(code).toBe(RAISED);
    expect(await newcomer()).toMatchObject({ status: 'onboarding', activated_at: null });
  });

  it("refuses a principal's own scope setting their activation time alone", async () => {
    const code = await codeOf(() =>
      own.$client.query('UPDATE principals SET activated_at = now() WHERE id = $1', [NEWCOMER_ID]),
    );
    expect(code).toBe(RAISED);
    expect(await newcomer()).toMatchObject({ activated_at: null });
  });

  it('refuses an admin scope activating a principal without an activation time', async () => {
    const code = await codeOf(() =>
      admin.$client.query("UPDATE principals SET status = 'active' WHERE id = $1", [NEWCOMER_ID]),
    );
    expect(code).toBe(RAISED);
    expect(await newcomer()).toMatchObject({ status: 'onboarding' });
  });

  it('lets an admin scope activate with the time, once', async () => {
    const result = await admin.$client.query(
      "UPDATE principals SET status = 'active', activated_at = now() WHERE id = $1",
      [NEWCOMER_ID],
    );
    expect(result.rowCount).toBe(1);
    const activated = await newcomer();
    expect(activated['status']).toBe('active');
    expect(activated['activated_at']).toBeInstanceOf(Date);

    const moved = await codeOf(() =>
      admin.$client.query(
        "UPDATE principals SET activated_at = now() - interval '30 days' WHERE id = $1",
        [NEWCOMER_ID],
      ),
    );
    expect(moved).toBe(RAISED);
    expect(await newcomer()).toMatchObject({ activated_at: activated['activated_at'] });
  });

  it('refuses an activation time on any status change but onboarding to active', async () => {
    const code = await codeOf(() =>
      admin.$client.query(
        "UPDATE principals SET status = 'paused', activated_at = now() WHERE id = $1",
        [NEWCOMER_ID],
      ),
    );
    expect(code).toBe(RAISED);
  });

  it('leaves the seed principal, who was never onboarded, with no activation time', async () => {
    const result = await fixture.$client.query(
      'SELECT status, activated_at FROM principals WHERE id = $1',
      [SEED_PRINCIPAL_ID],
    );
    expect(result.rows[0]).toMatchObject({ status: 'active', activated_at: null });
  });
});

describe("a principal's own time zone and run state", () => {
  it('lets the principal set their own time zone', async () => {
    const result = await own.$client.query(
      "UPDATE principals SET time_zone = 'America/New_York', updated_at = now() WHERE id = $1",
      [NEWCOMER_ID],
    );
    expect(result.rowCount).toBe(1);
    expect(await newcomer()).toMatchObject({ time_zone: 'America/New_York' });
  });

  it('refuses a time zone Postgres does not know', async () => {
    const code = await codeOf(() =>
      own.$client.query("UPDATE principals SET time_zone = 'Europe/Atlantis' WHERE id = $1", [
        NEWCOMER_ID,
      ]),
    );
    expect(code).toBe(INVALID_PARAMETER);
    expect(await newcomer()).toMatchObject({ time_zone: 'Europe/London' });
  });

  it("refuses the time zone of another principal's row", async () => {
    // The seed row has no Entra object id yet, so the binding policy admits
    // it and the guard trigger is what refuses the change.
    const code = await codeOf(() =>
      own.$client.query("UPDATE principals SET time_zone = 'Asia/Tokyo' WHERE id = $1", [
        SEED_PRINCIPAL_ID,
      ]),
    );
    expect(code).toBe(RAISED);
    const seed = await fixture.$client.query('SELECT time_zone FROM principals WHERE id = $1', [
      SEED_PRINCIPAL_ID,
    ]);
    expect(seed.rows[0]).toEqual({ time_zone: 'Europe/London' });
  });

  it('creates run state in dry run with the default daily ceiling of 15 pounds', async () => {
    await own.$client.query('INSERT INTO principal_state DEFAULT VALUES');
    const result = await fixture.$client.query(
      'SELECT mode, cost_ceiling_gbp FROM principal_state WHERE principal_id = $1',
      [NEWCOMER_ID],
    );
    expect(result.rows[0]).toEqual({ mode: 'dry_run', cost_ceiling_gbp: '15.00' });
  });
});
