import { describe, expect, it } from 'vitest';
import { transcriptReading, type TrailEvent } from './transcripts.js';

function meeting(id: string, transcript: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'observed',
    sourceSystem: 'jamie',
    sourceRecordId: 'mt-1',
    payload: {
      watcher: 'jamie',
      kind: 'meeting',
      id: 'mt-1',
      transcript,
      transcriptReady: transcript !== null,
      ...extra,
    },
  } satisfies TrailEvent;
}

function triage(id: string, observationEventIds: string[]): TrailEvent {
  return {
    id,
    kind: 'resolved',
    sourceSystem: 'lance',
    sourceRecordId: null,
    payload: { kind: 'triage', observationEventIds },
  };
}

describe('transcriptReading', () => {
  it('is first when no completed run has read a transcript of the meeting', () => {
    const trail = [meeting('e1', null), triage('t1', ['e1']), meeting('e2', 'Bea: I will.')];
    expect(transcriptReading(trail, 'mt-1', 'Bea: I will.')).toBe('first');
  });

  it('is repeat when a completed run read the same transcript under another hash', () => {
    const trail = [
      meeting('e1', 'Bea: I will.'),
      triage('t1', ['e1']),
      meeting('e2', 'Bea: I will.', { summaryShort: 'Arrived later' }),
    ];
    expect(transcriptReading(trail, 'mt-1', 'Bea: I will.')).toBe('repeat');
  });

  it('is changed when completed runs read only a different transcript', () => {
    const trail = [meeting('e1', 'Bea: I will.'), triage('t1', ['e1'])];
    expect(transcriptReading(trail, 'mt-1', 'Bea: I will, by Friday.')).toBe('changed');
  });

  it('ignores an observation no completed run has read, so a failed run leaves the transcript unread', () => {
    const trail = [meeting('e1', 'Bea: I will.'), meeting('e2', 'Bea: I will.')];
    expect(transcriptReading(trail, 'mt-1', 'Bea: I will.')).toBe('first');
  });

  it('ignores readings of another record on the same correlation id', () => {
    const other = { ...meeting('e1', 'Bea: I will.'), sourceRecordId: 'mt-2' };
    expect(transcriptReading([other, triage('t1', ['e1'])], 'mt-1', 'Bea: I will.')).toBe('first');
  });
});
