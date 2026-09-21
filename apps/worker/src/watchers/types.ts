import type { SourceSystem } from '@lance/shared';

/** One record as the source returned it, before normalisation. */
export interface SourceRecord {
  /** The source's own id for the record (message id, event id, page id). */
  id: string;
  /** When the source says the record was last changed; ISO string. */
  observedAt: string;
  raw: unknown;
  /** Set when the source reports a deletion; the runner records a removal observation. */
  removed?: boolean;
}

/** What the ledger stores for one record. */
export interface Observation {
  sourceSystem: SourceSystem;
  recordId: string;
  observedAt: string;
  /** Canonical content; its hash is the idempotency key's third part. */
  record: Record<string, unknown>;
  /** Groups records into one correlation id, for example a mail conversation id. */
  correlationKey: string;
  summary?: string;
  labels?: string[];
  url?: string;
}

export interface PollResult {
  records: SourceRecord[];
  nextCursor: string | null;
}

/** Spec 7.1. Watchers are deterministic; normalise may make one Haiku label call where the spec says so. */
export interface Watcher {
  name: string;
  sourceSystem: SourceSystem;
  /** Cron expressions; more than one lets weekday daytime and off-hours differ. */
  schedules: string[];
  partitions(): Promise<string[]>;
  poll(partition: string, cursor: string | null): Promise<PollResult>;
  normalise(record: SourceRecord, partition: string): Promise<Observation>;
}

export interface PartitionRunSummary {
  partition: string;
  status: 'ok' | 'skipped_breaker' | 'failed';
  polled: number;
  inserted: number;
  duplicates: number;
  error?: string;
}

export interface WatcherRunSummary {
  watcher: string;
  status: 'ran' | 'paused';
  partitions: PartitionRunSummary[];
}
