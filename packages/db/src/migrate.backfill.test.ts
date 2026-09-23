import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, scopedDb } from './client.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { startPostgresContainer } from './testing.js';

/**
 * Migration 0009 against a database that already holds a principal's data,
 * as dev does (ADR 0015). The history is applied up to 0008, rows are
 * written the way the running apps wrote them, then 0009 runs.
 */

const DOM_ID = '01K5S9V6QW3SWCCPVB0N0E300H';
const LEDGER_ID = '01K5S9V6QW3SWCCPVB0N0E301A';
const RULE_ID = '01K5S9V6QW3SWCCPVB0N0E301B';
const ALERT_ID = '01K5S9V6QW3SWCCPVB0N0E301C';
const CORRELATION = '01K5S9V6QW3SWCCPVB0N0E309Z';

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let partialFolder: string;

/** A copy of the migrations folder whose journal stops at 0008. */
const migrationsUpTo0008 = (): string => {
  const folder = mkdtempSync(path.join(tmpdir(), 'lance-migrations-'));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 8);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  partialFolder = migrationsUpTo0008();

  const early = createDb({ connectionString: url });
  await migrate(early, { migrationsFolder: partialFolder });
  await early.$client.end();

  client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    `INSERT INTO users (id, upn, slack_user_id, notion_user_id)
     VALUES ($1, 'dom@valliance.ai', 'U0SLACKDOM', 'notion-dom')`,
    [DOM_ID],
  );
  await client.query(
    `INSERT INTO system_state (id, paused, paused_reason, paused_by, mode, cost_ceiling_gbp, push_budget_per_hour)
     VALUES (1, true, 'drill', 'user:dom', 'dry_run', 30.01, 5)`,
  );
  await client.query(
    `INSERT INTO ledger_events (id, ts, actor, kind, idempotency_key, correlation_id, payload, payload_hash)
     VALUES ($1, now(), 'system:test', 'state_changed', 'lance:x:1', $2, '{}'::jsonb, 'sha256:x')`,
    [LEDGER_ID, CORRELATION],
  );
  await client.query(
    `INSERT INTO policy_rules (id, version, action_class, counterparty_class, system, decision, created_by, rationale)
     VALUES ($1, 1, 'read', '*', '*', 'auto', 'user:dom', 'seed')`,
    [RULE_ID],
  );
  await client.query(
    `INSERT INTO alerts (id, severity, kind, dedupe_key, title, body, provenance)
     VALUES ($1, 'P1', 'watcher_failed', 'graph-mail:inbox', 't', 'b', '[]'::jsonb)`,
    [ALERT_ID],
  );
  await client.query(
    "INSERT INTO cursors (watcher, key, value) VALUES ('graph-mail', 'inbox', 'delta-1')",
  );

  await runMigrations({ connectionString: url });
});

afterAll(async () => {
  await client?.end();
  await container?.stop();
  rmSync(partialFolder, { recursive: true, force: true });
});

describe('migration 0009 over existing data', () => {
  it('makes the one users row the principal, keeping its id and identifiers', async () => {
    const result = await client.query(
      'SELECT id, upn, slack_user_id, notion_user_id, status FROM principals',
    );
    expect(result.rows).toEqual([
      {
        id: DOM_ID,
        upn: 'dom@valliance.ai',
        slack_user_id: 'U0SLACKDOM',
        notion_user_id: 'notion-dom',
        status: 'active',
      },
    ]);
  });

  it("gives every existing row the principal's id and leaves the rules to the organisation", async () => {
    for (const table of ['ledger_events', 'alerts', 'cursors']) {
      const result = await client.query(`SELECT DISTINCT principal_id FROM ${table}`);
      expect({ table, rows: result.rows }).toEqual({ table, rows: [{ principal_id: DOM_ID }] });
    }
    const rules = await client.query('SELECT principal_id FROM policy_rules');
    expect(rules.rows).toEqual([{ principal_id: null }]);
  });

  it('moves the run state to the principal and clears the global pause', async () => {
    const state = await client.query(
      'SELECT principal_id, paused, paused_reason, mode, cost_ceiling_gbp, push_budget_per_hour FROM principal_state',
    );
    expect(state.rows).toEqual([
      {
        principal_id: DOM_ID,
        paused: true,
        paused_reason: 'drill',
        mode: 'dry_run',
        cost_ceiling_gbp: '30.01',
        push_budget_per_hour: 5,
      },
    ]);
    const global = await client.query('SELECT paused, mode, cost_ceiling_gbp FROM system_state');
    expect(global.rows).toEqual([{ paused: false, mode: 'dry_run', cost_ceiling_gbp: '30.01' }]);
  });

  it("serves the existing rows to the principal's own scope and to no other", async () => {
    const appUrl = new URL(container.getConnectionUri());
    await client.query("CREATE ROLE backfill_app LOGIN PASSWORD 'backfill'");
    await client.query('GRANT lance_app TO backfill_app');
    appUrl.username = 'backfill_app';
    appUrl.password = 'backfill';
    const appDb = createDb({ connectionString: appUrl.toString() });
    try {
      const dom = await scopedDb(appDb, { principalId: DOM_ID }).$client.query(
        'SELECT id FROM ledger_events',
      );
      expect(dom.rows).toEqual([{ id: LEDGER_ID }]);
      const unscoped = await appDb.$client.query('SELECT id FROM ledger_events');
      expect(unscoped.rows).toEqual([]);
    } finally {
      await appDb.$client.end();
    }
  });

  it('refuses a retention update that moves a ledger row to another principal', async () => {
    const other = '01K5S9V6QW3SWCCPVB0N0E302P';
    await client.query("INSERT INTO principals (id, upn) VALUES ($1, 'other@example.test')", [
      other,
    ]);
    // A superuser clears the trigger's retention membership check, so this
    // exercises the changed-column check that now covers principal_id.
    await expect(
      client.query('UPDATE ledger_events SET payload = NULL, principal_id = $1 WHERE id = $2', [
        other,
        LEDGER_ID,
      ]),
    ).rejects.toThrow(/changes another column/);
  });
});
