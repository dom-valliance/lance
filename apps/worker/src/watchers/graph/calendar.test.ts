import type {
  CalendarEvent,
  CalendarEventDelta,
  DeltaCalendarViewOptions,
} from '@lance/connectors/graph';
import { describe, expect, it } from 'vitest';
import {
  CALENDAR_PARTITION,
  GRAPH_CALENDAR_SCHEDULES,
  createGraphCalendarWatcher,
  externalAttendees,
  findConflicts,
  graphInstant,
  isAbbreviatedOccurrence,
  type GraphCalendarRecord,
} from './calendar.js';

const NOW = '2026-09-21T09:00:00.000Z';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    subject: 'Northwind pilot review',
    start: { dateTime: '2026-09-22T10:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-22T11:00:00.0000000', timeZone: 'UTC' },
    isCancelled: false,
    isAllDay: false,
    organizer: {
      emailAddress: { name: 'Priya Raman', address: 'priya.raman@northwind.example.com' },
    },
    attendees: [
      {
        type: 'required',
        status: { response: 'accepted', time: '2026-09-18T12:00:00Z' },
        emailAddress: { name: 'Dom Selvon', address: 'dom@valliance.ai' },
      },
    ],
    location: { displayName: 'Microsoft Teams Meeting', locationType: 'default' },
    onlineMeeting: { joinUrl: 'https://teams.example.com/l/meetup-join/evt-1' },
    webLink: 'https://outlook.office365.com/owa/?itemid=evt-1',
    lastModifiedDateTime: '2026-09-18T12:00:04Z',
    iCalUId: '040000008200E00074C5B7101A82E0080000000EVT1',
    seriesMasterId: null,
    ...overrides,
  };
}

function window(id: string, start: string, end: string, overrides: Partial<CalendarEvent> = {}) {
  return event({
    id,
    start: { dateTime: start, timeZone: 'UTC' },
    end: { dateTime: end, timeZone: 'UTC' },
    ...overrides,
  });
}

interface FakeReads {
  calls: DeltaCalendarViewOptions[];
  /** Ids handed to `getEvent`, in order. */
  fetched: string[];
  deltaCalendarView(options: DeltaCalendarViewOptions): Promise<CalendarEventDelta>;
  getEvent(id: string): Promise<CalendarEvent>;
}

function fakeReads(
  result: Partial<CalendarEventDelta> = {},
  fullEvents: Record<string, CalendarEvent> = {},
): FakeReads {
  const calls: DeltaCalendarViewOptions[] = [];
  const fetched: string[] = [];
  return {
    calls,
    fetched,
    deltaCalendarView: (options) => {
      calls.push(options);
      return Promise.resolve({ events: [], removed: [], deltaLink: 'delta-2', ...result });
    },
    getEvent: (id) => {
      fetched.push(id);
      const full = fullEvents[id];
      return full === undefined
        ? Promise.reject(new Error(`graph getEvent: no event ${id}`))
        : Promise.resolve(full);
    },
  };
}

/** What the calendar delta sends for one occurrence of a recurring series. */
const abbreviatedOccurrence = (id: string, seriesMasterId: string): CalendarEvent => ({
  id,
  seriesMasterId,
  start: { dateTime: '2026-09-23T10:45:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-09-23T11:00:00.0000000', timeZone: 'UTC' },
});

describe('createGraphCalendarWatcher', () => {
  it('polls one calendar partition every fifteen minutes', async () => {
    const watcher = createGraphCalendarWatcher({ reads: fakeReads(), now: () => NOW });
    expect(watcher.name).toBe('graph-calendar');
    expect(watcher.sourceSystem).toBe('graph');
    expect(watcher.schedules).toEqual([...GRAPH_CALENDAR_SCHEDULES]);
    expect(await watcher.partitions()).toEqual([CALENDAR_PARTITION]);
  });

  it('asks for the next fourteen days and passes the cursor through', async () => {
    const reads = fakeReads({ deltaLink: 'delta-3' });
    const watcher = createGraphCalendarWatcher({ reads, now: () => NOW });

    const first = await watcher.poll(CALENDAR_PARTITION, null);
    expect(reads.calls[0]).toEqual({ start: NOW, end: '2026-10-05T09:00:00.000Z' });
    expect(first.nextCursor).toBe('delta-3');

    await watcher.poll(CALENDAR_PARTITION, 'delta-3');
    expect(reads.calls[1]).toMatchObject({ deltaLink: 'delta-3' });
  });

  it('dates each event by when it was last modified and flags removals', async () => {
    const reads = fakeReads({ events: [event()], removed: ['evt-9'] });
    const result = await createGraphCalendarWatcher({ reads, now: () => NOW }).poll(
      CALENDAR_PARTITION,
      null,
    );
    expect(result.records[0]).toMatchObject({ id: 'evt-1', observedAt: '2026-09-18T12:00:04Z' });
    expect(result.records[1]).toEqual({
      id: 'evt-9',
      observedAt: NOW,
      raw: { id: 'evt-9' },
      removed: true,
    });
  });
});

describe('graph-calendar occurrence hydration', () => {
  it('recognises the cut-down occurrence and not a full event with blank fields', () => {
    expect(isAbbreviatedOccurrence(abbreviatedOccurrence('occ-1', 'series-1'))).toBe(true);
    expect(isAbbreviatedOccurrence(event())).toBe(false);
    expect(isAbbreviatedOccurrence(event({ subject: null, organizer: null, attendees: [] }))).toBe(
      false,
    );
  });

  it('reads an abbreviated occurrence in full before it becomes a record', async () => {
    const full = event({
      id: 'occ-1',
      subject: 'Chambers synch-ups',
      seriesMasterId: 'series-1',
      lastModifiedDateTime: '2026-09-19T08:12:40Z',
    });
    const reads = fakeReads(
      { events: [event(), abbreviatedOccurrence('occ-1', 'series-1')] },
      { 'occ-1': full },
    );
    const watcher = createGraphCalendarWatcher({ reads, now: () => NOW });

    const result = await watcher.poll(CALENDAR_PARTITION, null);

    expect(reads.fetched).toEqual(['occ-1']);
    const record = result.records[1];
    expect(record).toEqual({ id: 'occ-1', observedAt: '2026-09-19T08:12:40Z', raw: full });
    if (record === undefined) throw new Error('unreachable: the record was asserted above');
    const observation = await watcher.normalise(record, CALENDAR_PARTITION);
    expect(observation.summary).toBe('Chambers synch-ups 22 Sept 2026, 11:00');
    expect(observation.correlationKey).toBe('series-1');
  });

  it('fails the poll when the full occurrence cannot be read, so the cursor does not move', async () => {
    const reads = fakeReads({ events: [abbreviatedOccurrence('occ-2', 'series-1')] });
    const watcher = createGraphCalendarWatcher({ reads, now: () => NOW });

    await expect(watcher.poll(CALENDAR_PARTITION, null)).rejects.toThrow(/no event occ-2/);
  });
});

describe('graph-calendar normalise', () => {
  const watcher = createGraphCalendarWatcher({ reads: fakeReads(), now: () => NOW });

  it('reduces the event to the canonical record and labels it Calendar', async () => {
    const observation = await watcher.normalise(
      { id: 'evt-1', observedAt: '2026-09-18T12:00:04Z', raw: event() },
      CALENDAR_PARTITION,
    );
    const record = observation.record as GraphCalendarRecord;
    expect(record.location).toBe('Microsoft Teams Meeting');
    expect(record.joinUrl).toBe('https://teams.example.com/l/meetup-join/evt-1');
    expect(record.organizer).toEqual({
      name: 'Priya Raman',
      address: 'priya.raman@northwind.example.com',
    });
    expect(record.attendees).toEqual([
      {
        name: 'Dom Selvon',
        address: 'dom@valliance.ai',
        type: 'required',
        responseStatus: 'accepted',
      },
    ]);
    expect(record.start).toEqual({ dateTime: '2026-09-22T10:00:00.0000000', timeZone: 'UTC' });
    expect(record.removed).toBe(false);
    expect(observation.labels).toEqual(['Calendar']);
    expect(observation.correlationKey).toBe('evt-1');
    expect(observation.url).toBe('https://outlook.office365.com/owa/?itemid=evt-1');
    expect(observation.summary).toBe('Northwind pilot review 22 Sept 2026, 11:00');
  });

  it('correlates a recurring instance with its series', async () => {
    const observation = await watcher.normalise(
      { id: 'evt-2', observedAt: NOW, raw: event({ id: 'evt-2', seriesMasterId: 'series-1' }) },
      CALENDAR_PARTITION,
    );
    expect(observation.correlationKey).toBe('series-1');
    expect(observation.recordId).toBe('evt-2');
  });

  it('keeps a cancellation on the record', async () => {
    const observation = await watcher.normalise(
      { id: 'evt-1', observedAt: NOW, raw: event({ isCancelled: true }) },
      CALENDAR_PARTITION,
    );
    expect((observation.record as GraphCalendarRecord).isCancelled).toBe(true);
  });

  it('marks a removed event on the record', async () => {
    const observation = await watcher.normalise(
      { id: 'evt-9', observedAt: NOW, raw: { id: 'evt-9' }, removed: true },
      CALENDAR_PARTITION,
    );
    const record = observation.record as GraphCalendarRecord;
    expect(record.removed).toBe(true);
    expect(record.attendees).toEqual([]);
    expect(observation.labels).toEqual(['Calendar']);
  });
});

describe('graphInstant', () => {
  it('reads a UTC wall clock as an instant', () => {
    expect(graphInstant({ dateTime: '2026-09-22T10:00:00.0000000', timeZone: 'UTC' })).toBe(
      '2026-09-22T10:00:00.000Z',
    );
  });

  it('reads a London wall clock in British Summer Time', () => {
    expect(graphInstant({ dateTime: '2026-09-22T10:00:00', timeZone: 'Europe/London' })).toBe(
      '2026-09-22T09:00:00.000Z',
    );
  });

  it('treats a Windows zone name as UTC rather than failing', () => {
    expect(graphInstant({ dateTime: '2026-01-22T10:00:00', timeZone: 'GMT Standard Time' })).toBe(
      '2026-01-22T10:00:00.000Z',
    );
  });

  it('returns null for a missing time', () => {
    expect(graphInstant(null)).toBeNull();
  });
});

describe('findConflicts', () => {
  it('pairs two events that overlap', () => {
    const a = window('evt-a', '2026-09-22T10:00:00', '2026-09-22T11:00:00');
    const b = window('evt-b', '2026-09-22T10:30:00', '2026-09-22T11:30:00');
    const conflicts = findConflicts([a, b]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.first.id).toBe('evt-a');
    expect(conflicts[0]?.second.id).toBe('evt-b');
    expect(conflicts[0]?.dedupeKey).toBe('evt-a|evt-b');
  });

  it('leaves two events that only touch alone', () => {
    expect(
      findConflicts([
        window('evt-a', '2026-09-22T10:00:00', '2026-09-22T11:00:00'),
        window('evt-b', '2026-09-22T11:00:00', '2026-09-22T12:00:00'),
      ]),
    ).toEqual([]);
  });

  it('leaves disjoint events alone', () => {
    expect(
      findConflicts([
        window('evt-a', '2026-09-22T10:00:00', '2026-09-22T11:00:00'),
        window('evt-b', '2026-09-22T14:00:00', '2026-09-22T15:00:00'),
      ]),
    ).toEqual([]);
  });

  it('ignores a cancelled event', () => {
    expect(
      findConflicts([
        window('evt-a', '2026-09-22T10:00:00', '2026-09-22T11:00:00'),
        window('evt-b', '2026-09-22T10:30:00', '2026-09-22T11:30:00', { isCancelled: true }),
      ]),
    ).toEqual([]);
  });

  it('gives the same dedupe key whichever order the pair arrives in', () => {
    const a = window('evt-b', '2026-09-22T10:00:00', '2026-09-22T12:00:00');
    const b = window('evt-a', '2026-09-22T10:30:00', '2026-09-22T11:30:00');
    expect(findConflicts([a, b])[0]?.dedupeKey).toBe('evt-a|evt-b');
  });

  it('reports every pair when three events overlap', () => {
    const conflicts = findConflicts([
      window('evt-a', '2026-09-22T10:00:00', '2026-09-22T13:00:00'),
      window('evt-b', '2026-09-22T10:30:00', '2026-09-22T11:30:00'),
      window('evt-c', '2026-09-22T11:00:00', '2026-09-22T12:00:00'),
    ]);
    expect(conflicts.map((conflict) => conflict.dedupeKey).sort()).toEqual([
      'evt-a|evt-b',
      'evt-a|evt-c',
      'evt-b|evt-c',
    ]);
  });

  it('ignores an event with no usable start and end', () => {
    expect(
      findConflicts([
        window('evt-a', '2026-09-22T10:00:00', '2026-09-22T11:00:00'),
        event({ id: 'evt-b', start: null, end: null }),
      ]),
    ).toEqual([]);
  });
});

describe('externalAttendees', () => {
  const attendee = (address: string | null, name = 'Someone') => ({
    type: 'required',
    status: { response: 'none', time: null },
    emailAddress: { name, address },
  });

  it('returns only the attendees off the internal domain', () => {
    const external = externalAttendees(
      event({
        attendees: [
          attendee('dom@valliance.ai', 'Dom Selvon'),
          attendee('priya.raman@northwind.example.com', 'Priya Raman'),
          attendee('OLA@VALLIANCE.AI', 'Ola Bergstrom'),
        ],
      }),
    );
    expect(external.map((person) => person.emailAddress?.address)).toEqual([
      'priya.raman@northwind.example.com',
    ]);
  });

  it('counts an attendee with no readable address as external', () => {
    const external = externalAttendees(event({ attendees: [attendee(null, 'Room 4')] }));
    expect(external).toHaveLength(1);
  });

  it('accepts another internal domain', () => {
    expect(
      externalAttendees(
        event({ attendees: [attendee('dom@valliance.ai')] }),
        'northwind.example.com',
      ),
    ).toHaveLength(1);
  });

  it('returns nothing when the event has no attendees', () => {
    expect(externalAttendees(event({ attendees: null }))).toEqual([]);
  });
});
