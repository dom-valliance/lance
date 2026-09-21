import type { DecisionInput, DecisionResult } from '@lance/ledger';
import type { Proposal } from '@lance/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FeedEvent } from '../events.js';
import { fakeProposal, fakeSlackSurface, testConfig } from '../test-fakes.js';
import { applyDecision, type DecideDeps } from './decide.js';

const PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E301A';

interface Harness {
  deps: DecideDeps;
  decisions: DecisionInput[];
  enqueued: string[];
  events: FeedEvent[];
  updates: { ts: string; text: string }[];
  slackFailures: unknown[];
  setProposal(proposal: Proposal | null): void;
  setResult(result: Partial<DecisionResult>): void;
}

const harnessWith = (options: { proposal?: Proposal | null; slack?: boolean } = {}): Harness => {
  const decisions: DecisionInput[] = [];
  const enqueued: string[] = [];
  const events: FeedEvent[] = [];
  const slackFailures: unknown[] = [];
  const slack = fakeSlackSurface();
  let proposal: Proposal | null = options.proposal ?? fakeProposal({ id: PROPOSAL_ID });
  let result: DecisionResult = {
    proposalId: PROPOSAL_ID,
    from: 'pending',
    to: 'approved',
    execute: true,
    eventId: '01K5S9V6QW3SWCCPVB0N0E301C',
  };

  const deps: DecideDeps = {
    decide: (input) => {
      decisions.push(input);
      return Promise.resolve(result);
    },
    getProposal: () => Promise.resolve(proposal),
    enqueueExecute: (id) => {
      enqueued.push(id);
      return Promise.resolve();
    },
    slack: options.slack === false ? null : slack.surface,
    notify: (event) => events.push(event),
    config: testConfig(),
    onSlackFailure: (error) => slackFailures.push(error),
  };

  return {
    deps,
    decisions,
    enqueued,
    events,
    updates: slack.updates,
    slackFailures,
    setProposal(next) {
      proposal = next;
    },
    setResult(next) {
      result = { ...result, ...next };
    },
  };
};

let harness: Harness;

beforeEach(() => {
  harness = harnessWith();
});

describe('applyDecision', () => {
  it('passes only the fields it was given to the decision service', async () => {
    await applyDecision(harness.deps, {
      proposalId: PROPOSAL_ID,
      action: 'reject',
      actor: 'user:dom',
      reasonCode: 'not_now',
    });

    expect(harness.decisions).toEqual([
      { proposalId: PROPOSAL_ID, action: 'reject', actor: 'user:dom', reasonCode: 'not_now' },
    ]);
  });

  it('queues execution when the decision service says the proposal should run', async () => {
    await applyDecision(harness.deps, {
      proposalId: PROPOSAL_ID,
      action: 'approve',
      actor: 'user:dom',
    });

    expect(harness.enqueued).toEqual([PROPOSAL_ID]);
  });

  it('queues nothing when the decision service says the proposal should not run', async () => {
    harness.setResult({ execute: false, to: 'rejected' });

    await applyDecision(harness.deps, {
      proposalId: PROPOSAL_ID,
      action: 'reject',
      actor: 'user:dom',
    });

    expect(harness.enqueued).toEqual([]);
  });

  it('redraws the Slack card when the proposal was posted to Slack', async () => {
    harness.setProposal(
      fakeProposal({
        id: PROPOSAL_ID,
        status: 'approved',
        decidedBy: 'user:dom',
        decidedAt: '2026-09-21T12:00:00.000Z',
        slackChannel: 'C0BU7P278N5',
        slackTs: '1758351600.000100',
      }),
    );

    await applyDecision(harness.deps, {
      proposalId: PROPOSAL_ID,
      action: 'approve',
      actor: 'user:dom',
    });

    expect(harness.updates).toHaveLength(1);
    expect(harness.updates[0]?.ts).toBe('1758351600.000100');
  });

  it('redraws nothing for a proposal that was never posted to Slack', async () => {
    harness.setProposal(fakeProposal({ id: PROPOSAL_ID, slackChannel: null, slackTs: null }));

    await applyDecision(harness.deps, {
      proposalId: PROPOSAL_ID,
      action: 'approve',
      actor: 'user:dom',
    });

    expect(harness.updates).toEqual([]);
  });

  it('redraws nothing when no Slack surface is configured', async () => {
    const tokenless = harnessWith({ slack: false });

    await applyDecision(tokenless.deps, {
      proposalId: PROPOSAL_ID,
      action: 'approve',
      actor: 'user:dom',
    });

    expect(tokenless.updates).toEqual([]);
    expect(tokenless.enqueued).toEqual([PROPOSAL_ID]);
  });

  it('reports a failed card update rather than losing the decision', async () => {
    const slack = {
      update: () => Promise.reject(new Error('slack is down')),
    };
    const deps: DecideDeps = {
      ...harness.deps,
      slack,
      onSlackFailure: (error) => harness.slackFailures.push(error),
    };
    harness.setProposal(
      fakeProposal({ id: PROPOSAL_ID, slackChannel: 'C0BU7P278N5', slackTs: '1758351600.000100' }),
    );

    const result = await applyDecision(deps, {
      proposalId: PROPOSAL_ID,
      action: 'approve',
      actor: 'user:dom',
    });

    expect(result.to).toBe('approved');
    expect(harness.slackFailures).toHaveLength(1);
  });

  it('tells the live feed which proposal changed', async () => {
    await applyDecision(harness.deps, {
      proposalId: PROPOSAL_ID,
      action: 'approve',
      actor: 'user:dom',
    });

    expect(harness.events).toEqual([{ type: 'proposal', id: PROPOSAL_ID }]);
  });
});
