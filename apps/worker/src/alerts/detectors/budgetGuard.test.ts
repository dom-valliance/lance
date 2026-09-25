import { agentRuns, SEED_PRINCIPAL_ID, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { OntologyRepository } from '@lance/ontology';
import { hashRecord, newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { budgetGuardDetector } from './budgetGuard.js';
import type { DetectorContext } from './types.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;

const NOW = '2026-09-22T12:00:00.000Z';

/** A ceiling of GBP 15 at 0.8 GBP to the dollar: USD 18.75 buys the whole day. */
const config = {
  timeZone: 'Europe/London',
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.8 },
  dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
  proposals: { expiryHours: 24 },
  briefs: { minFreeBlockHours: 2 },
};

const context = (): DetectorContext => ({
  db,
  config,
  principal: { email: 'dom@valliance.ai' },
  ontology,
  now: () => NOW,
});

async function spend(startedAt: string, costUsd: number): Promise<void> {
  await db.insert(agentRuns).values({
    id: newUlid(),
    agent: 'planner',
    version: '0.1.0',
    model: 'claude-opus-5',
    startedAt: new Date(startedAt),
    status: 'succeeded',
    estimatedCostUsd: costUsd.toFixed(6),
  });
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  ontology = new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID });
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(agentRuns);
});

describe('budgetGuardDetector', () => {
  it('runs every fifteen minutes', () => {
    expect(budgetGuardDetector.schedule).toBe('*/15 * * * *');
  });

  it('stays quiet while spend is under eighty per cent of the ceiling', async () => {
    await spend('2026-09-22T09:00:00.000Z', 10);
    expect(await budgetGuardDetector.run(context())).toEqual([]);
  });

  it('raises a P1 at eighty per cent of the ceiling', async () => {
    await spend('2026-09-22T09:00:00.000Z', 15);
    const alerts = await budgetGuardDetector.run(context());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'cost_spike',
      severity: 'P1',
      dedupeKey: 'budget:80:2026-09-22',
      title: 'Daily model spend at 80% of the ceiling',
    });
    expect(alerts[0]?.body).toContain('GBP 12.00');
    expect(alerts[0]?.body).toContain('Suggested action');
    expect(alerts[0]?.provenance).toEqual([
      {
        system: 'lance',
        recordId: 'agent_runs:2026-09-22',
        hash: hashRecord(15),
        observedAt: NOW,
      },
    ]);
  });

  it('raises a P0 at the ceiling saying agents are paused and watchers continue', async () => {
    await spend('2026-09-22T08:00:00.000Z', 10);
    await spend('2026-09-22T09:00:00.000Z', 8.75);
    const alerts = await budgetGuardDetector.run(context());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'cost_spike',
      severity: 'P0',
      dedupeKey: 'budget:100:2026-09-22',
    });
    expect(alerts[0]?.body).toContain('paused until midnight');
    expect(alerts[0]?.body).toContain('Watchers continue');
  });

  it('raises the ceiling alert alone once spend is past the ceiling', async () => {
    await spend('2026-09-22T09:00:00.000Z', 40);
    const alerts = await budgetGuardDetector.run(context());
    expect(alerts.map((alert) => alert.dedupeKey)).toEqual(['budget:100:2026-09-22']);
  });

  it('counts today alone, so spend from the day before does not pause today', async () => {
    await spend('2026-09-21T09:00:00.000Z', 40);
    await spend('2026-09-22T09:00:00.000Z', 1);
    expect(await budgetGuardDetector.run(context())).toEqual([]);
  });
});
