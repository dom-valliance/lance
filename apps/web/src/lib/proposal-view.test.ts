import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  diffPayload,
  editableFields,
  formatInstant,
  statusSentence,
  type ProposalStatus,
} from './proposal-view';

describe('formatInstant', () => {
  it('shows a stored UTC instant in London time', () => {
    expect(formatInstant('2026-09-21T12:00:00.000Z')).toContain('13:00');
  });

  it('accepts a Date as well as the string tRPC sends over the wire', () => {
    expect(formatInstant(new Date('2026-09-21T12:00:00.000Z'))).toBe(
      formatInstant('2026-09-21T12:00:00.000Z'),
    );
  });

  it('says so rather than throwing when the value is not a time', () => {
    expect(formatInstant('soon')).toBe('unknown time');
  });
});

describe('diffPayload', () => {
  it('returns nothing for a proposal that was never edited', () => {
    expect(diffPayload({ subject: 'Hello' }, null)).toEqual([]);
  });

  it('lists only the fields the edit changed', () => {
    const changes = diffPayload(
      { subject: 'Hello', bodyText: 'Thanks.' },
      { subject: 'Hello', bodyText: 'Thanks, Tuesday works.' },
    );

    expect(changes).toEqual([
      { field: 'bodyText', before: 'Thanks.', after: 'Thanks, Tuesday works.' },
    ]);
  });

  it('shows a field the edit added and one it emptied', () => {
    const changes = diffPayload({ subject: 'Hello' }, { subject: '', cc: 'sam@example.com' });

    expect(changes).toEqual([
      { field: 'cc', before: '', after: 'sam@example.com' },
      { field: 'subject', before: 'Hello', after: '' },
    ]);
  });
});

describe('editableFields', () => {
  it('offers the string fields and leaves the rest alone', () => {
    expect(editableFields({ subject: 'Hello', attempts: 2, flags: ['a'] })).toEqual([
      ['subject', 'Hello'],
    ]);
  });
});

describe('allowedActions', () => {
  it('offers every decision on a pending proposal', () => {
    expect(allowedActions('pending')).toEqual(['approve', 'edit', 'reject', 'snooze']);
  });

  it('offers approve, edit and reject but not snooze on a held proposal', () => {
    expect(allowedActions('held')).toEqual(['approve', 'edit', 'reject']);
  });

  it.each<ProposalStatus>([
    'approved',
    'edited',
    'rejected',
    'expired',
    'executing',
    'executed',
    'failed',
  ])('offers nothing once a proposal is %s', (status) => {
    expect(allowedActions(status)).toEqual([]);
  });

  it('never allows approve on a status other than pending or held', () => {
    const statuses: ProposalStatus[] = [
      'approved',
      'edited',
      'rejected',
      'expired',
      'executing',
      'executed',
      'failed',
    ];
    for (const status of statuses) {
      expect(allowedActions(status)).not.toContain('approve');
    }
  });
});

describe('statusSentence', () => {
  it('says nothing while the proposal still has actions to offer', () => {
    expect(statusSentence('pending')).toBeNull();
    expect(statusSentence('held')).toBeNull();
  });

  it('explains an approved proposal in plain words', () => {
    expect(statusSentence('approved')).toBe('Approved and waiting for the executor.');
  });

  it.each<[ProposalStatus, string]>([
    ['edited', 'Edited and waiting for the executor.'],
    ['executing', 'Executing now.'],
    ['executed', 'Executed.'],
    ['rejected', 'Rejected.'],
    ['expired', 'Expired before it was decided.'],
    ['failed', 'Execution failed. Check the status history below.'],
  ])('gives %s its own sentence', (status, expected) => {
    expect(statusSentence(status)).toBe(expected);
  });
});
