import type { ProposalDraft } from '@lance/agents';
import { proposals, runMigrations, type Db } from '@lance/db';
import { openSeededTestDb, startPostgresContainer } from '@lance/db/testing';
import { LedgerReader, SystemControl } from '@lance/ledger';
import { seedRules } from '@lance/policy';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { critique } from '../critic/index.js';
import { createProposalHandler } from './createProposal.js';

let container: StartedPostgreSqlContainer;
let db: Db;
let control: SystemControl;
const CHANNEL = 'C0BU7P278N5';
const rules = seedRules({ slackChannelId: CHANNEL, createdAt: '2026-09-21T00:00:00.000Z' });
const posted: Array<{ text: string }> = [];
const executed: string[] = [];

const config = {
  agentDisplayName: 'Lance',
  timeZone: 'Europe/London',
  proposals: { expiryHours: 48 },
  interruption: { quietHoursStart: '19:00', quietHoursEnd: '07:00', pushBudgetPerHour: 6 },
};

function handler(slackConfigured = true) {
  return createProposalHandler({
    db,
    config,
    control,
    loadRules: () => Promise.resolve(rules),
    critique: (draft) => critique(draft, { permittedNotionProperties: ['Title', 'Status'] }),
    slack: slackConfigured
      ? {
          channelId: CHANNEL,
          post: (input) => {
            posted.push({ text: input.text });
            return Promise.resolve({ channel: CHANNEL, ts: `${posted.length}.0` });
          },
        }
      : null,
    enqueueExecute: (id) => {
      executed.push(id);
      return Promise.resolve();
    },
  });
}

const draft = (overrides: Partial<ProposalDraft> = {}): ProposalDraft => ({
  actionClass: 'apply_category',
  counterpartyClass: 'unknown',
  targetSystem: 'graph',
  targetRecordId: 'AAMk1',
  payload: { categories: ['Newsletters'] },
  preview: 'Apply category Newsletters',
  rationale: 'Sender is a newsletter.',
  provenance: [
    { system: 'graph', recordId: 'AAMk1', hash: 'h1', observedAt: '2026-09-21T08:00:00.000Z' },
  ],
  confidence: 0.95,
  ...overrides,
});

const context = { correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', actor: 'agent:triage@0.1.0' };

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = await openSeededTestDb(connectionString);
  control = new SystemControl(db);
  await control.setMode('live', { actor: 'user:dom' });
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('createProposal', () => {
  it('auto-approves a newsletter category and enqueues execution with a decided event', async () => {
    const outcome = await handler()(draft(), { ...context, labels: ['Newsletters'] });
    expect(outcome).toMatchObject({ decision: 'auto', status: 'approved' });
    expect(executed).toContain(outcome.proposalId);
    expect(posted).toHaveLength(0);
    const trail = await new LedgerReader(db).byCorrelation(context.correlationId);
    expect(trail.map((event) => event.kind)).toEqual(['proposed', 'decided']);
    expect(trail[0]?.policyDecisionId).not.toBeNull();
  });

  it('auto-approves a newsletter move into AI-Filed, reading the folder from the draft', async () => {
    const outcome = await handler()(
      draft({
        actionClass: 'move_mail',
        payload: { destinationFolderName: 'AI-Filed', sourceFolderId: 'inbox' },
        preview: 'Move to AI-Filed',
      }),
      { ...context, labels: ['Newsletters'] },
    );
    expect(outcome).toMatchObject({ decision: 'auto', status: 'approved' });
  });

  it('forbids a newsletter move that names AI-Filed but carries another folder id', async () => {
    // A prompt-injected draft that would pass rule 4 by name and move by id.
    const before = posted.length;
    const outcome = await handler()(
      draft({
        actionClass: 'move_mail',
        payload: { destinationFolderName: 'AI-Filed', destinationFolderId: 'deleteditems' },
        preview: 'Move to AI-Filed',
      }),
      { ...context, labels: ['Newsletters'] },
    );
    expect(outcome).toMatchObject({ decision: 'forbid', status: 'rejected' });
    expect(executed).not.toContain(outcome.proposalId);
    expect(posted).toHaveLength(before);
    const row = (await db.select().from(proposals).where(eq(proposals.id, outcome.proposalId)))[0];
    expect(row?.decisionNote).toContain('both folder name and folder id');
  });

  it('forbids a move into Deleted Items whatever the rules say', async () => {
    const outcome = await handler()(
      draft({ actionClass: 'move_mail', payload: { destinationFolderName: 'Deleted Items' } }),
      { ...context, labels: ['Newsletters'] },
    );
    expect(outcome).toMatchObject({ decision: 'forbid', status: 'rejected' });
    expect(outcome.note).toContain('is a delete');
  });

  it('proposes a newsletter move into any folder but AI-Filed', async () => {
    const outcome = await handler()(
      draft({
        actionClass: 'move_mail',
        payload: { destinationFolderName: 'Archive' },
        preview: 'Move to Archive',
      }),
      { ...context, labels: ['Newsletters'] },
    );
    expect(outcome).toMatchObject({ decision: 'propose', status: 'pending' });
    expect(outcome.note).toContain('targetAnyOf');
  });

  it('posts a card and leaves the proposal pending when policy says propose', async () => {
    const outcome = await handler()(draft({ counterpartyClass: 'client' }), {
      ...context,
      labels: ['Deals'],
    });
    expect(outcome).toMatchObject({ decision: 'propose', status: 'pending' });
    expect(outcome.note).toContain('conditions were unmet');
    expect(posted.at(-1)?.text).toContain('Apply category Newsletters');
    const row = (await db.select().from(proposals).where(eq(proposals.id, outcome.proposalId)))[0];
    expect(row).toMatchObject({
      slackChannel: CHANNEL,
      status: 'pending',
      reversibility: 'reversible',
    });
    expect(row?.slackTs).not.toBeNull();
  });

  it('records a forbidden action in the ledger only', async () => {
    const before = posted.length;
    const outcome = await handler()(
      draft({ actionClass: 'send_email', payload: { to: 'x@example.com' } }),
      context,
    );
    expect(outcome).toMatchObject({ decision: 'forbid', status: 'rejected' });
    expect(posted).toHaveLength(before);
    expect(executed).not.toContain(outcome.proposalId);
    const row = (await db.select().from(proposals).where(eq(proposals.id, outcome.proposalId)))[0];
    expect(row).toMatchObject({ decidedBy: 'system:policy', decisionNote: 'Forbidden by policy.' });
  });

  it('downgrades an auto decision to pending when the critic holds it', async () => {
    const offTarget = draft({
      targetRecordId: 'AAMk-other',
      provenance: [
        { system: 'graph', recordId: 'AAMk1', hash: 'h', observedAt: '2026-09-21T08:00:00.000Z' },
      ],
    });
    const outcome = await handler()(offTarget, { ...context, labels: ['Newsletters'] });
    expect(outcome).toMatchObject({ decision: 'auto', status: 'pending' });
    expect(outcome.note).toContain('Critic held this');
    expect(executed).not.toContain(outcome.proposalId);
  });

  it('runs the critic on a proposed draft and carries its notes on the pending proposal', async () => {
    const outcome = await handler()(
      draft({
        actionClass: 'draft_email',
        counterpartyClass: 'client',
        payload: { subject: 'Re: SOW', bodyText: 'Thanks \u2014 sending it today.', to: [] },
        preview: 'Reply about the SOW',
      }),
      { ...context, correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FB2' },
    );
    expect(outcome.status).toBe('pending');
    expect(outcome.note).toContain('Critic notes: Voice:');
    const rows = await db.select().from(proposals).where(eq(proposals.id, outcome.proposalId));
    expect(rows[0]?.decisionNote).toContain('Voice');
  });

  it('holds everything and posts nothing in dry run mode', async () => {
    await control.setMode('dry_run', { actor: 'user:dom' });
    const before = posted.length;
    const auto = await handler()(draft(), { ...context, labels: ['Newsletters'] });
    const propose = await handler()(draft({ counterpartyClass: 'client' }), {
      ...context,
      labels: ['Deals'],
    });
    expect(auto.status).toBe('held');
    expect(propose.status).toBe('held');
    expect(posted).toHaveLength(before);
    expect(executed).not.toContain(auto.proposalId);
    await control.setMode('live', { actor: 'user:dom' });
  });

  it('holds proposals from a watcher still in its dry-run window', async () => {
    const outcome = await handler()(draft(), {
      ...context,
      labels: ['Newsletters'],
      watcherDryRun: true,
    });
    expect(outcome.status).toBe('held');
  });

  it('leaves a pending proposal without a card when the hourly push budget is spent', async () => {
    const spent = createProposalHandler({
      db,
      config: { ...config, interruption: { ...config.interruption, pushBudgetPerHour: 0 } },
      control,
      loadRules: () => Promise.resolve(rules),
      critique: (draft) => critique(draft, { permittedNotionProperties: ['Title', 'Status'] }),
      slack: {
        channelId: CHANNEL,
        post: () => Promise.reject(new Error('the budget should have stopped this post')),
      },
      enqueueExecute: () => Promise.resolve(),
    });
    const outcome = await spent(draft({ counterpartyClass: 'client' }), {
      ...context,
      labels: ['Deals'],
    });
    expect(outcome.status).toBe('pending');
    const row = (await db.select().from(proposals).where(eq(proposals.id, outcome.proposalId)))[0];
    expect(row?.slackTs).toBeNull();
  });

  it('proceeds without Slack when no surface is configured', async () => {
    const outcome = await handler(false)(draft({ counterpartyClass: 'client' }), {
      ...context,
      labels: ['Deals'],
    });
    expect(outcome.status).toBe('pending');
    const row = (await db.select().from(proposals).where(eq(proposals.id, outcome.proposalId)))[0];
    expect(row?.slackTs).toBeNull();
  });
});

vi.setConfig({ testTimeout: 60000 });
