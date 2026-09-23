import { MemoryRunRecorder, ScriptedRunner, textMessage } from '@lance/agents/testing';
import type { ProposalDraft } from '@lance/agents';
import { briefs, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalPeople, renderDebriefMarkdown, runDebrief, type DebriefInput } from './run.js';

let container: StartedPostgreSqlContainer;
let db: Db;

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

const meeting = {
  id: 'mt-1',
  title: 'Kick-off with Client Ltd',
  startTime: '2026-09-21T10:00:00.000Z',
  endTime: '2026-09-21T11:00:00.000Z',
  participants: [
    { name: 'Dom Selvon', email: 'dom@valliance.ai' },
    { name: 'Ann Example', email: 'ann@client.test' },
  ],
  attendees: [
    { name: 'Ann Example', email: 'ann@client.test' },
    { name: 'Ronan Colleague', email: 'ronan@valliance.ai' },
  ],
  summaryShort: 'Agreed the scope and a start date.',
  url: 'https://app.meetjamie.ai/meetings/mt-1',
};

const input = (overrides: Partial<DebriefInput> = {}): DebriefInput => ({
  correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  meeting,
  provenance: [
    { system: 'jamie', recordId: 'mt-1', hash: 'h', observedAt: '2026-09-21T11:05:00.000Z' },
  ],
  summary: 'Client Ltd agreed the scope; Dom owes the SOW by Friday.',
  decisions: [
    { text: 'Start on 5 October.', evidenceQuote: 'we start on the fifth', recordId: 'mt-1' },
  ],
  openQuestions: [],
  taskProposalIds: ['01PROPOSAL0000000000000001'],
  commitments: [
    {
      id: '01COMMITMENT00000000000001',
      direction: 'outbound',
      description: 'Send the SOW',
      counterpartyPersonId: 'p1',
    },
  ],
  context: { correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', actor: 'agent:triage@0.1.0' },
  ...overrides,
});

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('externalPeople', () => {
  it("keeps only addresses outside Dom's domain, once each", () => {
    expect(externalPeople(meeting, 'dom@valliance.ai')).toEqual([
      { name: 'Ann Example', email: 'ann@client.test' },
    ]);
  });
});

describe('renderDebriefMarkdown', () => {
  it('lays out summary, decisions, actions, commitments and open questions', () => {
    const markdown = renderDebriefMarkdown(input(), 'Europe/London');
    expect(markdown).toContain('# Debrief: Kick-off with Client Ltd');
    expect(markdown).toContain('- Start on 5 October.');
    expect(markdown).toContain('- Dom owes: Send the SOW');
    expect(markdown).toContain('## Open questions\n- none');
  });
});

describe('runDebrief', () => {
  it('drafts one follow-up proposal for the external attendees, stores the brief, posts to Slack and records the ledger', async () => {
    const runner = new ScriptedRunner([
      [
        textMessage(
          JSON.stringify({
            subject: 'Kick-off follow-up',
            bodyText: 'Ann, the SOW is with you on Friday.',
          }),
        ),
      ],
    ]);
    const proposals: ProposalDraft[] = [];
    const posts: string[] = [];
    const result = await runDebrief(
      {
        db,
        config: {
          agentDisplayName: 'Lance',
          timeZone: 'Europe/London',
          models: { triage: { id: 'claude-sonnet-5', effort: 'medium' } } as never,
        },
        dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
        agent: {
          runner,
          recorder: new MemoryRunRecorder(),
          ledger: new LedgerWriter(db),
          config: agentConfig,
          readSpendUsd: () => Promise.resolve(0),
        },
        slack: {
          post: (message) => {
            posts.push(message.text);
            return Promise.resolve({ channel: 'C1', ts: '1.1' });
          },
        },
        createProposal: (draft) => {
          proposals.push(draft);
          return Promise.resolve({
            proposalId: '01PROPOSAL0000000000000002',
            decision: 'propose',
            status: 'pending',
          });
        },
      },
      input(),
    );

    expect(result.followUpProposalId).toBe('01PROPOSAL0000000000000002');
    expect(proposals[0]).toMatchObject({
      actionClass: 'draft_email',
      targetSystem: 'graph',
      payload: { subject: 'Kick-off follow-up', to: ['ann@client.test'] },
    });
    expect(runner.calls[0]?.tools).toEqual([]);
    expect(posts[0]).toContain('Debrief: Kick-off with Client Ltd');
    expect(result.slackTs).toBe('1.1');
    const stored = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
    expect(stored[0]).toMatchObject({ kind: 'debrief' });
    const trail = await new LedgerReader(db).byCorrelation(input().correlationId);
    expect(
      trail.some((event) => (event.payload as { kind?: string } | null)?.kind === 'debrief'),
    ).toBe(true);
  });

  it('drafts nothing when every attendee is internal', async () => {
    const runner = new ScriptedRunner([]);
    const result = await runDebrief(
      {
        db,
        config: {
          agentDisplayName: 'Lance',
          timeZone: 'Europe/London',
          models: { triage: { id: 'claude-sonnet-5', effort: 'medium' } } as never,
        },
        dom: { name: 'Dom Selvon', email: 'dom@valliance.ai' },
        agent: {
          runner,
          recorder: new MemoryRunRecorder(),
          ledger: new LedgerWriter(db),
          config: agentConfig,
          readSpendUsd: () => Promise.resolve(0),
        },
        slack: null,
        createProposal: () => Promise.reject(new Error('should not be called')),
      },
      input({
        correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
        context: { correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0', actor: 'agent:triage@0.1.0' },
        meeting: {
          ...meeting,
          participants: [meeting.participants[0]!],
          attendees: [meeting.attendees[1]!],
        },
      }),
    );
    expect(result.followUpProposalId).toBeNull();
    expect(result.slackTs).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });
});
