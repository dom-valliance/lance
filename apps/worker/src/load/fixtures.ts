import { readFileSync } from 'node:fs';
import {
  jamieMeetingSchema,
  type JamieMeeting,
  type JamieReads,
  type JamieTask,
} from '@lance/connectors';
import type { Random } from './random.js';

/**
 * The fixture world the load harness's principals live in: per principal
 * a Graph mailbox and calendar and a Jamie account, one shared Notion All
 * Tasks database, and one Slack workspace that records every post. Each
 * record is built from the recorded responses under
 * `packages/connectors/__fixtures__`, varied per principal; every address
 * is on `example.com` or the organisation's own domain, and every name is
 * invented.
 *
 * The world has two phases. `warm` is the Friday the principals' watchers
 * have already read, so cursors exist and the ledger has history, as on a
 * real Monday. `monday` is what arrives over the weekend: the unread
 * mail, a moved and a new meeting, the week's Jamie meetings and one
 * Notion edit per principal. The harness flips the phase as the window
 * opens, and the next poll of each watcher reads the difference.
 */

export type Phase = 'warm' | 'monday';

export interface World {
  phase: Phase;
}

export interface LoadPrincipal {
  index: number;
  id: string;
  upn: string;
  name: string;
  notionUserId: string;
  slackChannelId: string;
}

export interface MorningShape {
  /** New unread inbox messages waiting when the window opens. */
  unreadMessages: number;
  /** Meetings on the calendar today. */
  meetings: number;
  /** Jamie meetings not yet read. */
  jamieMeetings: number;
}

export interface LatencyRange {
  min: number;
  max: number;
}

export interface ConnectorLatency {
  graph: LatencyRange;
  notion: LatencyRange;
  jamie: LatencyRange;
  slack: LatencyRange;
}

const FIXTURES = new URL('../../../../packages/connectors/__fixtures__/', import.meta.url);
const JAMIE_FIXTURE = new URL(
  '../../../../packages/connectors/src/jamie/__fixtures__/meeting.json',
  import.meta.url,
);

function fixture<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, FIXTURES), 'utf8')) as T;
}

const clone = <T>(value: T): T => structuredClone(value);
const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const wait = (random: Random, range: LatencyRange): Promise<void> =>
  sleep(random.between(range.min, range.max));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const urlOf = (input: string | URL | Request): URL =>
  new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};

/** The synthetic principals. The first is the seeded principal the migration made, Dom. */
export function loadPrincipals(
  count: number,
  first: { id: string; upn: string; notionUserId: string },
  newId: (index: number) => string,
): LoadPrincipal[] {
  return Array.from({ length: count }, (_, index) => {
    const nn = pad(index + 1);
    const isFirst = index === 0;
    return {
      index,
      id: isFirst ? first.id : newId(index),
      upn: isFirst ? first.upn : `load.principal.${nn}@valliance.ai`,
      name: isFirst ? 'Dom Selvon' : `Load Principal ${nn}`,
      notionUserId: isFirst ? first.notionUserId : `00000000-0000-4000-8000-0000000000${nn}`,
      slackChannelId: `CLOAD000${nn}`,
    };
  });
}

// ---------------------------------------------------------------- Graph

interface GraphAddress {
  emailAddress: { name: string; address: string };
}

const CLIENTS = [
  { name: 'Priya Raman', address: 'priya.raman@northwind.example.com' },
  { name: 'Tom Okafor', address: 'tom.okafor@contoso.example.com' },
  { name: 'Lena Fischer', address: 'lena.fischer@fabrikam.example.com' },
  { name: 'Ade Balogun', address: 'ade.balogun@tailspin.example.com' },
] as const;
const BULK = [
  { name: 'Weekly Digest', address: 'digest@news.example.com' },
  { name: 'Build Alerts', address: 'alerts@ci.example.com' },
] as const;
const SUBJECTS = [
  'Renewal paperwork for the pilot',
  'Revised proposal and timeline',
  'Notes from Thursday',
  'Access to the staging workspace',
  'Invoice query for September',
  'Agenda for the steering group',
  'Quick question on the data model',
  'Your weekly summary',
] as const;
const BODY =
  'Following up on the points from last week. Could you send the revised proposal across before Friday? ' +
  'We reviewed the timeline internally and the second phase looks tight against the budget we agreed. ' +
  'If the commercial terms need another pass, let me know and I will set up time with procurement. ' +
  'The team also asked whether the pilot data can stay in the current region until the review completes. ';

const address = (person: { name: string; address: string }): GraphAddress => ({
  emailAddress: { name: person.name, address: person.address },
});

const graphTime = (at: Date): string => `${at.toISOString().slice(0, 19)}.0000000`;

export interface Mailbox {
  inbox: Record<Phase, Record<string, unknown>[]>;
  sentitems: Record<Phase, Record<string, unknown>[]>;
  calendar: Record<Phase, Record<string, unknown>[]>;
  byId: Map<string, Record<string, unknown>>;
}

/** One principal's mailbox and calendar on the Friday and on the Monday. */
export function buildMailbox(
  principal: LoadPrincipal,
  colleagues: readonly LoadPrincipal[],
  shape: MorningShape,
  random: Random,
  now: Date,
): Mailbox {
  const template = fixture<Record<string, unknown>>('graph/message.json');
  const eventTemplate =
    fixture<{ value: Record<string, unknown>[] }>('graph/calendar-delta-page-1.json').value[0] ??
    {};
  const me = { name: principal.name, address: principal.upn };
  const pfx = `P${pad(principal.index + 1)}`;
  const byId = new Map<string, Record<string, unknown>>();
  let n = 0;

  const message = (folder: 'inbox' | 'sentitems', hoursAgo: number, unread: boolean) => {
    n += 1;
    const colleague = colleagues[(principal.index + n) % colleagues.length];
    const pool = [
      ...CLIENTS,
      ...BULK,
      ...(colleague === undefined ? [] : [{ name: colleague.name, address: colleague.upn }]),
    ];
    const other = random.pick(pool);
    const from = folder === 'inbox' ? other : me;
    const to = folder === 'inbox' ? me : other;
    const at = new Date(now.getTime() - hoursAgo * 3600 * 1000);
    const id = `${pfx}-msg-${pad(n, 4)}`;
    const record = {
      ...clone(template),
      id,
      conversationId: `${pfx}-conv-${pad(Math.ceil(n / 1.4), 4)}`,
      subject: `${random.pick(SUBJECTS)} (${String(n)})`,
      from: address(from),
      sender: address(from),
      toRecipients: [address(to)],
      ccRecipients: [],
      receivedDateTime: at.toISOString(),
      sentDateTime: at.toISOString(),
      isRead: !unread,
      categories: [],
      parentFolderId: folder,
      bodyPreview: BODY.slice(0, 120),
      body: { contentType: 'text', content: `${BODY}\n\n${from.name}` },
      internetMessageId: `<${id}@example.com>`,
      webLink: `https://outlook.office365.com/owa/?ItemID=${id}`,
    };
    byId.set(id, record);
    return record;
  };

  const meeting = (start: Date, minutes: number, k: number, internal: boolean) => {
    const colleague = colleagues[(principal.index + k + 1) % colleagues.length];
    const others = internal
      ? colleague === undefined
        ? []
        : [{ name: colleague.name, address: colleague.upn }]
      : [random.pick(CLIENTS), random.pick(CLIENTS)];
    const id = `${pfx}-evt-${pad(k, 3)}`;
    const record = {
      ...clone(eventTemplate),
      id,
      subject: internal ? `Delivery sync ${String(k)}` : `Client review ${String(k)}`,
      start: { dateTime: graphTime(start), timeZone: 'UTC' },
      end: { dateTime: graphTime(new Date(start.getTime() + minutes * 60_000)), timeZone: 'UTC' },
      isCancelled: false,
      isAllDay: false,
      organizer: address(internal ? me : (others[0] ?? me)),
      attendees: [me, ...others].map((person) => ({
        type: 'required',
        status: { response: 'accepted', time: now.toISOString() },
        ...address(person),
      })),
      location: { displayName: 'Microsoft Teams Meeting', locationType: 'default' },
      onlineMeeting: { joinUrl: `https://teams.example.com/l/meetup-join/${id}` },
      webLink: `https://outlook.office365.com/owa/?itemid=${id}`,
      lastModifiedDateTime: new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString(),
      // Internal meetings share an iCalUId with the colleague who is also a
      // principal, as a real invitation does (ADR 0017).
      iCalUId: internal
        ? `LOAD-ICAL-${[principal.index, (principal.index + k + 1) % colleagues.length].sort().join('-')}-${String(k)}`
        : `LOAD-ICAL-${pfx}-${String(k)}`,
      seriesMasterId: null,
    };
    byId.set(id, record);
    return record;
  };

  const warmInbox = Array.from({ length: 15 }, (_, i) => message('inbox', 72 + i * 2, false));
  const warmSent = Array.from({ length: 3 }, (_, i) => message('sentitems', 70 + i * 3, false));
  const mondayInbox = Array.from({ length: shape.unreadMessages }, (_, i) =>
    message('inbox', 1 + (i * 60) / Math.max(1, shape.unreadMessages), true),
  );
  const mondaySent = Array.from({ length: 5 }, (_, i) => message('sentitems', 10 + i * 4, false));

  const firstStart = new Date(Math.ceil((now.getTime() + 20 * 60_000) / 900_000) * 900_000);
  const today = Array.from({ length: shape.meetings }, (_, k) =>
    meeting(new Date(firstStart.getTime() + k * 60 * 60_000), 45, k, k % 2 === 0),
  );
  const moved = today[0] === undefined ? [] : [clone(today[0])];
  for (const event of moved) {
    const start = new Date(
      new Date(
        `${String((event['start'] as { dateTime: string }).dateTime).slice(0, 19)}Z`,
      ).getTime() +
        30 * 60_000,
    );
    event['start'] = { dateTime: graphTime(start), timeZone: 'UTC' };
    event['end'] = {
      dateTime: graphTime(new Date(start.getTime() + 45 * 60_000)),
      timeZone: 'UTC',
    };
    event['lastModifiedDateTime'] = now.toISOString();
    byId.set(String(event['id']), event);
  }
  const added = meeting(
    new Date(firstStart.getTime() + shape.meetings * 60 * 60_000),
    30,
    shape.meetings,
    false,
  );
  added['lastModifiedDateTime'] = now.toISOString();

  return {
    inbox: { warm: warmInbox, monday: mondayInbox },
    sentitems: { warm: warmSent, monday: mondaySent },
    calendar: { warm: today, monday: [...moved, added] },
    byId,
  };
}

/** Graph's page size for a delta with bodies. */
const GRAPH_PAGE = 10;

/**
 * Microsoft Graph for one principal, at the HTTP boundary, so the real
 * connector's rate limit, retry, breaker and schema parsing run. Deltas
 * page ten at a time and hand back a delta token that names the phase it
 * has read up to.
 */
export function graphFetch(
  world: World,
  mailbox: Mailbox,
  random: Random,
  latency: LatencyRange,
): typeof fetch {
  const base = 'https://graph.microsoft.com/v1.0';
  const serve = (
    path: string,
    set: Record<string, unknown>[],
    phase: Phase,
    page: number,
  ): Response => {
    const items = set.slice(page * GRAPH_PAGE, (page + 1) * GRAPH_PAGE);
    const more = (page + 1) * GRAPH_PAGE < set.length;
    return json({
      value: items,
      ...(more
        ? { '@odata.nextLink': `${base}${path}?$skiptoken=${phase}-${String(page + 1)}` }
        : { '@odata.deltaLink': `${base}${path}?$deltatoken=${phase}` }),
    });
  };
  const delta = (path: string, sets: Record<Phase, Record<string, unknown>[]>, url: URL) => {
    const skip = url.searchParams.get('$skiptoken');
    if (skip !== null) {
      const [phase, page] = skip.split('-') as [Phase, string];
      return serve(path, sets[phase], phase, Number(page));
    }
    const token = url.searchParams.get('$deltatoken');
    if (token === null) return serve(path, sets.warm, 'warm', 0);
    if (token === 'warm' && world.phase === 'monday') return serve(path, sets.monday, 'monday', 0);
    return serve(path, [], token as Phase, 0);
  };
  return async (input) => {
    await wait(random, latency);
    const url = urlOf(input);
    const path = url.pathname.replace('/v1.0', '');
    const folder = /^\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(path)?.[1];
    if (folder === 'inbox' || folder === 'sentitems') return delta(path, mailbox[folder], url);
    if (path === '/me/calendarView/delta') return delta(path, mailbox.calendar, url);
    const item = /^\/me\/(?:messages|events)\/([^/]+)$/.exec(path)?.[1];
    if (item !== undefined) {
      const record = mailbox.byId.get(decodeURIComponent(item));
      return record === undefined
        ? json({ error: { code: 'ErrorItemNotFound' } }, 404)
        : json(record);
    }
    if (path === '/me/mailboxSettings') {
      return json({ timeZone: 'GMT Standard Time', workingHours: null });
    }
    return json({ error: { code: 'BadRequest', message: `No fixture for ${path}` } }, 400);
  };
}

// ---------------------------------------------------------------- Jamie

/** Jamie for one principal, in memory: the week's meetings and their action items. */
export function jamieReads(
  world: World,
  principal: LoadPrincipal,
  shape: MorningShape,
  random: Random,
  latency: LatencyRange,
  now: Date,
): JamieReads {
  const template = JSON.parse(readFileSync(JAMIE_FIXTURE, 'utf8')) as Record<string, unknown>;
  const meetings: JamieMeeting[] = Array.from({ length: shape.jamieMeetings }, (_, k) => {
    const start = new Date(now.getTime() - (70 - k * 3) * 3600 * 1000);
    const end = new Date(start.getTime() + 45 * 60_000);
    const client = CLIENTS[(principal.index + k) % CLIENTS.length] ?? CLIENTS[0];
    const people = [
      { id: `par_${principal.id}_me`, name: principal.name, email: principal.upn },
      { id: `par_${principal.id}_${String(k)}`, name: client.name, email: client.address },
    ];
    return jamieMeetingSchema.parse({
      ...clone(template),
      id: `mtg_${principal.id}_${String(k)}`,
      title: `Client review ${String(k)}`,
      generatedTitle: `Client review ${String(k)}: scope and next steps`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      user: { id: `usr_${principal.id}`, email: principal.upn },
      participants: people,
      tasks: [
        {
          content: 'Send the revised proposal to the client',
          completed: false,
          assignee: people[0],
        },
      ],
      event: {
        id: `evt_${principal.id}_${String(k)}`,
        externalId: null,
        title: `Client review ${String(k)}`,
        scheduledTime: start.toISOString(),
        endTime: end.toISOString(),
        attendees: people.map((person, index) => ({
          name: person.name,
          email: person.email,
          responseStatus: 'accepted',
          organizer: index === 0,
        })),
      },
    });
  });
  const tasks: JamieTask[] = meetings.map((meeting, k) => ({
    id: `tsk_${principal.id}_${String(k)}`,
    text: 'Send the revised proposal to the client',
    completed: false,
    assignee: { id: `par_${principal.id}_me`, name: principal.name, email: principal.upn },
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    createdAt: meeting.endTime ?? meeting.startTime,
    userId: `usr_${principal.id}`,
  }));
  const visible = <T>(items: T[]): T[] => (world.phase === 'monday' ? items : []);
  return {
    listMeetings: async () => {
      await wait(random, latency);
      return {
        meetings: visible(meetings).map((meeting) => ({
          id: meeting.id,
          title: meeting.title,
          generatedTitle: meeting.generatedTitle,
          startTime: meeting.startTime,
          endTime: meeting.endTime,
          calendarEventId: null,
          userId: `usr_${principal.id}`,
          isShared: false,
        })),
        nextCursor: null,
      };
    },
    getMeeting: async (meetingId) => {
      await wait(random, latency);
      const meeting = meetings.find((candidate) => candidate.id === meetingId);
      if (meeting === undefined) throw new Error(`No Jamie fixture meeting ${meetingId}.`);
      return meeting;
    },
    searchMeetings: async () => {
      await wait(random, latency);
      return [];
    },
    listTasks: async () => {
      await wait(random, latency);
      return { tasks: visible(tasks), nextCursor: null };
    },
    listTags: async () => {
      await wait(random, latency);
      return [];
    },
  };
}

// ---------------------------------------------------------------- Notion

export interface NotionDatabase {
  pages: Record<string, unknown>[];
}

const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Done'] as const;

function localDay(at: Date, offsetDays: number): string {
  return new Date(at.getTime() + offsetDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * The shared All Tasks database: `perPrincipal` tasks assigned to each
 * principal, some due today or overdue. Every principal's watcher reads it
 * whole, as in production (ADR 0022); the briefs filter it to their own.
 */
export function buildNotionDatabase(
  principals: readonly LoadPrincipal[],
  perPrincipal: number,
  now: Date,
): NotionDatabase {
  const template = fixture<Record<string, unknown>>('notion/task-page.json');
  const pages = principals.flatMap((principal) =>
    Array.from({ length: perPrincipal }, (_, k) => {
      const page = clone(template);
      const id = `${pad(principal.index + 1, 8)}-0000-4000-8000-${pad(k, 12)}`;
      const title = `Task ${String(k + 1)} for ${principal.name}`;
      const properties = page['properties'] as Record<string, Record<string, unknown>>;
      page['id'] = id;
      page['url'] = `https://www.notion.so/${id.replace(/-/g, '')}`;
      page['last_edited_time'] = new Date(now.getTime() - (4 + k) * 24 * 3600 * 1000).toISOString();
      properties['Title'] = {
        id: 'title',
        type: 'title',
        title: [
          { type: 'text', text: { content: title, link: null }, plain_text: title, href: null },
        ],
      };
      properties['Status'] = {
        id: 'Z%3ClH',
        type: 'status',
        status: { id: `status-${String(k)}`, name: STATUSES[k % STATUSES.length], color: 'blue' },
      };
      properties['Assignee'] = {
        id: '%7BLUX',
        type: 'people',
        people: [
          {
            object: 'user',
            id: principal.notionUserId,
            name: principal.name,
            avatar_url: null,
            type: 'person',
            person: { email: principal.upn },
          },
        ],
      };
      properties['Due'] = {
        id: 'M%3BBw',
        type: 'date',
        date: { start: localDay(now, k - 2), end: null, time_zone: null },
      };
      return page;
    }),
  );
  return { pages };
}

/** The Monday edit: one task per principal touched over the weekend. */
export function editForMonday(database: NotionDatabase, perPrincipal: number, now: Date): void {
  database.pages.forEach((page, index) => {
    if (index % perPrincipal === 0) page['last_edited_time'] = now.toISOString();
  });
}

const NOTION_PAGE = 100;

/**
 * Notion at the HTTP boundary: data source queries honouring the
 * last-edited filter, the open-tasks filter and paging, over the one
 * shared database.
 */
export function notionFetch(
  database: NotionDatabase,
  random: Random,
  latency: LatencyRange,
): typeof fetch {
  return async (input, init) => {
    await wait(random, latency);
    const url = urlOf(input);
    if (!/\/v1\/data_sources\/[^/]+\/query$/.test(url.pathname)) {
      return json(
        {
          object: 'error',
          status: 400,
          code: 'validation_error',
          message: `No fixture for ${url.pathname}`,
        },
        400,
      );
    }
    const body = bodyOf(init);
    const filter = body['filter'] as Record<string, unknown> | undefined;
    const after = (filter?.['last_edited_time'] as { after?: string } | undefined)?.after;
    const openOnly = Array.isArray(filter?.['and']);
    const matching = database.pages.filter((page) => {
      if (after !== undefined && String(page['last_edited_time']) <= after) return false;
      if (!openOnly) return true;
      const status = (page['properties'] as Record<string, { status?: { name?: string } }>)[
        'Status'
      ]?.status?.name;
      return status !== 'Done';
    });
    const start = Number(body['start_cursor'] ?? 0);
    const results = matching.slice(start, start + NOTION_PAGE);
    const more = start + NOTION_PAGE < matching.length;
    return json({
      object: 'list',
      results,
      has_more: more,
      next_cursor: more ? String(start + NOTION_PAGE) : null,
      type: 'page_or_data_source',
    });
  };
}

// ---------------------------------------------------------------- Slack

export interface SlackPost {
  channel: string;
  ts: string;
  threadTs: string | null;
  /** Epoch milliseconds the post landed. */
  at: number;
  /** The first words, to tell a brief from a card in the report. */
  text: string;
  hasBlocks: boolean;
}

/**
 * One Slack workspace for every principal's surface: `chat.postMessage`
 * and `chat.update` answer as Slack does and every post is recorded with
 * the time it landed.
 */
export class SlackRecorder {
  readonly posts: SlackPost[] = [];
  private sequence = 0;

  constructor(
    private readonly random: Random,
    private readonly latency: LatencyRange,
  ) {}

  fetch: typeof fetch = async (input, init) => {
    await wait(this.random, this.latency);
    const method = urlOf(input).pathname.split('/').pop() ?? '';
    const body = bodyOf(init);
    const channel = typeof body['channel'] === 'string' ? body['channel'] : '';
    if (method === 'chat.postMessage') {
      this.sequence += 1;
      const ts = `${String(Math.floor(Date.now() / 1000))}.${pad(this.sequence, 6)}`;
      this.posts.push({
        channel,
        ts,
        threadTs: typeof body['thread_ts'] === 'string' ? body['thread_ts'] : null,
        at: Date.now(),
        text: (typeof body['text'] === 'string' ? body['text'] : '').slice(0, 80),
        hasBlocks: Array.isArray(body['blocks']),
      });
      return json({ ok: true, channel, ts, message: {} });
    }
    if (method === 'chat.update') return json({ ok: true, channel, ts: body['ts'] });
    return json({ ok: false, error: 'unknown_method' });
  };
}
