import type { Commitment } from '@lance/db';
import { describe, expect, it } from 'vitest';
import {
  sourceRefsOf,
  toCommitmentView,
  toPersonView,
  UNKNOWN_PERSON_NAME,
  wholeDaysBetween,
} from './view.js';

const NOW = new Date('2026-09-21T09:00:00.000Z');

const row = (overrides: Partial<Commitment> = {}): Commitment => ({
  id: '01K5S9V6QW3SWCCPVB0N0E302A',
  direction: 'inbound',
  ownerPersonId: 'per-ann',
  counterpartyPersonId: 'per-dom',
  description: 'Send the signed order form',
  dueAt: new Date('2026-09-18T17:00:00.000Z'),
  dueConfidence: 0.8,
  evidenceQuote: 'I will get the order form over to you by Friday',
  sourceRefs: [
    { system: 'graph', recordId: 'AAMk2', hash: 'h2', observedAt: '2026-09-14T09:00:00.000Z' },
  ],
  status: 'open',
  chaseCount: 1,
  nextChaseAt: new Date('2026-09-20T17:00:00.000Z'),
  createdAt: new Date('2026-09-14T09:00:00.000Z'),
  updatedAt: new Date('2026-09-20T17:00:00.000Z'),
  ...overrides,
});

const people = {
  owner: { id: 'per-ann', name: 'Ann Example', email: 'ann@client.test' },
  counterparty: { id: 'per-dom', name: 'Dom Selvon', email: 'dom@valliance.ai' },
};

describe('wholeDaysBetween', () => {
  it('floors a part day rather than rounding it up', () => {
    expect(
      wholeDaysBetween(new Date('2026-09-20T23:00:00.000Z'), new Date('2026-09-21T09:00:00.000Z')),
    ).toBe(0);
  });

  it('counts nothing for an instant that has not arrived', () => {
    expect(
      wholeDaysBetween(new Date('2026-09-25T09:00:00.000Z'), new Date('2026-09-21T09:00:00.000Z')),
    ).toBe(0);
  });
});

describe('toPersonView', () => {
  it('takes the display name and the first email off the person node', () => {
    expect(
      toPersonView('per-ann', {
        properties: { display_name: 'Ann Example', emails: ['ann@client.test', 'ann@old.test'] },
      }),
    ).toEqual({ id: 'per-ann', name: 'Ann Example', email: 'ann@client.test' });
  });

  it('names a person the graph does not hold rather than dropping the row', () => {
    expect(toPersonView('per-ghost', null)).toEqual({
      id: 'per-ghost',
      name: UNKNOWN_PERSON_NAME,
      email: null,
    });
  });

  it('reads no email from a node whose emails property is not a list', () => {
    expect(
      toPersonView('per-ann', { properties: { display_name: 'Ann Example', emails: 'ann' } }).email,
    ).toBeNull();
  });
});

describe('sourceRefsOf', () => {
  it('keeps the refs that parse and drops the ones that do not', () => {
    expect(
      sourceRefsOf([
        { system: 'graph', recordId: 'AAMk2', hash: 'h2', observedAt: '2026-09-14T09:00:00.000Z' },
        { system: 'nowhere', recordId: 'x' },
      ]),
    ).toHaveLength(1);
  });

  it('reads an empty list from a column that holds no array', () => {
    expect(sourceRefsOf(null)).toEqual([]);
  });
});

describe('toCommitmentView', () => {
  it('renders dates as ISO strings and counts the age in whole days', () => {
    const view = toCommitmentView(row(), people, NOW);

    expect(view).toMatchObject({
      id: '01K5S9V6QW3SWCCPVB0N0E302A',
      direction: 'inbound',
      status: 'open',
      dueAt: '2026-09-18T17:00:00.000Z',
      ageDays: 7,
      chaseCount: 1,
      nextChaseAt: '2026-09-20T17:00:00.000Z',
      owner: people.owner,
      counterparty: people.counterparty,
    });
    expect(view.sourceRefs[0]?.recordId).toBe('AAMk2');
  });

  it('counts the days a live commitment is past its due date', () => {
    expect(toCommitmentView(row({ status: 'chased' }), people, NOW).overdueDays).toBe(2);
  });

  it('counts no overdue days once the commitment is done', () => {
    expect(toCommitmentView(row({ status: 'done' }), people, NOW).overdueDays).toBeNull();
  });

  it('counts no overdue days while the due date is still ahead', () => {
    expect(
      toCommitmentView(row({ dueAt: new Date('2026-09-30T17:00:00.000Z') }), people, NOW)
        .overdueDays,
    ).toBeNull();
  });

  it('counts no overdue days for a commitment with no due date', () => {
    expect(toCommitmentView(row({ dueAt: null }), people, NOW).overdueDays).toBeNull();
  });
});
