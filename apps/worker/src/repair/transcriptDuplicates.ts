import { commitments, ledgerEvents, type Db } from '@lance/db';
import { LedgerReader, LedgerWriter } from '@lance/ledger';
import { newUlid, nowIso } from '@lance/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { transcriptOf, transcriptReading } from '../triage/transcripts.js';

/**
 * Finds and drops the commitments recorded a second time from a meeting
 * transcript already read, before triage read each transcript once
 * (triage/transcripts.ts). The rule is the one triage now applies: a run
 * whose transcript a completed earlier run on the same correlation id had
 * already read should have recorded nothing, so everything it recorded
 * from that meeting is a rewording of the earlier run's list.
 *
 * Only `open` rows are dropped, each through the same status change and
 * `commitment_status` ledger event the Commitments page writes. The page
 * cannot reopen a dropped row, so `restoreTranscriptDuplicates` reopens
 * every row this repair dropped, found by its ledger actor. A `chased` row
 * has had a chase sent in its name and is reported, never changed.
 */

export const REPAIR_ACTOR = 'system:repair-transcript-duplicates';

export interface TranscriptDuplicate {
  commitmentId: string;
  description: string;
  status: string;
  /** The Jamie meeting the transcript belongs to. */
  recordId: string;
  /** The triage run that recorded the duplicate. */
  triageEventId: string;
}

function payloadOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The commitments a principal's triage runs recorded from a transcript an earlier run had read. */
export async function findTranscriptDuplicates(db: Db): Promise<TranscriptDuplicate[]> {
  const correlations = await db
    .selectDistinct({ correlationId: ledgerEvents.correlationId })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.kind, 'resolved'),
        sql`${ledgerEvents.payload}->>'kind' = 'triage'`,
        sql`jsonb_array_length(coalesce(${ledgerEvents.payload}->'recordedCommitmentIds', '[]'::jsonb)) > 0`,
      ),
    );

  const reader = new LedgerReader(db);
  const found: Array<Omit<TranscriptDuplicate, 'description' | 'status'>> = [];
  for (const { correlationId } of correlations) {
    if (correlationId === null) continue;
    const trail = await reader.byCorrelation(correlationId);
    const byId = new Map(trail.map((event) => [event.id, event]));
    for (const [index, event] of trail.entries()) {
      const payload = payloadOf(event.payload);
      if (event.kind !== 'resolved' || payload['kind'] !== 'triage') continue;
      const recorded = strings(payload['recordedCommitmentIds']);
      if (recorded.length === 0) continue;
      // The meeting transcript this run read: its most recently recorded
      // transcript-bearing observation, as triage picks it.
      const read = strings(payload['observationEventIds'])
        .flatMap((id) => {
          const observed = byId.get(id);
          return observed !== undefined && transcriptOf(observed) !== null ? [observed] : [];
        })
        .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
        .at(-1);
      if (read === undefined || read.sourceRecordId === null) continue;
      const transcript = transcriptOf(read);
      if (transcript === null) continue;
      const earlier = trail.slice(0, index);
      if (transcriptReading(earlier, read.sourceRecordId, transcript) !== 'repeat') continue;
      for (const commitmentId of recorded) {
        found.push({ commitmentId, recordId: read.sourceRecordId, triageEventId: event.id });
      }
    }
  }
  if (found.length === 0) return [];

  const rows = await db
    .select({
      id: commitments.id,
      description: commitments.description,
      status: commitments.status,
      sourceRefs: commitments.sourceRefs,
    })
    .from(commitments)
    .where(
      inArray(
        commitments.id,
        found.map((item) => item.commitmentId),
      ),
    );
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return found.flatMap((item) => {
    const row = rowsById.get(item.commitmentId);
    // A run can record commitments from mail on the same correlation id;
    // only the ones quoted from this meeting are its rewordings.
    const fromMeeting =
      Array.isArray(row?.sourceRefs) &&
      row.sourceRefs.some((ref) => payloadOf(ref)['recordId'] === item.recordId);
    if (row === undefined || !fromMeeting) return [];
    return [{ ...item, description: row.description, status: row.status }];
  });
}

export interface DropResult {
  dropped: string[];
  /** Duplicates left alone because they are no longer open, with their status. */
  left: Array<{ commitmentId: string; status: string }>;
}

/** Drops each open duplicate the way the Commitments page does, one ledger event per row. */
export async function dropTranscriptDuplicates(
  db: Db,
  duplicates: readonly TranscriptDuplicate[],
  now: () => string = nowIso,
): Promise<DropResult> {
  const writer = new LedgerWriter(db);
  const result: DropResult = { dropped: [], left: [] };
  for (const duplicate of duplicates) {
    const ts = now();
    const updated = await db
      .update(commitments)
      .set({ status: 'dropped', updatedAt: new Date(ts) })
      .where(and(eq(commitments.id, duplicate.commitmentId), eq(commitments.status, 'open')))
      .returning({ id: commitments.id });
    if (updated.length === 0) {
      result.left.push({ commitmentId: duplicate.commitmentId, status: duplicate.status });
      continue;
    }
    await writer.append({
      ts,
      actor: REPAIR_ACTOR,
      kind: 'resolved',
      sourceSystem: 'lance',
      sourceRecordId: duplicate.commitmentId,
      correlationId: newUlid(),
      payload: {
        kind: 'commitment_status',
        commitmentId: duplicate.commitmentId,
        from: 'open',
        to: 'dropped',
        reason: `Recorded again when the already-read transcript of Jamie meeting ${duplicate.recordId} was triaged a second time (triage event ${duplicate.triageEventId}).`,
      },
    });
    result.dropped.push(duplicate.commitmentId);
  }
  return result;
}

/**
 * Reopens every commitment this repair dropped whose last status change is
 * still that drop, one ledger event per row. A row Dom has resolved since
 * a restore is left as he left it.
 */
export async function restoreTranscriptDuplicates(
  db: Db,
  now: () => string = nowIso,
): Promise<string[]> {
  const events = await db
    .select({ payload: ledgerEvents.payload })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.actor, REPAIR_ACTOR),
        sql`${ledgerEvents.payload}->>'kind' = 'commitment_status'`,
        sql`${ledgerEvents.payload}->>'to' = 'dropped'`,
      ),
    );
  const ids = [
    ...new Set(
      events.flatMap((event) => {
        const id = payloadOf(event.payload)['commitmentId'];
        return typeof id === 'string' ? [id] : [];
      }),
    ),
  ];
  const writer = new LedgerWriter(db);
  const restored: string[] = [];
  for (const id of ids) {
    const last = await db
      .select({ actor: ledgerEvents.actor, payload: ledgerEvents.payload })
      .from(ledgerEvents)
      .where(
        and(
          eq(ledgerEvents.sourceRecordId, id),
          sql`${ledgerEvents.payload}->>'kind' = 'commitment_status'`,
        ),
      )
      .orderBy(desc(ledgerEvents.id))
      .limit(1);
    if (last[0]?.actor !== REPAIR_ACTOR || payloadOf(last[0].payload)['to'] !== 'dropped') continue;
    const ts = now();
    const updated = await db
      .update(commitments)
      .set({ status: 'open', updatedAt: new Date(ts) })
      .where(and(eq(commitments.id, id), eq(commitments.status, 'dropped')))
      .returning({ id: commitments.id });
    if (updated.length === 0) continue;
    await writer.append({
      ts,
      actor: REPAIR_ACTOR,
      kind: 'resolved',
      sourceSystem: 'lance',
      sourceRecordId: id,
      correlationId: newUlid(),
      payload: {
        kind: 'commitment_status',
        commitmentId: id,
        from: 'dropped',
        to: 'open',
        reason: 'Restored: the transcript duplicate repair was undone.',
      },
    });
    restored.push(id);
  }
  return restored;
}
