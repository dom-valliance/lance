import { describe, expect, it } from 'vitest';
import {
  boardMessages,
  buildBoard,
  canChase,
  chaseButtonLabel,
  chaseLine,
  laneMeta,
  moveFor,
  type BoardItem,
} from './commitment-board';

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'c1',
    direction: 'inbound',
    status: 'open',
    description: 'Send the intro deck',
    evidenceQuote: 'I will get the intro deck over to you by Friday.',
    dueAt: '2026-09-25T16:00:00.000Z',
    dueConfidence: 0.7,
    ageDays: 3,
    overdueDays: null,
    chaseCount: 0,
    nextChaseAt: null,
    owner: { id: 'p1', name: 'Marcus Reid', email: 'marcus@ostrava.test' },
    counterparty: { id: 'p1', name: 'Marcus Reid', email: 'marcus@ostrava.test' },
    sourceRefs: [],
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z',
    pendingChaseProposalId: null,
    ...overrides,
  };
}

describe('buildBoard', () => {
  const board = buildBoard([
    item({ id: 'late', overdueDays: 3, dueAt: '2026-09-18T16:00:00.000Z' }),
    item({ id: 'soon' }),
    item({ id: 'chased', status: 'chased', chaseCount: 1 }),
    item({ id: 'done', status: 'done' }),
    item({ id: 'mine', direction: 'outbound' }),
  ]);
  const [owed, owe] = board.lanes;

  it('puts Owed to me first and I owe second', () => {
    expect(board.lanes.map((lane) => lane.label)).toEqual(['Owed to me', 'I owe']);
  });

  it('sorts each column overdue first', () => {
    expect(owed?.columns[0]?.cards.map((card) => card.id)).toEqual(['late', 'soon']);
  });

  it('counts live and overdue commitments per lane and in total', () => {
    expect(owed).toMatchObject({ live: 3, overdue: 1 });
    expect(owe).toMatchObject({ live: 1, overdue: 0 });
    expect(board.totals).toEqual({ owed: 3, owe: 1, overdue: 1 });
  });

  it('counts each stage across both lanes', () => {
    expect(board.stageCounts).toEqual({ open: 3, chased: 1, done: 1, dropped: 0 });
  });

  it('turns off the Chased column for what the principal owes', () => {
    expect(owe?.columns.find((column) => column.id === 'chased')?.disabled).toBe(true);
    expect(owed?.columns.find((column) => column.id === 'chased')?.disabled).toBe(false);
  });

  it('leaves a triage commitment off the board', () => {
    const withTriage = buildBoard([item({ status: 'unconfirmed' })]);
    expect(withTriage.lanes[0]?.columns.flatMap((column) => column.cards)).toEqual([]);
  });
});

describe('the card lines', () => {
  it('says how the lane stands', () => {
    expect(laneMeta({ live: 3, overdue: 0 })).toBe('3 open');
    expect(laneMeta({ live: 3, overdue: 1 })).toBe('3 open, 1 overdue');
  });

  it('says how often a commitment was chased and when next', () => {
    expect(chaseLine({ chaseCount: 0, nextChaseAt: null })).toBeNull();
    expect(chaseLine({ chaseCount: 2, nextChaseAt: '2026-09-29T08:00:00.000Z' })).toBe(
      'Chased twice · next 29 Sept 2026, 09:00',
    );
  });

  it('offers Chase again once chased', () => {
    expect(chaseButtonLabel({ chaseCount: 0 })).toBe('Chase');
    expect(chaseButtonLabel({ chaseCount: 1 })).toBe('Chase again');
  });

  it('offers Chase only on a running commitment owed to the principal with no draft waiting', () => {
    expect(canChase(item())).toBe(true);
    expect(canChase(item({ direction: 'outbound' }))).toBe(false);
    expect(canChase(item({ status: 'done' }))).toBe(false);
    expect(canChase(item({ pendingChaseProposalId: 'p1' }))).toBe(false);
  });

  it('tells the principal nothing was sent when they drop', () => {
    expect(boardMessages.dropped(item())).toBe(
      'Dropped "Send the intro deck". Nothing was sent to Marcus.',
    );
  });
});

describe('moveFor', () => {
  it('marks done or asks to drop from any other column of the same lane', () => {
    expect(moveFor(item(), 'inbound', 'done')).toEqual({ kind: 'done' });
    expect(moveFor(item({ status: 'done' }), 'inbound', 'dropped')).toEqual({ kind: 'drop' });
  });

  it('reopens a closed or chased card dropped on Open', () => {
    expect(moveFor(item({ status: 'dropped' }), 'inbound', 'open')).toEqual({
      kind: 'status',
      to: 'open',
    });
    expect(moveFor(item({ status: 'chased', chaseCount: 1 }), 'inbound', 'open')).toEqual({
      kind: 'status',
      to: 'open',
    });
  });

  it('queues a chase for an open card dropped on Chased', () => {
    expect(moveFor(item(), 'inbound', 'chased')).toEqual({ kind: 'chase' });
  });

  it('refuses Chased for an open card whose draft is already waiting', () => {
    expect(moveFor(item({ pendingChaseProposalId: 'p1' }), 'inbound', 'chased')).toBeNull();
  });

  it('reopens as chased only a closed card that was chased before', () => {
    expect(moveFor(item({ status: 'done', chaseCount: 2 }), 'inbound', 'chased')).toEqual({
      kind: 'status',
      to: 'chased',
    });
    expect(moveFor(item({ status: 'done', chaseCount: 0 }), 'inbound', 'chased')).toBeNull();
  });

  it('never moves a card to the other lane, its own column or I owe Chased', () => {
    expect(moveFor(item(), 'outbound', 'done')).toBeNull();
    expect(moveFor(item(), 'inbound', 'open')).toBeNull();
    expect(moveFor(item({ direction: 'outbound' }), 'outbound', 'chased')).toBeNull();
  });
});
