import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  diffPayload,
  editableFields,
  expiryCell,
  fieldLabel,
  formatInstant,
  holdBar,
  payloadView,
  previewDetail,
  proposalFilterLabels,
  queueSummary,
  statusSentence,
  summariseLedgerPayload,
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

describe('fieldLabel', () => {
  it('opens camel case up into a reader’s label', () => {
    expect(fieldLabel('destinationFolderName')).toBe('Destination folder name');
    expect(fieldLabel('bodyText')).toBe('Body text');
    expect(fieldLabel('subject')).toBe('Subject');
  });
});

describe('payloadView', () => {
  it('reads a draft as an email with its recipients, subject and body', () => {
    const view = payloadView('draft_email', {
      to: ['priya.nair@haldengroup.com'],
      cc: [],
      subject: 'Re: Q4 discovery scope',
      bodyText: 'Hi Priya,\n\nThanks for confirming.',
      replyToMessageId: 'AAMkAGI2TG93AAA=',
    });
    expect(view).toEqual({
      kind: 'email',
      to: ['priya.nair@haldengroup.com'],
      cc: [],
      subject: 'Re: Q4 discovery scope',
      body: 'Hi Priya,\n\nThanks for confirming.',
      replyToMessageId: 'AAMkAGI2TG93AAA=',
    });
  });

  it('reads a task from the nested input the executor sends to Notion', () => {
    const view = payloadView('create_task', {
      input: { title: 'Send revised SOW to Halden', due: '2026-09-25', assigneeIds: ['u1', 'u2'] },
    });
    expect(view).toEqual({
      kind: 'task',
      fields: [
        { name: 'Title', value: 'Send revised SOW to Halden' },
        { name: 'Due', value: '2026-09-25' },
        { name: 'Assignee ids', value: 'u1, u2' },
      ],
    });
  });

  it('reads a hold and defaults its time zone to London', () => {
    expect(
      payloadView('create_calendar_hold', {
        subject: 'Focus block: Halden proposal',
        start: '2026-09-23T08:00:00.000Z',
        end: '2026-09-23T10:00:00.000Z',
      }),
    ).toEqual({
      kind: 'hold',
      title: 'Focus block: Halden proposal',
      start: '2026-09-23T08:00:00.000Z',
      end: '2026-09-23T10:00:00.000Z',
      timeZone: 'Europe/London',
    });
  });

  it('reads a category change as a before and an after', () => {
    expect(payloadView('apply_category', { categories: ['Newsletters'] })).toEqual({
      kind: 'transition',
      beforeLabel: 'Before',
      before: 'No category',
      afterLabel: 'After',
      after: 'Newsletters',
      messages: 1,
    });
  });

  it('counts the messages a move names', () => {
    const view = payloadView('move_mail', {
      sourceFolderName: 'Inbox',
      destinationFolderName: 'AI-Filed',
      messageIds: ['a', 'b', 'c'],
    });
    expect(view).toEqual({
      kind: 'transition',
      beforeLabel: 'From folder',
      before: 'Inbox',
      afterLabel: 'To folder',
      after: 'AI-Filed',
      messages: 3,
    });
  });

  it('says a folder is not recorded rather than inventing one', () => {
    const view = payloadView('move_mail', {});
    expect(view).toMatchObject({ before: 'Not recorded', after: 'Not recorded' });
  });

  it('falls back to the payload string and number fields for any other class', () => {
    expect(
      payloadView('post_slack', { channel: 'dom-claude-agent', threadDepth: 2, ids: ['x'] }),
    ).toEqual({
      kind: 'fields',
      fields: [
        { name: 'Channel', value: 'dom-claude-agent' },
        { name: 'Thread depth', value: '2' },
      ],
    });
  });
});

describe('holdBar', () => {
  it('places a 09:00 to 11:00 London hold in the working day', () => {
    const bar = holdBar('2026-09-23T08:00:00.000Z', '2026-09-23T10:00:00.000Z');
    expect(bar).toEqual({ left: 9.1, width: 18.2 });
  });

  it('starts at the left edge for a hold that opens the day', () => {
    expect(holdBar('2026-09-23T07:00:00.000Z', '2026-09-23T08:00:00.000Z')).toEqual({
      left: 0,
      width: 9.1,
    });
  });

  it('clamps a hold that runs past the end of the day', () => {
    const bar = holdBar('2026-09-23T17:00:00.000Z', '2026-09-23T21:00:00.000Z');
    expect(bar).toEqual({ left: 90.9, width: 9.1 });
  });

  it('gives nothing for a hold outside the band or an unreadable instant', () => {
    expect(holdBar('2026-09-23T04:00:00.000Z', '2026-09-23T05:00:00.000Z')).toBeNull();
    expect(holdBar('not a time', '2026-09-23T10:00:00.000Z')).toBeNull();
  });
});

describe('summariseLedgerPayload', () => {
  it('humanises the keys of a decision event', () => {
    expect(
      summariseLedgerPayload({ action: 'approve', from: 'pending', to: 'approved', ignored: 3 }),
    ).toBe('Action: approve, From: pending, To: approved');
  });

  it('gives an empty line for a payload that is not an object', () => {
    expect(summariseLedgerPayload(null)).toBe('');
  });
});

describe('previewDetail', () => {
  it('says why a row is held before anything else', () => {
    expect(
      previewDetail({ status: 'held', actionClass: 'draft_email', payload: { bodyText: 'Hi' } }),
    ).toBe('Held: dry run is on');
  });

  it('takes the first line of a draft body', () => {
    expect(
      previewDetail({
        status: 'pending',
        actionClass: 'draft_email',
        payload: { bodyText: 'Hi Priya,\nThanks for confirming.' },
      }),
    ).toBe('Hi Priya,');
  });

  it('shows the hours a calendar hold would take', () => {
    expect(
      previewDetail({
        status: 'pending',
        actionClass: 'create_calendar_hold',
        payload: { start: '2026-09-23T08:00:00.000Z', end: '2026-09-23T10:00:00.000Z' },
      }),
    ).toBe('09:00 to 11:00');
  });

  it('gives nothing for a class with no second line', () => {
    expect(
      previewDetail({ status: 'pending', actionClass: 'apply_category', payload: {} }),
    ).toBeNull();
  });
});

describe('expiryCell', () => {
  const now = new Date('2026-09-21T13:00:00.000Z');

  it('counts down while a proposal is still open', () => {
    expect(
      expiryCell(
        {
          status: 'pending',
          expiresAt: '2026-09-21T16:00:00.000Z',
          decidedAt: null,
          policyDecision: 'propose',
        },
        now,
      ),
    ).toEqual({ lead: 'in 3 h', detail: formatInstant('2026-09-21T16:00:00.000Z') });
  });

  it('says when a decision landed', () => {
    expect(
      expiryCell(
        {
          status: 'rejected',
          expiresAt: '2026-09-21T16:00:00.000Z',
          decidedAt: '2026-09-21T11:48:00.000Z',
          policyDecision: 'propose',
        },
        now,
      ).lead,
    ).toBe('Decided 12:48');
  });

  it('names policy as the decider when an auto cell executed', () => {
    expect(
      expiryCell(
        {
          status: 'executed',
          expiresAt: '2026-09-21T16:00:00.000Z',
          decidedAt: '2026-09-21T05:30:00.000Z',
          policyDecision: 'auto',
        },
        now,
      ).lead,
    ).toBe('Auto 06:30');
  });

  it('says when a proposal expired', () => {
    expect(
      expiryCell(
        {
          status: 'expired',
          expiresAt: '2026-09-20T12:00:00.000Z',
          decidedAt: null,
          policyDecision: 'propose',
        },
        now,
      ).lead,
    ).toBe('Expired yesterday');
  });

  it('falls back to the status when no decision time was recorded', () => {
    expect(
      expiryCell(
        {
          status: 'executed',
          expiresAt: '2026-09-21T16:00:00.000Z',
          decidedAt: null,
          policyDecision: 'auto',
        },
        now,
      ).lead,
    ).toBe('Executed');
  });
});

describe('proposalFilterLabels', () => {
  it('names the active filters in plain words', () => {
    expect(
      proposalFilterLabels({
        status: 'pending',
        actionClass: 'draft_email',
        targetSystem: 'graph',
      }),
    ).toEqual(['Pending', 'Draft email', 'Microsoft 365']);
  });

  it('names nothing when the queue is unfiltered', () => {
    expect(proposalFilterLabels({})).toEqual([]);
  });
});

describe('queueSummary', () => {
  const now = new Date('2026-09-21T13:00:00.000Z');

  it('counts the queue and dates the oldest expiry', () => {
    expect(queueSummary(2, '2026-09-21T16:00:00.000Z', now)).toBe(
      '2 pending. The oldest expires in 3 h.',
    );
  });

  it('separates thousands in a long queue', () => {
    expect(queueSummary(1204, '2026-09-21T16:00:00.000Z', now)).toBe(
      '1,204 pending. The oldest expires in 3 h.',
    );
  });

  it('says nothing is pending for an empty queue', () => {
    expect(queueSummary(0, null, now)).toBe('Nothing pending.');
  });
});
