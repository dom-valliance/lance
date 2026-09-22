import { ACTION, CALLBACK } from '@lance/connectors';
import { ProposalTransitionError } from '@lance/ledger';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  fakeAlert,
  fakeDeps,
  fakeProposal,
  TEST_ALERT_ID,
  TEST_SLACK_USER_ID,
  type FakeDeps,
} from '../test-fakes.js';
import {
  handleInteraction,
  MUTE_HOURS,
  SNOOZE_HOURS,
  type InteractionOutcome,
} from './interactions.js';

let harness: FakeDeps;
const PROPOSAL_ID = '01K5S9V6QW3SWCCPVB0N0E301A';

const blockAction = (actionId: string, overrides: Record<string, unknown> = {}): unknown => ({
  type: 'block_actions',
  user: { id: TEST_SLACK_USER_ID },
  trigger_id: 'T-1',
  actions: [{ action_id: actionId, value: PROPOSAL_ID }],
  ...overrides,
});

const text = (outcome: InteractionOutcome): string => {
  if (outcome.kind !== 'json' || !('text' in outcome.body)) {
    throw new Error('Expected an ephemeral reply.');
  }
  return outcome.body.text;
};

beforeEach(() => {
  harness = fakeDeps();
  harness.proposals.rows = [fakeProposal({ id: PROPOSAL_ID })];
});

describe('a proposal card button', () => {
  it('approves the proposal the button names and answers with an empty 200', async () => {
    const outcome = await handleInteraction(harness.deps, blockAction(ACTION.proposalApprove));

    expect(outcome).toEqual({ kind: 'empty' });
    expect(harness.decider.requests).toEqual([
      { proposalId: PROPOSAL_ID, actor: 'user:dom', action: 'approve' },
    ]);
  });

  it('snoozes for the four hours the button label promises', async () => {
    await handleInteraction(harness.deps, blockAction(ACTION.proposalSnooze));

    expect(harness.decider.requests[0]).toEqual({
      proposalId: PROPOSAL_ID,
      actor: 'user:dom',
      action: 'snooze',
      snoozeHours: SNOOZE_HOURS,
    });
    expect(SNOOZE_HOURS).toBe(4);
  });

  it('opens the edit modal pre-filled from the payload rather than deciding', async () => {
    const outcome = await handleInteraction(harness.deps, blockAction(ACTION.proposalEdit));

    expect(outcome).toEqual({ kind: 'empty' });
    expect(harness.decider.requests).toHaveLength(0);
    expect(harness.slack.views).toHaveLength(1);
    expect(harness.slack.views[0]?.triggerId).toBe('T-1');
    expect(JSON.stringify(harness.slack.views[0]?.view)).toContain(CALLBACK.proposalEdit);
  });

  it('opens the reject modal rather than deciding', async () => {
    await handleInteraction(harness.deps, blockAction(ACTION.proposalReject));

    expect(harness.decider.requests).toHaveLength(0);
    expect(JSON.stringify(harness.slack.views[0]?.view)).toContain(CALLBACK.proposalReject);
  });

  it('says undo arrives in a later phase', async () => {
    const outcome = await handleInteraction(harness.deps, blockAction(ACTION.executedUndo));

    expect(text(outcome)).toBe('Undo arrives in a later phase. Nothing has changed.');
    expect(harness.decider.requests).toHaveLength(0);
  });

  it('names an action id it does not answer', async () => {
    const outcome = await handleInteraction(harness.deps, blockAction('proposal:teleport'));

    expect(text(outcome)).toContain('proposal:teleport');
  });

  it('refuses a button with a value that is not a proposal id', async () => {
    const outcome = await handleInteraction(
      harness.deps,
      blockAction(ACTION.proposalApprove, { actions: [{ action_id: ACTION.proposalApprove }] }),
    );

    expect(text(outcome)).toContain('carried no proposal id');
    expect(harness.decider.requests).toHaveLength(0);
  });

  it('explains a refused transition instead of failing the request', async () => {
    harness.decider.failWith = new ProposalTransitionError(
      'Cannot approve proposal 01K5: it is rejected, and approve applies to pending or held.',
    );

    const outcome = await handleInteraction(harness.deps, blockAction(ACTION.proposalApprove));

    expect(text(outcome)).toContain('it is rejected');
  });
});

describe('an alert card button', () => {
  const alertAction = (actionId: string, id: string = TEST_ALERT_ID): unknown =>
    blockAction(actionId, { actions: [{ action_id: actionId, value: id }] });

  it('acknowledges the alert the button names, as Dom', async () => {
    const outcome = await handleInteraction(harness.deps, alertAction(ACTION.alertAck));

    expect(outcome).toEqual({ kind: 'empty' });
    expect(harness.alerts.rows[0]?.status).toBe('acked');
    expect(harness.alerts.rows[0]?.ackedBy).toBe('user:dom');
    expect(harness.writer.appended[0]?.kind).toBe('alert_acked');
  });

  it('mutes for the twenty-four hours the button label promises', async () => {
    await handleInteraction(harness.deps, alertAction(ACTION.alertMute));

    const mutedUntil = harness.alerts.rows[0]?.mutedUntil?.getTime() ?? 0;
    const lastSeen = harness.alerts.rows[0]?.updatedAt.getTime() ?? 0;

    expect(harness.alerts.rows[0]?.status).toBe('suppressed');
    expect((mutedUntil - lastSeen) / (60 * 60 * 1000)).toBe(MUTE_HOURS);
    expect(MUTE_HOURS).toBe(24);
  });

  it('explains a refused change instead of failing the request', async () => {
    harness.alerts.rows = [fakeAlert({ status: 'resolved' })];

    const outcome = await handleInteraction(harness.deps, alertAction(ACTION.alertAck));

    expect(text(outcome)).toContain('it cannot be acknowledged');
  });

  it('refuses a button with a value that is not an alert id', async () => {
    const outcome = await handleInteraction(
      harness.deps,
      blockAction(ACTION.alertMute, { actions: [{ action_id: ACTION.alertMute }] }),
    );

    expect(text(outcome)).toContain('carried no alert id');
    expect(harness.writer.appended).toHaveLength(0);
  });
});

describe('a Slack user other than Dom', () => {
  it('is refused and decides nothing', async () => {
    const outcome = await handleInteraction(harness.deps, {
      ...(blockAction(ACTION.proposalApprove) as object),
      user: { id: 'U0STRANGER' },
    });

    expect(text(outcome)).toContain('not authorised');
    expect(harness.decider.requests).toHaveLength(0);
    expect(harness.slack.views).toHaveLength(0);
  });

  it('is refused when no allowlisted Slack user id is configured', async () => {
    const unset = fakeDeps({ allowedSlackUserId: null });

    const outcome = await handleInteraction(unset.deps, blockAction(ACTION.proposalApprove));

    expect(text(outcome)).toContain('not authorised');
    expect(unset.decider.requests).toHaveLength(0);
  });
});

describe('a submitted modal', () => {
  it('applies the edited fields and clears the edit modal', async () => {
    const outcome = await handleInteraction(harness.deps, {
      type: 'view_submission',
      user: { id: TEST_SLACK_USER_ID },
      view: {
        callback_id: CALLBACK.proposalEdit,
        private_metadata: PROPOSAL_ID,
        state: {
          values: {
            'field:subject': { value: { type: 'plain_text_input', value: 'Re: the pilot dates' } },
            'field:bodyText': { value: { type: 'plain_text_input', value: 'Tuesday suits.' } },
          },
        },
      },
    });

    expect(outcome).toEqual({ kind: 'json', body: { response_action: 'clear' } });
    expect(harness.decider.requests[0]).toEqual({
      proposalId: PROPOSAL_ID,
      actor: 'user:dom',
      action: 'edit',
      editedPayload: { subject: 'Re: the pilot dates', bodyText: 'Tuesday suits.' },
    });
  });

  it('applies the reason code and note from the reject modal', async () => {
    const outcome = await handleInteraction(harness.deps, {
      type: 'view_submission',
      user: { id: TEST_SLACK_USER_ID },
      view: {
        callback_id: CALLBACK.proposalReject,
        private_metadata: PROPOSAL_ID,
        state: {
          values: {
            reason_code: {
              reason_code: { type: 'static_select', selected_option: { value: 'wrong_target' } },
            },
            reason_note: { reason_note: { type: 'plain_text_input', value: 'Wrong client.' } },
          },
        },
      },
    });

    expect(outcome).toEqual({ kind: 'json', body: { response_action: 'clear' } });
    expect(harness.decider.requests[0]).toEqual({
      proposalId: PROPOSAL_ID,
      actor: 'user:dom',
      action: 'reject',
      reasonCode: 'wrong_target',
      note: 'Wrong client.',
    });
  });

  it('names a callback id it does not handle', async () => {
    const outcome = await handleInteraction(harness.deps, {
      type: 'view_submission',
      user: { id: TEST_SLACK_USER_ID },
      view: { callback_id: 'some_other_modal', private_metadata: '', state: { values: {} } },
    });

    expect(text(outcome)).toContain('some_other_modal');
  });
});

describe('without a Slack bot token', () => {
  it('says so rather than opening a modal', async () => {
    const tokenless = fakeDeps({ withoutSlackSurface: true });
    tokenless.proposals.rows = [fakeProposal({ id: PROPOSAL_ID })];

    const outcome = await handleInteraction(tokenless.deps, blockAction(ACTION.proposalEdit));

    expect(text(outcome)).toContain('no Slack bot token');
  });
});
