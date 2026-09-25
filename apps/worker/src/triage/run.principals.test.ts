import { MemoryRunRecorder, ScriptedRunner, textMessage } from '@lance/agents/testing';
import type { CommitmentSource } from '@lance/agents';
import {
  SEED_PRINCIPAL_ID,
  commitments,
  ledgerEvents,
  principalState,
  principals,
  runMigrations,
  scopedDb,
  type Db,
} from '@lance/db';
import { openFixtureDb, openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { OntologyRepository } from '@lance/ontology';
import {
  hashRecord,
  idempotencyKey,
  loadConfig,
  principalIdentity,
  stableUlid,
} from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTriage } from './run.js';

/**
 * H1 of the Phase 5 review: triage in a second principal's context acts
 * for that principal. Bea's transcript is triaged in her scope with her
 * identity; Dom's Person node, written earlier in his scope, must come
 * out as it went in, and the commitments must name Bea.
 */

const BEA = '01K5S9V6QW3SWCCPVB0N0E301B';
const BEA_UPN = 'bea.hale@valliance.ai';

let container: StartedPostgreSqlContainer;
let dbDom: Db;
let dbBea: Db;
let domPersonId: string;

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
});

const agentConfig = {
  prices: {
    'claude-sonnet-5': {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
    },
  },
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.78 },
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  dbDom = await openSeededTestDb(connectionString);
  const fixtures = openFixtureDb(connectionString);
  await fixtures.insert(principals).values({ id: BEA, upn: BEA_UPN, notionUserId: 'notion-bea' });
  await fixtures.$client.end();
  dbBea = scopedDb(dbDom, { principalId: BEA });
  await dbBea.insert(principalState).values({});
  const dom = await new OntologyRepository(dbDom, { principalId: SEED_PRINCIPAL_ID }).upsertPerson(
    {
      displayName: 'Dom Selvon',
      emails: ['dom@valliance.ai'],
      notionUserId: 'notion-dom',
      isInternal: true,
      sourceRef: { system: 'lance', id: 'principal', observedAt: '2026-09-21T08:00:00.000Z' },
    },
    { correlationId: stableUlid('seed-dom') },
  );
  domPersonId = dom.id;
}, 120000);

afterAll(async () => {
  await dbDom.$client.end();
  await container.stop();
});

describe("triage in a second principal's context", () => {
  it("never touches Dom's Person node and records Bea's commitments under her", async () => {
    const domOntology = new OntologyRepository(dbDom, { principalId: SEED_PRINCIPAL_ID });
    const domBefore = await domOntology.getNode(domPersonId);

    const correlationId = stableUlid('jamie:bea-mt-1');
    const record = {
      kind: 'meeting',
      id: 'bea-mt-1',
      title: 'Bea / Ronan catch-up',
      startTime: '2026-09-21T09:00:00.000Z',
      endTime: '2026-09-21T09:30:00.000Z',
      participants: [
        { name: 'Bea Hale', email: BEA_UPN },
        { name: 'Ronan Forker', email: 'ronan@valliance.ai' },
      ],
      attendees: [],
      transcript: 'Bea: I will send you the resource plan by Friday.',
      transcriptReady: true,
      domAttended: true,
    };
    const hash = hashRecord(record);
    const observed = await new LedgerWriter(dbBea).append({
      ts: '2026-09-21T10:00:00.000Z',
      actor: 'agent:watcher-jamie@0.1.0',
      kind: 'observed',
      sourceSystem: 'jamie',
      sourceRecordId: 'bea-mt-1',
      sourceRecordHash: hash,
      idempotencyKey: idempotencyKey('jamie', 'bea-mt-1', hash),
      correlationId,
      payload: { ...record, labels: ['Meeting', 'TranscriptReady'], watcher: 'jamie' },
    });
    const modelOutput = {
      importance: 0.4,
      urgency: 0.2,
      summary: 'Bea will send the resource plan.',
      entities: [],
      commitments: [],
      taskCandidates: [],
      proposalsSubmitted: 0,
      alertCandidates: [],
    };
    const sources: CommitmentSource[] = [];
    const beaOntology = new OntologyRepository(
      dbBea,
      { principalId: BEA },
      { principalName: 'Bea Hale' },
    );
    const principal = principalIdentity({ upn: BEA_UPN, notionUserId: 'notion-bea' }, config);

    const result = await runTriage(
      {
        db: dbBea,
        config,
        agent: {
          runner: new ScriptedRunner([[textMessage(JSON.stringify(modelOutput))]]),
          recorder: new MemoryRunRecorder(),
          ledger: new LedgerWriter(dbBea),
          config: agentConfig,
          readSpendUsd: () => Promise.resolve(0),
        },
        createProposal: () => Promise.reject(new Error('no proposals in this test')),
        ontology: beaOntology,
        principal,
        extractCommitments: (source) => {
          sources.push(source);
          return Promise.resolve([
            {
              direction: 'outbound' as const,
              description: 'Send the resource plan',
              counterpartyName: 'Ronan Forker',
              counterpartyEmail: 'ronan@valliance.ai',
              dueAt: null,
              dueConfidence: 0,
              evidenceQuote: 'I will send you the resource plan by Friday',
              recordId: 'bea-mt-1',
            },
          ]);
        },
      },
      { watcher: 'jamie', correlationId, observationEventIds: [observed.id] },
    );

    expect(sources.map((source) => source.principal)).toEqual([
      { name: 'Bea Hale', email: BEA_UPN },
    ]);
    expect(result.commitments).toHaveLength(1);

    // Dom's Person node is exactly as Dom's scope left it.
    expect(await domOntology.getNode(domPersonId)).toEqual(domBefore);
    // No mutation Bea's triage recorded names Dom's node.
    const mutations = await dbBea
      .select({ payload: ledgerEvents.payload })
      .from(ledgerEvents)
      .where(eq(ledgerEvents.kind, 'resolved'));
    expect(mutations.length).toBeGreaterThan(0);
    for (const mutation of mutations) {
      expect(JSON.stringify(mutation.payload)).not.toContain(domPersonId);
      expect(JSON.stringify(mutation.payload)).not.toContain('dom@valliance.ai');
    }

    // Bea owes the commitment, through her own Person, keyed on her UPN.
    const bea = await beaOntology.findPersonByEmail(BEA_UPN);
    expect(bea).toMatchObject({
      properties: { display_name: 'Bea Hale', notion_user_id: 'notion-bea' },
    });
    const rows = await dbBea.select().from(commitments);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'outbound', ownerPersonId: bea?.id });
    expect(bea?.id).not.toBe(domPersonId);
  });
});
