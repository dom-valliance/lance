import {
  SEED_PRINCIPAL_ID,
  ledgerEvents,
  principalState,
  principals,
  runMigrations,
  scopedDb,
  type Db,
} from '@lance/db';
import { openFixtureDb, openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCypher, sqlRunnerOf, type CypherParams } from './cypher.js';
import { MUTATION_KIND, OntologyRepository, type SourceRef } from './repository.js';
import { graphSnapshot } from './testing.js';

/**
 * ADR 0033 as two principals write: name-only people stay private, a
 * shared Meeting drops its Jamie id once keyed on its iCalUId, and a
 * Jamie-keyed Meeting merges into the iCalUId one only when nothing
 * another principal wrote touches it.
 */

const DOM = SEED_PRINCIPAL_ID;
const BEA = '01K5S9V6QW3SWCCPVB0N0E301B';

let container: StartedPostgreSqlContainer;
let dbDom: Db;
let dbBea: Db;
let dom: OntologyRepository;
let bea: OntologyRepository;

const ref = (system: SourceRef['system'], id: string): SourceRef => ({
  system,
  id,
  observedAt: '2026-09-24T08:00:00.000Z',
});

const context = () => ({ correlationId: newUlid() });

function repository(db: Db, principalId: string, prefix: string, name: string) {
  let counter = 0;
  return new OntologyRepository(
    db,
    { principalId },
    {
      now: () => '2026-09-24T09:00:00.000Z',
      idFactory: () => `${prefix}${String(++counter).padStart(26 - prefix.length, '0')}`,
      principalName: name,
    },
  );
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  dbDom = await openSeededTestDb(connectionString);
  const fixtures = openFixtureDb(connectionString);
  await fixtures.insert(principals).values({ id: BEA, upn: 'bea@valliance.ai' });
  await fixtures.$client.end();
  dbBea = scopedDb(dbDom, { principalId: BEA });
  await dbBea.insert(principalState).values({});
  dom = repository(dbDom, DOM, '01D0M', 'Dom Selvon');
  bea = repository(dbBea, BEA, '01BEA', 'Bea Example');
}, 180000);

afterAll(async () => {
  await dbDom.$client.end();
  await container.stop();
});

describe('name-only people', () => {
  it('leaves the private node private when a later exact-key sighting creates the shared one, with a private candidate link', async () => {
    const heard = await dom.resolvePerson(
      { displayName: 'Farah Quinn', sourceRef: ref('jamie', 'jm-farah') },
      context(),
    );
    expect((await dom.getNode(heard.id))?.properties).toMatchObject({
      layer: 'private',
      principal_id: DOM,
    });

    const mailed = await dom.resolvePerson(
      {
        displayName: 'Farah Quinn',
        emails: ['farah@contoso.test'],
        sourceRef: ref('graph', 'msg-farah'),
      },
      context(),
    );
    expect(mailed.id).not.toBe(heard.id);
    expect(mailed).toMatchObject({ decision: 'candidate', matchedId: heard.id });
    expect((await dom.getNode(mailed.id))?.properties).toMatchObject({
      layer: 'shared',
      emails: ['farah@contoso.test'],
    });
    const stillPrivate = await dom.getNode(heard.id);
    expect(stillPrivate?.properties).toMatchObject({
      layer: 'private',
      principal_id: DOM,
      emails: [],
    });

    const { edges } = await graphSnapshot(dbDom);
    const candidate = edges.filter((edge) => edge.label === 'SAME_AS');
    expect(candidate).toEqual([
      expect.objectContaining({
        from: heard.id,
        to: mailed.id,
        layer: 'private',
        principalId: DOM,
      }),
    ]);
    expect(await bea.neighbours(mailed.id, 'SAME_AS')).toEqual([]);
  });

  it("finds the shared node for another principal's exact key without seeing the private one", async () => {
    const seen = await bea.resolvePerson(
      {
        displayName: 'Farah Quinn',
        emails: ['farah@contoso.test'],
        sourceRef: ref('graph', 'msg-bea-farah'),
      },
      context(),
    );
    expect(seen.decision).toBe('exact');
    expect(await bea.findPersonsByNormalisedName('farah quinn')).toEqual([
      expect.objectContaining({ id: seen.id }),
    ]);
  });
});

describe('shared meetings and Jamie ids', () => {
  it('drops the Jamie id from a shared Meeting once it gains an iCalUId, keeping it on the edge', async () => {
    const jamieOnly = await dom.upsertMeeting(
      {
        title: 'Contoso scoping',
        start: '2026-09-24T10:00:00.000Z',
        end: '2026-09-24T11:00:00.000Z',
        jamieId: 'jm-scope',
        graphEventId: 'evt-dom-scope',
        sourceRef: ref('jamie', 'jm-scope'),
      },
      context(),
    );
    expect((await dom.getNode(jamieOnly.id))?.properties['jamie_id']).toBe('jm-scope');
    expect(await bea.getNode(jamieOnly.id)).toBeNull();
    const keyed = await dom.upsertMeeting(
      {
        title: 'Contoso scoping',
        start: '2026-09-24T10:00:00.000Z',
        end: '2026-09-24T11:00:00.000Z',
        icalUid: 'ical-scope',
        jamieId: 'jm-scope',
        graphEventId: 'evt-dom-scope',
        sourceRef: ref('jamie', 'jm-scope'),
      },
      context(),
    );
    expect(keyed.id).toBe(jamieOnly.id);
    const node = await dom.getNode(keyed.id);
    expect(node?.properties['ical_uid']).toBe('ical-scope');
    expect(node?.properties).not.toHaveProperty('jamie_id');
    expect(node?.properties['layer']).toBe('shared');
    expect(node?.properties['principal_id'] ?? null).toBeNull();
    expect(await bea.getNode(keyed.id)).toMatchObject({ id: keyed.id });
    expect(await dom.meetingContext(keyed.id)).toMatchObject({ jamieId: 'jm-scope' });
  });

  it('creates a Meeting keyed on its iCalUId with no Jamie id on the node', async () => {
    const created = await bea.upsertMeeting(
      {
        title: 'Contoso steering',
        start: '2026-09-25T10:00:00.000Z',
        end: '2026-09-25T11:00:00.000Z',
        icalUid: 'ical-steer',
        jamieId: 'jm-bea-steer',
        sourceRef: ref('jamie', 'jm-bea-steer'),
      },
      context(),
    );
    expect((await bea.getNode(created.id))?.properties).not.toHaveProperty('jamie_id');
  });

  it('merges a Jamie-keyed Meeting into the iCalUId one when the calendar observation arrives', async () => {
    const calendar = await bea.upsertMeeting(
      {
        title: 'Contoso review',
        start: '2026-09-26T10:00:00.000Z',
        end: '2026-09-26T11:00:00.000Z',
        icalUid: 'ical-review',
        graphEventId: 'evt-bea-review',
        sourceRef: ref('graph', 'evt-bea-review'),
      },
      context(),
    );
    const mutation = context();
    const jamie = await dom.upsertMeeting(
      {
        title: 'Contoso review',
        start: '2026-09-26T10:00:00.000Z',
        end: '2026-09-26T11:00:00.000Z',
        jamieId: 'jm-review',
        transcriptRef: 'transcript-review',
        tags: ['Client'],
        sourceRef: ref('jamie', 'jm-review'),
      },
      mutation,
    );
    expect(jamie.id).not.toBe(calendar.id);
    const guest = await dom.resolvePerson(
      {
        displayName: 'Gus Guest',
        emails: ['gus@contoso.test'],
        sourceRef: ref('jamie', 'jm-review'),
      },
      mutation,
    );
    await dom.link(guest.id, 'ATTENDED', jamie.id, {}, mutation);
    const commitment = newUlid();
    await dom.ensureCommitment(commitment, mutation);
    await dom.link(commitment, 'DERIVED_FROM', jamie.id, {}, mutation);

    const merged = await dom.upsertMeeting(
      {
        title: 'Contoso review',
        start: '2026-09-26T10:00:00.000Z',
        end: '2026-09-26T11:00:00.000Z',
        icalUid: 'ical-review',
        jamieId: 'jm-review',
        graphEventId: 'evt-dom-review',
        sourceRef: ref('jamie', 'jm-review'),
      },
      context(),
    );
    expect(merged.id).toBe(calendar.id);
    expect(await dom.getNode(jamie.id)).toBeNull();
    const { nodes, edges } = await graphSnapshot(dbDom);
    expect(nodes.find((node) => node.id === jamie.id)).toBeUndefined();
    expect(edges.filter((edge) => edge.to === jamie.id || edge.from === jamie.id)).toEqual([]);
    expect(await dom.meetingContext(calendar.id)).toMatchObject({
      jamieId: 'jm-review',
      graphEventId: 'evt-dom-review',
      transcriptRef: 'transcript-review',
      tags: ['Client'],
    });
    expect(await bea.meetingContext(calendar.id)).toMatchObject({
      graphEventId: 'evt-bea-review',
      jamieId: null,
    });
    const intoDom = edges
      .filter((edge) => edge.to === calendar.id && edge.principalId === DOM)
      .map((edge) => `${edge.label}:${edge.from}`);
    expect(intoDom).toContain(`ATTENDED:${guest.id}`);
    expect(intoDom).toContain(`DERIVED_FROM:${commitment}`);
    expect(nodes.find((node) => node.id === calendar.id)?.properties).not.toHaveProperty(
      'jamie_id',
    );
  });

  it("keeps a meeting only one principal's Jamie saw private to them", async () => {
    const jamie = await dom.upsertMeeting(
      {
        title: 'Contoso retro',
        start: '2026-09-27T10:00:00.000Z',
        end: '2026-09-27T11:00:00.000Z',
        jamieId: 'jm-retro',
        sourceRef: ref('jamie', 'jm-retro'),
      },
      context(),
    );
    expect((await dom.getNode(jamie.id))?.properties).toMatchObject({
      layer: 'private',
      principal_id: DOM,
      title: 'Contoso retro',
    });
    expect(await bea.getNode(jamie.id)).toBeNull();
    expect(await bea.findMeeting({ jamieId: 'jm-retro' })).toBeNull();
    expect((await bea.search('Contoso retro')).map((node) => node.id)).not.toContain(jamie.id);
    // Bea's Jamie account seeing the same recording makes her own node.
    const hers = await bea.upsertMeeting(
      {
        title: 'Contoso retro',
        start: '2026-09-27T10:00:00.000Z',
        end: '2026-09-27T11:00:00.000Z',
        jamieId: 'jm-retro',
        sourceRef: ref('jamie', 'jm-retro'),
      },
      context(),
    );
    expect(hers.id).not.toBe(jamie.id);
    expect(await dom.getNode(hers.id)).toBeNull();
  });

  it("never lets one principal's Jamie rename a shared meeting, and lets the calendar", async () => {
    const calendar = await bea.upsertMeeting(
      {
        title: 'Contoso plan',
        start: '2026-09-28T10:00:00.000Z',
        end: '2026-09-28T11:00:00.000Z',
        icalUid: 'ical-plan',
        graphEventId: 'evt-bea-plan',
        sourceRef: ref('graph', 'evt-bea-plan'),
      },
      context(),
    );
    await dom.upsertMeeting(
      {
        title: 'Dom and Contoso, notes',
        start: '2026-09-28T10:04:00.000Z',
        end: '2026-09-28T10:52:00.000Z',
        icalUid: 'ical-plan',
        jamieId: 'jm-plan',
        sourceRef: ref('jamie', 'jm-plan'),
      },
      context(),
    );
    expect((await bea.getNode(calendar.id))?.properties).toMatchObject({
      title: 'Contoso plan',
      start: '2026-09-28T10:00:00.000Z',
      end_at: '2026-09-28T11:00:00.000Z',
    });
    await bea.upsertMeeting(
      {
        title: 'Contoso plan, moved',
        start: '2026-09-28T14:00:00.000Z',
        end: '2026-09-28T15:00:00.000Z',
        icalUid: 'ical-plan',
        graphEventId: 'evt-bea-plan',
        sourceRef: ref('graph', 'evt-bea-plan'),
      },
      context(),
    );
    expect((await dom.getNode(calendar.id))?.properties).toMatchObject({
      title: 'Contoso plan, moved',
      start: '2026-09-28T14:00:00.000Z',
    });
  });

  it("refuses to merge a Jamie-keyed Meeting another principal's edge touches, moving nothing", async () => {
    // A shared Jamie-keyed Meeting as the graph held them before private
    // Jamie meetings: Dom's edge and Bea's edge both reach it.
    const legacyId = '01LEGACYMEET0000000000000A';
    // Recorded as the repository records a mutation, so the rebuild replays them.
    const recorded = async (db: Db, cypher: string, params: CypherParams) => {
      await runCypher(sqlRunnerOf(db), cypher, params);
      await new LedgerWriter(db).append({
        ts: '2026-09-24T09:00:00.000Z',
        actor: 'system:ontology',
        kind: 'resolved',
        sourceSystem: 'lance',
        correlationId: newUlid(),
        payload: { kind: MUTATION_KIND, cypher, params },
      });
    };
    await recorded(
      dbDom,
      "CREATE (m:Meeting {id: $id, title: 'Contoso legacy', jamie_id: 'jm-legacy', layer: 'shared', principal_id: null, source_refs: []}) RETURN m.id",
      { id: legacyId },
    );
    const holder = await bea.upsertMeeting(
      {
        title: 'Contoso legacy',
        start: '2026-09-29T10:00:00.000Z',
        end: '2026-09-29T11:00:00.000Z',
        icalUid: 'ical-legacy',
        sourceRef: ref('graph', 'evt-bea-legacy'),
      },
      context(),
    );
    const domPerson = await dom.findPrincipalPerson();
    const beaPerson = await bea.findPrincipalPerson();
    if (domPerson === null || beaPerson === null) throw new Error('Both principals should exist.');
    for (const [person, principal, db] of [
      [domPerson.id, DOM, dbDom],
      [beaPerson.id, BEA, dbBea],
    ] as const) {
      await recorded(
        db,
        "MATCH (p:Person {id: $person}), (m:Meeting {id: $id}) CREATE (p)-[r:ATTENDED {layer: 'private', principal_id: $owner, jamie_id: 'jm-legacy'}]->(m) RETURN r",
        { person, id: legacyId, owner: principal },
      );
    }
    const commitment = newUlid();
    await dom.ensureCommitment(commitment, context());
    await dom.link(commitment, 'DERIVED_FROM', legacyId, {}, context());

    const result = await dom.upsertMeeting(
      {
        title: 'Contoso legacy',
        start: '2026-09-29T10:00:00.000Z',
        end: '2026-09-29T11:00:00.000Z',
        icalUid: 'ical-legacy',
        jamieId: 'jm-legacy',
        sourceRef: ref('jamie', 'jm-legacy'),
      },
      context(),
    );
    expect(result.id).toBe(holder.id);
    expect(await dom.getNode(legacyId)).toMatchObject({ id: legacyId });
    const { edges } = await graphSnapshot(dbDom);
    expect(edges.filter((edge) => edge.to === holder.id && edge.label === 'DERIVED_FROM')).toEqual(
      [],
    );
    expect(edges.filter((edge) => edge.to === legacyId).map((edge) => edge.principalId)).toEqual(
      expect.arrayContaining([DOM, BEA]),
    );
  });
});

describe('merging a meeting', () => {
  it('holds back an edge to a Meeting while a merge of it holds the lock, so none lands between check and delete', async () => {
    const meeting = await bea.upsertMeeting(
      {
        title: 'Contoso lock',
        start: '2026-09-30T10:00:00.000Z',
        end: '2026-09-30T11:00:00.000Z',
        icalUid: 'ical-lock',
        sourceRef: ref('graph', 'evt-bea-lock'),
      },
      context(),
    );
    const person = await bea.findPrincipalPerson();
    if (person === null) throw new Error('Bea should have a Person node.');
    let landed = false;
    let write: Promise<void> | null = null;
    await dbDom.transaction(async (tx) => {
      // What mergeMeeting holds from its edge scan to its delete.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`ontology-node:${meeting.id}`}))`,
      );
      write = bea.link(person.id, 'ATTENDED', meeting.id, {}, context()).then(() => {
        landed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(landed).toBe(false);
    });
    await write;
    expect(landed).toBe(true);
  });
});

describe('rebuild', () => {
  it('reproduces the graph exactly, merges and private people included', async () => {
    const before = await graphSnapshot(dbDom);
    const mutations = await dbDom
      .select({ payload: ledgerEvents.payload })
      .from(ledgerEvents)
      .where(eq(ledgerEvents.kind, 'resolved'));
    expect(mutations.some((row) => JSON.stringify(row.payload).includes('DETACH DELETE'))).toBe(
      true,
    );
    await dom.rebuild();
    expect(await graphSnapshot(dbDom)).toEqual(before);
  });
});
