import { runMigrations, scopedDb, SEED_PRINCIPAL_ID, type Db } from '@lance/db';
import { openAppTestDb, startPostgresContainer } from '@lance/db/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSeedRules, POLICY_SEED_ACTOR } from './rules.js';

/**
 * Seeding the organisation rules over a real database, as a lance_app
 * member in the admin's scope, as `main.ts` does.
 */

let container: StartedPostgreSqlContainer;
let root: Db;

beforeAll(async () => {
  container = await startPostgresContainer();
  const url = container.getConnectionUri();
  await runMigrations({ connectionString: url });
  root = await openAppTestDb(url);
}, 120_000);

afterAll(async () => {
  await root?.$client.end();
  await container?.stop();
});

describe('ensureSeedRules', () => {
  it('records a rule_changed event for every organisation rule it creates, where the admin views read it', async () => {
    const admin = scopedDb(root, { principalId: SEED_PRINCIPAL_ID, admin: true });

    const { inserted } = await ensureSeedRules(admin, 'C0BU7P278N5');

    expect(inserted).toBeGreaterThan(0);
    // The join the admin rule-change view runs (apps/api/src/admin/store.ts).
    const changes = await scopedDb(root, { principalId: SEED_PRINCIPAL_ID }).execute(sql`
      SELECT e.actor, e.payload ->> 'change' AS change, r.id AS rule_id
        FROM ledger_events e
        JOIN policy_rules r ON r.id = e.payload ->> 'ruleId' AND r.principal_id IS NULL
       WHERE e.kind = 'rule_changed'`);
    expect(changes.rows).toHaveLength(inserted);
    expect(new Set(changes.rows.map((row) => row['change']))).toEqual(new Set(['created']));
    expect(new Set(changes.rows.map((row) => row['actor']))).toEqual(new Set([POLICY_SEED_ACTOR]));
  });

  it('records nothing more once the rules exist', async () => {
    const admin = scopedDb(root, { principalId: SEED_PRINCIPAL_ID, admin: true });
    const before = await admin.execute(
      sql`SELECT count(*)::int AS n FROM ledger_events WHERE kind = 'rule_changed'`,
    );

    expect(await ensureSeedRules(admin, 'C0BU7P278N5')).toEqual({ inserted: 0 });
    const after = await admin.execute(
      sql`SELECT count(*)::int AS n FROM ledger_events WHERE kind = 'rule_changed'`,
    );
    expect(after.rows[0]?.['n']).toBe(before.rows[0]?.['n']);
  });
});
