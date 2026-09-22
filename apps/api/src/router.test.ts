import { beforeEach, describe, expect, it } from 'vitest';
import { actorFromUpn } from './actor.js';
import { appRouter } from './router.js';
import {
  fakeDeps,
  fakeProposal,
  TEST_COMMITMENT_ID,
  TEST_UPN,
  type FakeDeps,
} from './test-fakes.js';
import { createCallerFactory } from './trpc.js';

const PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E301A';
const CORRELATION_ID = '01K5S9V6QW3SWCCPVB0N0E301B';

const createCaller = createCallerFactory(appRouter);

let harness: FakeDeps;
let caller: ReturnType<typeof createCaller>;

beforeEach(() => {
  harness = fakeDeps();
  harness.proposals.rows = [fakeProposal({ id: PROPOSAL_ID, correlationId: CORRELATION_ID })];
  caller = createCaller({ deps: harness.deps, upn: TEST_UPN });
});

describe('actorFromUpn', () => {
  it('turns the allowlisted UPN into the ledger actor', () => {
    expect(actorFromUpn(TEST_UPN)).toBe('user:dom');
  });

  it('refuses a UPN whose local part has no letters', () => {
    expect(() => actorFromUpn('12345@valliance.ai')).toThrow(/no letters/);
  });
});

describe('proposals.list', () => {
  it('passes only the filters it was given', async () => {
    await caller.proposals.list({ status: 'pending', targetSystem: 'graph' });

    expect(harness.proposals.filters).toEqual([{ status: 'pending', targetSystem: 'graph' }]);
  });

  it('defaults to no filter at all', async () => {
    const rows = await caller.proposals.list();

    expect(harness.proposals.filters).toEqual([{}]);
    expect(rows).toHaveLength(1);
  });

  it('rejects a status the schema does not know', async () => {
    await expect(
      caller.proposals.list({ status: 'lingering' } as unknown as { status: 'pending' }),
    ).rejects.toThrow();
  });
});

describe('proposals.get', () => {
  it('returns the proposal with that id', async () => {
    expect((await caller.proposals.get({ proposalId: PROPOSAL_ID }))?.id).toBe(PROPOSAL_ID);
  });

  it('rejects an id that is not a ULID', async () => {
    await expect(caller.proposals.get({ proposalId: 'not-a-ulid' })).rejects.toThrow();
  });
});

describe('proposals.decide', () => {
  it('decides as the verified caller, not as anyone the client names', async () => {
    await caller.proposals.decide({ proposalId: PROPOSAL_ID, action: 'approve' });

    expect(harness.decider.requests).toEqual([
      { proposalId: PROPOSAL_ID, action: 'approve', actor: 'user:dom' },
    ]);
  });

  it('carries the reason code and note of a rejection', async () => {
    await caller.proposals.decide({
      proposalId: PROPOSAL_ID,
      action: 'reject',
      reasonCode: 'wrong_target',
      note: 'Wrong client.',
    });

    expect(harness.decider.requests[0]).toEqual({
      proposalId: PROPOSAL_ID,
      action: 'reject',
      actor: 'user:dom',
      reasonCode: 'wrong_target',
      note: 'Wrong client.',
    });
  });

  it('carries the edited payload of an edit', async () => {
    await caller.proposals.decide({
      proposalId: PROPOSAL_ID,
      action: 'edit',
      editedPayload: { subject: 'Re: the pilot dates' },
    });

    expect(harness.decider.requests[0]?.editedPayload).toEqual({
      subject: 'Re: the pilot dates',
    });
  });

  it('rejects an action the state machine does not have', async () => {
    await expect(
      caller.proposals.decide({
        proposalId: PROPOSAL_ID,
        action: 'teleport' as unknown as 'approve',
      }),
    ).rejects.toThrow();
  });
});

describe('ledger', () => {
  it('queries with the filters it was given', async () => {
    await caller.ledger.query({ kind: 'decided', actor: 'user:dom' });

    expect(harness.ledger.queries).toEqual([{ kind: 'decided', actor: 'user:dom' }]);
  });

  it('returns one correlation id trail through ledger.correlation', async () => {
    harness.ledger.rows = [
      {
        id: '01K5S9V6QW3SWCCPVB0N0E301C',
        ts: new Date('2026-09-21T12:00:00.000Z'),
        actor: 'user:dom',
        kind: 'decided',
        sourceSystem: 'lance',
        sourceRecordId: null,
        sourceRecordHash: null,
        correlationId: CORRELATION_ID,
        parentEventId: null,
        policyDecisionId: null,
        payload: { proposalId: PROPOSAL_ID },
        payloadHash: 'h1',
        idempotencyKey: null,
        createdAt: new Date('2026-09-21T12:00:00.000Z'),
      },
    ];

    const trail = await caller.ledger.correlation({ correlationId: CORRELATION_ID });

    expect(trail.map((event) => event.id)).toEqual(['01K5S9V6QW3SWCCPVB0N0E301C']);
  });
});

describe('commitments', () => {
  it('lists with the filters the page sent', async () => {
    const page = await caller.commitments.list({ direction: 'inbound', status: 'open' });

    expect(harness.commitments.queries).toEqual([
      { limit: 51, direction: 'inbound', status: 'open' },
    ]);
    expect(page.items[0]?.id).toBe(TEST_COMMITMENT_ID);
  });

  it('rejects a direction the schema does not know', async () => {
    await expect(
      caller.commitments.list({ direction: 'sideways' } as unknown as { direction: 'inbound' }),
    ).rejects.toThrow();
  });

  it('returns one commitment with its provenance', async () => {
    const view = await caller.commitments.get({ id: TEST_COMMITMENT_ID });

    expect(view?.sourceRefs[0]?.recordId).toBe('AAMk2');
  });

  it('marks a commitment done as Dom', async () => {
    const view = await caller.commitments.markDone({ id: TEST_COMMITMENT_ID });

    expect(view.status).toBe('done');
    expect(harness.writer.appended[0]?.actor).toBe('user:dom');
  });

  it('refuses a drop with no reason', async () => {
    await expect(caller.commitments.drop({ id: TEST_COMMITMENT_ID, reason: '' })).rejects.toThrow();
  });

  it('drops a commitment with the reason Dom gave', async () => {
    const view = await caller.commitments.drop({
      id: TEST_COMMITMENT_ID,
      reason: 'The client cancelled the order.',
    });

    expect(view.status).toBe('dropped');
  });

  it('enqueues a chase rather than drafting one itself', async () => {
    expect(await caller.commitments.chase({ id: TEST_COMMITMENT_ID })).toEqual({
      enqueued: true,
      jobId: 'job-1',
    });
    expect(harness.chased).toEqual([TEST_COMMITMENT_ID]);
  });
});

describe('tasks', () => {
  it('lists tasks from the observations the watchers recorded', async () => {
    const page = await caller.tasks.list({ source: 'notion' });

    expect(harness.tasks.queries).toEqual([{ limit: 51, source: 'notion' }]);
    expect(page.items[0]?.source).toBe('notion');
  });

  it('rejects a source the schema does not know', async () => {
    await expect(
      caller.tasks.list({ source: 'asana' } as unknown as { source: 'notion' }),
    ).rejects.toThrow();
  });
});
