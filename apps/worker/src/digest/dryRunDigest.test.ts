import { proposals, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDryRunDigest, postDryRunDigest } from './dryRunDigest.js';

let container: StartedPostgreSqlContainer;
let db: Db;

async function held(decision: 'auto' | 'propose' | 'forbid', preview: string): Promise<void> {
  await db.insert(proposals).values({
    id: newUlid(),
    correlationId: newUlid(),
    actionClass: 'apply_category',
    counterpartyClass: 'unknown',
    targetSystem: 'graph',
    targetRecordId: 'm',
    reversibility: 'reversible',
    payload: {},
    preview,
    rationale: 'r',
    provenance: [],
    policyDecision: decision,
    status: 'held',
    expiresAt: new Date(Date.now() + 3600_000),
  });
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('dry run digest', () => {
  it('says nothing was held when nothing was', async () => {
    const digest = await buildDryRunDigest(db, new Date(Date.now() - 3600_000), 'Lance');
    expect(digest.lines).toHaveLength(0);
    expect(digest.text).toContain('nothing was held');
  });

  it('counts what live mode would have done and posts one message', async () => {
    await held('auto', 'Apply category Newsletters');
    await held('propose', 'Create Notion task: Send SOW');
    const posted: string[] = [];
    const digest = await postDryRunDigest(
      db,
      { post: (input) => (posted.push(input.text), Promise.resolve({ channel: 'C', ts: '1' })) },
      { since: new Date(Date.now() - 3600_000), displayName: 'Lance' },
    );
    expect(digest.lines).toHaveLength(2);
    expect(digest.text).toContain(
      '1 would have run automatically, 1 would have asked you, 0 forbidden',
    );
    expect(digest.text).toContain('Apply category Newsletters');
    expect(posted).toHaveLength(1);
  });
});
