import type { JamieMeeting, JamieReads, JamieTask } from '@lance/connectors';
import { describe, expect, it } from 'vitest';
import type { JamieMeetingRecord } from './meetings.js';
import type { JamieTaskRecord } from './tasks.js';
import { JAMIE_SCHEDULES, createJamieWatcher } from './watcher.js';

const NOW = '2026-09-21T09:00:00.000Z';
const DOM_EMAIL = 'dom@example.test';

const MEETING: JamieMeeting = {
  id: 'mtg-7',
  title: 'Harbourside retainer review',
  generatedTitle: null,
  startTime: '2026-09-20T09:00:00.000Z',
  endTime: '2026-09-20T09:30:00.000Z',
  locked: false,
  user: { id: 'usr-1', email: DOM_EMAIL },
  summary: { markdown: '## Actions', html: '<h2>Actions</h2>', short: 'Retainer renewed.' },
  transcript: '**Dom Selvon:** Shall we renew?',
  scratchpadNotes: null,
  participants: [{ id: 'p-1', name: 'Dom Selvon', email: DOM_EMAIL }],
  tasks: [],
  tags: [{ name: 'Retainer', color: 'green' }],
  event: { id: 'evt-7', externalId: 'AAMkAGI2harbourside', attendees: [] },
};

const TASK: JamieTask = {
  id: 'tsk-7',
  text: 'Confirm the retainer renewal date',
  completed: false,
  assignee: { id: 'p-1', name: 'Dom Selvon', email: DOM_EMAIL },
  meetingId: 'mtg-7',
  meetingTitle: 'Harbourside retainer review',
  createdAt: '2026-09-20T09:31:00.000Z',
  userId: 'usr-1',
};

function fakeReads(): Pick<JamieReads, 'listMeetings' | 'getMeeting' | 'listTasks'> {
  return {
    listMeetings: () =>
      Promise.resolve({
        meetings: [
          {
            id: MEETING.id,
            title: MEETING.title,
            generatedTitle: null,
            startTime: MEETING.startTime,
            endTime: MEETING.endTime,
            calendarEventId: 'cal-7',
            userId: 'usr-1',
            isShared: false,
          },
        ],
        nextCursor: null,
      }),
    getMeeting: () => Promise.resolve(MEETING),
    listTasks: () => Promise.resolve({ tasks: [TASK], nextCursor: null }),
  };
}

describe('createJamieWatcher', () => {
  const watcher = createJamieWatcher({ reads: fakeReads(), domEmail: DOM_EMAIL, now: () => NOW });

  it('runs as the jamie watcher every fifteen minutes over two partitions', async () => {
    expect(watcher.name).toBe('jamie');
    expect(watcher.sourceSystem).toBe('jamie');
    expect(watcher.schedules).toEqual([...JAMIE_SCHEDULES]);
    expect(await watcher.partitions()).toEqual(['meetings', 'tasks']);
  });

  it('accepts schedules from its caller', () => {
    const hourly = createJamieWatcher({
      reads: fakeReads(),
      domEmail: DOM_EMAIL,
      schedules: ['0 * * * *'],
    });
    expect(hourly.schedules).toEqual(['0 * * * *']);
  });

  it('polls and normalises a meeting on the meetings partition', async () => {
    const polled = await watcher.poll('meetings', null);
    expect(polled.records).toHaveLength(1);
    const first = polled.records[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const observation = await watcher.normalise(first, 'meetings');
    expect(observation.sourceSystem).toBe('jamie');
    expect((observation.record as JamieMeetingRecord).kind).toBe('meeting');
    expect(observation.labels).toEqual(['Meeting', 'TranscriptReady', 'DomAttended']);
  });

  it('polls and normalises an action item on the tasks partition', async () => {
    const polled = await watcher.poll('tasks', null);
    const first = polled.records[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const observation = await watcher.normalise(first, 'tasks');
    expect((observation.record as JamieTaskRecord).kind).toBe('task');
    expect(observation.correlationKey).toBe('mtg-7');
  });

  it('refuses a partition it does not own', async () => {
    await expect(watcher.poll('transcripts', null)).rejects.toThrow(/no partition named/);
    await expect(
      watcher.normalise({ id: 'x', observedAt: NOW, raw: {} }, 'transcripts'),
    ).rejects.toThrow(/no partition named/);
  });
});
