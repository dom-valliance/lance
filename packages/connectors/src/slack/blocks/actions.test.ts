import { describe, expect, it } from 'vitest';
import { ACTION, CALLBACK, parseActionValue } from './actions.js';
import { FIXTURE_PROPOSAL_ID } from './fixtures.js';

describe('ACTION', () => {
  it('namespaces every proposal action id under "proposal:"', () => {
    expect(ACTION.proposalApprove).toBe('proposal:approve');
    expect(ACTION.proposalEdit).toBe('proposal:edit');
    expect(ACTION.proposalReject).toBe('proposal:reject');
    expect(ACTION.proposalSnooze).toBe('proposal:snooze');
  });

  it('namespaces the executed and alert action ids', () => {
    expect(ACTION.executedUndo).toBe('executed:undo');
    expect(ACTION.alertAck).toBe('alert:ack');
    expect(ACTION.alertMute).toBe('alert:mute');
  });
});

describe('CALLBACK', () => {
  it('gives the edit and reject modals their callback ids', () => {
    expect(CALLBACK.proposalEdit).toBe('proposal_edit_modal');
    expect(CALLBACK.proposalReject).toBe('proposal_reject_modal');
  });
});

describe('parseActionValue', () => {
  it('accepts a 26-character ULID and returns it as the id', () => {
    expect(parseActionValue(FIXTURE_PROPOSAL_ID)).toEqual({ id: FIXTURE_PROPOSAL_ID });
  });

  it('rejects a malformed id', () => {
    expect(() => parseActionValue('not-a-ulid')).toThrow(/ULID/);
  });

  it('rejects an id that is one character short of a ULID', () => {
    expect(() => parseActionValue(FIXTURE_PROPOSAL_ID.slice(0, 25))).toThrow(/ULID/);
  });

  it('rejects a lower-case ULID', () => {
    expect(() => parseActionValue(FIXTURE_PROPOSAL_ID.toLowerCase())).toThrow(/ULID/);
  });
});
