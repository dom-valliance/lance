import { describe, expect, it } from 'vitest';
import { connectorHealth, retentionLabel, retentionRunSummary } from '@/lib/settings-view';

const cursor = (watcher: string, ageMinutes: number, updatedAt: string) => ({
  watcher,
  key: 'delta',
  value: 'token',
  updatedAt,
  ageMinutes,
});

describe('retentionLabel', () => {
  it('counts a window shorter than a year in days', () => {
    expect(retentionLabel(30)).toBe('30 days');
    expect(retentionLabel(90)).toBe('90 days');
  });

  it('counts a whole number of years in years', () => {
    expect(retentionLabel(365)).toBe('1 year');
    expect(retentionLabel(730)).toBe('2 years');
  });

  it('keeps days when the window is not a whole number of years', () => {
    expect(retentionLabel(400)).toBe('400 days');
  });

  it('says one day in the singular', () => {
    expect(retentionLabel(1)).toBe('1 day');
  });
});

describe('retentionRunSummary', () => {
  it('names one count in plain words', () => {
    expect(retentionRunSummary({ mailBodies: 41 })).toBe('41 mail bodies');
  });

  it('joins several counts with a final and', () => {
    expect(retentionRunSummary({ mailBodies: 41, transcripts: 12, modelLogs: 3 })).toBe(
      '41 mail bodies, 12 transcripts and 3 model logs',
    );
  });

  it('reads the counts the retention job records under counts', () => {
    expect(
      retentionRunSummary({
        trigger: 'nightly',
        windows: { mailBodiesDays: 90 },
        counts: { mailBodies: 41, transcripts: 12 },
      }),
    ).toBe('41 mail bodies and 12 transcripts');
  });

  it('humanises snake case keys the same way', () => {
    expect(retentionRunSummary({ mail_bodies: 41 })).toBe('41 mail bodies');
  });

  it('ignores fields that are not numbers', () => {
    expect(retentionRunSummary({ mailBodies: 41, ranAt: '2026-09-21T03:00:00Z', ok: true })).toBe(
      '41 mail bodies',
    );
  });

  it('answers null when the payload carries no counts', () => {
    expect(retentionRunSummary({ ranAt: '2026-09-21T03:00:00Z' })).toBeNull();
    expect(retentionRunSummary(null)).toBeNull();
    expect(retentionRunSummary('41')).toBeNull();
    expect(retentionRunSummary([1, 2])).toBeNull();
  });
});

describe('connectorHealth', () => {
  it('reports Microsoft 365 healthy from the newest of its two watchers', () => {
    const [graph] = connectorHealth({
      cursors: [
        cursor('graph-mail', 9, '2026-09-21T13:56:00+01:00'),
        cursor('graph-calendar', 120, '2026-09-21T11:05:00+01:00'),
      ],
    });

    expect(graph).toEqual({
      key: 'graph',
      name: 'Microsoft 365',
      state: 'healthy',
      lastReadAt: '2026-09-21T13:56:00+01:00',
    });
  });

  it('reports a connector stale once its newest cursor is over an hour old', () => {
    const health = connectorHealth({
      cursors: [cursor('jamie', 240, '2026-09-21T10:02:00+01:00')],
    });
    const jamie = health.find((entry) => entry.key === 'jamie');

    expect(jamie?.state).toBe('stale');
    expect(jamie?.lastReadAt).toBe('2026-09-21T10:02:00+01:00');
  });

  it('keeps a cursor exactly at the threshold healthy, as the sidebar does', () => {
    const health = connectorHealth({
      cursors: [cursor('notion', 60, '2026-09-21T13:05:00+01:00')],
    });

    expect(health.find((entry) => entry.key === 'notion')?.state).toBe('healthy');
  });

  it('reports a watcher that has never written a cursor as unknown', () => {
    const health = connectorHealth({ cursors: [] });

    expect(health.find((entry) => entry.key === 'notion')).toEqual({
      key: 'notion',
      name: 'Notion',
      state: 'unknown',
      lastReadAt: null,
    });
  });

  it('reports Slack as unmonitored because no watcher reads it', () => {
    const health = connectorHealth({ cursors: [cursor('graph-mail', 5, '2026-09-21T14:00:00Z')] });

    expect(health.find((entry) => entry.key === 'slack')).toEqual({
      key: 'slack',
      name: 'Slack',
      state: 'unmonitored',
      lastReadAt: null,
    });
  });

  it('lists the four connectors in the order the page shows them', () => {
    expect(connectorHealth({ cursors: [] }).map((entry) => entry.key)).toEqual([
      'graph',
      'jamie',
      'notion',
      'slack',
    ]);
  });
});
