import { commitments, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader } from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordCommitments } from './record.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let ontology: OntologyRepository;

const correlationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const provenance = [
  {
    system: 'jamie' as const,
    recordId: 'mt-1',
    hash: 'h1',
    observedAt: '2026-09-21T10:00:00.000Z',
  },
];
const dom = { name: 'Dom Selvon', email: 'dom@valliance.ai', notionUserId: 'notion-dom' };

const candidates = [
  {
    direction: 'outbound' as const,
    description: 'Send the revised statement of work',
    counterpartyName: 'Ann Example',
    counterpartyEmail: 'ann@client.test',
    dueAt: '2026-09-25',
    dueConfidence: 0.7,
    evidenceQuote: 'I will send the revised SOW by Friday',
    recordId: 'mt-1',
  },
  {
    direction: 'inbound' as const,
    description: 'Confirm the start date',
    counterpartyName: 'Ann Example',
    counterpartyEmail: null,
    dueAt: '2026-09-23',
    dueConfidence: 1,
    evidenceQuote: 'I will confirm the start date on Wednesday',
    recordId: 'mt-1',
  },
];

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  ontology = new OntologyRepository(db);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('recordCommitments', () => {
  it('writes one row per commitment with the right owner, resolves the counterparty once and links the graph', async () => {
    const result = await recordCommitments({ db, ontology, dom }, candidates, {
      correlationId,
      actor: 'agent:triage@0.1.0',
      provenance,
      directory: [{ name: 'Ann Example', email: 'ann@client.test' }],
    });

    expect(result.recorded).toHaveLength(2);
    expect(result.skipped).toBe(0);
    const ann = await ontology.findPersonByEmail('ann@client.test');
    const domNode = await ontology.findPersonByEmail('dom@valliance.ai');
    if (ann === null || domNode === null) throw new Error('people should exist');
    const rows = await db.select().from(commitments);
    const outbound = rows.find((row) => row.direction === 'outbound');
    const inbound = rows.find((row) => row.direction === 'inbound');
    expect(outbound).toMatchObject({ ownerPersonId: domNode.id, counterpartyPersonId: ann.id });
    expect(inbound).toMatchObject({ ownerPersonId: ann.id, counterpartyPersonId: ann.id });
    expect(inbound?.nextChaseAt?.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(outbound?.nextChaseAt).toBeNull();
    const owes = await ontology.neighbours(outbound?.id ?? '', 'OWES');
    expect(owes[0]?.node.id).toBe(domNode.id);
    const trail = await new LedgerReader(db).byCorrelation(correlationId);
    expect(
      trail.filter(
        (event) => (event.payload as { kind?: string } | null)?.kind === 'commitment_recorded',
      ),
    ).toHaveLength(2);
  });

  it('does not record the same open commitment twice', async () => {
    const again = await recordCommitments({ db, ontology, dom }, candidates, {
      correlationId,
      actor: 'agent:triage@0.1.0',
      provenance,
      directory: [{ name: 'Ann Example', email: 'ann@client.test' }],
    });
    expect(again.recorded).toHaveLength(0);
    expect(again.skipped).toBe(2);
    expect(await db.select().from(commitments)).toHaveLength(2);
  });

  it('skips a candidate with no counterparty and one that resolves to Dom himself', async () => {
    const result = await recordCommitments(
      { db, ontology, dom },
      [
        {
          ...candidates[0]!,
          description: 'Nobody in particular',
          counterpartyName: null,
          counterpartyEmail: null,
        },
        {
          ...candidates[0]!,
          description: 'Talk to myself',
          counterpartyName: 'Dom Selvon',
          counterpartyEmail: 'dom@valliance.ai',
        },
      ],
      { correlationId, actor: 'agent:triage@0.1.0', provenance },
    );
    expect(result.recorded).toHaveLength(0);
    expect(result.skipped).toBe(2);
  });
});
