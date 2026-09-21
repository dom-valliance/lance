import { createDb, proposals, runMigrations, seed, type Db } from '@lance/db';
import { startPostgresContainer } from '@lance/db/testing';
import { newUlid } from '@lance/shared';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideProposal, expireProposals, ProposalTransitionError } from './proposals.js';
import { LedgerReader } from './reader.js';

let container: StartedPostgreSqlContainer;
let db: Db;
const NOW = '2026-09-21T12:00:00.000Z';

async function insertProposal(
  status: 'pending' | 'held' | 'approved' | 'executed',
  expiresAt = '2026-09-23T12:00:00.000Z',
): Promise<string> {
  const id = newUlid();
  await db.insert(proposals).values({
    id,
    correlationId: newUlid(),
    actionClass: 'draft_email',
    counterpartyClass: 'client',
    targetSystem: 'graph',
    targetRecordId: 'AAMk1',
    reversibility: 'compensatable',
    payload: { subject: 'Re: hello', bodyText: 'Thanks.' },
    preview: 'Reply to hello',
    rationale: 'They asked.',
    provenance: [{ system: 'graph', recordId: 'AAMk1', hash: 'h', observedAt: NOW }],
    policyDecision: 'propose',
    status,
    expiresAt: new Date(expiresAt),
  });
  return id;
}

const statusOf = async (id: string) =>
  (await db.select().from(proposals).where(eq(proposals.id, id)))[0];

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

describe('decideProposal', () => {
  it('approves a pending proposal, records who decided and asks for execution', async () => {
    const id = await insertProposal('pending');
    const result = await decideProposal(db, {
      proposalId: id,
      action: 'approve',
      actor: 'user:dom',
      now: () => NOW,
    });
    expect(result).toMatchObject({ from: 'pending', to: 'approved', execute: true });
    const row = await statusOf(id);
    expect(row).toMatchObject({ status: 'approved', decidedBy: 'user:dom' });
    const trail = await new LedgerReader(db).byCorrelation(row?.correlationId ?? '');
    expect(trail[0]).toMatchObject({ kind: 'decided', actor: 'user:dom' });
    expect(trail[0]?.payload).toMatchObject({ action: 'approve', from: 'pending', to: 'approved' });
  });

  it('stores the edited payload and executes the edit', async () => {
    const id = await insertProposal('pending');
    const result = await decideProposal(db, {
      proposalId: id,
      action: 'edit',
      actor: 'user:dom',
      editedPayload: { subject: 'Re: hello', bodyText: 'Thanks, will do.' },
      now: () => NOW,
    });
    expect(result.to).toBe('edited');
    expect(result.execute).toBe(true);
    expect((await statusOf(id))?.editedPayload).toEqual({
      subject: 'Re: hello',
      bodyText: 'Thanks, will do.',
    });
  });

  it('refuses an edit without a payload', async () => {
    const id = await insertProposal('pending');
    await expect(
      decideProposal(db, { proposalId: id, action: 'edit', actor: 'user:dom' }),
    ).rejects.toBeInstanceOf(ProposalTransitionError);
  });

  it('rejects with a reason code that reaches the ledger', async () => {
    const id = await insertProposal('approved');
    const result = await decideProposal(db, {
      proposalId: id,
      action: 'reject',
      actor: 'user:dom',
      reasonCode: 'wrong_target',
      note: 'Wrong thread',
      now: () => NOW,
    });
    expect(result).toMatchObject({ from: 'approved', to: 'rejected', execute: false });
    const row = await statusOf(id);
    const trail = await new LedgerReader(db).byCorrelation(row?.correlationId ?? '');
    expect(trail[0]?.payload).toMatchObject({ reasonCode: 'wrong_target', note: 'Wrong thread' });
  });

  it('snoozes by pushing the expiry out and keeping the proposal pending', async () => {
    const id = await insertProposal('pending');
    const result = await decideProposal(db, {
      proposalId: id,
      action: 'snooze',
      actor: 'user:dom',
      now: () => NOW,
    });
    expect(result).toMatchObject({ from: 'pending', to: 'pending', execute: false });
    expect((await statusOf(id))?.expiresAt.toISOString()).toBe('2026-09-21T16:00:00.000Z');
  });

  it('refuses a move the table does not list and names the current status', async () => {
    const id = await insertProposal('executed');
    await expect(
      decideProposal(db, { proposalId: id, action: 'approve', actor: 'user:dom' }),
    ).rejects.toThrow(/it is executed/);
  });

  it('lets a held proposal be approved once the hold has passed', async () => {
    const id = await insertProposal('held');
    expect(
      (
        await decideProposal(db, {
          proposalId: id,
          action: 'approve',
          actor: 'user:dom',
          now: () => NOW,
        })
      ).to,
    ).toBe('approved');
  });

  it('refuses to approve an expired proposal but still allows a reject', async () => {
    const id = await insertProposal('pending', '2026-09-20T00:00:00.000Z');
    await expect(
      decideProposal(db, { proposalId: id, action: 'approve', actor: 'user:dom', now: () => NOW }),
    ).rejects.toThrow(/expired/);
    expect(
      (
        await decideProposal(db, {
          proposalId: id,
          action: 'reject',
          actor: 'user:dom',
          now: () => NOW,
        })
      ).to,
    ).toBe('rejected');
  });

  it('expires every pending proposal past its expiry and no other', async () => {
    const stale = await insertProposal('pending', '2026-09-20T00:00:00.000Z');
    const fresh = await insertProposal('pending');
    const expired = await expireProposals(db, () => NOW);
    expect(expired).toContain(stale);
    expect(expired).not.toContain(fresh);
    expect((await statusOf(stale))?.status).toBe('expired');
  });
});
