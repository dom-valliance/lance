import { cursors, type Db } from '@lance/db';
import { LedgerWriter, type SystemControl } from '@lance/ledger';
import { hashRecord, idempotencyKey, nowIso, stableUlid } from '@lance/shared';
import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { raiseAlert } from '../alerts/raise.js';
import type { PauseGate } from '../scheduler/gate.js';
import { QUEUES } from '../scheduler/queues.js';
import type { Observation, PartitionRunSummary, Watcher, WatcherRunSummary } from './types.js';

export const WATCHER_ACTOR_PREFIX = 'agent:watcher-';
const STARTED_AT_KEY = '__started_at';
/** Spec 7.1: three consecutive failures on a partition trip its breaker. */
const PARTITION_FAILURE_THRESHOLD = 3;

export interface TriageJob {
  watcher: string;
  correlationId: string;
  observationEventIds: string[];
}

export interface WatcherRunnerDeps {
  db: Db;
  gate: PauseGate;
  control: Pick<SystemControl, 'read'>;
  /** Enqueues triage for a correlation id. The default sends to pg-boss with a singleton window so a burst on one thread triages once. */
  enqueueTriage: (job: TriageJob) => Promise<void>;
  now?: () => string;
}

export function pgBossTriageEnqueuer(boss: PgBoss): (job: TriageJob) => Promise<void> {
  return async (job) => {
    await boss.send(QUEUES.triage, job, { singletonKey: job.correlationId, singletonSeconds: 60 });
  };
}

async function readCursor(db: Db, watcher: string, key: string): Promise<string | null> {
  const rows = await db
    .select({ value: cursors.value })
    .from(cursors)
    .where(and(eq(cursors.watcher, watcher), eq(cursors.key, key)))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function writeCursor(
  db: Db,
  watcher: string,
  key: string,
  value: string,
  ts: string,
): Promise<void> {
  await db
    .insert(cursors)
    .values({ watcher, key, value, updatedAt: new Date(ts) })
    .onConflictDoUpdate({
      target: [cursors.watcher, cursors.key],
      set: { value, updatedAt: new Date(ts) },
    });
}

/** Cursors double as the watcher's memory of when it first ran (dry-run gating, spec 6.3). */
export async function watcherStartedAt(db: Db, watcher: string): Promise<string | null> {
  return readCursor(db, watcher, STARTED_AT_KEY);
}

/**
 * Per-partition breaker state lives in memory: a restart resets it, which
 * is the "next successful health probe" the spec allows. The alert it raised
 * stays in the alerts table until acknowledged.
 */
const partitionFailures = new Map<string, { count: number; open: boolean }>();

export function resetPartitionBreaker(watcher: string, partition: string): void {
  partitionFailures.delete(`${watcher}:${partition}`);
}

function actorFor(watcher: Watcher): string {
  return `${WATCHER_ACTOR_PREFIX}${watcher.name}@0.1.0`;
}

async function recordObservation(
  ledger: LedgerWriter,
  watcher: Watcher,
  observation: Observation,
): Promise<{ eventId: string; inserted: boolean; correlationId: string }> {
  const hash = hashRecord(observation.record);
  const correlationId = stableUlid(`${observation.sourceSystem}:${observation.correlationKey}`);
  const result = await ledger.append({
    ts: observation.observedAt,
    actor: actorFor(watcher),
    kind: 'observed',
    sourceSystem: observation.sourceSystem,
    sourceRecordId: observation.recordId,
    sourceRecordHash: hash,
    idempotencyKey: idempotencyKey(observation.sourceSystem, observation.recordId, hash),
    correlationId,
    payload: {
      ...observation.record,
      ...(observation.summary === undefined ? {} : { summary: observation.summary }),
      ...(observation.labels === undefined ? {} : { labels: observation.labels }),
      ...(observation.url === undefined ? {} : { url: observation.url }),
      watcher: watcher.name,
    },
  });
  return { eventId: result.id, inserted: result.inserted, correlationId };
}

async function runPartition(
  deps: WatcherRunnerDeps,
  watcher: Watcher,
  partition: string,
): Promise<PartitionRunSummary> {
  const key = `${watcher.name}:${partition}`;
  const state = partitionFailures.get(key) ?? { count: 0, open: false };
  if (state.open) {
    return { partition, status: 'skipped_breaker', polled: 0, inserted: 0, duplicates: 0 };
  }
  const ledger = new LedgerWriter(deps.db);
  const now = deps.now ?? nowIso;
  try {
    const cursor = await readCursor(deps.db, watcher.name, partition);
    const polled = await watcher.poll(partition, cursor);
    const byCorrelation = new Map<string, string[]>();
    let inserted = 0;
    let duplicates = 0;
    for (const record of polled.records) {
      const observation = await watcher.normalise(record, partition);
      const outcome = await recordObservation(ledger, watcher, observation);
      if (outcome.inserted) {
        inserted += 1;
        const ids = byCorrelation.get(outcome.correlationId) ?? [];
        ids.push(outcome.eventId);
        byCorrelation.set(outcome.correlationId, ids);
      } else {
        duplicates += 1;
      }
    }
    for (const [correlationId, observationEventIds] of byCorrelation) {
      await deps.enqueueTriage({ watcher: watcher.name, correlationId, observationEventIds });
    }
    if (polled.nextCursor !== null) {
      await writeCursor(deps.db, watcher.name, partition, polled.nextCursor, now());
    }
    partitionFailures.delete(key);
    return { partition, status: 'ok', polled: polled.records.length, inserted, duplicates };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const next = { count: state.count + 1, open: false };
    if (next.count >= PARTITION_FAILURE_THRESHOLD) {
      next.open = true;
      await raiseAlert(deps.db, {
        kind: 'watcher_failed',
        severity: 'P1',
        dedupeKey: `watcher:${watcher.name}:${partition}`,
        title: `Watcher ${watcher.name} stopped on partition ${partition}`,
        body: `Three consecutive polls failed. Last error: ${message}. The partition stays stopped until the worker restarts or the breaker is reset from the Agents page.`,
        actor: actorFor(watcher),
      });
    }
    partitionFailures.set(key, next);
    return { partition, status: 'failed', polled: 0, inserted: 0, duplicates: 0, error: message };
  }
}

/**
 * One scheduled run of a watcher (spec 7.1): checks the kill switch, walks
 * every partition with its cursor, writes an observed event per new record
 * (idempotent on system:record_id:content_hash), enqueues triage per
 * correlation id, and advances the cursor only after the partition's records
 * are all recorded. Re-running over the same window inserts nothing.
 */
export async function runWatcher(
  deps: WatcherRunnerDeps,
  watcher: Watcher,
): Promise<WatcherRunSummary> {
  const verdict = await deps.gate.check();
  if (!verdict.runnable) {
    return { watcher: watcher.name, status: 'paused', partitions: [] };
  }
  const now = deps.now ?? nowIso;
  if ((await watcherStartedAt(deps.db, watcher.name)) === null) {
    await writeCursor(deps.db, watcher.name, STARTED_AT_KEY, now(), now());
  }
  const partitions = await watcher.partitions();
  const summaries: PartitionRunSummary[] = [];
  for (const partition of partitions) {
    summaries.push(await runPartition(deps, watcher, partition));
  }
  return { watcher: watcher.name, status: 'ran', partitions: summaries };
}

export function watcherQueue(watcher: Pick<Watcher, 'name'>): string {
  return `watcher:${watcher.name}`;
}

/** Registers the watcher's queue, schedules and handler with pg-boss. */
export async function registerWatcher(
  boss: PgBoss,
  deps: WatcherRunnerDeps,
  watcher: Watcher,
  timeZone: string,
): Promise<void> {
  const queue = watcherQueue(watcher);
  await boss.createQueue(queue);
  for (const [index, cron] of watcher.schedules.entries()) {
    await boss.schedule(
      queue,
      cron,
      { schedule: index },
      { tz: timeZone, key: `${queue}:${index}` },
    );
  }
  await boss.work(queue, async () => {
    await runWatcher(deps, watcher);
  });
}
