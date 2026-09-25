import {
  SEED_PRINCIPAL_ID,
  principalState,
  principals,
  runMigrations,
  scopedDb,
  type Db,
} from '@lance/db';
import { openFixtureDb, openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OntologyRepository, type SourceRef } from './repository.js';
import { graphSnapshot, type GraphSnapshot } from './testing.js';

/**
 * ADR 0017's isolation harness. Two principals write private evidence
 * about the same meeting through their own repositories; every public
 * read of one principal's repository is then probed for the other's
 * private nodes, edges and edge properties, and the graph is rebuilt
 * from both principals' ledgers.
 */

const DOM = SEED_PRINCIPAL_ID;
const BEA = '01K5S9V6QW3SWCCPVB0N0E301B';
const ICAL = '040000008200E00074C5B7101A82E008000000000SHARED';

let container: StartedPostgreSqlContainer;
let dbDom: Db;
let dbBea: Db;
let dom: OntologyRepository;
let bea: OntologyRepository;

const ref = (system: SourceRef['system'], id: string): SourceRef => ({
  system,
  id,
  observedAt: '2026-09-22T08:00:00.000Z',
});

/** What each principal wrote, by id. */
interface Evidence {
  meeting: string;
  principalPerson: string;
  thread: string;
  commitment: string;
  task: string;
  /** The private Person made for a transcript attendee known only by name (ADR 0033). */
  nameOnly: string;
  /** Edge property values only this principal's edges carry. */
  edgeValues: string[];
  /** Record ids of this principal's sightings, which no shared node may carry (ADR 0033). */
  recordIds: string[];
}

let domEvidence: Evidence;
let beaEvidence: Evidence;
let ann: string;
let carol: string;
let dana: string;
let before: GraphSnapshot;

function repository(db: Db, principalId: string, prefix: string, name: string) {
  let counter = 0;
  return new OntologyRepository(
    db,
    { principalId },
    {
      now: () => '2026-09-22T09:00:00.000Z',
      idFactory: () => `${prefix}${String(++counter).padStart(26 - prefix.length, '0')}`,
      principalName: name,
    },
  );
}

async function writeEvidence(
  repo: OntologyRepository,
  who: 'dom' | 'bea',
  attendees: { name: string; email: string }[],
): Promise<Evidence> {
  const context = { correlationId: newUlid() };
  const jamieRef = ref('jamie', `jamie-${who}`);
  const meeting = await repo.upsertMeeting(
    {
      title: 'Northwind pilot review',
      start: '2026-09-22T10:00:00.000Z',
      end: '2026-09-22T11:00:00.000Z',
      icalUid: ICAL,
      jamieId: `jamie-${who}`,
      graphEventId: `graph-${who}`,
      transcriptRef: `transcript-${who}`,
      tags: [`tag-${who}`],
      sourceRef: jamieRef,
    },
    context,
  );
  const people: string[] = [];
  for (const attendee of attendees) {
    const resolved = await repo.resolvePerson(
      { displayName: attendee.name, emails: [attendee.email], sourceRef: jamieRef },
      context,
    );
    await repo.link(resolved.id, 'ATTENDED', meeting.id, {}, context);
    people.push(resolved.id);
  }
  // Both principals hear an attendee Jamie names without an address, and
  // both see Dana in a message of their own.
  const nameOnly = await repo.resolvePerson(
    { displayName: 'Erin Nokey', sourceRef: jamieRef },
    context,
  );
  await repo.link(nameOnly.id, 'ATTENDED', meeting.id, {}, context);
  await repo.resolvePerson(
    {
      displayName: 'Dana Example',
      emails: ['dana@northwind.test'],
      sourceRef: {
        ...ref('graph', `msg-${who}-dana`),
        url: `https://outlook.test/msg-${who}-dana`,
      },
    },
    context,
  );
  const counterparty = people[people.length - 1];
  if (counterparty === undefined) throw new Error('Each principal needs an attendee.');
  const thread = await repo.upsertThread(
    {
      conversationId: `conv-${who}`,
      subject: `Renewal paperwork ${who}`,
      lastMessageAt: '2026-09-22T07:00:00.000Z',
      sourceRef: ref('graph', `msg-${who}`),
    },
    context,
  );
  await repo.link(counterparty, 'PARTICIPATED_IN', thread.id, {}, context);
  const commitmentId = newUlid();
  await repo.ensureCommitment(commitmentId, context);
  await repo.link(commitmentId, 'OWES', counterparty, {}, context);
  await repo.link(commitmentId, 'DERIVED_FROM', meeting.id, {}, context);
  const task = await repo.upsertTask(
    {
      title: `Send the pilot plan ${who}`,
      status: 'open',
      due: null,
      source: 'jamie',
      sourceId: `jtask-${who}`,
      sourceRef: ref('jamie', `jtask-${who}`),
    },
    context,
  );
  await repo.link(task.id, 'ASSIGNED_TO', counterparty, {}, context);
  await repo.link(task.id, 'DERIVED_FROM', meeting.id, {}, context);
  const principalPerson = await repo.findPrincipalPerson();
  if (principalPerson === null) throw new Error(`${who} should have a Person node.`);
  return {
    meeting: meeting.id,
    principalPerson: principalPerson.id,
    thread: thread.id,
    commitment: commitmentId,
    task: task.id,
    nameOnly: nameOnly.id,
    edgeValues: [`graph-${who}`, `transcript-${who}`, `tag-${who}`, `jamie-${who}`],
    recordIds: [`msg-${who}`, `msg-${who}-dana`, `jtask-${who}`],
  };
}

/**
 * The scan covers everything a read returns, shared nodes' source refs
 * included: since ADR 0033 they carry only a system and a time, so a
 * record id of the other principal's anywhere in a result is a leak.
 */
function leaks(result: unknown, other: Evidence, otherPrincipal: string): string[] {
  const text = JSON.stringify(result ?? null);
  const tokens = [
    otherPrincipal,
    other.thread,
    other.commitment,
    other.task,
    other.nameOnly,
    ...other.edgeValues,
    ...other.recordIds,
  ];
  return tokens.filter((token) => text.includes(token));
}

interface ReadProbe {
  name: keyof OntologyRepository;
  /** Runs the method with arguments aimed at the other principal's evidence. */
  probe(repo: OntologyRepository, other: Evidence, own: Evidence): Promise<unknown>;
}

/**
 * Every public read of the repository, each probed with arguments that
 * point at the other principal's private evidence. This list must be kept
 * complete: the test below fails when the class gains a method that is in
 * neither this list nor WRITE_METHODS nor INTERNAL_METHODS.
 */
const READ_PROBES: ReadProbe[] = [
  {
    name: 'getNode',
    probe: async (repo, other) =>
      Promise.all([
        repo.getNode(other.thread),
        repo.getNode(other.commitment),
        repo.getNode(other.task),
      ]),
  },
  { name: 'findPersonByEmail', probe: (repo) => repo.findPersonByEmail('carol@northwind.test') },
  { name: 'findPersonByKey', probe: (repo) => repo.findPersonByKey('slack_id', 'U-CAROL') },
  {
    name: 'findPersonByJamieParticipantId',
    probe: (repo) => repo.findPersonByJamieParticipantId('jp-carol'),
  },
  {
    name: 'findPersonsByNormalisedName',
    probe: async (repo) =>
      Promise.all([
        repo.findPersonsByNormalisedName('carol example'),
        repo.findPersonsByNormalisedName('erin nokey'),
      ]),
  },
  {
    name: 'findPersonsByEmailDomain',
    probe: (repo) => repo.findPersonsByEmailDomain('northwind.test'),
  },
  {
    name: 'findOrganisationByDomain',
    probe: (repo) => repo.findOrganisationByDomain('northwind.test'),
  },
  { name: 'findPrincipalPerson', probe: (repo) => repo.findPrincipalPerson() },
  {
    name: 'findMeeting',
    probe: async (repo, other) =>
      Promise.all([
        repo.findMeeting({ icalUid: ICAL }),
        repo.findMeeting({ jamieId: other.edgeValues[3] ?? null }),
        repo.findMeeting({ graphEventId: other.edgeValues[0] ?? null }),
      ]),
  },
  { name: 'meetingContext', probe: (repo, other) => repo.meetingContext(other.meeting) },
  {
    name: 'sightings',
    probe: async (repo, other) =>
      Promise.all([
        repo.sightings(dana),
        repo.sightings(ann),
        repo.sightings(other.principalPerson),
        repo.sightings(other.nameOnly),
      ]),
  },
  {
    name: 'findTask',
    probe: async (repo) =>
      Promise.all([repo.findTask('jamie', 'jtask-dom'), repo.findTask('jamie', 'jtask-bea')]),
  },
  {
    name: 'findThread',
    probe: async (repo) => Promise.all([repo.findThread('conv-dom'), repo.findThread('conv-bea')]),
  },
  {
    name: 'neighbours',
    probe: async (repo, other, own) =>
      Promise.all([
        repo.neighbours(other.meeting),
        repo.neighbours(ann),
        repo.neighbours(carol),
        repo.neighbours(dana),
        repo.neighbours(own.principalPerson),
        repo.neighbours(other.principalPerson),
        repo.neighbours(other.nameOnly),
      ]),
  },
  { name: 'coAttended', probe: (repo) => repo.coAttended(ann, carol) },
  {
    name: 'search',
    probe: async (repo) =>
      Promise.all([repo.search('renewal'), repo.search('pilot'), repo.search('nokey')]),
  },
  { name: 'counts', probe: (repo) => repo.counts() },
];

const WRITE_METHODS = [
  'upsertPerson',
  'resolvePerson',
  'upsertOrganisation',
  'upsertMeeting',
  'upsertTask',
  'upsertThread',
  'ensureCommitment',
  'upsertProject',
  'link',
  'setSameAsStatus',
  'backfillLayers',
  'rebuild',
];

const INTERNAL_METHODS = [
  'createPerson',
  'updatePerson',
  'findExistingPerson',
  'wouldViolateRuleThree',
  'findOwnJamieKeyedMeeting',
  'mergeMeeting',
  'edgesOf',
  'foldAttendance',
  'recordMeetingContext',
  'writeAttendance',
  'recordSightings',
  'ownEdge',
  'ownAttendance',
  'backfillProvenance',
  'touchedByAnother',
  'read',
  'scoped',
  'stamp',
  'principalUpn',
  'ensurePrincipalPerson',
  'mutationCount',
  'apply',
];

function visibleCounts(snapshot: GraphSnapshot, principalId: string) {
  const sees = (item: { layer: unknown; principalId: unknown }) =>
    item.layer === 'reference' ||
    item.layer === 'shared' ||
    (item.layer === 'private' && item.principalId === principalId);
  const visibleIds = new Set(snapshot.nodes.filter(sees).map((node) => node.id));
  return {
    nodes: visibleIds.size,
    edges: snapshot.edges.filter(
      (edge) => sees(edge) && visibleIds.has(edge.from) && visibleIds.has(edge.to),
    ).length,
  };
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  dbDom = await openSeededTestDb(connectionString);
  // The apps may only read principals, so the second principal is created
  // through a fixture handle; principal_state is under row-level security,
  // so Bea's row is written in her own scope.
  const fixtures = openFixtureDb(connectionString);
  await fixtures.insert(principals).values({ id: BEA, upn: 'bea@valliance.ai' });
  await fixtures.$client.end();
  dbBea = scopedDb(dbDom, { principalId: BEA });
  await dbBea.insert(principalState).values({});
  dom = repository(dbDom, DOM, '01D0M', 'Dom Selvon');
  bea = repository(dbBea, BEA, '01BEA', 'Bea Example');

  domEvidence = await writeEvidence(dom, 'dom', [
    { name: 'Ann Example', email: 'ann@northwind.test' },
  ]);
  beaEvidence = await writeEvidence(bea, 'bea', [
    { name: 'Ann Example', email: 'ann@northwind.test' },
    { name: 'Carol Example', email: 'carol@northwind.test' },
  ]);
  const annNode = await dom.findPersonByEmail('ann@northwind.test');
  const carolNode = await bea.findPersonByEmail('carol@northwind.test');
  const danaNode = await bea.findPersonByEmail('dana@northwind.test');
  if (annNode === null || carolNode === null || danaNode === null) {
    throw new Error('Ann, Carol and Dana should exist.');
  }
  ann = annNode.id;
  carol = carolNode.id;
  dana = danaNode.id;
  before = await graphSnapshot(dbDom);
}, 180000);

afterAll(async () => {
  await dbDom.$client.end();
  await container.stop();
});

describe('ontology isolation between principals', () => {
  it('refuses a scope that differs from the database handle it is given', () => {
    expect(() => new OntologyRepository(dbDom, { principalId: BEA })).toThrow(
      /scoped to "01K5S9V6QW3SWCCPVB0N0E300H"/,
    );
  });

  it("keeps one shared Meeting node and one ATTENDED edge from each principal's own Person", () => {
    const meetings = before.nodes.filter((node) => node.label === 'Meeting');
    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toMatchObject({ layer: 'shared', principalId: null });
    expect(domEvidence.meeting).toBe(beaEvidence.meeting);
    const own = (person: string, principalId: string) =>
      before.edges.filter(
        (edge) =>
          edge.label === 'ATTENDED' &&
          edge.from === person &&
          edge.to === domEvidence.meeting &&
          edge.principalId === principalId,
      );
    expect(own(domEvidence.principalPerson, DOM)).toHaveLength(1);
    expect(own(beaEvidence.principalPerson, BEA)).toHaveLength(1);
    expect(meetings[0]?.properties).not.toHaveProperty('graph_event_id');
    expect(meetings[0]?.properties).not.toHaveProperty('tags');
    expect(meetings[0]?.properties).not.toHaveProperty('transcript_ref');
  });

  it('gives each principal its own meeting context from its own edge', async () => {
    expect(await dom.meetingContext(domEvidence.meeting)).toMatchObject({
      graphEventId: 'graph-dom',
      transcriptRef: 'transcript-dom',
      tags: ['tag-dom'],
      jamieId: 'jamie-dom',
    });
    expect(await bea.meetingContext(beaEvidence.meeting)).toMatchObject({
      graphEventId: 'graph-bea',
      transcriptRef: 'transcript-bea',
      tags: ['tag-bea'],
      jamieId: 'jamie-bea',
    });
  });

  it('stamps every private node and edge with the principal that wrote it', () => {
    const privateNodes = before.nodes.filter((node) => node.layer === 'private');
    expect(privateNodes.map((node) => [node.id, node.principalId]).sort()).toEqual(
      [
        [domEvidence.thread, DOM],
        [domEvidence.commitment, DOM],
        [domEvidence.task, DOM],
        [domEvidence.nameOnly, DOM],
        [beaEvidence.thread, BEA],
        [beaEvidence.commitment, BEA],
        [beaEvidence.task, BEA],
        [beaEvidence.nameOnly, BEA],
      ].sort(),
    );
    for (const node of before.nodes.filter((item) => item.layer !== 'private')) {
      expect(node.principalId).toBeNull();
    }
    for (const edge of before.edges) {
      if (edge.label === 'SAME_AS' || edge.label === 'WORKS_AT') {
        expect(edge).toMatchObject({ layer: 'shared', principalId: null });
      } else {
        expect(edge.layer).toBe('private');
        expect([DOM, BEA]).toContain(edge.principalId);
      }
    }
  });

  it('lists every method of the repository as a read, a write or an internal', () => {
    const methods = Object.getOwnPropertyNames(OntologyRepository.prototype).filter(
      (name) => name !== 'constructor',
    );
    const classified = [
      ...READ_PROBES.map((probe) => probe.name),
      ...WRITE_METHODS,
      ...INTERNAL_METHODS,
    ];
    expect(methods.filter((name) => !classified.includes(name))).toEqual([]);
    expect(classified.filter((name) => !methods.includes(name))).toEqual([]);
  });

  for (const [who, other] of [
    ['dom', 'bea'],
    ['bea', 'dom'],
  ] as const) {
    it(`returns none of ${other}'s private nodes, edges or edge properties from any read scoped to ${who}`, async () => {
      const repo = who === 'dom' ? dom : bea;
      const ownEvidence = who === 'dom' ? domEvidence : beaEvidence;
      const otherEvidence = who === 'dom' ? beaEvidence : domEvidence;
      const otherPrincipal = who === 'dom' ? BEA : DOM;
      for (const read of READ_PROBES) {
        const result = await read.probe(repo, otherEvidence, ownEvidence);
        expect(leaks(result, otherEvidence, otherPrincipal), String(read.name)).toEqual([]);
      }
    });
  }

  it("hides the other principal's attendance, even through a shared node", async () => {
    const fromMeeting = await dom.neighbours(domEvidence.meeting);
    const ids = fromMeeting.map((hit) => hit.node.id);
    expect(ids).toContain(domEvidence.principalPerson);
    expect(ids).toContain(ann);
    expect(ids).not.toContain(beaEvidence.principalPerson);
    expect(ids).not.toContain(carol);
    expect(await dom.neighbours(carol)).toEqual([]);
    expect(await dom.coAttended(ann, carol)).toBe(false);
    expect(await bea.coAttended(ann, carol)).toBe(true);
    expect(await dom.findMeeting({ jamieId: 'jamie-bea' })).toBeNull();
    expect(await dom.findMeeting({ graphEventId: 'graph-bea' })).toBeNull();
    expect(await bea.findMeeting({ jamieId: 'jamie-bea' })).toMatchObject({
      id: beaEvidence.meeting,
    });
  });

  it("keeps only the system and time in every shared node's source refs", () => {
    const shared = before.nodes.filter((node) => node.layer !== 'private');
    expect(shared.length).toBeGreaterThan(0);
    for (const node of shared) {
      for (const entry of (node.properties['source_refs'] as object[] | undefined) ?? []) {
        expect(Object.keys(entry).sort(), `${node.label} ${node.id}`).toEqual([
          'observedAt',
          'system',
        ]);
      }
    }
    const annNode = before.nodes.find((node) => node.id === ann);
    expect(annNode?.properties['source_refs']).toEqual([
      { system: 'jamie', observedAt: '2026-09-22T08:00:00.000Z' },
    ]);
  });

  it('tells another principal that a person exists, not which message showed them', async () => {
    const seen = await dom.findPersonByEmail('dana@northwind.test');
    expect(seen?.id).toBe(dana);
    expect(JSON.stringify(seen)).not.toContain('msg-bea-dana');
    expect(await dom.sightings(dana)).toEqual([
      expect.objectContaining({ system: 'graph', id: 'msg-dom-dana' }),
    ]);
    expect(await bea.sightings(dana)).toEqual([
      expect.objectContaining({
        system: 'graph',
        id: 'msg-bea-dana',
        url: 'https://outlook.test/msg-bea-dana',
      }),
    ]);
  });

  it('keeps a name-only attendee private to the principal who heard it', async () => {
    expect(domEvidence.nameOnly).not.toBe(beaEvidence.nameOnly);
    const node = (id: string) => before.nodes.find((item) => item.id === id);
    expect(node(domEvidence.nameOnly)).toMatchObject({ layer: 'private', principalId: DOM });
    expect(node(beaEvidence.nameOnly)).toMatchObject({ layer: 'private', principalId: BEA });
    expect(await dom.getNode(beaEvidence.nameOnly)).toBeNull();
    expect((await dom.findPersonsByNormalisedName('erin nokey')).map((hit) => hit.id)).toEqual([
      domEvidence.nameOnly,
    ]);
    expect((await dom.neighbours(domEvidence.meeting)).map((hit) => hit.node.id)).not.toContain(
      beaEvidence.nameOnly,
    );
  });

  it('counts only what each scope can see', async () => {
    expect(await dom.counts()).toEqual(visibleCounts(before, DOM));
    expect(await bea.counts()).toEqual(visibleCounts(before, BEA));
    expect((await dom.counts()).nodes).toBeLessThan(before.nodes.length);
  });

  it('rebuilds the same graph, layers and principals included, from both ledgers', async () => {
    const result = await dom.rebuild();
    expect({ nodes: result.nodes, edges: result.edges }).toEqual({
      nodes: before.nodes.length,
      edges: before.edges.length,
    });
    const after = await graphSnapshot(dbDom);
    expect(after).toEqual(before);
  });
});
