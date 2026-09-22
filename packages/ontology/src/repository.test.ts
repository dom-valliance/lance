import { createDb, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OntologyRepository, type SourceRef } from './repository.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let repo: OntologyRepository;
let counter = 0;
const context = { correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };

const ref = (system: SourceRef['system'], id: string): SourceRef => ({
  system,
  id,
  observedAt: '2026-09-21T08:00:00.000Z',
});

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  repo = new OntologyRepository(db, {
    now: () => '2026-09-21T09:00:00.000Z',
    idFactory: () => `01ONTOLOGY${String(++counter).padStart(16, '0')}`,
  });
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('OntologyRepository', () => {
  it('creates a person once and merges a second sighting by email', async () => {
    const first = await repo.upsertPerson(
      { displayName: 'Ann Example', emails: ['Ann@Client.test'], sourceRef: ref('graph', 'm1') },
      context,
    );
    const second = await repo.upsertPerson(
      {
        displayName: 'Ann Example',
        emails: ['ann@client.test', 'ann.example@client.test'],
        notionUserId: 'notion-ann',
        sourceRef: ref('notion', 'page-1'),
      },
      context,
    );
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    const node = await repo.getNode(first.id);
    expect(node?.properties['emails']).toEqual(['ann@client.test', 'ann.example@client.test']);
    expect(node?.properties['notion_user_id']).toBe('notion-ann');
    expect(node?.properties['source_refs']).toHaveLength(2);
    expect(await repo.findPersonByKey('notion_user_id', 'notion-ann')).toMatchObject({
      id: first.id,
    });
  });

  it('links nodes idempotently and reads neighbours', async () => {
    const org = await repo.upsertOrganisation(
      {
        name: 'Client Ltd',
        domains: ['client.test'],
        type: 'client',
        sourceRef: ref('graph', 'm1'),
      },
      context,
    );
    const ann = await repo.findPersonByEmail('ann@client.test');
    if (ann === null) throw new Error('Ann should exist');
    await repo.link(ann.id, 'WORKS_AT', org.id, { role: 'Director' }, context);
    await repo.link(ann.id, 'WORKS_AT', org.id, { role: 'Director' }, context);
    const neighbours = await repo.neighbours(ann.id, 'WORKS_AT');
    expect(neighbours).toHaveLength(1);
    expect(neighbours[0]?.node.properties['name']).toBe('Client Ltd');
  });

  it('records every mutation as a resolved event with its Cypher and parameters', async () => {
    const trail = await new LedgerReader(db).byCorrelation(context.correlationId);
    const mutations = trail.filter((event) => event.kind === 'resolved');
    expect(mutations.length).toBeGreaterThanOrEqual(5);
    const payload = mutations[0]?.payload as { kind: string; cypher: string; params: unknown };
    expect(payload.kind).toBe('ontology_mutation');
    expect(payload.cypher).toContain('CREATE (p:Person');
    expect(payload.params).toMatchObject({ displayName: 'Ann Example' });
  });

  it('resolves an exact email match without scoring and a same-name unknown-org sighting as a candidate', async () => {
    const exact = await repo.resolvePerson(
      { displayName: 'A. Example', emails: ['ann@client.test'], sourceRef: ref('jamie', 'mt-1') },
      context,
    );
    expect(exact.decision).toBe('exact');

    const candidate = await repo.resolvePerson(
      { displayName: 'Ann Example', emails: ['ann@gmail.com'], sourceRef: ref('jamie', 'mt-2') },
      context,
    );
    expect(candidate.decision).toBe('candidate');
    expect(candidate.matchedId).toBe(exact.id);
    const sameAs = await repo.neighbours(candidate.id, 'SAME_AS');
    expect(sameAs).toHaveLength(1);
  });

  it('never auto-merges two people who attended the same meeting as distinct attendees', async () => {
    const meeting = await repo.upsertMeeting(
      {
        title: 'Kick-off',
        start: '2026-09-21T10:00:00.000Z',
        end: '2026-09-21T11:00:00.000Z',
        jamieId: 'mt-3',
        sourceRef: ref('jamie', 'mt-3'),
      },
      context,
    );
    const bob = await repo.upsertPerson(
      { displayName: 'Bob Sample', emails: ['bob@client.test'], sourceRef: ref('jamie', 'mt-3') },
      context,
    );
    await repo.link(bob.id, 'ATTENDED', meeting.id, {}, context);

    const other = await repo.resolvePerson(
      {
        displayName: 'Bob Sample',
        emails: ['bob.sample@client.test'],
        sourceRef: ref('jamie', 'mt-3'),
      },
      context,
    );
    expect(other.decision).toBe('candidate');
    expect(other.id).not.toBe(bob.id);
  });

  it('rebuilds the same graph from the ledger', async () => {
    const before = await repo.counts();
    const annBefore = await repo.findPersonByEmail('ann@client.test');
    const result = await repo.rebuild();
    expect(result.replayed).toBeGreaterThan(0);
    expect({ nodes: result.nodes, edges: result.edges }).toEqual(before);
    const annAfter = await repo.findPersonByEmail('ann@client.test');
    expect(annAfter?.id).toBe(annBefore?.id);
    expect(annAfter?.properties).toEqual(annBefore?.properties);
  });

  it('finds nodes by a case-insensitive substring of their name', async () => {
    const hits = await repo.search('client');
    expect(hits.map((hit) => hit.label)).toContain('Organisation');
  });
});

describe('OntologyRepository, review follow-ups', () => {
  it('reuses the known person for a same-name sighting that carries no identifier', async () => {
    const known = await repo.upsertPerson(
      { displayName: 'Priya Nandra', emails: ['priya@client.test'], sourceRef: ref('graph', 'm9') },
      context,
    );
    const sighting = await repo.resolvePerson(
      { displayName: 'Priya Nandra', sourceRef: ref('jamie', 'mt-9') },
      context,
    );
    expect(sighting.id).toBe(known.id);
    expect(sighting.decision).toBe('merge');
  });

  it('refuses to rebuild when a recorded mutation has lost its statement', async () => {
    // Retention nulls a payload in place (ADR 0011); the closest a test can
    // get without that role is a mutation event whose statement is absent.
    await new LedgerWriter(db).append({
      ts: '2026-09-21T12:00:00.000Z',
      actor: 'system:ontology',
      kind: 'resolved',
      sourceSystem: 'lance',
      correlationId: context.correlationId,
      payload: { kind: 'ontology_mutation' },
    });
    await expect(repo.rebuild()).rejects.toThrow(/no longer be rebuilt/);
  });
});
