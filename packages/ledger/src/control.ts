import { SYSTEM_STATE_ID, proposals, systemState, type Db, type SystemState } from '@lance/db';
import { newUlid, nowIso, type SystemMode } from '@lance/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { LedgerReader } from './reader.js';
import { LedgerWriter, type DbExecutor } from './writer.js';

export interface ActorOptions {
  /** Ledger actor, for example user:dom or system:cost-guard. */
  actor: string;
}

export interface PauseOptions extends ActorOptions {
  reason: string;
}

export interface PauseResult {
  changed: boolean;
  heldProposalIds: string[];
  eventId: string;
}

export interface ResumeResult {
  changed: boolean;
  releasedProposalIds: string[];
  eventId: string;
}

/**
 * How often Lance may interrupt Dom: the quiet-hours window in `HH:MM`
 * 24-hour local time, and the ceiling on pushes in any one hour (spec 9.1).
 */
export interface InterruptionBudget {
  quietHoursStart: string;
  quietHoursEnd: string;
  pushBudgetPerHour: number;
}

/** Proposal statuses that are waiting for the executor and can be held. */
const HOLDABLE_STATUSES = ['approved', 'edited'] as const;
export type HoldableStatus = (typeof HOLDABLE_STATUSES)[number];
const PAGE = 200;

export interface HeldProposal {
  id: string;
  /** Status to restore on resume, so an edited proposal stays edited. */
  from: HoldableStatus;
}

/** Moves every approved or edited proposal to held and returns what was moved. */
async function holdProposals(executor: DbExecutor, ts: string): Promise<HeldProposal[]> {
  const holdable = await executor
    .select({ id: proposals.id, status: proposals.status })
    .from(proposals)
    .where(inArray(proposals.status, [...HOLDABLE_STATUSES]));
  const held: HeldProposal[] = holdable.map((row) => ({
    id: row.id,
    from: row.status as HoldableStatus,
  }));
  if (held.length > 0) {
    await executor
      .update(proposals)
      .set({ status: 'held', updatedAt: new Date(ts) })
      .where(
        inArray(
          proposals.id,
          held.map((row) => row.id),
        ),
      );
  }
  return held;
}

function readHeld(payload: Record<string, unknown> | null): HeldProposal[] {
  const raw = payload?.['held'];
  if (!Array.isArray(raw)) return [];
  const out: HeldProposal[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, from } = item as { id?: unknown; from?: unknown };
    if (typeof id === 'string' && (from === 'approved' || from === 'edited'))
      out.push({ id, from });
  }
  return out;
}

/**
 * The kill switch and mode switch (spec 4.3). Both api and worker use this
 * class so there is one implementation. Every change is a state_changed
 * ledger event; a resume reuses the pause's correlation id so the pair reads
 * as one trail.
 */
export class SystemControl {
  private readonly writer: LedgerWriter;
  private readonly reader: LedgerReader;

  constructor(private readonly db: Db) {
    this.writer = new LedgerWriter(db);
    this.reader = new LedgerReader(db);
  }

  async read(): Promise<SystemState> {
    return this.readWith(this.db);
  }

  private async readWith(executor: DbExecutor): Promise<SystemState> {
    const rows = await executor
      .select()
      .from(systemState)
      .where(eq(systemState.id, SYSTEM_STATE_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        'system_state has no row with id 1; run `pnpm --filter @lance/db seed` to create it.',
      );
    }
    return row;
  }

  async isPaused(): Promise<boolean> {
    return (await this.read()).paused;
  }

  async pause(options: PauseOptions): Promise<PauseResult> {
    return this.db.transaction(async (tx) => {
      const current = await this.readWith(tx);
      const ts = nowIso();
      const correlationId = newUlid();

      const held = await holdProposals(tx, ts);
      const heldProposalIds = held.map((row) => row.id);

      if (!current.paused) {
        await tx
          .update(systemState)
          .set({
            paused: true,
            pausedReason: options.reason,
            pausedBy: options.actor,
            pausedAt: new Date(ts),
            updatedAt: new Date(ts),
          })
          .where(eq(systemState.id, SYSTEM_STATE_ID));
      }

      const event = await this.writer.append(
        {
          ts,
          actor: options.actor,
          kind: 'state_changed',
          sourceSystem: 'lance',
          correlationId,
          payload: {
            change: 'pause',
            paused: true,
            alreadyPaused: current.paused,
            reason: options.reason,
            heldProposalIds,
            held,
          },
        },
        tx,
      );

      return { changed: !current.paused, heldProposalIds, eventId: event.id };
    });
  }

  /**
   * Records that the executor held a proposal because the system was paused
   * when its job ran, so resume can release it (spec 4.3). The executor calls
   * this after moving the proposal to held.
   */
  async recordHold(
    held: HeldProposal[],
    options: ActorOptions & { reason: string },
  ): Promise<{ eventId: string }> {
    const event = await this.writer.append({
      ts: nowIso(),
      actor: options.actor,
      kind: 'state_changed',
      sourceSystem: 'lance',
      correlationId: newUlid(),
      payload: { change: 'hold', reason: options.reason, held },
    });
    return { eventId: event.id };
  }

  async resume(options: ActorOptions): Promise<ResumeResult> {
    return this.db.transaction(async (tx) => {
      const current = await this.readWith(tx);
      const ts = nowIso();
      const outstanding = await this.heldSinceLastResume(tx);
      const releasedProposalIds: string[] = [];
      for (const from of HOLDABLE_STATUSES) {
        const ids = outstanding.held.filter((row) => row.from === from).map((row) => row.id);
        if (ids.length === 0) continue;
        const released = await tx
          .update(proposals)
          .set({ status: from, updatedAt: new Date(ts) })
          .where(and(eq(proposals.status, 'held'), inArray(proposals.id, ids)))
          .returning({ id: proposals.id });
        releasedProposalIds.push(...released.map((row) => row.id));
      }

      if (current.paused) {
        await tx
          .update(systemState)
          .set({
            paused: false,
            pausedReason: null,
            pausedBy: null,
            pausedAt: null,
            updatedAt: new Date(ts),
          })
          .where(eq(systemState.id, SYSTEM_STATE_ID));
      }

      const event = await this.writer.append(
        {
          ts,
          actor: options.actor,
          kind: 'state_changed',
          sourceSystem: 'lance',
          correlationId: outstanding.lastPause?.correlationId ?? newUlid(),
          parentEventId: outstanding.lastPause?.eventId ?? null,
          payload: {
            change: 'resume',
            paused: false,
            wasPaused: current.paused,
            releasedProposalIds,
          },
        },
        tx,
      );

      return { changed: current.paused, releasedProposalIds, eventId: event.id };
    });
  }

  async setMode(
    mode: SystemMode,
    options: ActorOptions,
  ): Promise<{ changed: boolean; eventId: string }> {
    return this.db.transaction(async (tx) => {
      const current = await this.readWith(tx);
      const ts = nowIso();
      if (current.mode !== mode) {
        await tx
          .update(systemState)
          .set({ mode, updatedAt: new Date(ts) })
          .where(eq(systemState.id, SYSTEM_STATE_ID));
      }
      const event = await this.writer.append(
        {
          ts,
          actor: options.actor,
          kind: 'state_changed',
          sourceSystem: 'lance',
          correlationId: newUlid(),
          payload: { change: 'mode', from: current.mode, to: mode },
        },
        tx,
      );
      return { changed: current.mode !== mode, eventId: event.id };
    });
  }

  /**
   * Sets the quiet hours and the push budget that shape how often Lance
   * interrupts Dom (spec 9.1). Like every other change to `system_state`,
   * it goes through here so the ledger carries it.
   */
  async setInterruptionBudget(
    budget: InterruptionBudget,
    options: ActorOptions,
  ): Promise<{ changed: boolean; eventId: string }> {
    return this.db.transaction(async (tx) => {
      const current = await this.readWith(tx);
      const ts = nowIso();
      const changed =
        current.quietHoursStart !== budget.quietHoursStart ||
        current.quietHoursEnd !== budget.quietHoursEnd ||
        current.pushBudgetPerHour !== budget.pushBudgetPerHour;
      if (changed) {
        await tx
          .update(systemState)
          .set({
            quietHoursStart: budget.quietHoursStart,
            quietHoursEnd: budget.quietHoursEnd,
            pushBudgetPerHour: budget.pushBudgetPerHour,
            updatedAt: new Date(ts),
          })
          .where(eq(systemState.id, SYSTEM_STATE_ID));
      }
      const event = await this.writer.append(
        {
          ts,
          actor: options.actor,
          kind: 'state_changed',
          sourceSystem: 'lance',
          correlationId: newUlid(),
          payload: {
            change: 'interruption_budget',
            quietHoursStart: budget.quietHoursStart,
            quietHoursEnd: budget.quietHoursEnd,
            pushBudgetPerHour: budget.pushBudgetPerHour,
          },
        },
        tx,
      );
      return { changed, eventId: event.id };
    });
  }

  /**
   * Every proposal held since the most recent resume, by a pause or by the
   * executor finding the system paused, with the status each had before.
   * Walks state_changed events newest first in pages until a resume is seen,
   * so mode changes cannot push a pause out of view. Newest pause first, so
   * its correlation id links the resume. A second pause while already paused
   * adds to the set rather than replacing it.
   */
  private async heldSinceLastResume(executor: DbExecutor): Promise<{
    lastPause: { eventId: string; correlationId: string } | null;
    held: HeldProposal[];
  }> {
    const reader = new LedgerReader(executor);
    const held = new Map<string, HeldProposal>();
    let lastPause: { eventId: string; correlationId: string } | null = null;
    let before: string | undefined;
    for (;;) {
      const page = await reader.query({
        kind: 'state_changed',
        limit: PAGE,
        ...(before ? { to: before } : {}),
      });
      const events =
        before === undefined ? page : page.filter((event) => event.ts.toISOString() < before!);
      for (const event of events) {
        const payload = event.payload as Record<string, unknown> | null;
        const change = payload?.['change'];
        if (change === 'resume') return { lastPause, held: [...held.values()] };
        if (change !== 'pause' && change !== 'hold') continue;
        if (change === 'pause')
          lastPause ??= { eventId: event.id, correlationId: event.correlationId };
        for (const row of readHeld(payload)) {
          if (!held.has(row.id)) held.set(row.id, row);
        }
      }
      if (page.length < PAGE) return { lastPause, held: [...held.values()] };
      const oldest = page[page.length - 1];
      if (oldest === undefined) return { lastPause, held: [...held.values()] };
      before = oldest.ts.toISOString();
    }
  }
}
