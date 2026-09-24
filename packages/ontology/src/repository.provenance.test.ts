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
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OntologyRepository, type SourceRef } from './repository.js';
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
  const dbBea = scopedDb(dbDom, { principalId: BEA });
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

  it("does not merge a Jamie-keyed Meeting that another principal's edges touch", async () => {
    await bea.upsertMeeting(
      {
        title: 'Contoso retro',
        start: '2026-09-27T10:00:00.000Z',
        end: '2026-09-27T11:00:00.000Z',
        icalUid: 'ical-retro',
        sourceRef: ref('graph', 'evt-bea-retro'),
      },
      context(),
    );
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
    // Bea's Jamie account shares the recording and finds Dom's node by its Jamie id.
    const shared = await bea.upsertMeeting(
      {
        title: 'Contoso retro',
        start: '2026-09-27T10:00:00.000Z',
        end: '2026-09-27T11:00:00.000Z',
        jamieId: 'jm-retro',
        sourceRef: ref('jamie', 'jm-retro'),
      },
      context(),
    );
    expect(shared.id).toBe(jamie.id);

    const keyed = await dom.upsertMeeting(
      {
        title: 'Contoso retro',
        start: '2026-09-27T10:00:00.000Z',
        end: '2026-09-27T11:00:00.000Z',
        icalUid: 'ical-retro',
        jamieId: 'jm-retro',
        sourceRef: ref('jamie', 'jm-retro'),
      },
      context(),
    );
    expect(keyed.id).not.toBe(jamie.id);
    expect(await dom.getNode(jamie.id)).toMatchObject({ id: jamie.id });
    expect(await bea.meetingContext(jamie.id)).toMatchObject({ jamieId: 'jm-retro' });
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
