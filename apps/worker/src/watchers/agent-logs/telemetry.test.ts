import type { AppInsightsClient, AppInsightsRow } from '@lance/connectors';
import { hashRecord } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import {
  normaliseTelemetryRow,
  pollTelemetry,
  telemetryQuery,
  telemetryRowToRaw,
  telemetryWindowStart,
  type TelemetryRecord,
} from './telemetry.js';

const NOW = '2026-09-22T09:00:00.000Z';
const PRINCIPAL = '01K5S9V6QW3SWCCPVB0N0E300H';
const OTHER_PRINCIPAL = '01K5S9V6QW3SWCCPVB0N0E3Q7H';

function row(overrides: Partial<AppInsightsRow> = {}): AppInsightsRow {
  return {
    ts: '2026-09-22T08:55:00Z',
    operationId: 'op-1',
    agent: 'planner',
    step: 'critic',
    success: false,
    message: 'critic skipped: no proposals to review',
    ...overrides,
  };
}

interface QueryCall {
  query: string;
  timespan?: string;
}

function fakeClient(rows: AppInsightsRow[]): AppInsightsClient & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    connector: undefined as unknown as AppInsightsClient['connector'],
    workspaceId: 'workspace-test',
    query: (_operation, request) => {
      calls.push(request);
      return Promise.resolve(rows);
    },
  };
}

describe('telemetryQuery', () => {
  it('reads only the telemetry the principal own jobs produced', () => {
    const query = telemetryQuery(PRINCIPAL);

    expect(
      query.match(/tostring\(Properties\['lance\.principal'\]\) == '([0-9A-Z]{26})'/g),
    ).toEqual([
      `tostring(Properties['lance.principal']) == '${PRINCIPAL}'`,
      `tostring(Properties['lance.principal']) == '${PRINCIPAL}'`,
    ]);
    expect(query).not.toContain(OTHER_PRINCIPAL);
    expect(telemetryQuery(OTHER_PRINCIPAL)).not.toBe(query);
  });

  it('refuses anything that is not a principal id, so nothing can be spliced into the KQL', () => {
    expect(() => telemetryQuery("x' or 1 == 1 or '")).toThrow('is not a principal id');
  });
});

describe('pollTelemetry', () => {
  it('returns nothing and holds the cursor when no workspace is configured', async () => {
    const result = await pollTelemetry(null, PRINCIPAL, '2026-09-22T08:00:00.000Z', NOW);
    expect(result).toEqual({ records: [], nextCursor: '2026-09-22T08:00:00.000Z' });
  });

  it('asks for the window between the cursor and now', async () => {
    const client = fakeClient([]);
    await pollTelemetry(client, PRINCIPAL, '2026-09-22T08:30:00.000Z', NOW);
    expect(client.calls[0]).toEqual({
      query: telemetryQuery(PRINCIPAL),
      timespan: `2026-09-22T08:29:00.000Z/${NOW}`,
    });
  });

  it('moves the cursor to the end of the window when nothing failed', async () => {
    const result = await pollTelemetry(fakeClient([]), PRINCIPAL, '2026-09-22T08:30:00.000Z', NOW);
    expect(result.nextCursor).toBe(NOW);
  });

  it('advances the cursor to the newest row it read', async () => {
    const result = await pollTelemetry(
      fakeClient([row(), row({ operationId: 'op-2', ts: '2026-09-22T08:58:00Z' })]),
      PRINCIPAL,
      null,
      NOW,
    );
    expect(result.records).toHaveLength(2);
    expect(result.nextCursor).toBe('2026-09-22T08:58:00.000Z');
  });

  it('drops a row that names no operation, since nothing could correlate it', async () => {
    const result = await pollTelemetry(
      fakeClient([row({ operationId: '' })]),
      PRINCIPAL,
      null,
      NOW,
    );
    expect(result.records).toEqual([]);
  });
});

describe('telemetryWindowStart', () => {
  it('reaches back an hour on the first poll', () => {
    expect(telemetryWindowStart(null, NOW)).toBe('2026-09-22T08:00:00.000Z');
  });

  it('never asks for more than a day, however far behind the cursor is', () => {
    expect(telemetryWindowStart('2026-09-01T00:00:00.000Z', NOW)).toBe('2026-09-21T09:00:00.000Z');
  });
});

describe('telemetryRowToRaw', () => {
  it('reads a skipped step as a record carrying the step name', () => {
    expect(telemetryRowToRaw(row())?.record).toEqual({
      kind: 'agent_log',
      stream: 'telemetry',
      agent: 'planner',
      step: 'critic',
      success: false,
      message: 'critic skipped: no proposals to review',
      ts: '2026-09-22T08:55:00.000Z',
    });
  });

  it('reads a failed span as a record with no step', () => {
    const raw = telemetryRowToRaw(row({ step: '', message: 'notion.queryDatabase failed' }));
    expect(raw?.record.step).toBeNull();
  });

  it('falls back to Lance when the span names no agent', () => {
    expect(telemetryRowToRaw(row({ agent: '' }))?.record.agent).toBe('lance');
  });
});

describe('normaliseTelemetryRow', () => {
  it('correlates a row on its operation id and labels it a skipped step', async () => {
    const polled = await pollTelemetry(fakeClient([row()]), PRINCIPAL, null, NOW);
    const first = polled.records[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const observation = normaliseTelemetryRow(first);
    expect(observation.sourceSystem).toBe('lance');
    expect(observation.correlationKey).toBe('op-1');
    expect(observation.labels).toEqual(['AgentLog', 'Telemetry', 'StepSkipped']);
    expect((observation.record as TelemetryRecord).step).toBe('critic');
  });

  it('gives the same record every time the same row is normalised', async () => {
    const first = await pollTelemetry(fakeClient([row()]), PRINCIPAL, null, NOW);
    const second = await pollTelemetry(fakeClient([row()]), PRINCIPAL, null, NOW);
    const left = first.records[0];
    const right = second.records[0];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (left === undefined || right === undefined) return;
    expect(hashRecord(normaliseTelemetryRow(right).record)).toBe(
      hashRecord(normaliseTelemetryRow(left).record),
    );
  });

  it('labels a failed span apart from a skipped step', async () => {
    const polled = await pollTelemetry(fakeClient([row({ step: '' })]), PRINCIPAL, null, NOW);
    const first = polled.records[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(normaliseTelemetryRow(first).labels).toEqual(['AgentLog', 'Telemetry', 'SpanFailed']);
  });
});
