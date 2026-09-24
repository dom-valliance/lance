import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scopedDb, type Db } from './client.js';
import { runMigrations } from './migrate.js';
import { SEED_PRINCIPAL_ID } from './seed.js';
import { openAppTestDb, openFixtureDb, startPostgresContainer } from './testing.js';

/**
 * What the apps may write to `slack_links`, `slack_link_tokens`,
 * `slack_request_nonces` and the Slack and role columns of `principals`
 * (migration 0014, ADR 0021, ADR 0023). Every case runs as a member of
 * lance_app, as the apps do; the superuser handle only sets fixtures up and
 * reads the result back.
 */

const PERMISSION_DENIED = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
/** RAISE EXCEPTION in a guard trigger. */
const RAISED = 'P0001';

const OTHER_ID = '01K5S9V6QW3SWCCPVB0N0E3N11';
const DOM_SLACK = 'U0BN7JN7BAN';
const OTHER_SLACK = 'U0OTHER';
const TEAM = 'T0VALLIANCE';

let container: StartedPostgreSqlContainer;
let root: Db;
let dom: Db;
let other: Db;
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

const principal = async (id: string): Promise<Record<string, unknown> | undefined> => {
  const result = await fixture.$client.query(
    'SELECT slack_user_id, slack_channel_id, lance_roles, status FROM principals WHERE id = $1',
    [id],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
};

const link = (db: Db, slackUserId: string, principalId: string) =>
  db.$client.query(
    'INSERT INTO slack_links (slack_user_id, slack_team_id, principal_id) VALUES ($1, $2, $3)',
    [slackUserId, TEAM, principalId],
  );

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  root = await openAppTestDb(url);
  dom = scopedDb(root, { principalId: SEED_PRINCIPAL_ID });
  other = scopedDb(root, { principalId: OTHER_ID });
  fixture = openFixtureDb(url);
});

afterAll(async () => {
  await root?.$client.end();
  await fixture?.$client.end();
  await container?.stop();
});

beforeEach(async () => {
  await fixture.$client.query('DELETE FROM slack_links');
  await fixture.$client.query('DELETE FROM slack_link_tokens');
  await fixture.$client.query('DELETE FROM slack_request_nonces');
  await fixture.$client.query('DELETE FROM principals WHERE id <> $1', [SEED_PRINCIPAL_ID]);
  await fixture.$client.query(
    "UPDATE principals SET slack_user_id = NULL, slack_channel_id = NULL, lance_roles = '{}' WHERE id = $1",
    [SEED_PRINCIPAL_ID],
  );
  await fixture.$client.query(
    "INSERT INTO principals (id, entra_oid, upn, status) VALUES ($1, 'oid-other', 'other@example.test', 'active')",
    [OTHER_ID],
  );
});

describe('slack_links as lance_app', () => {
  it("links a Slack user in the principal's own scope and fills principals.slack_user_id from it", async () => {
    await link(dom, DOM_SLACK, SEED_PRINCIPAL_ID);
    expect(await principal(SEED_PRINCIPAL_ID)).toMatchObject({ slack_user_id: DOM_SLACK });
  });

  it("refuses a link written for another principal from one principal's scope", async () => {
    expect(await codeOf(() => link(dom, OTHER_SLACK, OTHER_ID))).toBe(PERMISSION_DENIED);
    expect(await principal(OTHER_ID)).toMatchObject({ slack_user_id: null });
  });

  it('refuses a link written from an unscoped session', async () => {
    expect(await codeOf(() => link(root, DOM_SLACK, SEED_PRINCIPAL_ID))).toBe(PERMISSION_DENIED);
  });

  it('refuses a link that is created already revoked', async () => {
    const code = await codeOf(() =>
      dom.$client.query(
        'INSERT INTO slack_links (slack_user_id, slack_team_id, principal_id, revoked_at) VALUES ($1, $2, $3, now())',
        [DOM_SLACK, TEAM, SEED_PRINCIPAL_ID],
      ),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it('refuses a second principal claiming a Slack user already linked', async () => {
    await link(dom, DOM_SLACK, SEED_PRINCIPAL_ID);
    expect(await codeOf(() => link(other, DOM_SLACK, OTHER_ID))).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a second active link for the same principal', async () => {
    await link(dom, DOM_SLACK, SEED_PRINCIPAL_ID);
    expect(await codeOf(() => link(dom, 'U0SECOND', SEED_PRINCIPAL_ID))).toBe(UNIQUE_VIOLATION);
  });

  it("revokes the principal's own link and clears principals.slack_user_id", async () => {
    await link(dom, DOM_SLACK, SEED_PRINCIPAL_ID);
    const result = await dom.$client.query(
      'UPDATE slack_links SET revoked_at = now() WHERE slack_user_id = $1',
      [DOM_SLACK],
    );
    expect(result.rowCount).toBe(1);
    expect(await principal(SEED_PRINCIPAL_ID)).toMatchObject({ slack_user_id: null });
  });

  it("leaves another principal's link untouched when asked to revoke it", async () => {
    await link(other, OTHER_SLACK, OTHER_ID);
    const result = await dom.$client.query(
      'UPDATE slack_links SET revoked_at = now() WHERE slack_user_id = $1',
      [OTHER_SLACK],
    );
    expect(result.rowCount).toBe(0);
    expect(await principal(OTHER_ID)).toMatchObject({ slack_user_id: OTHER_SLACK });
  });

  it('lets an admin scope revoke any link', async () => {
    await link(other, OTHER_SLACK, OTHER_ID);
    const admin = scopedDb(root, { principalId: SEED_PRINCIPAL_ID, admin: true });
    const result = await admin.$client.query(
      'UPDATE slack_links SET revoked_at = now() WHERE slack_user_id = $1',
      [OTHER_SLACK],
    );
    expect(result.rowCount).toBe(1);
    expect(await principal(OTHER_ID)).toMatchObject({ slack_user_id: null });
  });

  it('refuses to move a link to another principal, even from an admin scope', async () => {
    await link(dom, DOM_SLACK, SEED_PRINCIPAL_ID);
    const admin = scopedDb(root, { principalId: SEED_PRINCIPAL_ID, admin: true });
    const code = await codeOf(() =>
      admin.$client.query('UPDATE slack_links SET principal_id = $1 WHERE slack_user_id = $2', [
        OTHER_ID,
        DOM_SLACK,
      ]),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it('refuses to delete a link', async () => {
    await link(dom, DOM_SLACK, SEED_PRINCIPAL_ID);
    const code = await codeOf(() =>
      dom.$client.query('DELETE FROM slack_links WHERE slack_user_id = $1', [DOM_SLACK]),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it("refuses to set a principal's Slack user id directly", async () => {
    const code = await codeOf(() =>
      dom.$client.query('UPDATE principals SET slack_user_id = $1 WHERE id = $2', [
        OTHER_SLACK,
        SEED_PRINCIPAL_ID,
      ]),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });
});

describe('principal roles and channel as lance_app', () => {
  it("records the principal's own Lance roles in their own scope", async () => {
    const result = await dom.$client.query(
      "UPDATE principals SET lance_roles = '{Lance.User,Lance.Admin}', roles_recorded_at = now() WHERE id = $1",
      [SEED_PRINCIPAL_ID],
    );
    expect(result.rowCount).toBe(1);
    expect(await principal(SEED_PRINCIPAL_ID)).toMatchObject({
      lance_roles: ['Lance.User', 'Lance.Admin'],
    });
  });

  it("leaves another principal's roles untouched when asked to change them", async () => {
    const result = await dom.$client.query(
      "UPDATE principals SET lance_roles = '{Lance.Admin}' WHERE id = $1",
      [OTHER_ID],
    );
    expect(result.rowCount).toBe(0);
    expect(await principal(OTHER_ID)).toMatchObject({ lance_roles: [] });
  });

  it('refuses a role Lance does not know', async () => {
    const code = await codeOf(() =>
      dom.$client.query("UPDATE principals SET lance_roles = '{Global.Admin}' WHERE id = $1", [
        SEED_PRINCIPAL_ID,
      ]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('sets the private channel once and refuses to change it after', async () => {
    const first = await other.$client.query(
      "UPDATE principals SET slack_channel_id = 'G0OTHER' WHERE id = $1",
      [OTHER_ID],
    );
    expect(first.rowCount).toBe(1);
    const code = await codeOf(() =>
      other.$client.query("UPDATE principals SET slack_channel_id = 'G0ELSEWHERE' WHERE id = $1", [
        OTHER_ID,
      ]),
    );
    expect(code).toBe(RAISED);
    expect(await principal(OTHER_ID)).toMatchObject({ slack_channel_id: 'G0OTHER' });
  });

  it("refuses a status change from the principal's own scope in the same statement", async () => {
    const code = await codeOf(() =>
      other.$client.query(
        "UPDATE principals SET status = 'paused', lance_roles = '{Lance.User}' WHERE id = $1",
        [OTHER_ID],
      ),
    );
    expect(code).toBe(RAISED);
    expect(await principal(OTHER_ID)).toMatchObject({ status: 'active', lance_roles: [] });
  });
});

describe('slack_link_tokens as lance_app', () => {
  const issue = (db: Db, nonce: string, expiry = "now() + interval '5 minutes'") =>
    db.$client.query(
      `INSERT INTO slack_link_tokens (nonce, slack_user_id, slack_team_id, expires_at) VALUES ($1, $2, $3, ${expiry})`,
      [nonce, DOM_SLACK, TEAM],
    );
  const consume = (db: Db, nonce: string) =>
    db.$client.query(
      'UPDATE slack_link_tokens SET used_at = now() WHERE nonce = $1 AND used_at IS NULL',
      [nonce],
    );

  it('issues a token from an unscoped session, for five minutes at most', async () => {
    await issue(root, 'nonce-a');
    const code = await codeOf(() => issue(root, 'nonce-b', "now() + interval '6 minutes'"));
    expect(code).toBe(PERMISSION_DENIED);
  });

  it('consumes a token once', async () => {
    await issue(root, 'nonce-once');
    expect((await consume(root, 'nonce-once')).rowCount).toBe(1);
    const again = await root.$client.query(
      'UPDATE slack_link_tokens SET used_at = now() WHERE nonce = $1',
      ['nonce-once'],
    );
    expect(again.rowCount).toBe(0);
  });

  it('refuses to consume a token that has expired', async () => {
    await issue(root, 'nonce-late');
    await fixture.$client.query(
      "UPDATE slack_link_tokens SET issued_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' WHERE nonce = $1",
      ['nonce-late'],
    );
    expect((await consume(root, 'nonce-late')).rowCount).toBe(0);
  });

  it('prunes expired tokens and keeps live ones', async () => {
    await issue(root, 'nonce-live');
    await issue(root, 'nonce-dead');
    await fixture.$client.query(
      "UPDATE slack_link_tokens SET issued_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' WHERE nonce = $1",
      ['nonce-dead'],
    );
    const pruned = await root.$client.query('DELETE FROM slack_link_tokens');
    expect(pruned.rowCount).toBe(1);
    const left = await fixture.$client.query('SELECT nonce FROM slack_link_tokens');
    expect(left.rows).toEqual([{ nonce: 'nonce-live' }]);
  });
});

describe('slack_request_nonces as lance_app', () => {
  const record = (signature: string, expiry = "now() + interval '5 minutes'") =>
    root.$client.query(
      `INSERT INTO slack_request_nonces (signature, expires_at) VALUES ($1, ${expiry}) ON CONFLICT (signature) DO NOTHING`,
      [signature],
    );

  it('records a signature once and ignores the replay', async () => {
    expect((await record('v0=abc')).rowCount).toBe(1);
    expect((await record('v0=abc')).rowCount).toBe(0);
  });

  it('refuses an entry kept longer than the replay window needs', async () => {
    expect(await codeOf(() => record('v0=long', "now() + interval '1 hour'"))).toBe(
      PERMISSION_DENIED,
    );
  });

  it('prunes entries whose window has passed and keeps the rest', async () => {
    await record('v0=live');
    await fixture.$client.query(
      "INSERT INTO slack_request_nonces (signature, expires_at) VALUES ('v0=dead', now() - interval '1 minute')",
    );
    const pruned = await root.$client.query('DELETE FROM slack_request_nonces');
    expect(pruned.rowCount).toBe(1);
  });
});
