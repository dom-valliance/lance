import type { ProposalDraft } from '@lance/agents';
import { MemoryRunRecorder, ScriptedRunner, textMessage } from '@lance/agents/testing';
import { commitments, createDb, runMigrations, seed, type Db, type NewCommitment } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import type { Node } from '@lance/ontology';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChase, type ChaseDeps } from './run.js';

let container: StartedPostgreSqlContainer;
let db: Db;

const NOW = '2026-09-21T09:00:00.000Z';
const ANN = 'per-ann';
const SILENT = 'per-silent';

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

const person = (id: string, name: string, emails: string[]): Node => ({
  id,
  label: 'Person',
  properties: { id, display_name: name, emails },
});

const nodes = new Map<string, Node>([
  [ANN, person(ANN, 'Ann Example', ['ann@client.test'])],
  [SILENT, person(SILENT, 'Sam Silent', [])],
]);

const insert = async (overrides: Partial<NewCommitment> = {}): Promise<string> => {
  const id = newUlid();
  await db.insert(commitments).values({
    id,
    direction: 'inbound',
    ownerPersonId: ANN,
    counterpartyPersonId: ANN,
    description: 'Send the signed order form',
    dueAt: new Date('2026-09-18T17:00:00.000Z'),
    dueConfidence: 0.8,
    evidenceQuote: 'I will get the order form over to you by Friday',
    sourceRefs: [
      { system: 'graph', recordId: 'AAMk2', hash: 'h2', observedAt: '2026-09-14T09:00:00.000Z' },
    ],
    status: 'open',
    createdAt: new Date('2026-09-14T09:00:00.000Z'),
    ...overrides,
  });
  return id;
};

interface Harness {
  deps: ChaseDeps;
  runner: ScriptedRunner;
  drafts: ProposalDraft[];
}

const harness = (
  replies: string[] = [
    '{"subject":"The order form","bodyText":"Ann, the order form was due on Friday. Can you send it today?"}',
  ],
): Harness => {
  const runner = new ScriptedRunner(replies.map((reply) => [textMessage(reply)]));
  const drafts: ProposalDraft[] = [];
  return {
    runner,
    drafts,
    deps: {
      db,
      config: {
        agentDisplayName: 'Lance',
        models: { triage: { id: 'claude-sonnet-5', effort: 'medium' } } as never,
      },
      agent: {
        runner,
        recorder: new MemoryRunRecorder(),
        ledger: new LedgerWriter(db),
        config: agentConfig,
        readSpendUsd: () => Promise.resolve(0),
      },
      ontology: { getNode: (id: string) => Promise.resolve(nodes.get(id) ?? null) },
      createProposal: (draft) => {
        drafts.push(draft);
        return Promise.resolve({
          proposalId: '01PROPOSAL0000000000000003',
          decision: 'propose',
          status: 'pending',
        });
      },
      now: () => NOW,
    },
  };
};

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
}, 300000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('runChase', () => {
  it('drafts one chase proposal for an inbound commitment and records the provenance it came from', async () => {
    const id = await insert();
    const { deps, drafts, runner } = harness();

    const result = await runChase(deps, { commitmentId: id });

    expect(result).toMatchObject({ status: 'drafted', proposalId: '01PROPOSAL0000000000000003' });
    expect(drafts[0]).toMatchObject({
      actionClass: 'draft_email',
      counterpartyClass: 'unknown',
      targetSystem: 'graph',
      confidence: 0.7,
      payload: {
        subject: 'The order form',
        to: ['ann@client.test'],
        commitmentId: id,
      },
    });
    expect(drafts[0]?.provenance[0]?.recordId).toBe('AAMk2');
    expect(runner.calls[0]?.tools).toEqual([]);
  });

  it('moves the commitment to chased, counts the chase and sets the next one seven days on', async () => {
    const id = await insert({ chaseCount: 1 });

    await runChase(harness().deps, { commitmentId: id });

    const rows = await db.select().from(commitments).where(eq(commitments.id, id));
    expect(rows[0]).toMatchObject({ status: 'chased', chaseCount: 2 });
    expect(rows[0]?.nextChaseAt?.toISOString()).toBe('2026-09-28T09:00:00.000Z');
  });

  it('records the chase and the proposal it created in the ledger', async () => {
    const id = await insert();

    const result = await runChase(harness().deps, { commitmentId: id });

    const trail = await new LedgerReader(db).byCorrelation(result.correlationId);
    expect(
      trail.some(
        (event) =>
          (event.payload as { kind?: string; proposalId?: string } | null)?.kind ===
            'commitment_chased' &&
          (event.payload as { proposalId?: string } | null)?.proposalId ===
            '01PROPOSAL0000000000000003',
      ),
    ).toBe(true);
  });

  it('refuses an outbound commitment, because Dom owes it', async () => {
    const id = await insert({ direction: 'outbound', description: 'Send the SOW' });
    const { deps, drafts, runner } = harness();

    const result = await runChase(deps, { commitmentId: id });

    expect(result).toMatchObject({ status: 'refused' });
    expect(result.status === 'refused' && result.reason).toContain('outbound');
    expect(drafts).toHaveLength(0);
    expect(runner.calls).toHaveLength(0);
  });

  it('refuses a commitment that is already done', async () => {
    const id = await insert({ status: 'done' });

    const result = await runChase(harness().deps, { commitmentId: id });

    expect(result.status === 'refused' && result.reason).toContain('is done');
  });

  it('refuses a commitment it cannot address, naming the person with no email', async () => {
    const id = await insert({ ownerPersonId: SILENT, counterpartyPersonId: SILENT });

    const result = await runChase(harness().deps, { commitmentId: id });

    expect(result.status === 'refused' && result.reason).toContain('Sam Silent');
  });

  it('refuses an id no commitment has and says so in the ledger', async () => {
    const id = newUlid();

    const result = await runChase(harness().deps, { commitmentId: id });

    expect(result.status).toBe('refused');
    const trail = await new LedgerReader(db).byCorrelation(result.correlationId);
    expect(
      trail.some(
        (event) => (event.payload as { kind?: string } | null)?.kind === 'commitment_chase_refused',
      ),
    ).toBe(true);
  });
});
