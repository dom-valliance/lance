import type { JamieMeeting, JamieReads } from '@lance/connectors';
import type { Observation, PollResult, SourceRecord } from '../types.js';
import { cap, collectPages, londonDate, newestInstant, sameEmail, windowStart } from './paging.js';

/**
 * The `meetings` partition of the `jamie` watcher (spec 7.1): meetings,
 * their transcripts once Jamie has them, their action items and their tags.
 * Reads only, per ADR 0005.
 */

export const MEETINGS_PARTITION = 'meetings';

const MAX_SUMMARY_CHARS = 200;

/** Where a meeting is read in Jamie's own app, for provenance (non-negotiable 5). */
export function jamieMeetingUrl(meetingId: string): string {
  return `https://app.meetjamie.ai/meetings/${meetingId}`;
}

export interface JamieMeetingParticipant {
  name: string | null;
  email: string | null;
}

export interface JamieMeetingAttendee {
  name: string | null;
  email: string | null;
  responseStatus: string | null;
  organizer: boolean | null;
}

export interface JamieMeetingActionItem {
  content: string | null;
  completed: boolean;
  assigneeName: string | null;
  assigneeEmail: string | null;
}

/**
 * The canonical meeting record. Its hash is the third part of the
 * idempotency key, so a meeting polled again unchanged is a duplicate the
 * runner counts and drops, while the same meeting polled once its
 * transcript has arrived hashes differently and becomes a second, fuller
 * observation. That is intended: the earlier, transcript-free observation
 * stays in the ledger as what Lance knew at the time.
 *
 * Three fields of the Jamie meeting are deliberately left out. `locked` is
 * a Jamie-side sharing flag that says nothing about the meeting's content.
 * `scratchpadNotes` are Dom's private notes, which stay private and never
 * reach the ledger or a model. `summary.html` is the same prose as
 * `summary.markdown` in another wrapper, so storing it would double the
 * ledger's bulk and the hash's sensitivity to Jamie's markup changes.
 */
export type JamieMeetingRecord = {
  kind: 'meeting';
  id: string;
  title: string;
  startTime: string;
  endTime: string | null;
  participants: JamieMeetingParticipant[];
  attendees: JamieMeetingAttendee[];
  graphEventId: string | null;
  tags: string[];
  summaryShort: string | null;
  summaryMarkdown: string | null;
  transcript: string | null;
  transcriptReady: boolean;
  tasks: JamieMeetingActionItem[];
  domAttended: boolean;
};

function meetingOf(raw: unknown): JamieMeeting {
  if (typeof raw !== 'object' || raw === null || typeof (raw as { id?: unknown }).id !== 'string') {
    throw new Error(
      'jamie meetings could not read a meeting: the record carries no string id. ' +
        'Check jamieMeetingSchema in packages/connectors/src/jamie/types.ts.',
    );
  }
  return raw as JamieMeeting;
}

/**
 * One poll of the meetings window. Jamie's list gives summary rows only, so
 * each row is fetched in full: the transcript, summary, tasks and tags all
 * live on `meetings.get`.
 */
export async function pollMeetings(
  reads: Pick<JamieReads, 'listMeetings' | 'getMeeting'>,
  cursor: string | null,
  now: string,
): Promise<PollResult> {
  const startDate = windowStart(cursor, now);
  const summaries = await collectPages(MEETINGS_PARTITION, async (pageCursor) => {
    const page = await reads.listMeetings({
      startDate,
      ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
    });
    return { items: page.meetings, nextCursor: page.nextCursor };
  });

  const records: SourceRecord[] = [];
  for (const summary of summaries) {
    const meeting = await reads.getMeeting(summary.id);
    records.push({
      id: meeting.id,
      // A meeting is observed when it ended; a meeting still running has
      // only a start time to date it by.
      observedAt: meeting.endTime ?? meeting.startTime,
      raw: meeting,
    });
  }

  return {
    records,
    nextCursor: newestInstant(
      summaries.map((summary) => summary.startTime),
      cursor,
    ),
  };
}

/** Reduces a Jamie meeting to its canonical record and the ledger metadata around it. */
export function normaliseMeeting(record: SourceRecord, domEmail: string): Observation {
  const meeting = meetingOf(record.raw);
  const participants: JamieMeetingParticipant[] = meeting.participants.map((participant) => ({
    name: participant.name,
    email: participant.email ?? null,
  }));
  const attendees: JamieMeetingAttendee[] = (meeting.event?.attendees ?? []).map((attendee) => ({
    name: attendee.name ?? null,
    email: attendee.email ?? null,
    responseStatus: attendee.responseStatus ?? null,
    organizer: attendee.organizer ?? null,
  }));
  const transcript = meeting.transcript ?? null;
  const transcriptReady = transcript !== null && transcript.trim() !== '';
  const domAttended = [...participants, ...attendees].some((person) =>
    sameEmail(person.email, domEmail),
  );
  const title = meeting.title ?? meeting.generatedTitle ?? '(untitled)';

  const canonical: JamieMeetingRecord = {
    kind: 'meeting',
    id: meeting.id,
    title,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    participants,
    attendees,
    graphEventId: meeting.event?.externalId ?? null,
    tags: meeting.tags.map((tag) => tag.name),
    summaryShort: meeting.summary?.short ?? null,
    summaryMarkdown: meeting.summary?.markdown ?? null,
    transcript,
    transcriptReady,
    tasks: meeting.tasks.map((task) => ({
      content: task.content ?? task.text ?? null,
      completed: task.completed,
      assigneeName: task.assignee?.name ?? null,
      assigneeEmail: task.assignee?.email ?? null,
    })),
    domAttended,
  };

  return {
    sourceSystem: 'jamie',
    recordId: meeting.id,
    observedAt: record.observedAt,
    record: canonical,
    correlationKey: meeting.id,
    summary: cap(`Meeting: ${title} (${londonDate(meeting.startTime)})`, MAX_SUMMARY_CHARS),
    // Deterministic labels, no model call: the watcher decides these from
    // the record alone (spec 7.1).
    labels: [
      'Meeting',
      transcriptReady ? 'TranscriptReady' : 'TranscriptPending',
      domAttended ? 'DomAttended' : 'DomAbsent',
    ],
    url: jamieMeetingUrl(meeting.id),
  };
}
