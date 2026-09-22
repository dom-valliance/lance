import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorError } from '../core/errors.js';
import { FakeClock } from '../core/testing.js';
import { createJamieConnector, jamieProcedurePath, type JamieConnector } from './client.js';
import {
  checkAccess,
  createJamieReads,
  getMeeting,
  listAllMeetings,
  listAllTasks,
  listMeetings,
  listTags,
  listTasks,
  searchMeetings,
  MAX_LIST_PAGES,
} from './reads.js';
import { JAMIE_API_BASE_URL } from './types.js';

/** The synthetic meeting recorded beside this test. Its shape is asserted by the schemas. */
const meetingFixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/meeting.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const url = (procedure: string): string => `${JAMIE_API_BASE_URL}${jamieProcedurePath(procedure)}`;
const HEALTH_URL = `${JAMIE_API_BASE_URL}/health`;

const envelope = (json: unknown): Record<string, unknown> => ({ result: { data: { json } } });

/** The input Jamie received, decoded from the query string. */
const inputOf = (request: Request): unknown => {
  const raw = new URL(request.url).searchParams.get('input');
  return raw === null ? undefined : JSON.parse(raw);
};

const MEETING_SUMMARY = {
  id: 'mtg_0000000000000001',
  title: 'Weekly delivery review',
  generatedTitle: 'Delivery review: pilot scope and timeline',
  startTime: '2026-09-21T09:00:00.000Z',
  endTime: '2026-09-21T09:30:00.000Z',
  calendarEventId: 'evt_0000000000000001',
  userId: 'usr_0000000000000001',
  isShared: false,
};

const TASK = {
  id: 'tsk_0000000000000001',
  text: 'Move the delivery timeline by one week',
  completed: false,
  assignee: { id: 'par_0000000000000002', name: 'Robin Placeholder' },
  meetingId: 'mtg_0000000000000001',
  meetingTitle: 'Weekly delivery review',
  createdAt: '2026-09-21T09:31:00.000Z',
  userId: 'usr_0000000000000001',
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function connect(): JamieConnector {
  return createJamieConnector({ apiKey: 'jk_test_only', clock: new FakeClock() });
}

describe('listMeetings', () => {
  it('sends every argument it was given inside the json input', async () => {
    let input: unknown;
    server.use(
      http.get(url('meetings.list'), ({ request }) => {
        input = inputOf(request);
        return HttpResponse.json(envelope({ meetings: [MEETING_SUMMARY], nextCursor: null }));
      }),
    );
    await listMeetings(connect(), {
      limit: 10,
      cursor: '2026-09-21T09:00:00.000Z::mtg_0000000000000001',
      startDate: '2026-09-01T00:00:00.000Z',
      endDate: '2026-09-21T00:00:00.000Z',
      tag: 'delivery',
    });
    expect(input).toEqual({
      json: {
        limit: 10,
        cursor: '2026-09-21T09:00:00.000Z::mtg_0000000000000001',
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-21T00:00:00.000Z',
        tag: 'delivery',
      },
    });
  });

  it('sends no input at all when it was given no arguments', async () => {
    let input: unknown = 'unset';
    server.use(
      http.get(url('meetings.list'), ({ request }) => {
        input = inputOf(request);
        return HttpResponse.json(envelope({ meetings: [], nextCursor: null }));
      }),
    );
    await listMeetings(connect());
    expect(input).toBeUndefined();
  });

  it('returns the page and its cursor', async () => {
    server.use(
      http.get(url('meetings.list'), () =>
        HttpResponse.json(envelope({ meetings: [MEETING_SUMMARY], nextCursor: 'next' })),
      ),
    );
    const page = await listMeetings(connect());
    expect(page.meetings.map((meeting) => meeting.id)).toEqual(['mtg_0000000000000001']);
    expect(page.nextCursor).toBe('next');
  });

  it('refuses a limit outside one to a hundred before calling Jamie', async () => {
    const error = (await listMeetings(connect(), { limit: 0 }).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('limit must be a whole number from 1 to 100');
  });
});

describe('getMeeting', () => {
  it('sends the meeting id and returns the transcript, tasks, tags and event', async () => {
    let input: unknown;
    server.use(
      http.get(url('meetings.get'), ({ request }) => {
        input = inputOf(request);
        return HttpResponse.json(envelope(meetingFixture));
      }),
    );
    const meeting = await getMeeting(connect(), 'mtg_0000000000000001');
    expect(input).toEqual({ json: { meetingId: 'mtg_0000000000000001' } });
    expect(meeting.transcript).toContain('**Sam Placeholder:**');
    expect(meeting.participants).toHaveLength(1);
    expect(meeting.tasks[0]?.content).toBe('Move the delivery timeline by one week');
    expect(meeting.tags.map((tag) => tag.name)).toEqual(['delivery']);
    expect(meeting.event?.attendees).toHaveLength(2);
  });
});

describe('searchMeetings', () => {
  it('sends the query with its window and returns the results alone', async () => {
    let input: unknown;
    server.use(
      http.get(url('meetings.search'), ({ request }) => {
        input = inputOf(request);
        return HttpResponse.json(
          envelope({
            results: [
              {
                id: 'chk_0000000000000001',
                text: 'We agreed to move the timeline.',
                meetingId: 'mtg_0000000000000001',
                meetingTitle: 'Weekly delivery review',
                meetingDate: '2026-09-21T09:00:00.000Z',
              },
            ],
          }),
        );
      }),
    );
    const results = await searchMeetings(connect(), {
      query: 'timeline',
      startDate: '2026-09-01T00:00:00.000Z',
    });
    expect(input).toEqual({ json: { query: 'timeline', startDate: '2026-09-01T00:00:00.000Z' } });
    expect(results.map((result) => result.meetingId)).toEqual(['mtg_0000000000000001']);
  });
});

describe('listTasks', () => {
  it('sends the completed flag and the meeting filter inside the json input', async () => {
    let input: unknown;
    server.use(
      http.get(url('tasks.list'), ({ request }) => {
        input = inputOf(request);
        return HttpResponse.json(envelope({ tasks: [TASK], nextCursor: null }));
      }),
    );
    const page = await listTasks(connect(), {
      limit: 25,
      completed: false,
      meetingId: 'mtg_0000000000000001',
    });
    expect(input).toEqual({
      json: { limit: 25, completed: false, meetingId: 'mtg_0000000000000001' },
    });
    expect(page.tasks[0]?.text).toBe('Move the delivery timeline by one week');
  });
});

describe('listTags', () => {
  it('sends no input parameter because the procedure takes none', async () => {
    let hasInput = true;
    server.use(
      http.get(url('tags.list'), ({ request }) => {
        hasInput = new URL(request.url).searchParams.has('input');
        return HttpResponse.json(
          envelope({ tags: [{ id: 'tag_0000000000000001', name: 'delivery', shared: false }] }),
        );
      }),
    );
    const tags = await listTags(connect());
    expect(hasInput).toBe(false);
    expect(tags.map((tag) => tag.name)).toEqual(['delivery']);
  });
});

describe('listAllMeetings', () => {
  it('follows nextCursor to the last page and returns every meeting in order', async () => {
    const cursors: (string | undefined)[] = [];
    server.use(
      http.get(url('meetings.list'), ({ request }) => {
        const input = inputOf(request) as { json?: { cursor?: string } } | undefined;
        const cursor = input?.json?.cursor;
        cursors.push(cursor);
        return HttpResponse.json(
          envelope(
            cursor === undefined
              ? { meetings: [MEETING_SUMMARY], nextCursor: 'page-2' }
              : {
                  meetings: [{ ...MEETING_SUMMARY, id: 'mtg_0000000000000002' }],
                  nextCursor: null,
                },
          ),
        );
      }),
    );
    const meetings = await listAllMeetings(connect());
    expect(cursors).toEqual([undefined, 'page-2']);
    expect(meetings.map((meeting) => meeting.id)).toEqual([
      'mtg_0000000000000001',
      'mtg_0000000000000002',
    ]);
  });

  it('stops at the page cap and names it when Jamie keeps returning a cursor', async () => {
    let pages = 0;
    server.use(
      http.get(url('meetings.list'), () => {
        pages += 1;
        return HttpResponse.json(envelope({ meetings: [MEETING_SUMMARY], nextCursor: 'more' }));
      }),
    );
    const error = (await listAllMeetings(connect(), {}, { maxPages: 3 }).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(pages).toBe(3);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('paging did not finish within 3 pages');
  });

  it('caps a run at fifty pages when the caller names no cap', () => {
    expect(MAX_LIST_PAGES).toBe(50);
  });
});

describe('listAllTasks', () => {
  it('stops at the page cap and names it when Jamie keeps returning a cursor', async () => {
    let pages = 0;
    server.use(
      http.get(url('tasks.list'), () => {
        pages += 1;
        return HttpResponse.json(envelope({ tasks: [TASK], nextCursor: 'more' }));
      }),
    );
    const error = (await listAllTasks(connect(), {}, { maxPages: 2 }).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(pages).toBe(2);
    expect(error.message).toContain('paging did not finish within 2 pages');
  });
});

describe('checkAccess', () => {
  it('reports a personal key when health answers and the personal route reads', async () => {
    let input: unknown;
    server.use(
      http.get(HEALTH_URL, () => HttpResponse.json({ status: 'ok' })),
      http.get(url('meetings.list'), ({ request }) => {
        input = inputOf(request);
        return HttpResponse.json(envelope({ meetings: [], nextCursor: null }));
      }),
    );
    await expect(checkAccess(connect())).resolves.toEqual({ ok: true, personalKey: true });
    expect(input).toEqual({ json: { limit: 1 } });
  });

  it('says where to create a personal read key when the personal route answers 403', async () => {
    server.use(
      http.get(HEALTH_URL, () => HttpResponse.json({ status: 'ok' })),
      http.get(url('meetings.list'), () =>
        HttpResponse.json({ error: { json: { message: 'Forbidden' } } }, { status: 403 }),
      ),
    );
    const error = (await checkAccess(connect()).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.status).toBe(403);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('refused with HTTP 403 on /v1/me/meetings.list');
    expect(error.message).toContain('Settings, Developers, API Keys');
  });

  it('reports the service as unreachable when health does not answer', async () => {
    server.use(http.get(HEALTH_URL, () => HttpResponse.json({}, { status: 503 })));
    const error = (await checkAccess(connect()).catch(
      (caught: unknown) => caught,
    )) as ConnectorError;
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('/health did not answer');
  });
});

describe('createJamieReads', () => {
  it('exposes the five reads of the JamieReads interface and nothing else', () => {
    const reads = createJamieReads(connect());
    expect(Object.keys(reads).sort()).toEqual([
      'getMeeting',
      'listMeetings',
      'listTags',
      'listTasks',
      'searchMeetings',
    ]);
  });
});
