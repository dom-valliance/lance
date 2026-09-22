import { observations, type Db } from '@lance/db';
import type { ProvenanceRef } from '@lance/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { DetectedAlert, Detector } from '../../alerts/detectors/types.js';
import { INBOX_AGENT } from './slack.js';
import {
  TELEMETRY_SOURCE_SYSTEM,
  telemetryRecordSchema,
  type TelemetryRecord,
} from './telemetry.js';

/**
 * The two alert kinds the `agent-logs` watcher owns (spec 11):
 * `stale_watermark`, when the inbox agent has stopped saying how far it has
 * read, and `agent_step_skipped`, when an agent passed over a step.
 *
 * Detection is the alerts engine's job, so what lives here is the pair of
 * pure functions that decide, plus the detector that feeds them from the
 * `observations` table. Neither raises anything: the engine records what a
 * detector returns, dedupes on the key and decides when Slack sees it.
 */

/** Spec 11: the dedupe key for `stale_watermark` is the agent. */
export const STALE_WATERMARK_DEDUPE_KEY = `agent:${INBOX_AGENT}`;

/** Spec 7.1 puts the watcher on five minutes; its alerts are quarter-hourly. */
export const AGENT_LOGS_DETECTOR_SCHEDULE = '*/15 * * * *';

/** How far back the detector reads telemetry observations when the caller names no window. */
export const DEFAULT_TELEMETRY_LOOKBACK_HOURS = 24;

/** Rows per detector run. The alert says how many times, not which ones. */
export const MAX_TELEMETRY_ROWS = 500;

const HOUR_MS = 60 * 60 * 1000;

/** Hours to one decimal place, with the trailing zero dropped, for a readable alert line. */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * The inbox agent's watermark, judged against the clock.
 *
 * A null watermark returns nothing. Lance cannot tell an inbox agent that
 * has fallen over from one that has never posted since Lance started
 * watching, and an alert on every fresh deployment would be noise. Once one
 * watermark has been seen, its age is the measure.
 */
export function staleWatermark(
  latestWatermarkAt: string | null,
  now: string,
  maxAgeHours: number,
): DetectedAlert | null {
  if (latestWatermarkAt === null) return null;
  const watermarkMs = Date.parse(latestWatermarkAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(watermarkMs) || Number.isNaN(nowMs)) return null;
  const ageHours = (nowMs - watermarkMs) / HOUR_MS;
  if (ageHours <= maxAgeHours) return null;
  const age = formatHours(ageHours);
  return {
    kind: 'stale_watermark',
    severity: 'P1',
    dedupeKey: STALE_WATERMARK_DEDUPE_KEY,
    title: `The inbox agent's watermark is ${age} hours old`,
    body:
      `The last watermark the inbox agent posted in the channel reads ${latestWatermarkAt}, ${age} hours ago, ` +
      `past the ${formatHours(maxAgeHours)} hour threshold. Mail may be arriving that nothing has triaged. ` +
      'Check the inbox agent is still running and still posting its digest.',
  };
}

/**
 * One alert for each agent and step pair that was skipped. A failed span
 * carries no step, so it never reaches here; `watcher_failed` and
 * `breaker_open` cover failures.
 */
export function skippedSteps(records: readonly TelemetryRecord[]): DetectedAlert[] {
  const groups = new Map<string, { agent: string; step: string; count: number; latest: string }>();
  for (const record of records) {
    if (record.step === null || record.step === '' || record.success) continue;
    const key = `agent:${record.agent}:${record.step}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { agent: record.agent, step: record.step, count: 1, latest: record.ts });
    } else {
      group.count += 1;
      if (Date.parse(record.ts) > Date.parse(group.latest)) group.latest = record.ts;
    }
  }

  return [...groups].map(([dedupeKey, group]) => ({
    kind: 'agent_step_skipped',
    severity: 'P1',
    dedupeKey,
    title: `${group.agent} skipped the ${group.step} step`,
    body:
      `${group.agent} recorded ${String(group.count)} skipped ${group.step} ${group.count === 1 ? 'step' : 'steps'} ` +
      `in the window, the last at ${group.latest}. Whatever that step produces is missing for those runs. ` +
      'Check the agent run in the ledger for the reason it was passed over.',
  }));
}

/** One observation row as the detector reads it, with the provenance every alert carries. */
export interface ObservedRow {
  id: string;
  sourceSystem: string;
  sourceRecordId: string;
  sourceRecordHash: string;
  ts: Date;
  payload: unknown;
}

function provenanceOf(row: ObservedRow, system: 'slack' | 'lance'): ProvenanceRef {
  const url = (row.payload as { url?: unknown } | null)?.url;
  return {
    system,
    recordId: row.sourceRecordId,
    hash: row.sourceRecordHash,
    observedAt: row.ts.toISOString(),
    ...(typeof url === 'string' ? { url } : {}),
  };
}

/** The instant the newest watermark line carried, or null when the payload has none. */
export function watermarkAtOf(payload: unknown): string | null {
  const value = (payload as { watermarkAt?: unknown } | null)?.watermarkAt;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Keeps the rows whose payload is a telemetry agent log, with each row's provenance beside it. */
export function telemetryFromRows(
  rows: readonly ObservedRow[],
): { record: TelemetryRecord; provenance: ProvenanceRef }[] {
  const kept: { record: TelemetryRecord; provenance: ProvenanceRef }[] = [];
  for (const row of rows) {
    const parsed = telemetryRecordSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    kept.push({ record: parsed.data, provenance: provenanceOf(row, 'lance') });
  }
  return kept;
}

const OBSERVED_COLUMNS = {
  id: observations.id,
  sourceSystem: observations.sourceSystem,
  sourceRecordId: observations.sourceRecordId,
  sourceRecordHash: observations.sourceRecordHash,
  ts: observations.ts,
  payload: observations.payload,
};

/** The newest watermark line the Slack stream recorded, labelled `Watermark` by the watcher. */
export async function readLatestWatermark(db: Db): Promise<ObservedRow | null> {
  const rows = await db
    .select(OBSERVED_COLUMNS)
    .from(observations)
    .where(
      and(
        eq(observations.sourceSystem, 'slack'),
        sql`${observations.labels} @> ARRAY['Watermark']::text[]`,
      ),
    )
    .orderBy(desc(observations.ts))
    .limit(1);
  return rows[0] ?? null;
}

/** The telemetry observations Lance recorded about itself since the given instant. */
export async function readRecentTelemetry(db: Db, since: string): Promise<ObservedRow[]> {
  return db
    .select(OBSERVED_COLUMNS)
    .from(observations)
    .where(
      and(
        eq(observations.sourceSystem, TELEMETRY_SOURCE_SYSTEM),
        gte(observations.ts, new Date(since)),
      ),
    )
    .orderBy(desc(observations.ts))
    .limit(MAX_TELEMETRY_ROWS);
}

export interface AgentLogsDetectorOptions {
  /** The pool to read. Defaults to the one the engine passes on the context. */
  db?: Db;
  /** How old the inbox agent's watermark may be before it is an alert. */
  maxWatermarkAgeHours: number;
  telemetryLookbackHours?: number;
}

/**
 * The detector behind the two alert kinds. It reads what the watcher has
 * already recorded, so it never touches Slack or Application Insights
 * itself, and it returns alerts rather than raising them.
 */
export function createAgentLogsDetector(options: AgentLogsDetectorOptions): Detector {
  const lookbackHours = options.telemetryLookbackHours ?? DEFAULT_TELEMETRY_LOOKBACK_HOURS;

  return {
    name: 'agent-logs',
    schedule: AGENT_LOGS_DETECTOR_SCHEDULE,

    async run(context): Promise<DetectedAlert[]> {
      const db = options.db ?? context.db;
      const now = context.now();
      const detected: DetectedAlert[] = [];

      const watermark = await readLatestWatermark(db);
      const stale = staleWatermark(
        watermark === null ? null : watermarkAtOf(watermark.payload),
        now,
        options.maxWatermarkAgeHours,
      );
      if (stale !== null && watermark !== null) {
        detected.push({ ...stale, provenance: [provenanceOf(watermark, 'slack')] });
      }

      const since = new Date(Date.parse(now) - lookbackHours * HOUR_MS).toISOString();
      const telemetry = telemetryFromRows(await readRecentTelemetry(db, since));
      const byKey = new Map<string, ProvenanceRef[]>();
      for (const { record, provenance } of telemetry) {
        const key = `agent:${record.agent}:${record.step ?? ''}`;
        byKey.set(key, [...(byKey.get(key) ?? []), provenance]);
      }
      for (const alert of skippedSteps(telemetry.map((entry) => entry.record))) {
        const provenance = byKey.get(alert.dedupeKey) ?? [];
        detected.push(provenance.length === 0 ? alert : { ...alert, provenance });
      }

      return detected;
    },
  };
}
