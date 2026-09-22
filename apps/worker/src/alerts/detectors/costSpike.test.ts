import { agentRuns, createDb, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { OntologyRepository } from '@lance/ontology';
import { hashRecord, newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { costSpikeDetector } from './costSpike.js';
import type { DetectorContext } from './types.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;

/** Tuesday lunchtime, British Summer Time: the local day is 22 September. */
const NOW = '2026-09-22T12:00:00.000Z';

const config = {
  timeZone: 'Europe/London',
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.8 },
  dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
  proposals: { expiryHours: 24 },
  briefs: { minFreeBlockHours: 2 },
};

const context = (): DetectorContext => ({ db, config, ontology, now: () => NOW });

async function spend(day: string, costUsd: number): Promise<void> {
  await db.insert(agentRuns).values({
    id: newUlid(),
    agent: 'triage',
    version: '0.1.0',
    model: 'claude-sonnet-5',
    startedAt: new Date(`${day}T09:00:00.000Z`),
    status: 'succeeded',
    estimatedCostUsd: costUsd.toFixed(6),
  });
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  ontology = new OntologyRepository(db);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(agentRuns);
});

describe('costSpikeDetector', () => {
  it('runs hourly and raises cost_spike keyed on the local day when today beats twice the trailing mean', async () => {
    await spend('2026-09-19', 1);
    await spend('2026-09-20', 1);
    await spend('2026-09-21', 1);
    await spend('2026-09-22', 2);

    expect(costSpikeDetector.schedule).toBe('0 * * * *');
    const alerts = await costSpikeDetector.run(context());
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert?.kind).toBe('cost_spike');
    expect(alert?.severity).toBe('P1');
    expect(alert?.dedupeKey).toBe('date:2026-09-22');
    expect(alert?.body).toContain('USD 2.00');
    expect(alert?.body).toContain('Suggested action');
  });

  it('carries provenance naming the agent runs for the day and the hash of its total', async () => {
    await spend('2026-09-19', 1);
    await spend('2026-09-20', 1);
    await spend('2026-09-21', 1);
    await spend('2026-09-22', 2);

    const alerts = await costSpikeDetector.run(context());
    expect(alerts[0]?.provenance).toEqual([
      {
        system: 'lance',
        recordId: 'agent_runs:2026-09-22',
        hash: hashRecord(2),
        observedAt: NOW,
      },
    ]);
  });

  it('stays quiet when fewer than three of the trailing days have any spend', async () => {
    await spend('2026-09-20', 1);
    await spend('2026-09-21', 1);
    await spend('2026-09-22', 20);

    expect(await costSpikeDetector.run(context())).toEqual([]);
  });

  it('stays quiet when today is under twice the trailing mean', async () => {
    await spend('2026-09-19', 1);
    await spend('2026-09-20', 1);
    await spend('2026-09-21', 1);
    await spend('2026-09-22', 0.5);

    expect(await costSpikeDetector.run(context())).toEqual([]);
  });

  it('ignores days older than the trailing week', async () => {
    await spend('2026-09-10', 100);
    await spend('2026-09-19', 1);
    await spend('2026-09-20', 1);
    await spend('2026-09-21', 1);
    await spend('2026-09-22', 2);

    const alerts = await costSpikeDetector.run(context());
    expect(alerts).toHaveLength(1);
  });

  it('counts a run at 23:30 UTC towards the following local day', async () => {
    await db.insert(agentRuns).values({
      id: newUlid(),
      agent: 'triage',
      version: '0.1.0',
      model: 'claude-sonnet-5',
      // 00:30 on 22 September in Europe/London, so it belongs to today.
      startedAt: new Date('2026-09-21T23:30:00.000Z'),
      status: 'succeeded',
      estimatedCostUsd: '2.000000',
    });
    await spend('2026-09-19', 1);
    await spend('2026-09-20', 1);
    await spend('2026-09-21', 1);

    const alerts = await costSpikeDetector.run(context());
    expect(alerts[0]?.dedupeKey).toBe('date:2026-09-22');
    expect(alerts[0]?.body).toContain('USD 2.00');
  });
});
