import { describe, expect, it } from 'vitest';
import {
  STALE_WATERMARK_DEDUPE_KEY,
  formatHours,
  skippedSteps,
  staleWatermark,
  telemetryFromRows,
  watermarkAtOf,
  type ObservedRow,
} from './detect.js';
import type { TelemetryRecord } from './telemetry.js';

const NOW = '2026-09-22T09:00:00.000Z';
const MAX_AGE_HOURS = 6;

function telemetry(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    kind: 'agent_log',
    stream: 'telemetry',
    agent: 'planner',
    step: 'critic',
    success: false,
    message: 'critic skipped',
    ts: '2026-09-22T08:00:00.000Z',
    ...overrides,
  };
}

function observed(payload: unknown, ts = '2026-09-22T08:00:00.000Z'): ObservedRow {
  return {
    id: '01K5Z0000000000000000AGENT',
    sourceSystem: 'lance',
    sourceRecordId: 'op-1:critic:2026-09-22T08:00:00.000Z',
    sourceRecordHash: 'sha256:abc',
    ts: new Date(ts),
    payload,
  };
}

describe('staleWatermark', () => {
  it('raises one P1 alert when the watermark is older than the threshold', () => {
    const alert = staleWatermark('2026-09-22T00:00:00.000Z', NOW, MAX_AGE_HOURS);
    expect(alert).not.toBeNull();
    expect(alert?.kind).toBe('stale_watermark');
    expect(alert?.severity).toBe('P1');
    expect(alert?.dedupeKey).toBe(STALE_WATERMARK_DEDUPE_KEY);
    expect(alert?.title).toContain('9 hours old');
    expect(alert?.body).toContain('2026-09-22T00:00:00.000Z');
    expect(alert?.body).toContain('6 hour threshold');
  });

  it('raises nothing when the watermark is fresh', () => {
    expect(staleWatermark('2026-09-22T08:30:00.000Z', NOW, MAX_AGE_HOURS)).toBeNull();
  });

  it('raises nothing when the watermark is exactly at the threshold', () => {
    expect(staleWatermark('2026-09-22T03:00:00.000Z', NOW, MAX_AGE_HOURS)).toBeNull();
  });

  it('raises nothing when no watermark has been seen at all', () => {
    expect(staleWatermark(null, NOW, MAX_AGE_HOURS)).toBeNull();
  });

  it('raises nothing when the watermark line carried an unreadable instant', () => {
    expect(staleWatermark('sometime yesterday', NOW, MAX_AGE_HOURS)).toBeNull();
  });
});

describe('skippedSteps', () => {
  it('raises one P1 alert for each agent and step pair', () => {
    const alerts = skippedSteps([
      telemetry(),
      telemetry({ ts: '2026-09-22T08:30:00.000Z' }),
      telemetry({ agent: 'triage', step: 'label' }),
    ]);
    expect(alerts.map((alert) => alert.dedupeKey)).toEqual([
      'agent:planner:critic',
      'agent:triage:label',
    ]);
    expect(alerts.every((alert) => alert.kind === 'agent_step_skipped')).toBe(true);
    expect(alerts.every((alert) => alert.severity === 'P1')).toBe(true);
  });

  it('counts the repeats and names the latest in the body', () => {
    const alerts = skippedSteps([telemetry(), telemetry({ ts: '2026-09-22T08:30:00.000Z' })]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('2 skipped critic steps');
    expect(alerts[0]?.body).toContain('2026-09-22T08:30:00.000Z');
  });

  it('ignores a failed span, which carries no step', () => {
    expect(skippedSteps([telemetry({ step: null })])).toEqual([]);
  });

  it('ignores a step that ran successfully', () => {
    expect(skippedSteps([telemetry({ success: true })])).toEqual([]);
  });

  it('raises nothing from an empty window', () => {
    expect(skippedSteps([])).toEqual([]);
  });
});

describe('telemetryFromRows', () => {
  it('keeps a telemetry agent log and its provenance', () => {
    const kept = telemetryFromRows([observed(telemetry())]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.record.step).toBe('critic');
    expect(kept[0]?.provenance).toEqual({
      system: 'lance',
      recordId: 'op-1:critic:2026-09-22T08:00:00.000Z',
      hash: 'sha256:abc',
      observedAt: '2026-09-22T08:00:00.000Z',
    });
  });

  it('drops a payload that is not a telemetry agent log', () => {
    expect(telemetryFromRows([observed({ kind: 'meeting', id: 'mtg-1' })])).toEqual([]);
  });
});

describe('watermarkAtOf', () => {
  it('reads the instant a watermark observation carried', () => {
    expect(watermarkAtOf({ watermarkAt: '2026-09-22T07:00:00.000Z' })).toBe(
      '2026-09-22T07:00:00.000Z',
    );
  });

  it('reads nothing from a watermark line that carried no instant', () => {
    expect(watermarkAtOf({ watermarkAt: null })).toBeNull();
  });
});

describe('formatHours', () => {
  it('drops the decimal from a whole number of hours', () => {
    expect(formatHours(9)).toBe('9');
  });

  it('keeps one decimal place for a part hour', () => {
    expect(formatHours(9.26)).toBe('9.3');
  });
});
