import { MemoryRunRecorder, ScriptedRunner, textMessage } from '@lance/agents/testing';
import { briefs, commitments, createDb, proposals, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { LedgerWriter } from '@lance/ledger';
import { loadConfig, newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleWeeklyReview, renderWeeklyReview, runWeeklyReview } from './weekly.js';

let container: StartedPostgreSqlContainer;
let db: Db;
const NOW = '2026-09-25T15:30:00.000Z';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lance',
});

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  const base = {
    correlationId: newUlid(),
    counterpartyClass: 'client' as const,
    targetSystem: 'graph' as const,
    targetRecordId: 'AAMk1',
    reversibility: 'reversible' as const,
    payload: {},
    preview: 'p',
    rationale: 'r',
    provenance: [{ system: 'graph', recordId: 'AAMk1', hash: 'h', observedAt: NOW }],
    policyDecision: 'propose' as const,
    expiresAt: new Date('2026-09-27T00:00:00.000Z'),
  };
  for (let i = 0; i < 3; i += 1) {
    await db.insert(proposals).values({
      ...base,
      id: newUlid(),
      actionClass: 'apply_category',
      status: 'executed',
      decidedBy: 'user:dom',
      decidedAt: new Date('2026-09-23T10:00:00.000Z'),
      createdAt: new Date('2026-09-23T09:00:00.000Z'),
    });
  }
  await db.insert(proposals).values({
    ...base,
    id: newUlid(),
    actionClass: 'draft_email',
    status: 'rejected',
    decidedBy: 'user:dom',
    decidedAt: new Date('2026-09-24T10:00:00.000Z'),
    createdAt: new Date('2026-09-24T09:00:00.000Z'),
  });
  await db.insert(commitments).values({
    id: newUlid(),
    direction: 'outbound',
    ownerPersonId: 'p-dom',
    counterpartyPersonId: 'p-ann',
    description: 'Send the SOW',
    dueAt: new Date('2026-09-20T00:00:00.000Z'),
    dueConfidence: 1,
    evidenceQuote: 'q',
    sourceRefs: [],
    status: 'open',
  });
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('weekly review', () => {
  it('aggregates commitments, proposals by cell and promotion candidates for the week', async () => {
    const facts = await assembleWeeklyReview({
      db,
      config: { ...config, promotion: { threshold: 3, minSpanDays: 14 } },
      agent: null,
      slack: null,
      now: () => NOW,
    });
    expect(facts.commitmentAgeing.find((a) => a.direction === 'outbound')).toMatchObject({
      open: 1,
      overdue: 1,
    });
    const cell = facts.proposalsByCell.find((c) => c.cell.startsWith('apply_category'));
    expect(cell).toMatchObject({ approved: 3, rejected: 0 });
    expect(facts.promotionCandidates.map((p) => p.cell)).toEqual([
      'apply_category / client / graph',
    ]);
    expect(renderWeeklyReview({ ...facts, questions: [] }, 'Lance')).toContain(
      'Promotion candidates',
    );
  });

  it('asks the planner three questions, posts the review with them in thread and stores it', async () => {
    const runner = new ScriptedRunner([
      [textMessage(JSON.stringify({ questions: ['One?', 'Two?', 'Three?'] }))],
    ]);
    const posts: { text: string; threadTs?: string }[] = [];
    const result = await runWeeklyReview({
      db,
      config,
      agent: {
        runner,
        recorder: new MemoryRunRecorder(),
        ledger: new LedgerWriter(db),
        config: { prices: config.prices, cost: config.cost },
        readSpendUsd: () => Promise.resolve(0),
      },
      slack: {
        post: (input) => {
          posts.push({
            text: input.text,
            ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }),
          });
          return Promise.resolve({ channel: 'C1', ts: `1.${String(posts.length)}` });
        },
      },
      now: () => NOW,
    });
    expect(result.slackTs).toBe('1.1');
    expect(posts[1]).toMatchObject({ threadTs: '1.1' });
    expect(posts[1]?.text).toContain('Three?');
    const stored = (await db.select().from(briefs).where(eq(briefs.id, result.briefId)))[0];
    expect(stored?.kind).toBe('weekly_review');
    expect(stored?.markdown).toContain('## Questions for next week');
    expect(runner.calls[0]?.tools).toEqual([]);
  });
});
