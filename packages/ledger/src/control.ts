import { SYSTEM_STATE_ID, proposals, systemState, type Db, type SystemState } from '@lance/db';
import { newUlid, nowIso, type SystemMode } from '@lance/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { LedgerReader } from './reader.js';
import { LedgerWriter } from './writer.js';

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

/** Proposal statuses that are waiting for the executor and can be held. */
const HOLDABLE_STATUSES = ['approved', 'edited'] as const;
type HoldableStatus = (typeof HOLDABLE_STATUSES)[number];

interface HeldProposal {
  id: string;
  /** Status to restore on resume, so an edited proposal stays edited. */
  from: HoldableStatus;
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
    const rows = await this.db
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
    const current = await this.read();
    const ts = nowIso();
    const correlationId = newUlid();

    const holdable = await this.db
      .select({ id: proposals.id, status: proposals.status })
      .from(proposals)
      .where(inArray(proposals.status, [...HOLDABLE_STATUSES]));
    const held: HeldProposal[] = holdable.map((row) => ({
      id: row.id,
      from: row.status as HoldableStatus,
    }));
    if (held.length > 0) {
      await this.db
        .update(proposals)
        .set({ status: 'held', updatedAt: new Date(ts) })
        .where(
          inArray(
            proposals.id,
            held.map((row) => row.id),
          ),
        );
    }
    const heldProposalIds = held.map((row) => row.id);

    if (!current.paused) {
      await this.db
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

    const event = await this.writer.append({
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
    });

    return { changed: !current.paused, heldProposalIds, eventId: event.id };
  }

  async resume(options: ActorOptions): Promise<ResumeResult> {
    const current = await this.read();
    const ts = nowIso();
    const outstanding = await this.heldSinceLastResume();
    const releasedProposalIds: string[] = [];
    for (const from of HOLDABLE_STATUSES) {
      const ids = outstanding.held.filter((row) => row.from === from).map((row) => row.id);
      if (ids.length === 0) continue;
      const released = await this.db
        .update(proposals)
        .set({ status: from, updatedAt: new Date(ts) })
        .where(and(eq(proposals.status, 'held'), inArray(proposals.id, ids)))
        .returning({ id: proposals.id });
      releasedProposalIds.push(...released.map((row) => row.id));
    }

    if (current.paused) {
      await this.db
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

    const event = await this.writer.append({
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
    });

    return { changed: current.paused, releasedProposalIds, eventId: event.id };
  }

  async setMode(
    mode: SystemMode,
    options: ActorOptions,
  ): Promise<{ changed: boolean; eventId: string }> {
    const current = await this.read();
    const ts = nowIso();
    if (current.mode !== mode) {
      await this.db
        .update(systemState)
        .set({ mode, updatedAt: new Date(ts) })
        .where(eq(systemState.id, SYSTEM_STATE_ID));
    }
    const event = await this.writer.append({
      ts,
      actor: options.actor,
      kind: 'state_changed',
      sourceSystem: 'lance',
      correlationId: newUlid(),
      payload: { change: 'mode', from: current.mode, to: mode },
    });
    return { changed: current.mode !== mode, eventId: event.id };
  }

  /**
   * Every proposal held by pause events since the most recent resume, with the
   * status each had before it was held. Newest pause first, so its correlation
   * id links the resume. A second pause while already paused adds to the set
   * rather than replacing it, which is what keeps a double pause from
   * stranding the first pause's proposals.
   */
  private async heldSinceLastResume(): Promise<{
    lastPause: { eventId: string; correlationId: string } | null;
    held: HeldProposal[];
  }> {
    const events = await this.reader.query({ kind: 'state_changed', limit: 200 });
    const held = new Map<string, HeldProposal>();
    let lastPause: { eventId: string; correlationId: string } | null = null;
    for (const event of events) {
      const payload = event.payload as Record<string, unknown> | null;
      const change = payload?.['change'];
      if (change === 'resume') break;
      if (change !== 'pause') continue;
      lastPause ??= { eventId: event.id, correlationId: event.correlationId };
      for (const row of readHeld(payload)) {
        if (!held.has(row.id)) held.set(row.id, row);
      }
    }
    return { lastPause, held: [...held.values()] };
  }
}
