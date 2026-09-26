/**
 * What earlier triage runs did with a meeting's transcript. The Jamie
 * watcher observes a meeting again whenever any part of it changes (the
 * summary, tags, title or Jamie's own action items arriving after the
 * transcript), and every observation is triaged. The commitment extractor
 * and the triage model word the same promise differently on each reading,
 * so a transcript read twice recorded its commitments twice. A transcript
 * is therefore read for commitments, tasks and the debrief once.
 *
 * The evidence is the ledger alone: every completed triage run appends a
 * `triage` resolved event naming the observations it read, and each
 * observation carries the transcript it was read with.
 */

/** The parts of a ledger event this module reads. */
export interface TrailEvent {
  id: string;
  kind: string;
  sourceSystem: string | null;
  sourceRecordId: string | null;
  payload: unknown;
}

/**
 * - `first`: no completed triage run has read a transcript of this meeting.
 * - `changed`: one has, but this transcript differs from every one read.
 * - `repeat`: this exact transcript has been read by a completed run.
 */
export type TranscriptReading = 'first' | 'changed' | 'repeat';

function record(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

/** Observation event ids named by the completed triage runs in a trail. */
export function triagedObservationIds(trail: readonly TrailEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of trail) {
    const payload = record(event.payload);
    if (event.kind !== 'resolved' || payload?.['kind'] !== 'triage') continue;
    const named = payload['observationEventIds'];
    if (!Array.isArray(named)) continue;
    for (const id of named) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/** The transcript a Jamie meeting observation was read with, or null when it had none. */
export function transcriptOf(event: TrailEvent): string | null {
  const payload = record(event.payload);
  if (
    event.kind !== 'observed' ||
    payload?.['watcher'] !== 'jamie' ||
    payload['kind'] !== 'meeting' ||
    payload['transcriptReady'] !== true
  )
    return null;
  const transcript = payload['transcript'];
  return typeof transcript === 'string' && transcript.trim() !== '' ? transcript : null;
}

/**
 * How this reading of a meeting's transcript relates to the readings
 * completed runs on the same correlation id have already made.
 */
export function transcriptReading(
  trail: readonly TrailEvent[],
  recordId: string,
  transcript: string,
): TranscriptReading {
  const triaged = triagedObservationIds(trail);
  let readBefore = false;
  for (const event of trail) {
    if (!triaged.has(event.id) || event.sourceRecordId !== recordId) continue;
    const earlier = transcriptOf(event);
    if (earlier === null) continue;
    if (earlier === transcript) return 'repeat';
    readBefore = true;
  }
  return readBefore ? 'changed' : 'first';
}
