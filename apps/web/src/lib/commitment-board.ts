/**
 * The Commitments board (design 7.5, the swimlane board): lanes are the
 * direction, columns the workflow stage. The api chooses the rows; this
 * groups, counts and words them, so the client component only renders.
 * Cards move only through recorded actions, never by dragging, so every
 * move lands in the ledger.
 */

import {
  chasePhrase,
  firstName,
  isCommitmentOverdue,
  sortCommitments,
  type CommitmentDirection,
  type CommitmentView,
} from '@/lib/commitment-view';
import { formatInstant } from '@/lib/proposal-view';

export interface BoardItem extends CommitmentView {
  /** The chase draft waiting in Proposals for this commitment, if there is one. */
  pendingChaseProposalId: string | null;
}

export const BOARD_STAGE_IDS = ['open', 'chased', 'done', 'dropped'] as const;
export type BoardStageId = (typeof BOARD_STAGE_IDS)[number];

export interface BoardStage {
  id: BoardStageId;
  label: string;
  hint: string;
}

export const BOARD_STAGES: readonly BoardStage[] = [
  { id: 'open', label: 'Open', hint: 'Found, not yet chased' },
  { id: 'chased', label: 'Chased', hint: 'Nudged, or a chase is awaiting approval' },
  { id: 'done', label: 'Done', hint: 'Fulfilled' },
  { id: 'dropped', label: 'Dropped', hint: 'Closed with a reason' },
];

export interface BoardLane {
  id: CommitmentDirection;
  label: string;
  note: string;
}

export const BOARD_LANES: readonly BoardLane[] = [
  { id: 'inbound', label: 'Owed to me', note: 'Lance drafts chases for your approval' },
  {
    id: 'outbound',
    label: 'I owe',
    note: 'Lance never chases you; an overdue one raises an alert',
  },
];

/** Why the I owe lane has no Chased column, in the board's words and the phone's. */
export const NOT_CHASED_NOTE =
  'Not used for promises you made. Lance never chases you; an overdue one raises an alert instead.';
export const NOT_CHASED_SHORT = 'Not used. An overdue one raises an alert instead.';

export interface BoardColumn extends BoardStage {
  cards: BoardItem[];
  /** The I owe lane has no Chased column: Lance never chases the principal. */
  disabled: boolean;
}

export interface BoardLaneView extends BoardLane {
  columns: BoardColumn[];
  /** Open and chased, the commitments still running. */
  live: number;
  overdue: number;
}

export interface BoardView {
  lanes: BoardLaneView[];
  /** Cards per stage across both lanes, for the column heads. */
  stageCounts: Record<BoardStageId, number>;
  /** Live commitments owed to the principal, live ones they owe, and overdue across both. */
  totals: { owed: number; owe: number; overdue: number };
}

const isLive = (item: Pick<CommitmentView, 'status'>): boolean =>
  item.status === 'open' || item.status === 'chased';

const isBoardStage = (status: CommitmentView['status']): status is BoardStageId =>
  (BOARD_STAGE_IDS as readonly string[]).includes(status);

/** Groups the board's rows into lanes and columns, each column overdue first, then soonest due. */
export function buildBoard(items: readonly BoardItem[]): BoardView {
  const stageCounts: Record<BoardStageId, number> = { open: 0, chased: 0, done: 0, dropped: 0 };
  for (const item of items) {
    if (isBoardStage(item.status)) stageCounts[item.status] += 1;
  }
  const lanes = BOARD_LANES.map((lane): BoardLaneView => {
    const inLane = items.filter((item) => item.direction === lane.id);
    const live = inLane.filter(isLive);
    return {
      ...lane,
      live: live.length,
      overdue: live.filter(isCommitmentOverdue).length,
      columns: BOARD_STAGES.map((stage) => ({
        ...stage,
        disabled: lane.id === 'outbound' && stage.id === 'chased',
        cards: sortCommitments(inLane.filter((item) => item.status === stage.id)),
      })),
    };
  });
  const [owed, owe] = lanes;
  return {
    lanes,
    stageCounts,
    totals: {
      owed: owed?.live ?? 0,
      owe: owe?.live ?? 0,
      overdue: (owed?.overdue ?? 0) + (owe?.overdue ?? 0),
    },
  };
}

/** "3 open, 1 overdue", or "3 open" with nothing late. */
export function laneMeta(lane: Pick<BoardLaneView, 'live' | 'overdue'>): string {
  return lane.overdue === 0
    ? `${String(lane.live)} open`
    : `${String(lane.live)} open, ${String(lane.overdue)} overdue`;
}

/** The chase line under a chased card: "Chased once · next 22 Sept 2026, 09:00". */
export function chaseLine(item: Pick<BoardItem, 'chaseCount' | 'nextChaseAt'>): string | null {
  const phrase = chasePhrase(item.chaseCount);
  if (phrase === null) return null;
  const said = `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
  return item.nextChaseAt === null ? said : `${said} · next ${formatInstant(item.nextChaseAt)}`;
}

/** Chase, or Chase again for one already chased. */
export function chaseButtonLabel(item: Pick<BoardItem, 'chaseCount'>): string {
  return item.chaseCount > 0 ? 'Chase again' : 'Chase';
}

/** Whether the card offers Chase: owed to the principal, still running, no draft waiting. */
export function canChase(
  item: Pick<BoardItem, 'direction' | 'status' | 'pendingChaseProposalId'>,
): boolean {
  return item.direction === 'inbound' && isLive(item) && item.pendingChaseProposalId === null;
}

/** What the status line says after each action. */
export const boardMessages = {
  done: (item: Pick<BoardItem, 'description'>): string =>
    `Moved "${item.description}" to Done. Recorded in the ledger.`,
  dropped: (item: Pick<BoardItem, 'description' | 'counterparty'>): string =>
    `Dropped "${item.description}". Nothing was sent to ${firstName(item.counterparty.name)}.`,
  chased: (item: Pick<BoardItem, 'counterparty'>): string =>
    `Chase queued for ${firstName(item.counterparty.name)}. The draft arrives in Proposals for your approval.`,
  undone: (item: Pick<BoardItem, 'description'>): string =>
    `Put "${item.description}" back where it was. Recorded in the ledger.`,
};

/** The reason an Undo carries into the ledger. */
export const UNDO_REASON = 'Undone from the Commitments board.';
