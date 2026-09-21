import { describe, expect, it } from 'vitest';
import {
  ageingLabel,
  commitmentDirectionFrom,
  commitmentSort,
  commitmentStatusFilterFrom,
  commitmentStatusSelected,
  isCommitmentOpenForAction,
  sortCommitments,
  type CommitmentView,
} from './commitment-view';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function view(overrides: Partial<CommitmentView> = {}): CommitmentView {
  return {
    id: 'commitment_1',
    direction: 'outbound',
    status: 'open',
    description: 'Send the revised proposal',
    evidenceQuote: "I'll send that over by Friday.",
    dueAt: null,
    dueConfidence: null,
    ageDays: 0,
    overdueDays: null,
    chaseCount: 0,
    nextChaseAt: null,
    owner: { id: 'person_1', name: 'Dom Selvon', email: 'dom@valliance.ai' },
    counterparty: { id: 'person_2', name: 'Sam Ellis', email: 'sam@example.com' },
    sourceRefs: [],
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('ageingLabel', () => {
  it('says "no date" when there is no due date and it is not overdue', () => {
    expect(ageingLabel(view(), NOW)).toBe('no date');
  });

  it('says how many days remain when the due date is in the future', () => {
    expect(ageingLabel(view({ dueAt: '2026-09-24T12:00:00.000Z' }), NOW)).toBe('due in 3 days');
  });

  it('says "due in 1 day" for a single day, not "1 days"', () => {
    expect(ageingLabel(view({ dueAt: '2026-09-22T12:00:00.000Z' }), NOW)).toBe('due in 1 day');
  });

  it('says "due today" when the due date has arrived', () => {
    expect(ageingLabel(view({ dueAt: '2026-09-21T18:00:00.000Z' }), NOW)).toBe('due today');
  });

  it('reports overdue days from the api rather than recomputing them', () => {
    expect(ageingLabel(view({ dueAt: '2026-09-19T12:00:00.000Z', overdueDays: 2 }), NOW)).toBe(
      'overdue by 2 days',
    );
  });

  it('says "overdue by 1 day" for a single day', () => {
    expect(ageingLabel(view({ overdueDays: 1 }), NOW)).toBe('overdue by 1 day');
  });

  it('shows a "done N days ago" label for a done commitment', () => {
    expect(ageingLabel(view({ status: 'done', updatedAt: '2026-09-09T12:00:00.000Z' }), NOW)).toBe(
      'done 12 days ago',
    );
  });

  it('shows "done today" and "done yesterday" without a day count', () => {
    expect(ageingLabel(view({ status: 'done', updatedAt: NOW.toISOString() }), NOW)).toBe(
      'done today',
    );
    expect(ageingLabel(view({ status: 'done', updatedAt: '2026-09-20T12:00:00.000Z' }), NOW)).toBe(
      'done yesterday',
    );
  });

  it('shows a "dropped N days ago" label for a dropped commitment', () => {
    expect(
      ageingLabel(view({ status: 'dropped', updatedAt: '2026-09-19T12:00:00.000Z' }), NOW),
    ).toBe('dropped 2 days ago');
  });
});

describe('commitmentSort / sortCommitments', () => {
  it('puts the most overdue commitment first', () => {
    const light = view({ id: 'light', overdueDays: 1 });
    const heavy = view({ id: 'heavy', overdueDays: 5 });
    expect(sortCommitments([light, heavy])).toEqual([heavy, light]);
  });

  it('sorts non-overdue commitments by soonest due date once overdue ones are placed', () => {
    const soon = view({ id: 'soon', dueAt: '2026-09-22T00:00:00.000Z' });
    const later = view({ id: 'later', dueAt: '2026-09-30T00:00:00.000Z' });
    expect(sortCommitments([later, soon])).toEqual([soon, later]);
  });

  it('sorts a commitment with no due date after every dated one', () => {
    const dated = view({ id: 'dated', dueAt: '2026-09-22T00:00:00.000Z' });
    const undated = view({ id: 'undated', dueAt: null });
    expect(sortCommitments([undated, dated])).toEqual([dated, undated]);
  });

  it('falls back to oldest first when overdue status and due date are equal', () => {
    const young = view({ id: 'young', dueAt: null, ageDays: 2 });
    const old = view({ id: 'old', dueAt: null, ageDays: 20 });
    expect(sortCommitments([young, old])).toEqual([old, young]);
  });

  it('leaves the source array untouched', () => {
    const source = [view({ id: 'a', overdueDays: 1 }), view({ id: 'b', overdueDays: 5 })];
    const copy = [...source];
    sortCommitments(source);
    expect(source).toEqual(copy);
  });

  it('is usable directly as an Array#sort comparator', () => {
    const light = view({ id: 'light', overdueDays: 1 });
    const heavy = view({ id: 'heavy', overdueDays: 5 });
    expect([light, heavy].sort(commitmentSort)).toEqual([heavy, light]);
  });
});

describe('isCommitmentOpenForAction', () => {
  it('allows mark done and drop on open and chased commitments', () => {
    expect(isCommitmentOpenForAction(view({ status: 'open' }))).toBe(true);
    expect(isCommitmentOpenForAction(view({ status: 'chased' }))).toBe(true);
  });

  it('refuses further action once a commitment is done or dropped', () => {
    expect(isCommitmentOpenForAction(view({ status: 'done' }))).toBe(false);
    expect(isCommitmentOpenForAction(view({ status: 'dropped' }))).toBe(false);
  });
});

describe('commitmentDirectionFrom', () => {
  it('defaults to outbound when no direction is given', () => {
    expect(commitmentDirectionFrom({})).toBe('outbound');
  });

  it('accepts an inbound direction from the query string', () => {
    expect(commitmentDirectionFrom({ direction: 'inbound' })).toBe('inbound');
  });

  it('falls back to outbound for a value the api would reject', () => {
    expect(commitmentDirectionFrom({ direction: 'sideways' })).toBe('outbound');
  });
});

describe('commitmentStatusSelected / commitmentStatusFilterFrom', () => {
  it('defaults the selected status to open', () => {
    expect(commitmentStatusSelected({})).toBe('open');
    expect(commitmentStatusFilterFrom({})).toBe('open');
  });

  it('treats "all" as no status filter', () => {
    expect(commitmentStatusSelected({ status: 'all' })).toBe('all');
    expect(commitmentStatusFilterFrom({ status: 'all' })).toBeUndefined();
  });

  it('keeps a recognised status', () => {
    expect(commitmentStatusSelected({ status: 'dropped' })).toBe('dropped');
    expect(commitmentStatusFilterFrom({ status: 'dropped' })).toBe('dropped');
  });

  it('falls back to open for an unrecognised status', () => {
    expect(commitmentStatusSelected({ status: 'archived' })).toBe('open');
    expect(commitmentStatusFilterFrom({ status: 'archived' })).toBe('open');
  });
});
