import type { AppInsightsClient, AppInsightsRow } from '@lance/connectors';
import { ULID_PATTERN } from '@lance/db';
import { ATTR_PRINCIPAL } from '@lance/telemetry';
import { z } from 'zod';
import type { Observation, PollResult, SourceRecord } from '../types.js';

/**
 * The `telemetry` partition of the `agent-logs` watcher (spec 7.1): Lance's
 * own OTel spans, read back out of Application Insights so that a failure
 * inside Lance is an observation like any other.
 *
 * Two things are looked for: a span that ended unsuccessfully, and a trace
 * carrying a `step_skipped` custom dimension, which is how an agent records
 * that it passed over a step it was meant to run. Query results are never
 * logged: they go to the ledger through the runner and nowhere else.
 */

export const TELEMETRY_PARTITION = 'telemetry';

/** Source system for Lance's own telemetry (spec 7.1). */
export const TELEMETRY_SOURCE_SYSTEM = 'lance';

/** The custom dimension an agent sets when it passes over a step. */
export const STEP_SKIPPED_DIMENSION = 'step_skipped';

/** First run, cursor null: one hour back, so a restart does not replay a day of spans. */
export const TELEMETRY_FIRST_RUN_MINUTES = 60;

/** Later runs reach back a minute behind the cursor, for spans that landed late in the index. */
export const TELEMETRY_OVERLAP_MINUTES = 1;

/** However far behind the cursor is, one poll never asks for more than a day. */
export const TELEMETRY_MAX_WINDOW_HOURS = 24;

/** Rows per poll. Beyond this the picture is not a few skipped steps, it is an outage. */
export const TELEMETRY_MAX_ROWS = 500;

/**
 * The KQL both streams share, for one principal: only spans and traces
 * carrying their `lance.principal` (set by the job wrapper through
 * `withPrincipal`), so the organisation's telemetry never reaches another
 * principal's ledger. A failed span projects no step: only the
 * skipped-step branch fills `step`, which is what lets `skippedSteps` in
 * `detect.ts` tell the two apart inside one record shape.
 */
export function telemetryQuery(principalId: string): string {
  if (!new RegExp(ULID_PATTERN).test(principalId)) {
    throw new Error(
      `agent-logs telemetry: "${principalId}" is not a principal id, so it cannot filter the query. The watcher is built with the principal's own id in apps/worker/src/jobs/context.ts.`,
    );
  }
  const own = `| where tostring(Properties['${ATTR_PRINCIPAL}']) == '${principalId}'`;
  return `let failedSpans = AppDependencies
| where Success == false
${own}
| project ts = TimeGenerated, operationId = OperationId, agent = tostring(Properties['lance.agent']), step = '', success = false, message = strcat(Name, ' failed');
let skippedSteps = AppTraces
| where isnotempty(tostring(Properties['${STEP_SKIPPED_DIMENSION}']))
${own}
| project ts = TimeGenerated, operationId = OperationId, agent = tostring(Properties['lance.agent']), step = tostring(Properties['${STEP_SKIPPED_DIMENSION}']), success = false, message = Message;
union failedSpans, skippedSteps
| order by ts asc
| take ${String(TELEMETRY_MAX_ROWS)}`;
}

/** The canonical record for one telemetry row. */
export const telemetryRecordSchema = z.looseObject({
  kind: z.literal('agent_log'),
  stream: z.literal('telemetry'),
  agent: z.string(),
  step: z.string().nullable(),
  success: z.boolean(),
  message: z.string(),
  ts: z.string(),
});
export type TelemetryRecord = z.infer<typeof telemetryRecordSchema>;

/** What `poll` hands `normalise`: the row plus the operation id it correlates on. */
export interface TelemetryRawRow {
  operationId: string;
  record: TelemetryRecord;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Where the poll window opens: behind the cursor, or an hour back on the first run, never more than a day. */
export function telemetryWindowStart(cursor: string | null, now: string): string {
  const nowMs = Date.parse(now);
  const floor = nowMs - TELEMETRY_MAX_WINDOW_HOURS * HOUR_MS;
  if (cursor !== null) {
    const cursorMs = Date.parse(cursor);
    if (!Number.isNaN(cursorMs)) {
      const start = Math.min(cursorMs, nowMs) - TELEMETRY_OVERLAP_MINUTES * MINUTE_MS;
      return new Date(Math.max(start, floor)).toISOString();
    }
  }
  return new Date(nowMs - TELEMETRY_FIRST_RUN_MINUTES * MINUTE_MS).toISOString();
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Turns one query row into the canonical record, or null when the row names no operation. */
export function telemetryRowToRaw(row: AppInsightsRow): TelemetryRawRow | null {
  const operationId = text(row['operationId']);
  const ts = text(row['ts']);
  if (operationId === '' || ts === '') return null;
  const step = text(row['step']);
  const parsedTs = Date.parse(ts);
  return {
    operationId,
    record: {
      kind: 'agent_log',
      stream: 'telemetry',
      agent: text(row['agent']) === '' ? 'lance' : text(row['agent']),
      step: step === '' ? null : step,
      success: row['success'] === true,
      message: text(row['message']),
      ts: Number.isNaN(parsedTs) ? ts : new Date(parsedTs).toISOString(),
    },
  };
}

/**
 * One poll of the telemetry window.
 *
 * With no client the partition returns nothing at all. `LOG_ANALYTICS_WORKSPACE_ID`
 * is absent in local development and in any environment without Application
 * Insights, and an unconfigured stream is not a failure: the runner knows
 * `ok`, `failed` and `skipped_breaker` only, so a status such as
 * `skipped_unconfigured` would have to be invented for it. An empty poll
 * leaves the summary honest, the cursor untouched and the breaker closed.
 */
export async function pollTelemetry(
  client: AppInsightsClient | null,
  principalId: string,
  cursor: string | null,
  now: string,
): Promise<PollResult> {
  if (client === null) return { records: [], nextCursor: cursor };

  const start = telemetryWindowStart(cursor, now);
  const rows = await client.query('agentLogs', {
    query: telemetryQuery(principalId),
    timespan: `${start}/${now}`,
  });

  const records: SourceRecord[] = [];
  let newest: number | null = null;
  for (const row of rows) {
    const raw = telemetryRowToRaw(row);
    if (raw === null) continue;
    records.push({
      id: `${raw.operationId}:${raw.record.step ?? 'span'}:${raw.record.ts}`,
      observedAt: raw.record.ts,
      raw,
    });
    const ms = Date.parse(raw.record.ts);
    if (!Number.isNaN(ms) && (newest === null || ms > newest)) newest = ms;
  }

  // With nothing to show for the window the cursor moves to its end, so a
  // quiet day does not widen the next query.
  return { records, nextCursor: newest === null ? now : new Date(newest).toISOString() };
}

function rawOf(raw: unknown): TelemetryRawRow {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as { operationId?: unknown }).operationId !== 'string'
  ) {
    throw new Error(
      'agent-logs telemetry could not read a row: the record carries no operation id. ' +
        'It is built by telemetryRowToRaw in apps/worker/src/watchers/agent-logs/telemetry.ts.',
    );
  }
  return raw as TelemetryRawRow;
}

/** Reduces one telemetry row to its canonical record and the ledger metadata around it. */
export function normaliseTelemetryRow(record: SourceRecord): Observation {
  const { operationId, record: canonical } = rawOf(record.raw);
  const skipped = canonical.step !== null;
  return {
    sourceSystem: TELEMETRY_SOURCE_SYSTEM,
    recordId: record.id,
    observedAt: record.observedAt,
    record: canonical,
    correlationKey: operationId,
    summary: skipped
      ? `${canonical.agent} skipped ${canonical.step ?? ''}`
      : `${canonical.agent} span failed`,
    labels: ['AgentLog', 'Telemetry', ...(skipped ? ['StepSkipped'] : ['SpanFailed'])],
  };
}
