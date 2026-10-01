'use client';

import { useState, useTransition, type DragEvent, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from 'cn';
import { Ageing } from '@/components/ageing';
import { InlineFailure } from '@/components/inline-failure';
import { ProvenanceLink } from '@/components/provenance';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ageingEmphasis } from '@/lib/ageing';
import {
  boardMessages,
  buildBoard,
  canChase,
  chaseButtonLabel,
  chaseLine,
  laneMeta,
  moveFor,
  NOT_CHASED_NOTE,
  NOT_CHASED_SHORT,
  UNDO_REASON,
  type BoardColumn,
  type BoardItem,
  type BoardMove,
  type BoardStageId,
} from '@/lib/commitment-board';
import {
  ageingLabel,
  commitmentHref,
  firstName,
  isCommitmentOverdue,
  type CommitmentDirection,
} from '@/lib/commitment-view';
import { formatDate } from '@/lib/time';
import {
  chaseCommitment,
  dropCommitment,
  markCommitmentDone,
  setCommitmentStatus,
} from './actions';

/**
 * The swimlane board (design 7.5). Both lanes side by side from `lg`; at
 * 360 the lane is a tab and its stages stack. Cards move only through the
 * recorded actions: Mark done, Chase and Drop, each a server action that
 * writes the ledger. On the desktop board a card can also be dragged to
 * another column of its lane, which runs the same action (`moveFor`); the
 * buttons stay, so the keyboard and the phone lose nothing. Every move but
 * a chase offers an Undo, itself a recorded status change back. A chase
 * cannot be undone here: it becomes a draft in Proposals, where the
 * principal approves or rejects it.
 */

const STAGE_DOT: Record<BoardStageId, string> = {
  open: 'bg-muted-foreground',
  chased: 'bg-brand',
  done: 'bg-sem-green-fg',
  dropped: 'bg-sem-red-fg',
};

type Action = 'done' | 'chase' | 'drop' | 'move';

interface LastMove {
  label: string;
  /** The status to put back on Undo; absent when the move cannot be undone. */
  undo?: { id: string; status: BoardItem['status']; description: string };
}

/** The board's compact controls: the design's 28px buttons with 12px text. */
const COMPACT = 'h-7 px-2.5 text-xs';

const form = (fields: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

function StageDot({ stage }: { stage: BoardStageId }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', STAGE_DOT[stage])} />;
}

interface CardHandlers {
  busy: Action | null;
  error: string | null;
  dropOpen: boolean;
  reason: string;
  reasonMissing: boolean;
  onDone: () => void;
  onChase: () => void;
  onDropOpen: () => void;
  onDropCancel: () => void;
  onReason: (value: string) => void;
  onDropSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function Sources({ item }: { item: BoardItem }) {
  if (item.sourceRefs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {item.sourceRefs.map((ref) => (
        <ProvenanceLink
          key={`${ref.system}:${ref.recordId}`}
          className="text-[11px]"
          seen={false}
          source={{
            system: ref.system,
            recordId: ref.recordId,
            ...(ref.url === undefined ? {} : { url: ref.url }),
          }}
        />
      ))}
    </div>
  );
}

function DropForm({
  item,
  handlers,
  size,
}: {
  item: BoardItem;
  handlers: CardHandlers;
  size: 'sm' | 'lg';
}) {
  const inputId = `drop-reason-${size}-${item.id}`;
  return (
    <form
      onSubmit={handlers.onDropSubmit}
      className="flex flex-col gap-2 rounded-lg bg-background p-3"
    >
      <label htmlFor={inputId} className="flex flex-col gap-1 text-xs text-muted-foreground">
        Reason for dropping, required
      </label>
      <Input
        id={inputId}
        value={handlers.reason}
        onChange={(event) => {
          handlers.onReason(event.target.value);
        }}
        autoFocus
        placeholder="Why this no longer needs chasing"
        aria-invalid={handlers.reasonMissing}
        className={cn(size === 'sm' && 'h-8 text-[13px]')}
      />
      {handlers.reasonMissing ? (
        <InlineFailure className="text-xs">
          Add a reason; it is recorded in the ledger.
        </InlineFailure>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="destructive"
          size={size}
          disabled={handlers.busy !== null}
          aria-busy={handlers.busy === 'drop'}
          className={cn(size === 'lg' ? 'flex-1' : COMPACT)}
        >
          {handlers.busy === 'drop' ? <Spinner /> : null}
          {handlers.busy === 'drop' ? 'Dropping' : 'Drop'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size={size}
          onClick={handlers.onDropCancel}
          className={cn(size === 'sm' && COMPACT)}
        >
          Cancel
        </Button>
      </div>
      <p className="m-0 text-[11px] text-muted-foreground">
        Nothing is sent to {firstName(item.counterparty.name)}.
      </p>
    </form>
  );
}

function CardActions({
  item,
  handlers,
  size,
}: {
  item: BoardItem;
  handlers: CardHandlers;
  size: 'sm' | 'lg';
}) {
  const busy = handlers.busy !== null;
  return (
    <div className={cn('flex gap-1.5', size === 'lg' && 'mt-1 gap-2')}>
      <Button
        type="button"
        size={size}
        onClick={handlers.onDone}
        disabled={busy}
        aria-busy={handlers.busy === 'done'}
        className={cn(size === 'lg' ? 'flex-1' : COMPACT)}
      >
        {handlers.busy === 'done' ? <Spinner /> : null}
        {handlers.busy === 'done' ? 'Marking' : 'Mark done'}
      </Button>
      {canChase(item) ? (
        <Button
          type="button"
          variant="outline"
          size={size}
          onClick={handlers.onChase}
          disabled={busy}
          aria-busy={handlers.busy === 'chase'}
          className={cn(size === 'sm' && COMPACT)}
        >
          {handlers.busy === 'chase' ? <Spinner /> : null}
          {handlers.busy === 'chase' ? 'Queuing' : chaseButtonLabel(item)}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size={size}
        onClick={handlers.onDropOpen}
        disabled={busy}
        aria-expanded={handlers.dropOpen}
        className={cn(size === 'sm' && 'h-7 px-2 text-xs')}
      >
        Drop
      </Button>
    </div>
  );
}

/** A running card: open or chased, with its actions. */
function LiveCard({
  item,
  handlers,
  drag,
  now,
  size,
}: {
  item: BoardItem;
  handlers: CardHandlers;
  drag: DragProps;
  now: Date;
  size: 'sm' | 'lg';
}) {
  const overdue = isCommitmentOverdue(item);
  const ageing = ageingLabel(item, now);
  const chased = item.pendingChaseProposalId === null ? chaseLine(item) : null;
  return (
    <article
      {...(size === 'sm' ? drag.cardProps(item) : {})}
      className={cn(
        'flex flex-col gap-2 rounded-[10px] bg-card p-3',
        size === 'sm' && 'cursor-grab active:cursor-grabbing',
        size === 'lg' && 'rounded-xl p-3.5',
        overdue && 'shadow-[inset_2px_0_0_var(--sem-red-fg)]',
        drag.dragging === item.id && 'opacity-50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <TextLink
          href={commitmentHref(item.id)}
          tone="foreground"
          className={cn('leading-snug font-medium text-pretty', size === 'sm' && 'text-[13px]')}
        >
          {item.description}
        </TextLink>
        {overdue ? (
          <Badge tone="red" size="sm" className="shrink-0">
            Overdue
          </Badge>
        ) : null}
      </div>
      <p className="m-0 line-clamp-2 text-xs text-muted-foreground">
        &ldquo;{item.evidenceQuote}&rdquo;
      </p>
      {size === 'sm' ? (
        <>
          <p className="m-0 text-xs">{item.counterparty.name}</p>
          <div className="flex justify-between gap-2 text-xs">
            <span>{item.dueAt === null ? 'No date' : formatDate(item.dueAt)}</span>
            {item.dueAt === null ? null : (
              <Ageing label={ageing} emphasis={ageingEmphasis(ageing)} />
            )}
          </div>
        </>
      ) : (
        <p className="m-0 text-xs text-muted-foreground">
          {item.counterparty.name} ·{' '}
          {item.dueAt === null ? (
            'no date'
          ) : (
            <>
              {formatDate(item.dueAt)}, <Ageing label={ageing} emphasis={ageingEmphasis(ageing)} />
            </>
          )}
        </p>
      )}
      {chased === null ? null : <p className="m-0 text-xs text-muted-foreground">{chased}</p>}
      {item.pendingChaseProposalId === null ? null : (
        <TextLink href={`/proposals/${item.pendingChaseProposalId}`} className="text-xs">
          Chase draft awaiting your approval
        </TextLink>
      )}
      {size === 'sm' ? <Sources item={item} /> : null}
      {handlers.error === null ? null : (
        <InlineFailure className="text-xs">{handlers.error}</InlineFailure>
      )}
      {handlers.dropOpen && !drag.dropInColumn ? (
        <DropForm item={item} handlers={handlers} size={size} />
      ) : (
        <CardActions item={item} handlers={handlers} size={size} />
      )}
    </article>
  );
}

/** A closed card: done or dropped, quiet, linking to its page where it can be reopened. */
function ClosedCard({
  item,
  handlers,
  drag,
  now,
  size,
}: {
  item: BoardItem;
  handlers: CardHandlers;
  drag: DragProps;
  now: Date;
  size: 'sm' | 'lg';
}) {
  return (
    <article
      {...(size === 'sm' ? drag.cardProps(item) : {})}
      aria-busy={handlers.busy !== null}
      className={cn(
        'flex flex-col gap-1 rounded-[10px] bg-card/70 px-3 py-2.5 text-muted-foreground',
        size === 'sm' && 'cursor-grab active:cursor-grabbing',
        size === 'lg' && 'rounded-xl px-3.5 py-3',
        (drag.dragging === item.id || handlers.busy !== null) && 'opacity-50',
      )}
    >
      <TextLink
        href={commitmentHref(item.id)}
        tone="muted"
        className="text-[13px] leading-snug text-pretty text-foreground/85"
      >
        {item.description}
      </TextLink>
      <p className="m-0 text-xs">
        {item.counterparty.name} · {ageingLabel(item, now)}
      </p>
      {handlers.error === null ? null : (
        <InlineFailure className="text-xs">{handlers.error}</InlineFailure>
      )}
    </article>
  );
}

/** What a card and a column need from the board's drag state. */
interface DragProps {
  /** The id of the card being dragged, if any. */
  dragging: string | null;
  /** Whether the open drop form belongs in the Dropped column, after a drag there. */
  dropInColumn: boolean;
  cardProps: (item: BoardItem) => {
    draggable: true;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
}

function ColumnCards({
  column,
  handlersFor,
  drag,
  now,
  size,
}: {
  column: BoardColumn;
  handlersFor: (item: BoardItem) => CardHandlers;
  drag: DragProps;
  now: Date;
  size: 'sm' | 'lg';
}) {
  if (column.cards.length === 0) {
    return size === 'sm' ? (
      <div className="rounded-[10px] border border-dashed border-border p-3 text-xs text-muted-foreground">
        Nothing here
      </div>
    ) : (
      <p className="m-0 pb-1 pl-4 text-xs text-muted-foreground">Nothing here</p>
    );
  }
  return (
    <>
      {column.cards.map((item) =>
        item.status === 'open' || item.status === 'chased' ? (
          <LiveCard
            key={item.id}
            item={item}
            handlers={handlersFor(item)}
            drag={drag}
            now={now}
            size={size}
          />
        ) : (
          <ClosedCard
            key={item.id}
            item={item}
            handlers={handlersFor(item)}
            drag={drag}
            now={now}
            size={size}
          />
        ),
      )}
    </>
  );
}

export function CommitmentBoard({
  items,
  now: nowIso,
  initialLane,
}: {
  items: readonly BoardItem[];
  /** The server's clock, so the cards age the same on the server and in the browser. */
  now: string;
  /** The lane the phone layout opens on, from `?direction=`. */
  initialLane: CommitmentDirection;
}) {
  const now = new Date(nowIso);
  const board = buildBoard(items);
  const [lane, setLane] = useState<CommitmentDirection>(initialLane);
  const [last, setLast] = useState<LastMove | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: Action } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dropFor, setDropFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [dragging, setDragging] = useState<BoardItem | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [dropInColumn, setDropInColumn] = useState(false);
  const [, startTransition] = useTransition();

  const run = (
    item: BoardItem,
    action: Action,
    call: () => Promise<string | null>,
    after: LastMove,
  ): void => {
    setBusy({ id: item.id, action });
    startTransition(async () => {
      const failure = await call();
      setBusy(null);
      setErrors((current) => {
        const next = { ...current };
        if (failure === null) delete next[item.id];
        else next[item.id] = failure;
        return next;
      });
      if (failure === null) {
        setLast(after);
        setDropFor(null);
        setDropInColumn(false);
        setReason('');
      }
    });
  };

  const handlersFor = (item: BoardItem): CardHandlers => ({
    busy: busy?.id === item.id ? busy.action : null,
    error: errors[item.id] ?? null,
    dropOpen: dropFor === item.id,
    reason,
    reasonMissing: dropFor === item.id && reasonMissing,
    onDone: () => {
      run(item, 'done', () => markCommitmentDone(null, form({ commitmentId: item.id })), {
        label: boardMessages.done(item),
        undo: { id: item.id, status: item.status, description: item.description },
      });
    },
    onChase: () => {
      run(item, 'chase', () => chaseCommitment(null, form({ commitmentId: item.id })), {
        label: boardMessages.chased(item),
      });
    },
    onDropOpen: () => {
      setDropFor(item.id);
      setDropInColumn(false);
      setReason('');
      setReasonMissing(false);
    },
    onDropCancel: () => {
      setDropFor(null);
      setDropInColumn(false);
      setReason('');
      setReasonMissing(false);
    },
    onReason: (value) => {
      setReason(value);
      setReasonMissing(false);
    },
    onDropSubmit: (event) => {
      event.preventDefault();
      const given = reason.trim();
      if (given === '') {
        setReasonMissing(true);
        return;
      }
      run(
        item,
        'drop',
        () => dropCommitment(null, form({ commitmentId: item.id, reason: given })),
        {
          label: boardMessages.dropped(item),
          undo: { id: item.id, status: item.status, description: item.description },
        },
      );
    },
  });

  /** Runs the recorded action a drop on a column stands for. */
  const apply = (item: BoardItem, move: BoardMove): void => {
    const handlers = handlersFor(item);
    switch (move.kind) {
      case 'done':
        handlers.onDone();
        return;
      case 'chase':
        handlers.onChase();
        return;
      case 'drop':
        setDropFor(item.id);
        setDropInColumn(true);
        setReason('');
        setReasonMissing(false);
        return;
      case 'status':
        run(
          item,
          'move',
          () => setCommitmentStatus(null, form({ commitmentId: item.id, status: move.to })),
          {
            label: boardMessages.moved(item, move.to),
            undo: { id: item.id, status: item.status, description: item.description },
          },
        );
    }
  };

  const drag: DragProps = {
    dragging: dragging?.id ?? null,
    dropInColumn,
    cardProps: (item) => ({
      draggable: true,
      onDragStart: (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.id);
        setDragging(item);
      },
      onDragEnd: () => {
        setDragging(null);
        setOver(null);
      },
    }),
  };

  /** The drag handlers and highlight for one lane's column on the desktop board. */
  const target = (laneId: CommitmentDirection, stage: BoardStageId) => {
    const key = `${laneId}:${stage}`;
    const move = dragging === null ? null : moveFor(dragging, laneId, stage);
    return {
      accepts: move !== null,
      over: over === key && move !== null,
      props: {
        onDragOver: (event: DragEvent<HTMLElement>) => {
          if (move === null) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (over !== key) setOver(key);
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => {
          const next = event.relatedTarget;
          if (next instanceof Node && event.currentTarget.contains(next)) return;
          if (over === key) setOver(null);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          event.preventDefault();
          const item = dragging;
          setDragging(null);
          setOver(null);
          if (item !== null && move !== null) apply(item, move);
        },
      },
    };
  };

  /** The card whose reason the Dropped column of this lane is asking for, after a drag. */
  const droppingIn = (laneId: CommitmentDirection): BoardItem | null => {
    if (!dropInColumn || dropFor === null) return null;
    const item = items.find((candidate) => candidate.id === dropFor);
    return item !== undefined && item.direction === laneId ? item : null;
  };

  const undo = (): void => {
    const move = last?.undo;
    if (move === undefined) return;
    setUndoing(true);
    startTransition(async () => {
      const failure = await setCommitmentStatus(
        null,
        form({ commitmentId: move.id, status: move.status, reason: UNDO_REASON }),
      );
      setUndoing(false);
      setLast(
        failure === null
          ? { label: boardMessages.undone(move) }
          : { label: `Undo failed: ${failure}`, undo: move },
      );
    });
  };

  const mobileLane = board.lanes.find((candidate) => candidate.id === lane) ?? board.lanes[0];

  return (
    <div className="flex flex-col gap-5">
      {last === null ? null : (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-[13px]"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
          <span className="flex-1">{last.label}</span>
          {last.undo === undefined ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={undo}
              disabled={undoing}
              aria-busy={undoing}
              className="h-7 px-2.5 text-xs"
            >
              {undoing ? <Spinner /> : null}
              Undo
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Dismiss"
            onClick={() => {
              setLast(null);
            }}
            className="size-7 text-muted-foreground"
          >
            <X aria-hidden />
          </Button>
        </div>
      )}

      <div className="hidden flex-col gap-5 lg:flex">
        <div className="grid grid-cols-4 gap-3">
          {board.lanes[0]?.columns.map((column) => (
            <div key={column.id} className="flex flex-col gap-0.5 border-b border-border px-1 pb-2">
              <div className="flex items-center gap-2 font-medium">
                <StageDot stage={column.id} />
                {column.label}
                <span className="text-xs font-normal text-muted-foreground">
                  {board.stageCounts[column.id]}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">{column.hint}</div>
            </div>
          ))}
        </div>

        {board.lanes.map((row) => (
          <section key={row.id} aria-label={row.label} className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-3 px-1">
              <h2 className="text-[15px] font-semibold">{row.label}</h2>
              <span className="text-xs text-muted-foreground">{laneMeta(row)}</span>
              <span className="ml-auto text-xs text-muted-foreground">{row.note}</span>
            </div>
            <div className="grid grid-cols-4 gap-3 rounded-xl bg-card/50 p-3">
              {row.columns.map((column) => {
                const zone = target(row.id, column.id);
                const pending = column.id === 'dropped' ? droppingIn(row.id) : null;
                return (
                  <div
                    key={column.id}
                    aria-label={`${row.label}, ${column.label}`}
                    {...zone.props}
                    className={cn(
                      'flex min-h-24 min-w-0 flex-col gap-2 rounded-[10px] transition-colors',
                      zone.accepts && 'outline-1 outline-offset-4 outline-border outline-dashed',
                      zone.over && 'bg-brand-soft outline-brand',
                    )}
                  >
                    {column.disabled ? (
                      <div className="flex flex-1 items-center rounded-[10px] border border-dashed border-border p-3 text-xs text-pretty text-muted-foreground">
                        {NOT_CHASED_NOTE}
                      </div>
                    ) : (
                      <>
                        {pending === null ? null : (
                          <article className="flex flex-col gap-2 rounded-[10px] bg-card p-3">
                            <p className="m-0 text-[13px] leading-snug font-medium text-pretty">
                              {pending.description}
                            </p>
                            <DropForm item={pending} handlers={handlersFor(pending)} size="sm" />
                          </article>
                        )}
                        <ColumnCards
                          column={column}
                          handlersFor={handlersFor}
                          drag={drag}
                          now={now}
                          size="sm"
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {mobileLane === undefined ? null : (
        <div className="flex flex-col gap-4 lg:hidden">
          <div
            role="tablist"
            aria-label="Direction"
            className="grid grid-cols-2 border-b border-border"
          >
            {board.lanes.map((row) => (
              <button
                key={row.id}
                type="button"
                role="tab"
                aria-selected={row.id === mobileLane.id}
                onClick={() => {
                  setLane(row.id);
                }}
                className={cn(
                  'h-11 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/45',
                  row.id === mobileLane.id
                    ? 'text-foreground shadow-[inset_0_-2px_0_var(--brand)]'
                    : 'text-muted-foreground',
                )}
              >
                {row.label} · {row.live}
              </button>
            ))}
          </div>
          {mobileLane.columns.map((column) => (
            <section key={column.id} aria-label={column.label} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <StageDot stage={column.id} />
                {column.label}
                {column.disabled ? null : (
                  <span className="font-normal text-muted-foreground">{column.cards.length}</span>
                )}
              </div>
              {column.disabled ? (
                <p className="m-0 pb-1 pl-4 text-xs text-muted-foreground">{NOT_CHASED_SHORT}</p>
              ) : (
                <ColumnCards
                  column={column}
                  handlersFor={handlersFor}
                  drag={drag}
                  now={now}
                  size="lg"
                />
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
