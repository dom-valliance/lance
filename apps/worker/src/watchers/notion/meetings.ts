import type { GetPageTextOptions, MeetingRecord } from '@lance/connectors';
import type { Observation, SourceRecord } from '../types.js';

/**
 * The meetings half of the `notion` watcher: the Meetings DB, read only.
 * Lance has no Meetings write function, so nothing here has a counterpart in
 * the executor.
 */

export const MEETING_PARTITION = 'meetings';

/** Longest page text kept on a record. Triage reads it; the ledger stores it. */
export const MAX_NOTES_CHARS = 20_000;

/**
 * How recently a meeting must have been edited for its page text to be
 * worth a second Notion call. A backfill therefore costs one call a page,
 * not two, and notes arrive on the first poll after the notes are written.
 */
export const NOTES_FRESHNESS_HOURS = 24;

const MAX_SUMMARY_CHARS = 200;

/**
 * The canonical meeting record. `lastEditedTime` is dropped and `Last edited
 * by` is never read, for the reason given in `tasks.ts`: a no-op edit must
 * not become a new observation. `notes` is present only when the page was
 * edited inside the freshness window, and `notesTruncated` says whether the
 * cap cut the text.
 */
export type NotionMeetingRecord = Omit<MeetingRecord, 'lastEditedTime'> & {
  kind: 'meeting';
  notes?: string;
  notesTruncated?: boolean;
};

/** The one read the meetings partition makes beyond its query. */
export interface MeetingNotesReader {
  getPageText(pageId: string, options?: GetPageTextOptions): Promise<string>;
}

function cap(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function isMeetingRecord(raw: unknown): raw is MeetingRecord {
  if (typeof raw !== 'object' || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return typeof value.id === 'string' && typeof value.lastEditedTime === 'string';
}

/** The meeting `poll` put in `raw`; see `taskOf`. */
export function meetingOf(record: SourceRecord): MeetingRecord {
  if (!isMeetingRecord(record.raw)) {
    throw new Error(
      `The notion watcher was handed a record for page ${record.id} that is not a MeetingRecord. Only poll may fill SourceRecord.raw for the meetings partition.`,
    );
  }
  return record.raw;
}

/** Whether the page was edited within the freshness window ending at `now`. */
export function editedRecently(lastEditedTime: string, now: string): boolean {
  const edited = Date.parse(lastEditedTime);
  const at = Date.parse(now);
  if (Number.isNaN(edited) || Number.isNaN(at)) return false;
  return at - edited <= NOTES_FRESHNESS_HOURS * 60 * 60 * 1000;
}

async function notesFor(
  meeting: MeetingRecord,
  reads: MeetingNotesReader,
  now: string,
): Promise<{ notes?: string; notesTruncated?: boolean }> {
  if (!editedRecently(meeting.lastEditedTime, now)) return {};
  const text = await reads.getPageText(meeting.id);
  return { notes: cap(text, MAX_NOTES_CHARS), notesTruncated: text.length > MAX_NOTES_CHARS };
}

export interface MeetingObservationDeps {
  reads: MeetingNotesReader;
  /** The instant the run started, against which freshness is measured. */
  now: string;
}

/**
 * One Meetings row as a ledger observation, with the page text when the page
 * is fresh. No model call. A failed page read is left to throw: the runner
 * skips the record, holds the cursor and retries on the next poll.
 */
export async function meetingObservation(
  meeting: MeetingRecord,
  deps: MeetingObservationDeps,
): Promise<Observation> {
  const { lastEditedTime, ...rest } = meeting;
  const notes = await notesFor(meeting, deps.reads, deps.now);
  const canonical: NotionMeetingRecord = { ...rest, kind: 'meeting', ...notes };
  const name = meeting.name.trim() === '' ? '(untitled)' : meeting.name;
  const summary =
    meeting.eventTimeStart === null
      ? `Meeting: ${name}`
      : `Meeting: ${name} (${meeting.eventTimeStart})`;
  return {
    sourceSystem: 'notion',
    recordId: meeting.id,
    observedAt: lastEditedTime,
    record: canonical,
    correlationKey: meeting.id,
    summary: cap(summary, MAX_SUMMARY_CHARS),
    labels: ['Notion', 'Meeting'],
    url: meeting.url,
  };
}
