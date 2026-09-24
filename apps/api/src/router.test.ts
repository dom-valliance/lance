import type { MorningBriefContent } from '@lance/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { actorFromUpn } from './actor.js';
import { appRouter } from './router.js';
import {
  fakeBrief,
  fakeDeps,
  fakeProposal,
  fakeSnapshot,
  TEST_COMMITMENT_ID,
  TEST_UPN,
  type FakeDeps,
} from './test-fakes.js';
import { createCallerFactory } from './trpc.js';

const PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E301A';
const CORRELATION_ID = '01K5S9V6QW3SWCCPVB0N0E301B';

/** A morning brief with nothing in it, which is still a complete shape (spec 10.1). */
const morningBriefContent: MorningBriefContent = {
  date: '2026-09-21',
  headline: 'Nothing in the diary. Two things overdue.',
  dayShape: {
    firstMeeting: null,
    lastMeeting: null,
    meetingHours: 0,
    workingHours: 8,
    longestFreeBlock: null,
    proposedHolds: [],
    note: 'No holds proposed: free time is over two hours.',
    calendarObservedAt: '2026-09-21T05:30:00.000Z',
  },
  meetings: [],
  tasks: { items: [], total: 0, duplicatesMerged: 0 },
  waitingFor: [],
  overnight: {
    from: '2026-09-20T18:00:00.000Z',
    to: '2026-09-21T05:30:00.000Z',
    alerts: [],
    awaiting: { count: 0, top: [] },
    executed: [],
  },
  agentHealth: {
    watchers: [{ name: 'graph-mail', ageMinutes: 12, state: 'healthy' }],
    breakersOpen: 0,
    costYesterdayGbp: 1.42,
    costTodayGbp: 0.08,
    ceilingGbp: 10,
  },
};

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
  it('passes only the filters it was given, with one row beyond the page', async () => {
    await caller.proposals.list({ status: 'pending', targetSystem: 'graph' });

    expect(harness.proposals.filters).toEqual([
      { status: 'pending', targetSystem: 'graph', limit: 51 },
    ]);
  });

  it('defaults to no filter at all and answers with a page', async () => {
    const page = await caller.proposals.list();

    expect(harness.proposals.filters).toEqual([{ limit: 51 }]);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(1);
  });

  it('rejects a status the schema does not know', async () => {
    await expect(
      caller.proposals.list({ status: 'lingering' } as unknown as { status: 'pending' }),
    ).rejects.toThrow();
  });
});

describe('proposals.summary', () => {
  it('counts the pending queue and names the earliest expiry', async () => {
    expect(await caller.proposals.summary()).toEqual({
      pending: 1,
      oldestExpiresAt: '2026-09-22T09:00:00.000Z',
    });
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

  it('pages the ledger with a total through ledger.list', async () => {
    const page = await caller.ledger.list({ kind: 'decided', limit: 50 });

    expect(harness.ledger.queries).toEqual([{ kind: 'decided', limit: 51 }]);
    expect(harness.ledger.counts).toEqual([{ kind: 'decided' }]);
    expect(page).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it('refuses a ledger cursor that is not an event id', async () => {
    await expect(caller.ledger.list({ cursor: '2026-09-21T09:00:00.000Z' })).rejects.toThrow();
  });

  it('refuses a ledger page larger than the page limit', async () => {
    await expect(caller.ledger.list({ limit: 201 })).rejects.toThrow();
  });

  it('returns one correlation id trail through ledger.correlation', async () => {
    harness.ledger.rows = [
      {
        id: '01K5S9V6QW3SWCCPVB0N0E301C',
        principalId: '01K5S9V6QW3SWCCPVB0N0E300H',
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
    expect(page.total).toBe(1);
  });

  it('summarises the open and overdue commitments of both tabs', async () => {
    expect(await caller.commitments.summary()).toEqual({
      inbound: { open: 1, overdue: 1 },
      outbound: { open: 0, overdue: 0 },
    });
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
    expect(page.total).toBe(1);
  });

  it('rejects a source the schema does not know', async () => {
    await expect(
      caller.tasks.list({ source: 'asana' } as unknown as { source: 'notion' }),
    ).rejects.toThrow();
  });
});

describe('systemState.status', () => {
  it('returns the same snapshot the admin status route serves', async () => {
    harness.status.current = fakeSnapshot({ costTodayGbp: 2.5 });

    const snapshot = await caller.systemState.status();

    expect(snapshot.costTodayGbp).toBe(2.5);
    expect(snapshot.cursors[0]?.watcher).toBe('graph-mail');
  });
});

describe('systemState.pause', () => {
  it('pauses as the verified caller, with the reason given', async () => {
    const result = await caller.systemState.pause({ reason: 'Graph token refresh is failing' });

    expect(harness.control.pauseCalls).toEqual([
      { reason: 'Graph token refresh is failing', actor: 'user:dom' },
    ]);
    expect(result.heldProposalIds).toEqual([PROPOSAL_ID]);
  });

  it('refuses a pause with no reason', async () => {
    await expect(caller.systemState.pause({ reason: '' })).rejects.toThrow();
  });
});

describe('systemState.resume', () => {
  it('re-queues every proposal the resume released', async () => {
    const result = await caller.systemState.resume();

    expect(harness.control.resumeCalls).toEqual([{ actor: 'user:dom' }]);
    expect(result.releasedProposalIds).toEqual([PROPOSAL_ID]);
    expect(harness.enqueued).toEqual([PROPOSAL_ID]);
  });
});

describe('systemState.setMode', () => {
  it('switches the mode as the verified caller', async () => {
    const result = await caller.systemState.setMode({ mode: 'live' });

    expect(harness.control.modeCalls).toEqual([{ mode: 'live', actor: 'user:dom' }]);
    expect(result.changed).toBe(true);
  });

  it('rejects a mode the schema does not know', async () => {
    await expect(
      caller.systemState.setMode({ mode: 'yolo' } as unknown as { mode: 'live' }),
    ).rejects.toThrow();
  });
});

describe('systemState.setInterruptionBudget', () => {
  const budget = { quietHoursStart: '20:00', quietHoursEnd: '06:30', pushBudgetPerHour: 5 };

  it('stores the quiet hours and the push budget as the verified caller', async () => {
    const result = await caller.systemState.setInterruptionBudget(budget);

    expect(harness.control.budgetCalls).toEqual([{ budget, actor: 'user:dom' }]);
    expect(result.changed).toBe(true);
  });

  it('rejects a quiet hour outside the 24-hour clock', async () => {
    await expect(
      caller.systemState.setInterruptionBudget({ ...budget, quietHoursStart: '25:00' }),
    ).rejects.toThrow();
  });

  it('rejects a push budget above the ceiling', async () => {
    await expect(
      caller.systemState.setInterruptionBudget({ ...budget, pushBudgetPerHour: 51 }),
    ).rejects.toThrow();
  });
});

describe('systemState.setCostCeiling', () => {
  it('stores the daily spend ceiling as the verified caller', async () => {
    const result = await caller.systemState.setCostCeiling({ costCeilingGbp: 25 });
    expect(harness.control.ceilingCalls).toEqual([
      { ceiling: { costCeilingGbp: 25 }, actor: 'user:dom' },
    ]);
    expect(result.changed).toBe(true);
  });

  it('rejects a ceiling of zero or below', async () => {
    await expect(caller.systemState.setCostCeiling({ costCeilingGbp: 0 })).rejects.toThrow();
  });
});

describe('settings.retention', () => {
  it('returns the configured retention windows', async () => {
    expect(await caller.settings.retention()).toEqual(harness.deps.config.retention);
  });
});

describe('briefs.latest', () => {
  it('returns nothing when that local day has no brief of that kind', async () => {
    expect(await caller.briefs.latest({ kind: 'morning_brief', date: '2026-09-22' })).toBeNull();
  });

  it('returns the newest brief of that kind on the day, with its content as stored', async () => {
    harness.briefs.rows = [
      fakeBrief({
        id: '01K5S9V6QW3SWCCPVB0N0E305A',
        content: morningBriefContent,
        generatedAt: '2026-09-22T04:00:00.000Z',
      }),
      fakeBrief({
        id: '01K5S9V6QW3SWCCPVB0N0E305C',
        content: { ...morningBriefContent, date: '2026-09-22', slackTs: '1758351600.000100' },
        generatedAt: '2026-09-22T05:30:00.000Z',
      }),
    ];

    const brief = await caller.briefs.latest({ kind: 'morning_brief', date: '2026-09-22' });

    expect(brief?.id).toBe('01K5S9V6QW3SWCCPVB0N0E305C');
    expect((brief?.content as MorningBriefContent).date).toBe('2026-09-22');
    expect(brief?.slackTs).toBe('1758351600.000100');
  });

  it('returns a kind the Today page renders itself as it was stored', async () => {
    harness.briefs.rows = [
      fakeBrief({
        id: '01K5S9V6QW3SWCCPVB0N0E305E',
        kind: 'meeting_prep',
        content: { eventId: 'AAMk1', section: { subject: 'The pilot' }, slackTs: null },
      }),
    ];

    const brief = await caller.briefs.latest({ kind: 'meeting_prep', date: '2026-09-22' });

    expect(brief?.content).toEqual({
      eventId: 'AAMk1',
      section: { subject: 'The pilot' },
      slackTs: null,
    });
    expect(brief?.slackTs).toBeNull();
  });

  it('rejects a kind the schema does not know', async () => {
    await expect(
      caller.briefs.latest({ kind: 'daydream' } as unknown as { kind: 'morning_brief' }),
    ).rejects.toThrow();
  });

  it('rejects a date that is not a calendar date', async () => {
    await expect(
      caller.briefs.latest({ kind: 'morning_brief', date: '22-09-2026' }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('briefs.list', () => {
  beforeEach(() => {
    harness.briefs.rows = [
      fakeBrief({ id: '01K5S9V6QW3SWCCPVB0N0E305A' }),
      fakeBrief({ id: '01K5S9V6QW3SWCCPVB0N0E305B', kind: 'afternoon_board' }),
    ];
  });

  it('returns every kind newest first when it is given no filter', async () => {
    const page = await caller.briefs.list({});

    expect(page.items.map((item) => item.id)).toEqual([
      '01K5S9V6QW3SWCCPVB0N0E305B',
      '01K5S9V6QW3SWCCPVB0N0E305A',
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('returns the cursor for the next page when one exists', async () => {
    const page = await caller.briefs.list({ limit: 1 });

    expect(page.nextCursor).toBe('01K5S9V6QW3SWCCPVB0N0E305B');
  });
});

describe('briefs.get', () => {
  it('returns nothing for an id that has no brief', async () => {
    expect(await caller.briefs.get({ id: '01K5S9V6QW3SWCCPVB0N0E305A' })).toBeNull();
  });

  it('returns the brief and its markdown', async () => {
    harness.briefs.rows = [fakeBrief({ id: '01K5S9V6QW3SWCCPVB0N0E305A' })];

    expect((await caller.briefs.get({ id: '01K5S9V6QW3SWCCPVB0N0E305A' }))?.markdown).toBe(
      '# Morning brief',
    );
  });
});

describe('agents.status', () => {
  it('returns the watchers, the agents, the cost and the breakers in one read', async () => {
    const status = await caller.agents.status();

    expect(status.system).toMatchObject({ paused: false, mode: 'dry_run' });
    expect(status.watchers.map((watcher) => watcher.name)).toEqual(['graph-mail']);
    expect(status.agents.map((agent) => agent.name)).toEqual(['triage']);
    expect(status.costToday.ceilingGbp).toBe(harness.deps.config.cost.dailyCeilingGbp);
    expect(status.costByDay).toHaveLength(14);
    expect(status.breakers).toEqual([]);
  });
});

describe('briefs.regenerate', () => {
  it('queues a morning brief on the worker rather than building one itself', async () => {
    expect(await caller.briefs.regenerate()).toEqual({ enqueued: true, jobId: 'job-brief' });
    expect(harness.briefRequests).toHaveLength(1);
  });
});
