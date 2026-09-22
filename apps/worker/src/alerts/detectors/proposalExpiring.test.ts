import { createDb, proposals, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { OntologyRepository } from '@lance/ontology';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { proposalExpiringDetector } from './proposalExpiring.js';
import type { DetectorContext } from './types.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;

const NOW = '2026-09-22T12:00:00.000Z';

const config = {
  timeZone: 'Europe/London',
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.8 },
  dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
  proposals: { expiryHours: 24 },
  briefs: { minFreeBlockHours: 2 },
};

const context = (): DetectorContext => ({ db, config, ontology, now: () => NOW });

const provenance = [
  { system: 'graph', recordId: 'm1', hash: 'h1', observedAt: '2026-09-21T08:00:00.000Z' },
];

async function proposal(values: {
  expiresAt: string;
  counterpartyClass?: 'client' | 'internal';
  status?: 'pending' | 'approved';
  refs?: unknown;
}): Promise<string> {
  const id = newUlid();
  await db.insert(proposals).values({
    id,
    correlationId: newUlid(),
    actionClass: 'draft_email',
    counterpartyClass: values.counterpartyClass ?? 'client',
    targetSystem: 'graph',
    reversibility: 'reversible',
    payload: { input: { subject: 'Revised SOW' } },
    preview: 'Draft a reply to Ann Example about the revised SOW.',
    rationale: 'Ann asked for the revised SOW on Monday.',
    provenance: values.refs ?? provenance,
    policyDecision: 'propose',
    status: values.status ?? 'pending',
    expiresAt: new Date(values.expiresAt),
  });
  return id;
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
  await db.delete(proposals);
});

describe('proposalExpiringDetector', () => {
  it('runs every fifteen minutes', () => {
    expect(proposalExpiringDetector.schedule).toBe('*/15 * * * *');
  });

  it('raises a P2 keyed on the proposal within six hours of expiry, carrying its provenance', async () => {
    const id = await proposal({ expiresAt: '2026-09-22T15:00:00.000Z' });

    const alerts = await proposalExpiringDetector.run(context());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'proposal_expiring',
      severity: 'P2',
      dedupeKey: `proposal:${id}`,
    });
    expect(alerts[0]?.title).toBe('Client proposal expires in 3.0 hours');
    expect(alerts[0]?.body).toContain('Draft a reply to Ann Example');
    expect(alerts[0]?.body).toContain('Suggested action');
    expect(alerts[0]?.provenance).toEqual(provenance);
  });

  it('stays quiet while expiry is more than six hours away', async () => {
    await proposal({ expiresAt: '2026-09-22T22:00:00.000Z' });
    expect(await proposalExpiringDetector.run(context())).toEqual([]);
  });

  it('stays quiet once the proposal has already expired', async () => {
    await proposal({ expiresAt: '2026-09-22T11:00:00.000Z' });
    expect(await proposalExpiringDetector.run(context())).toEqual([]);
  });

  it('ignores a proposal whose counterparty is not a client', async () => {
    await proposal({ expiresAt: '2026-09-22T15:00:00.000Z', counterpartyClass: 'internal' });
    expect(await proposalExpiringDetector.run(context())).toEqual([]);
  });

  it('ignores a proposal that has already been decided', async () => {
    await proposal({ expiresAt: '2026-09-22T15:00:00.000Z', status: 'approved' });
    expect(await proposalExpiringDetector.run(context())).toEqual([]);
  });

  it('falls back to a Lance provenance ref when the proposal carries none', async () => {
    await proposal({ expiresAt: '2026-09-22T15:00:00.000Z', refs: [] });
    const alerts = await proposalExpiringDetector.run(context());
    expect(alerts[0]?.provenance?.[0]?.system).toBe('lance');
  });
});
