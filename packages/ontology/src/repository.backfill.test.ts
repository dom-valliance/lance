import { SEED_PRINCIPAL_ID, ledgerEvents, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCypher, sqlRunnerOf, type CypherParams } from './cypher.js';
import { MUTATION_KIND, OntologyRepository } from './repository.js';
import { graphSnapshot } from './testing.js';

/**
 * A graph as the repository wrote it before ADR 0017: no layers, and each
 * meeting's mailbox context on the shared node. Each statement is recorded
 * the way `apply` recorded it then, so a rebuild replays the legacy writes
 * and then the backfill.
 */

let container: StartedPostgreSqlContainer;
let db: Db;
let repo: OntologyRepository;
const context = { correlationId: newUlid() };
const TS = '2026-09-20T09:00:00.000Z';
const refs = [{ system: 'jamie', id: 'jm-1', observedAt: TS }];

async function legacy(cypher: string, params: CypherParams): Promise<void> {
  await runCypher(sqlRunnerOf(db), cypher, params);
  await new LedgerWriter(db).append({
    ts: TS,
    actor: 'system:ontology',
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId: context.correlationId,
    payload: { kind: MUTATION_KIND, cypher, params },
  });
}

async function mutations(): Promise<number> {
  const rows = await db.select().from(ledgerEvents).where(eq(ledgerEvents.kind, 'resolved'));
  return rows.length;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  repo = new OntologyRepository(
    db,
    { principalId: SEED_PRINCIPAL_ID },
    { now: () => '2026-09-23T09:00:00.000Z' },
  );
  const person = (id: string, name: string, email: string) =>
    legacy(
      'CREATE (p:Person {id: $id, display_name: $name, normalised_name: $normalised, emails: $emails, source_refs: $refs, created_at: $ts, updated_at: $ts}) RETURN p.id',
      { id, name, normalised: name.toLowerCase(), emails: [email], refs, ts: TS },
    );
  await person('P-DOM', 'Dom Selvon', 'dom@valliance.ai');
  await person('P-ANN', 'Ann Example', 'ann@northwind.test');
  // A transcript's name-only attendee, written shared before ADR 0033.
  await legacy(
    'CREATE (p:Person {id: $id, display_name: $name, normalised_name: $normalised, emails: [], source_refs: $refs, created_at: $ts, updated_at: $ts}) RETURN p.id',
    { id: 'P-NAME', name: 'Nia Nokey', normalised: 'nia nokey', refs, ts: TS },
  );
  await legacy(
    "CREATE (o:Organisation {id: 'O-1', name: 'Northwind', domains: ['northwind.test'], type: 'client'}) RETURN o.id",
    {},
  );
  const meeting = (id: string, jamieId: string, graphEventId: string, tags: string[]) =>
    legacy(
      'CREATE (m:Meeting {id: $id, title: $title, jamie_id: $jamieId, graph_event_id: $graphEventId, transcript_ref: null, tags: $tags, source_refs: $refs, created_at: $ts, updated_at: $ts}) RETURN m.id',
      { id, title: `Meeting ${id}`, jamieId, graphEventId, tags, refs, ts: TS },
    );
  await meeting('M-1', 'jm-1', 'evt-1', ['Client']);
  await meeting('M-2', 'jm-2', 'evt-unknown', []);
  // Jamie saw M-4 before the calendar did; M-5 already holds its iCalUId.
  await meeting('M-4', 'jm-4', 'evt-4', []);
  await legacy(
    'CREATE (m:Meeting {id: $id, title: $title, ical_uid: $icalUid, source_refs: [], created_at: $ts, updated_at: $ts}) RETURN m.id',
    { id: 'M-5', title: 'Meeting M-5', icalUid: 'ical-4', ts: TS },
  );
  await legacy(
    "CREATE (t:Task {id: 'T-N', title: 'Notion task', source: 'notion', source_id: 'n-1'}) RETURN t.id",
    {},
  );
  await legacy(
    "CREATE (t:Task {id: 'T-J', title: 'Jamie task', source: 'jamie', source_id: 'j-1'}) RETURN t.id",
    {},
  );
  await legacy("CREATE (c:Commitment {id: 'C-1'}) RETURN c.id", {});
  const edge = (from: string, label: string, to: string) =>
    legacy(`MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${label}]->(b) RETURN r`, {
      from,
      to,
    });
  await edge('P-ANN', 'ATTENDED', 'M-1');
  await edge('P-ANN', 'WORKS_AT', 'O-1');
  await edge('C-1', 'OWES', 'P-ANN');
  await edge('T-J', 'DERIVED_FROM', 'M-1');
  await edge('P-NAME', 'WORKS_AT', 'O-1');
  await edge('P-ANN', 'ATTENDED', 'M-4');
  await edge('C-1', 'DERIVED_FROM', 'M-4');
}, 120000);

const icalUidOf = (graphEventId: string): Promise<string | null> =>
  Promise.resolve(
    ({ 'evt-1': 'ical-1', 'evt-4': 'ical-4' } as Record<string, string>)[graphEventId] ?? null,
  );

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('OntologyRepository.backfillLayers', () => {
  it('shows nothing from a graph the backfill has not reached', async () => {
    expect(await repo.getNode('P-ANN')).toBeNull();
    expect(await repo.counts()).toEqual({ nodes: 0, edges: 0 });
  });

  it('layers every node and edge, moves meeting context to the edge and keys meetings on iCalUId', async () => {
    const result = await repo.backfillLayers(context, { icalUidOf });
    expect(result).toMatchObject({
      nodes: 11,
      edges: 7,
      meetingContexts: 3,
      meetingKeys: 1,
      meetingKeyConflicts: 0,
      meetingMerges: 1,
      meetingJamieIds: 1,
      privatePersons: 1,
      strippedRefs: 2,
      refused: 0,
    });
    expect(result.mutations).toBeGreaterThan(0);

    const { nodes, edges } = await graphSnapshot(db);
    const layerOf = (id: string) => nodes.find((node) => node.id === id);
    expect(layerOf('P-DOM')).toMatchObject({ layer: 'shared', principalId: null });
    expect(layerOf('O-1')).toMatchObject({ layer: 'shared', principalId: null });
    expect(layerOf('M-1')).toMatchObject({ layer: 'shared', principalId: null });
    expect(layerOf('T-N')).toMatchObject({ layer: 'shared', principalId: null });
    expect(layerOf('T-J')).toMatchObject({ layer: 'private', principalId: SEED_PRINCIPAL_ID });
    expect(layerOf('C-1')).toMatchObject({ layer: 'private', principalId: SEED_PRINCIPAL_ID });
    for (const edge of edges) {
      expect(edge).toMatchObject(
        edge.label === 'WORKS_AT' && edge.from === 'P-ANN'
          ? { layer: 'shared', principalId: null }
          : { layer: 'private', principalId: SEED_PRINCIPAL_ID },
      );
    }

    const m1 = layerOf('M-1')?.properties;
    expect(m1?.['ical_uid']).toBe('ical-1');
    expect(m1).not.toHaveProperty('graph_event_id');
    expect(m1).not.toHaveProperty('tags');
    expect(m1?.['source_refs']).toEqual([]);
    expect(await repo.meetingContext('M-1')).toMatchObject({
      graphEventId: 'evt-1',
      tags: ['Client'],
      jamieId: 'jm-1',
      sourceRefs: refs,
    });
    expect(await repo.findMeeting({ icalUid: 'ical-1' })).toMatchObject({ id: 'M-1' });
    expect(await repo.findMeeting({ graphEventId: 'evt-1' })).toMatchObject({ id: 'M-1' });
    expect(await repo.findMeeting({ jamieId: 'jm-2' })).toMatchObject({ id: 'M-2' });
    expect(layerOf('M-2')?.properties).not.toHaveProperty('ical_uid');
  });

  it('moves a name-only Person and its edges to the principal and strips record ids from shared refs', async () => {
    const { nodes, edges } = await graphSnapshot(db);
    const node = (id: string) => nodes.find((item) => item.id === id);
    expect(node('P-NAME')).toMatchObject({ layer: 'private', principalId: SEED_PRINCIPAL_ID });
    expect(node('P-NAME')?.properties['source_refs']).toEqual(refs);
    expect(edges.find((edge) => edge.from === 'P-NAME')).toMatchObject({
      label: 'WORKS_AT',
      layer: 'private',
      principalId: SEED_PRINCIPAL_ID,
    });
    for (const shared of nodes.filter((item) => item.layer === 'shared')) {
      for (const ref of (shared.properties['source_refs'] as object[] | undefined) ?? []) {
        expect(Object.keys(ref).sort()).toEqual(['observedAt', 'system']);
      }
    }
    expect(node('P-ANN')?.properties['source_refs']).toEqual([{ system: 'jamie', observedAt: TS }]);
    expect(await repo.sightings('P-ANN')).toEqual(refs);
    expect(await repo.sightings('P-DOM')).toEqual([]);
  });

  it('drops the Jamie id from a keyed Meeting and merges a Jamie-keyed one into its iCalUId holder', async () => {
    const { nodes, edges } = await graphSnapshot(db);
    const node = (id: string) => nodes.find((item) => item.id === id);
    expect(node('M-1')?.properties).not.toHaveProperty('jamie_id');
    expect(await repo.meetingContext('M-1')).toMatchObject({ jamieId: 'jm-1' });
    expect(node('M-4')).toBeUndefined();
    expect(edges.filter((edge) => edge.to === 'M-4' || edge.from === 'M-4')).toEqual([]);
    expect(await repo.findMeeting({ jamieId: 'jm-4' })).toMatchObject({ id: 'M-5' });
    expect(await repo.meetingContext('M-5')).toMatchObject({
      jamieId: 'jm-4',
      graphEventId: 'evt-4',
    });
    const into = edges
      .filter((edge) => edge.to === 'M-5')
      .map((edge) => `${edge.label}:${edge.from}`);
    expect(into.sort()).toEqual(['ATTENDED:P-ANN', 'ATTENDED:P-DOM', 'DERIVED_FROM:C-1']);
  });

  it('records nothing on a second run', async () => {
    const before = await mutations();
    const again = await repo.backfillLayers(context, { icalUidOf });
    expect(again).toEqual({
      nodes: 0,
      edges: 0,
      meetingContexts: 0,
      meetingKeys: 0,
      meetingKeyConflicts: 0,
      meetingMerges: 0,
      meetingJamieIds: 0,
      privatePersons: 0,
      strippedRefs: 0,
      refused: 0,
      mutations: 0,
    });
    expect(await mutations()).toBe(before);
  });

  it('rebuilds the backfilled graph exactly from the legacy writes and the backfill', async () => {
    const before = await graphSnapshot(db);
    await repo.rebuild();
    expect(await graphSnapshot(db)).toEqual(before);
  });
});
