import { describe, expect, it } from 'vitest';
import {
  formatDelta,
  formatInstantWithSeconds,
  formatTimeWithSeconds,
  ledgerDetail,
  type LedgerEventView,
  proposalIdIn,
  recordUrlIn,
  sourceSystemLabel,
  sourceSystemOf,
} from './ledger-view';

const event = (over: Partial<LedgerEventView>): LedgerEventView => ({
  id: '01K5X0000000000000000EVENT',
  ts: '2026-09-21T13:05:41.000Z',
  actor: 'agent:triage',
  kind: 'observed',
  sourceSystem: 'graph',
  sourceRecordId: null,
  correlationId: '01K5X0000000000000000TRAIL',
  payload: null,
  ...over,
});

describe('formatInstantWithSeconds', () => {
  it('prints the London date and time to the second', () => {
    expect(formatInstantWithSeconds('2026-09-21T13:05:41.000Z')).toBe('21 Sept 2026, 14:05:41');
  });

  it('says so when the value is not a time', () => {
    expect(formatInstantWithSeconds('never')).toBe('unknown time');
  });
});

describe('formatTimeWithSeconds', () => {
  it('prints the London time alone', () => {
    expect(formatTimeWithSeconds(new Date('2026-09-21T13:05:41.000Z'))).toBe('14:05:41');
  });
});

describe('formatDelta', () => {
  it('counts seconds under a minute', () => {
    expect(formatDelta(0)).toBe('0 s');
    expect(formatDelta(3_000)).toBe('3 s');
  });

  it('counts minutes and seconds under an hour', () => {
    expect(formatDelta(109_000)).toBe('1 min 49 s');
    expect(formatDelta(120_000)).toBe('2 min');
  });

  it('counts hours and minutes above an hour', () => {
    expect(formatDelta(17_280_000)).toBe('4 h 48 min');
    expect(formatDelta(7_200_000)).toBe('2 h');
  });
});

describe('sourceSystemOf', () => {
  it('recognises a known system and rejects anything else', () => {
    expect(sourceSystemOf('notion')).toBe('notion');
    expect(sourceSystemOf('mainframe')).toBeNull();
    expect(sourceSystemOf(null)).toBeNull();
  });
});

describe('sourceSystemLabel', () => {
  it('humanises a known system, an unknown one and a missing one', () => {
    expect(sourceSystemLabel('graph')).toBe('Microsoft 365');
    expect(sourceSystemLabel('old_mailbox')).toBe('Old mailbox');
    expect(sourceSystemLabel(null)).toBe('none');
  });
});

describe('proposalIdIn and recordUrlIn', () => {
  it('reads the proposal a payload names', () => {
    expect(proposalIdIn({ proposalId: '01K5PROP' })).toBe('01K5PROP');
    expect(proposalIdIn({ other: 1 })).toBeNull();
    expect(proposalIdIn('a string')).toBeNull();
  });

  it('reads only an http record link', () => {
    expect(recordUrlIn({ url: 'https://notion.so/task' })).toBe('https://notion.so/task');
    expect(recordUrlIn({ url: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('ledgerDetail', () => {
  it('says what Dom decided, with the reject reason in plain words', () => {
    expect(
      ledgerDetail(
        event({
          kind: 'decided',
          payload: { proposalId: 'p1', action: 'approve', to: 'approved' },
        }),
      ),
    ).toBe('Approved');
    expect(
      ledgerDetail(
        event({ kind: 'decided', payload: { action: 'reject', reasonCode: 'wrong_target' } }),
      ),
    ).toBe('Rejected: wrong target');
  });

  it('falls back to the status a policy decision recorded', () => {
    expect(
      ledgerDetail(event({ kind: 'decided', payload: { proposalId: 'p1', status: 'held' } })),
    ).toBe('Held');
  });

  it('names what an execution did and the record it touched', () => {
    expect(
      ledgerDetail(
        event({
          kind: 'executed',
          sourceRecordId: 'task-42',
          payload: { proposalId: 'p1', actionClass: 'create_task' },
        }),
      ),
    ).toBe('Create task on task-42');
    expect(
      ledgerDetail(event({ kind: 'executed', payload: { summary: 'Filed under Clients' } })),
    ).toBe('Filed under Clients');
  });

  it('gives the error a failure carried', () => {
    expect(
      ledgerDetail(event({ kind: 'failed', payload: { error: 'Notion refused the update' } })),
    ).toBe('Notion refused the update');
    expect(ledgerDetail(event({ kind: 'failed', payload: { message: 'Timed out' } }))).toBe(
      'Timed out',
    );
  });

  it('reads a proposal as its action, counterparty and policy decision', () => {
    expect(
      ledgerDetail(
        event({
          kind: 'proposed',
          payload: { actionClass: 'draft_email', counterpartyClass: 'client', decision: 'propose' },
        }),
      ),
    ).toBe('Draft email for a client counterparty, policy says propose');
  });

  it('reads an observation as its subject, title or summary', () => {
    expect(ledgerDetail(event({ payload: { subject: 'Renewal terms' } }))).toBe('Renewal terms');
    expect(ledgerDetail(event({ payload: { title: 'Weekly sync' } }))).toBe('Weekly sync');
  });

  it('reads a cost event as the spend and the tokens', () => {
    expect(
      ledgerDetail(
        event({
          kind: 'cost_recorded',
          payload: { estimatedCostUsd: 0.0142, inputTokens: 1204, outputTokens: 318 },
        }),
      ),
    ).toBe('$0.0142, 1204 tokens in, 318 out');
  });

  it('reads a state change as the pause, the resume or the mode', () => {
    expect(
      ledgerDetail(
        event({
          kind: 'state_changed',
          payload: { change: 'pause', paused: true, reason: 'Graph token expired' },
        }),
      ),
    ).toBe('Paused: Graph token expired');
    expect(
      ledgerDetail(event({ kind: 'state_changed', payload: { change: 'resume', paused: false } })),
    ).toBe('Resumed');
    expect(
      ledgerDetail(
        event({ kind: 'state_changed', payload: { change: 'mode', from: 'dry_run', to: 'live' } }),
      ),
    ).toBe('Mode changed from dry run to live');
  });

  it('reads a retention run as its counts', () => {
    expect(
      ledgerDetail(
        event({ kind: 'retention_applied', payload: { mailBodies: 12, transcripts: 3 } }),
      ),
    ).toBe('12 mail bodies, 3 transcripts');
  });

  it('reads an alert as its severity, kind and title', () => {
    expect(
      ledgerDetail(
        event({
          kind: 'alert_raised',
          payload: { severity: 'P1', kind: 'watcher_failed', title: 'The mail watcher failed' },
        }),
      ),
    ).toBe('P1 watcher failed: The mail watcher failed');
  });

  it('falls back to the first words the payload holds, and to nothing when it holds none', () => {
    expect(
      ledgerDetail(event({ kind: 'resolved', payload: { kind: 'commitment_recorded' } })),
    ).toBe('Commitment recorded');
    expect(ledgerDetail(event({ kind: 'rule_changed', payload: { ruleId: 'rule-7' } }))).toBe(
      'rule-7',
    );
    expect(ledgerDetail(event({ kind: 'observed', payload: null }))).toBe('');
    expect(ledgerDetail(event({ kind: 'observed', payload: { count: 3 } }))).toBe('');
  });
});
