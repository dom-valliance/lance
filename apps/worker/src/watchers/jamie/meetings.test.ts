import type { JamieMeeting, JamieReads } from '@lance/connectors';
import { hashRecord } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '../types.js';
import { normaliseMeeting, pollMeetings, type JamieMeetingRecord } from './meetings.js';

const NOW = '2026-09-21T09:00:00.000Z';
const DOM_EMAIL = 'dom@example.test';

type MeetingList = Awaited<ReturnType<JamieReads['listMeetings']>>;
type MeetingSummary = MeetingList['meetings'][number];
type ListMeetingsCall = NonNullable<Parameters<JamieReads['listMeetings']>[0]>;

function summary(overrides: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    id: 'mtg-1',
    title: 'Northwind pilot debrief',
    generatedTitle: null,
    startTime: '2026-09-20T13:00:00.000Z',
    endTime: '2026-09-20T13:45:00.000Z',
    calendarEventId: 'cal-1',
    userId: 'usr-1',
    isShared: false,
    ...overrides,
  };
}

function meeting(overrides: Partial<JamieMeeting> = {}): JamieMeeting {
  return {
    id: 'mtg-1',
    title: 'Northwind pilot debrief',
    generatedTitle: 'Pilot debrief with Northwind',
    startTime: '2026-09-20T13:00:00.000Z',
    endTime: '2026-09-20T13:45:00.000Z',
    locked: true,
    user: { id: 'usr-1', email: DOM_EMAIL },
    summary: {
      markdown: '## Decisions\n\nNorthwind signs the pilot extension.',
      html: '<h2>Decisions</h2><p>Northwind signs the pilot extension.</p>',
      short: 'Northwind signs the pilot extension.',
    },
    transcript: '',
    scratchpadNotes: 'Private: push back on the day rate.',
    participants: [
      { id: 'p-1', name: 'Dom Selvon', email: 'DOM@EXAMPLE.TEST' },
      { id: 'p-2', name: 'Ingrid Halvorsen', email: 'ingrid@northwind.example.test' },
    ],
    tasks: [
      {
        content: 'Send the revised statement of work',
        completed: false,
        assignee: { id: 'p-2', name: 'Ingrid Halvorsen', email: 'ingrid@northwind.example.test' },
      },
    ],
    tags: [{ name: 'Client', color: 'blue' }],
    event: {
      id: 'evt-1',
      externalId: 'AAMkAGI2graphEventId',
      title: 'Northwind pilot debrief',
      scheduledTime: '2026-09-20T13:00:00.000Z',
      endTime: '2026-09-20T13:45:00.000Z',
      attendees: [
        {
          name: 'Dom Selvon',
          email: 'dom@example.test',
          responseStatus: 'accepted',
          organizer: true,
        },
        {
          name: 'Ingrid Halvorsen',
          email: 'ingrid@northwind.example.test',
          responseStatus: 'accepted',
          organizer: false,
        },
      ],
    },
    ...overrides,
  };
}

interface FakeMeetingReads {
  listCalls: ListMeetingsCall[];
  fetched: string[];
  listMeetings: JamieReads['listMeetings'];
  getMeeting: JamieReads['getMeeting'];
}

function fakeReads(pages: MeetingList[], meetings: JamieMeeting[] = [meeting()]): FakeMeetingReads {
  const listCalls: ListMeetingsCall[] = [];
  const fetched: string[] = [];
  let page = 0;
  return {
    listCalls,
    fetched,
    listMeetings: (args) => {
      listCalls.push(args ?? {});
      const result = pages[Math.min(page, pages.length - 1)] ?? { meetings: [], nextCursor: null };
      page += 1;
      return Promise.resolve(result);
    },
    getMeeting: (id) => {
      fetched.push(id);
      const found = meetings.find((candidate) => candidate.id === id);
      if (found === undefined) throw new Error(`no fake meeting ${id}`);
      return Promise.resolve(found);
    },
  };
}

function sourceRecord(raw: JamieMeeting): SourceRecord {
  return { id: raw.id, observedAt: raw.endTime ?? raw.startTime, raw };
}

describe('pollMeetings', () => {
  it('asks for the last fourteen days on the first poll', async () => {
    const reads = fakeReads([{ meetings: [], nextCursor: null }]);
    await pollMeetings(reads, null, NOW);
    expect(reads.listCalls[0]).toEqual({ startDate: '2026-09-07T09:00:00.000Z' });
  });

  it('reaches back seventy-two hours behind the cursor on a later poll', async () => {
    const reads = fakeReads([{ meetings: [], nextCursor: null }]);
    await pollMeetings(reads, '2026-09-20T13:00:00.000Z', NOW);
    expect(reads.listCalls[0]).toEqual({ startDate: '2026-09-17T13:00:00.000Z' });
  });

  it('advances the cursor to the newest start time seen', async () => {
    const reads = fakeReads(
      [
        {
          meetings: [
            summary({ id: 'mtg-1', startTime: '2026-09-20T13:00:00.000Z' }),
            summary({ id: 'mtg-2', startTime: '2026-09-21T08:00:00.000Z' }),
          ],
          nextCursor: null,
        },
      ],
      [meeting(), meeting({ id: 'mtg-2' })],
    );
    const result = await pollMeetings(reads, '2026-09-20T13:00:00.000Z', NOW);
    expect(result.nextCursor).toBe('2026-09-21T08:00:00.000Z');
    expect(result.records.map((record) => record.id)).toEqual(['mtg-1', 'mtg-2']);
  });

  it('keeps the previous cursor when the window returns nothing', async () => {
    const reads = fakeReads([{ meetings: [], nextCursor: null }]);
    const result = await pollMeetings(reads, '2026-09-20T13:00:00.000Z', NOW);
    expect(result.nextCursor).toBe('2026-09-20T13:00:00.000Z');
    expect(result.records).toEqual([]);
  });

  it('follows nextCursor to the end of the window', async () => {
    const reads = fakeReads(
      [
        { meetings: [summary({ id: 'mtg-1' })], nextCursor: 'page-2' },
        { meetings: [summary({ id: 'mtg-2' })], nextCursor: null },
      ],
      [meeting(), meeting({ id: 'mtg-2' })],
    );
    const result = await pollMeetings(reads, null, NOW);
    expect(reads.listCalls[1]).toMatchObject({ cursor: 'page-2' });
    expect(reads.fetched).toEqual(['mtg-1', 'mtg-2']);
    expect(result.records).toHaveLength(2);
  });

  it('fails the poll when the page cap is reached, so the runner counts it', async () => {
    const reads = fakeReads([{ meetings: [summary()], nextCursor: 'more' }]);
    await expect(pollMeetings(reads, null, NOW)).rejects.toThrow(/50 page cap/);
  });

  it('dates a meeting by when it ended, and a running meeting by when it began', async () => {
    const reads = fakeReads(
      [{ meetings: [summary({ id: 'mtg-3' })], nextCursor: null }],
      [meeting({ id: 'mtg-3', endTime: null })],
    );
    const result = await pollMeetings(reads, null, NOW);
    expect(result.records[0]?.observedAt).toBe('2026-09-20T13:00:00.000Z');
  });
});

describe('normaliseMeeting', () => {
  it('reduces the meeting to its canonical record with provenance', () => {
    const observation = normaliseMeeting(sourceRecord(meeting()), DOM_EMAIL);
    const record = observation.record as JamieMeetingRecord;
    expect(record.kind).toBe('meeting');
    expect(record.title).toBe('Northwind pilot debrief');
    expect(record.graphEventId).toBe('AAMkAGI2graphEventId');
    expect(record.tags).toEqual(['Client']);
    expect(record.summaryShort).toBe('Northwind signs the pilot extension.');
    expect(record.tasks).toEqual([
      {
        content: 'Send the revised statement of work',
        completed: false,
        assigneeName: 'Ingrid Halvorsen',
        assigneeEmail: 'ingrid@northwind.example.test',
      },
    ]);
    expect(observation.correlationKey).toBe('mtg-1');
    expect(observation.url).toBe('https://app.meetjamie.ai/meetings/mtg-1');
    expect(observation.summary).toBe('Meeting: Northwind pilot debrief (20 Sept 2026)');
    expect(observation.observedAt).toBe('2026-09-20T13:45:00.000Z');
  });

  it('gives the same record every time the same meeting is normalised', () => {
    const first = normaliseMeeting(sourceRecord(meeting()), DOM_EMAIL);
    const second = normaliseMeeting(sourceRecord(meeting()), DOM_EMAIL);
    expect(second.record).toEqual(first.record);
    expect(hashRecord(second.record)).toBe(hashRecord(first.record));
  });

  it('gives a different record once the transcript has arrived', () => {
    const pending = normaliseMeeting(sourceRecord(meeting()), DOM_EMAIL);
    const ready = normaliseMeeting(
      sourceRecord(meeting({ transcript: '**Dom Selvon:** Thanks for joining.' })),
      DOM_EMAIL,
    );
    expect(hashRecord(ready.record)).not.toBe(hashRecord(pending.record));
    expect((pending.record as JamieMeetingRecord).transcriptReady).toBe(false);
    expect(pending.labels).toEqual(['Meeting', 'TranscriptPending', 'DomAttended']);
    expect(ready.labels).toEqual(['Meeting', 'TranscriptReady', 'DomAttended']);
  });

  it('treats a whitespace-only transcript as still pending', () => {
    const observation = normaliseMeeting(sourceRecord(meeting({ transcript: '   ' })), DOM_EMAIL);
    expect((observation.record as JamieMeetingRecord).transcriptReady).toBe(false);
  });

  it('matches Dom on his address whatever its case', () => {
    const attended = normaliseMeeting(sourceRecord(meeting()), 'DoM@ExAmPlE.TeSt');
    expect((attended.record as JamieMeetingRecord).domAttended).toBe(true);
    expect(attended.labels).toContain('DomAttended');
  });

  it('marks Dom absent when neither a participant nor an attendee is him', () => {
    const observation = normaliseMeeting(
      sourceRecord(
        meeting({
          participants: [
            { id: 'p-2', name: 'Ingrid Halvorsen', email: 'ingrid@northwind.example.test' },
          ],
          event: { id: 'evt-1', externalId: null, attendees: [] },
        }),
      ),
      DOM_EMAIL,
    );
    const record = observation.record as JamieMeetingRecord;
    expect(record.domAttended).toBe(false);
    expect(record.graphEventId).toBeNull();
    expect(observation.labels).toContain('DomAbsent');
  });

  it('keeps the html summary, the scratchpad notes and the lock flag out of the record', () => {
    const observation = normaliseMeeting(sourceRecord(meeting()), DOM_EMAIL);
    const serialised = JSON.stringify(observation.record);
    expect(serialised).not.toContain('<h2>');
    expect(serialised).not.toContain('push back on the day rate');
    expect(Object.keys(observation.record)).not.toContain('locked');
    expect(Object.keys(observation.record)).not.toContain('scratchpadNotes');
  });

  it('falls back to the generated title and then to a placeholder', () => {
    const generated = normaliseMeeting(sourceRecord(meeting({ title: null })), DOM_EMAIL);
    expect((generated.record as JamieMeetingRecord).title).toBe('Pilot debrief with Northwind');
    const untitled = normaliseMeeting(
      sourceRecord(meeting({ title: null, generatedTitle: null })),
      DOM_EMAIL,
    );
    expect((untitled.record as JamieMeetingRecord).title).toBe('(untitled)');
  });

  it('refuses a record that is not a meeting', () => {
    expect(() =>
      normaliseMeeting({ id: 'mtg-1', observedAt: NOW, raw: { title: 'x' } }, DOM_EMAIL),
    ).toThrow(/no string id/);
  });
});
