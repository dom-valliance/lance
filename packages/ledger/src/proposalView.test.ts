import { createDb, proposals, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countProposals,
  getProposal,
  listProposals,
  pendingProposalSummary,
  toProposal,
  type ProposalRow,
} from './proposalView.js';

let container: StartedPostgreSqlContainer;
let db: Db;

const NOW = '2026-09-21T12:00:00.000Z';

interface InsertOptions {
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  actionClass?: 'draft_email' | 'create_task';
  counterpartyClass?: 'client' | 'internal';
  targetSystem?: 'graph' | 'notion';
  expiresAt?: Date;
}

async function insertProposal(options: InsertOptions = {}): Promise<string> {
  const id = newUlid();
  await db.insert(proposals).values({
    id,
    correlationId: newUlid(),
    actionClass: options.actionClass ?? 'draft_email',
    counterpartyClass: options.counterpartyClass ?? 'client',
    targetSystem: options.targetSystem ?? 'graph',
    targetRecordId: 'AAMk1',
    reversibility: 'compensatable',
    payload: { subject: 'Re: hello', bodyText: 'Thanks.' },
    preview: 'Reply to hello',
    rationale: 'They asked.',
    provenance: [{ system: 'graph', recordId: 'AAMk1', hash: 'h', observedAt: NOW }],
    policyDecision: 'propose',
    status: options.status ?? 'pending',
    expiresAt: options.expiresAt ?? new Date('2026-09-23T12:00:00.000Z'),
  });
  return id;
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
}, 120000);

afterAll(async () => {
  await db.$client.end();
  await container.stop();
});

describe('toProposal', () => {
  it('renders timestamps as ISO strings and leaves an undecided proposal null', () => {
    const row: ProposalRow = {
      id: '01K5S9V6QW3SWCCPVB0N0E301A',
      correlationId: '01K5S9V6QW3SWCCPVB0N0E301B',
      actionClass: 'draft_email',
      counterpartyClass: 'client',
      targetSystem: 'graph',
      targetRecordId: 'AAMk1',
      reversibility: 'compensatable',
      payload: { subject: 'Re: hello' },
      editedPayload: null,
      preview: 'Reply to hello',
      rationale: 'They asked.',
      provenance: [{ system: 'graph', recordId: 'AAMk1', hash: 'h', observedAt: NOW }],
      policyDecision: 'propose',
      policyRuleId: null,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      slackChannel: null,
      slackTs: null,
      expiresAt: new Date('2026-09-23T12:00:00.000Z'),
      executionEventId: null,
      compensationPayload: null,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    };

    const proposal = toProposal(row);

    expect(proposal.expiresAt).toBe('2026-09-23T12:00:00.000Z');
    expect(proposal.decidedAt).toBeNull();
    expect(proposal.payload).toEqual({ subject: 'Re: hello' });
  });
});

describe('listProposals', () => {
  it('returns proposals newest first', async () => {
    const first = await insertProposal();
    const second = await insertProposal();

    const rows = await listProposals(db);

    expect(rows.map((row) => row.id).slice(0, 2)).toEqual([second, first]);
  });

  it('filters by status, action class, counterparty class and target system', async () => {
    const wanted = await insertProposal({
      status: 'approved',
      actionClass: 'create_task',
      counterpartyClass: 'internal',
      targetSystem: 'notion',
    });

    const rows = await listProposals(db, {
      status: 'approved',
      actionClass: 'create_task',
      counterpartyClass: 'internal',
      targetSystem: 'notion',
    });

    expect(rows.map((row) => row.id)).toEqual([wanted]);
  });

  it('pages with a cursor, excluding the proposal the cursor names', async () => {
    const older = await insertProposal({ status: 'rejected' });
    const newer = await insertProposal({ status: 'rejected' });

    const page = await listProposals(db, { status: 'rejected', limit: 1 });
    expect(page.map((row) => row.id)).toEqual([newer]);

    const next = await listProposals(db, { status: 'rejected', limit: 1, cursor: newer });
    expect(next.map((row) => row.id)).toEqual([older]);
  });
});

describe('countProposals', () => {
  it('counts every proposal the filters match, the rows the list would page through', async () => {
    await insertProposal({ status: 'expired', targetSystem: 'notion' });
    await insertProposal({ status: 'expired', targetSystem: 'notion' });
    await insertProposal({ status: 'expired', targetSystem: 'graph' });

    expect(await countProposals(db, { status: 'expired' })).toBe(3);
    expect(await countProposals(db, { status: 'expired', targetSystem: 'notion' })).toBe(2);
    expect(await countProposals(db)).toBe((await listProposals(db, { limit: 200 })).length);
  });
});

describe('pendingProposalSummary', () => {
  it('counts the pending proposals and names the earliest expiry among them', async () => {
    const before = await pendingProposalSummary(db);
    await insertProposal({ expiresAt: new Date('2026-09-20T08:00:00.000Z') });
    await insertProposal({ status: 'approved', expiresAt: new Date('2026-09-01T08:00:00.000Z') });

    const after = await pendingProposalSummary(db);

    expect(after.pending).toBe(before.pending + 1);
    expect(after.oldestExpiresAt).toBe('2026-09-20T08:00:00.000Z');
  });
});

describe('getProposal', () => {
  it('returns the proposal with that id', async () => {
    const id = await insertProposal();

    expect((await getProposal(db, id))?.id).toBe(id);
  });

  it('returns null when no proposal carries that id', async () => {
    expect(await getProposal(db, newUlid())).toBeNull();
  });
});
