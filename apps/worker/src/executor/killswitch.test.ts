import { startPostgresContainer } from '@lance/db/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, proposals, runMigrations, seed, type Db } from '@lance/db';
import { LedgerReader, SystemControl } from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBoss, startBoss } from '../scheduler/boss.js';
import { PauseGate } from '../scheduler/gate.js';
import { QUEUES } from '../scheduler/queues.js';
import { registerExecutor, type ConnectorWrite } from './index.js';

const FAILING_PROPOSAL_MARKER = 'fail-me';

let container: StartedPostgreSqlContainer;
let db: Db;
let boss: PgBoss;
let control: SystemControl;
const perform = vi.fn<ConnectorWrite['perform']>();

async function insertApprovedProposal(preview = 'apply category Newsletters'): Promise<string> {
  const id = newUlid();
  const now = new Date(nowIso());
  await db.insert(proposals).values({
    id,
    correlationId: newUlid(),
    actionClass: 'apply_category',
    counterpartyClass: 'unknown',
    targetSystem: 'graph',
    targetRecordId: 'AAMk-message-1',
    reversibility: 'reversible',
    payload: { categories: ['Newsletters'] },
    preview,
    rationale: 'Test fixture.',
    provenance: [{ system: 'graph', recordId: 'AAMk-message-1', hash: 'h', observedAt: nowIso() }],
    policyDecision: 'propose',
    status: 'approved',
    decidedBy: 'user:dom',
    decidedAt: now,
    expiresAt: new Date(now.getTime() + 48 * 3600 * 1000),
  });
  return id;
}

async function statusOf(id: string): Promise<string> {
  const rows = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, id));
  return rows[0]?.status ?? 'missing';
}

async function waitForStatus(id: string, expected: string[], timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await statusOf(id);
    if (expected.includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return statusOf(id);
}

beforeAll(async () => {
  container = await startPostgresContainer();
  const connectionString = container.getConnectionUri();
  await runMigrations({ connectionString });
  db = createDb({ connectionString, password: 'postgres' });
  await seed(db);
  control = new SystemControl(db);
  boss = createBoss(db);
  await startBoss(boss);
  perform.mockImplementation((proposalId) =>
    proposalId.includes(FAILING_PROPOSAL_MARKER)
      ? Promise.reject(new Error('connector exploded'))
      : Promise.resolve({ targetRecordId: 'AAMk-message-1' }),
  );
  await registerExecutor(boss, { db, gate: new PauseGate(control), write: { perform } });
}, 120000);

afterAll(async () => {
  await boss.stop({ graceful: false });
  await db.$client.end();
  await container.stop();
});

describe('kill switch', () => {
  it('holds a queued execution and performs no write while paused', async () => {
    const id = await insertApprovedProposal();
    await control.pause({ reason: 'drill', actor: 'user:dom' });
    expect(await statusOf(id)).toBe('held');

    const queuedId = await insertApprovedProposal('queued after pause');
    await boss.send(QUEUES.execute, { proposalId: queuedId });
    expect(await waitForStatus(queuedId, ['held'])).toBe('held');
    expect(perform).not.toHaveBeenCalled();
  }, 30000);

  it('releases a proposal the executor held once the system resumes', async () => {
    await control.pause({ reason: 'drill', actor: 'user:dom' });
    const id = await insertApprovedProposal('held by executor');
    await boss.send(QUEUES.execute, { proposalId: id });
    expect(await waitForStatus(id, ['held'])).toBe('held');
    const resumed = await control.resume({ actor: 'user:dom' });
    expect(resumed.releasedProposalIds).toContain(id);
    expect(await statusOf(id)).toBe('approved');
  }, 30000);

  it('executes a released proposal after resume and records the executed event', async () => {
    const id = await insertApprovedProposal('released on resume');
    await control.pause({ reason: 'drill', actor: 'user:dom' });
    const resumed = await control.resume({ actor: 'user:dom' });
    expect(resumed.releasedProposalIds).toContain(id);

    await boss.send(QUEUES.execute, { proposalId: id });
    expect(await waitForStatus(id, ['executed', 'failed'])).toBe('executed');
    expect(perform).toHaveBeenCalledWith(id);

    const rows = await db.select().from(proposals).where(eq(proposals.id, id));
    const executionEventId = rows[0]?.executionEventId;
    expect(executionEventId).toBeTruthy();
    const trail = await new LedgerReader(db).byCorrelation(rows[0]?.correlationId ?? '');
    expect(trail.map((event) => event.kind)).toContain('executed');
  }, 30000);

  it('records a failed event and status when the connector write throws', async () => {
    const id = await insertApprovedProposal(FAILING_PROPOSAL_MARKER);
    perform.mockImplementationOnce(() => Promise.reject(new Error('connector exploded')));
    await boss.send(QUEUES.execute, { proposalId: id });
    expect(await waitForStatus(id, ['executed', 'failed'])).toBe('failed');
    const trail = await new LedgerReader(db).query({ kind: 'failed' });
    expect(
      trail.some((event) => (event.payload as { proposalId?: string } | null)?.proposalId === id),
    ).toBe(true);
  }, 30000);

  it('skips a proposal that is not approved without writing', async () => {
    const id = await insertApprovedProposal('pending one');
    await db.update(proposals).set({ status: 'pending' }).where(eq(proposals.id, id));
    const before = perform.mock.calls.length;
    await boss.send(QUEUES.execute, { proposalId: id });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await statusOf(id)).toBe('pending');
    expect(perform.mock.calls.length).toBe(before);
  }, 30000);
});
