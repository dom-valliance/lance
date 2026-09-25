import { commitments, SEED_PRINCIPAL_ID, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { OntologyRepository } from '@lance/ontology';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { commitmentOverdueDetector } from './commitmentOverdue.js';
import type { DetectorContext } from './types.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;
let annId: string;
let domId: string;

const NOW = '2026-09-22T12:00:00.000Z';
const correlationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const config = {
  timeZone: 'Europe/London',
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.8 },
  dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
  proposals: { expiryHours: 24 },
  briefs: { minFreeBlockHours: 2 },
};

const sourceRefs = [
  { system: 'jamie', recordId: 'mt-1', hash: 'h1', observedAt: '2026-09-15T10:00:00.000Z' },
];

const context = (): DetectorContext => ({
  db,
  config,
  principal: { email: 'dom@valliance.ai' },
  ontology,
  now: () => NOW,
});

async function commitment(values: {
  direction: 'outbound' | 'inbound';
  status: 'open' | 'chased' | 'done' | 'dropped';
  dueAt: string | null;
  description?: string;
  refs?: unknown;
}): Promise<string> {
  const id = newUlid();
  await db.insert(commitments).values({
    id,
    direction: values.direction,
    ownerPersonId: values.direction === 'outbound' ? domId : annId,
    counterpartyPersonId: annId,
    description: values.description ?? 'Send the revised statement of work',
    dueAt: values.dueAt === null ? null : new Date(values.dueAt),
    evidenceQuote: 'I will send the revised SOW by Friday',
    sourceRefs: values.refs ?? sourceRefs,
    status: values.status,
  });
  return id;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  ontology = new OntologyRepository(db, { principalId: SEED_PRINCIPAL_ID });
  const ref = { system: 'jamie' as const, id: 'mt-1', observedAt: '2026-09-15T10:00:00.000Z' };
  annId = (
    await ontology.upsertPerson(
      { displayName: 'Ann Example', emails: ['ann@client.test'], sourceRef: ref },
      { correlationId },
    )
  ).id;
  domId = (
    await ontology.upsertPerson(
      { displayName: 'Dom Selvon', emails: ['dom@valliance.ai'], sourceRef: ref },
      { correlationId },
    )
  ).id;
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(commitments);
});

describe('commitmentOverdueDetector', () => {
  it('runs hourly', () => {
    expect(commitmentOverdueDetector.schedule).toBe('0 * * * *');
  });

  it('raises a P1 naming the counterparty and the days overdue, keyed on the commitment', async () => {
    const id = await commitment({
      direction: 'outbound',
      status: 'open',
      dueAt: '2026-09-19T12:00:00.000Z',
    });

    const alerts = await commitmentOverdueDetector.run(context());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'commitment_overdue_outbound',
      severity: 'P1',
      dedupeKey: `commitment:${id}`,
    });
    expect(alerts[0]?.title).toBe('Promise to Ann Example is 3 days overdue');
    expect(alerts[0]?.body).toContain('Send the revised statement of work');
    expect(alerts[0]?.body).toContain('Suggested action');
    expect(alerts[0]?.provenance).toEqual(sourceRefs.map((ref) => ({ ...ref, system: 'jamie' })));
  });

  it('includes a commitment already chased once', async () => {
    await commitment({
      direction: 'outbound',
      status: 'chased',
      dueAt: '2026-09-18T12:00:00.000Z',
    });
    expect(await commitmentOverdueDetector.run(context())).toHaveLength(1);
  });

  it('gives a promise a day of grace before calling it overdue', async () => {
    await commitment({ direction: 'outbound', status: 'open', dueAt: '2026-09-22T00:00:00.000Z' });
    expect(await commitmentOverdueDetector.run(context())).toEqual([]);
  });

  it('ignores an inbound promise, which is a chase rather than an alert', async () => {
    await commitment({ direction: 'inbound', status: 'open', dueAt: '2026-09-15T12:00:00.000Z' });
    expect(await commitmentOverdueDetector.run(context())).toEqual([]);
  });

  it('ignores a commitment that is done or dropped', async () => {
    await commitment({ direction: 'outbound', status: 'done', dueAt: '2026-09-15T12:00:00.000Z' });
    await commitment({
      direction: 'outbound',
      status: 'dropped',
      dueAt: '2026-09-15T12:00:00.000Z',
    });
    expect(await commitmentOverdueDetector.run(context())).toEqual([]);
  });

  it('ignores a commitment with no due date, which cannot be late', async () => {
    await commitment({ direction: 'outbound', status: 'open', dueAt: null });
    expect(await commitmentOverdueDetector.run(context())).toEqual([]);
  });

  it('falls back to a Lance provenance ref when the commitment carries none', async () => {
    await commitment({
      direction: 'outbound',
      status: 'open',
      dueAt: '2026-09-19T12:00:00.000Z',
      refs: [],
    });
    const alerts = await commitmentOverdueDetector.run(context());
    expect(alerts[0]?.provenance?.[0]?.system).toBe('lance');
    expect(alerts[0]?.provenance?.[0]?.hash).not.toBe('');
  });
});
