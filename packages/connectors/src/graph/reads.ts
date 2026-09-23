import type { z } from 'zod';
import { ConnectorError } from '../core/index.js';
import { GRAPH_BASE_URL, type GraphConnector } from './client.js';
import {
  CalendarEventSchema,
  CollectionSchema,
  DeltaPageSchema,
  isRemovedEntry,
  MailboxSettingsSchema,
  MailFolderSchema,
  MessageSchema,
  OutlookCategorySchema,
  RemovedEntrySchema,
  type CalendarEvent,
  type CalendarEventDelta,
  type MailboxSettings,
  type MailFolder,
  type Message,
  type MessageDelta,
  type OutlookCategory,
} from './types.js';

/**
 * Every Graph read Lance performs (spec 8): messages and events by delta,
 * mail folders, categories and mailbox settings. Each one is a
 * `connector.read`, so each HTTP request carries the rate limit, the
 * retry policy, the breaker and its own span. A delta query that spans
 * several pages therefore counts as several calls, which is what the
 * throttle on the far side counts too.
 */

/** Spec 7.1 `graph-mail`: the fields triage and the ontology need. */
export const MESSAGE_SELECT = [
  'id',
  'conversationId',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'isRead',
  'categories',
  'parentFolderId',
  'bodyPreview',
  'body',
  'internetMessageId',
  'webLink',
] as const;

/** Spec 7.1 `graph-calendar`: enough to detect new, moved and cancelled events. */
export const EVENT_SELECT = [
  'id',
  'subject',
  'start',
  'end',
  'isCancelled',
  'isAllDay',
  'organizer',
  'attendees',
  'location',
  'onlineMeeting',
  'webLink',
  'lastModifiedDateTime',
  'iCalUId',
  'seriesMasterId',
] as const;

/**
 * Asks Graph for plain text rather than HTML. Triage reads bodies, and
 * text keeps the model prompt free of markup it would only have to strip.
 */
const TEXT_BODY_HEADERS: Record<string, string> = {
  prefer: 'outlook.body-content-type="text"',
};

/**
 * A delta query with no `deltaLink` walks the whole folder, so the loop
 * has to be bounded. At Graph's default page size this is far more than a
 * mailbox holds; hitting it means Graph is paging without converging and
 * the watcher should fail loudly rather than spin.
 */
const MAX_DELTA_PAGES = 500;

export interface DeltaMessagesOptions {
  folderId: string;
  /** The `deltaLink` from the previous poll. Absent means a full sync. */
  deltaLink?: string;
  /** Defaults to `MESSAGE_SELECT`. */
  select?: readonly string[];
}

export interface DeltaCalendarViewOptions {
  /** ISO-8601 instant, the start of the window (spec 7.1: next 14 days). */
  start: string;
  end: string;
  deltaLink?: string;
  /** Defaults to `EVENT_SELECT`. */
  select?: readonly string[];
}

export interface GraphReads {
  listMailFolders(): Promise<MailFolder[]>;
  listCategories(): Promise<OutlookCategory[]>;
  getMailboxSettings(): Promise<MailboxSettings>;
  deltaMessages(options: DeltaMessagesOptions): Promise<MessageDelta>;
  deltaCalendarView(options: DeltaCalendarViewOptions): Promise<CalendarEventDelta>;
  /** The whole message, for the executor's record hash before a write. */
  getMessage(id: string): Promise<Message>;
  /**
   * One event with the same fields the delta selects. The calendar delta
   * abbreviates an occurrence of a recurring series to its id, start and
   * end; the watcher reads the occurrence in full through this.
   */
  getEvent(id: string): Promise<CalendarEvent>;
}

function parseOrThrow<T>(operation: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ConnectorError(
    `graph ${operation}: an entry in the response did not match the expected shape at ${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}. Update the schema in packages/connectors/src/graph/types.ts.`,
    { connector: 'graph', operation, retryable: false },
  );
}

interface DeltaResult<T> {
  items: T[];
  removed: string[];
  deltaLink: string;
}

/**
 * Follows `@odata.nextLink` until Graph sends `@odata.deltaLink`,
 * separating tombstones (`@removed`) from records as it goes. The
 * continuation links are absolute and already carry the original
 * `$select`, so they are requested unchanged.
 */
async function followDelta<T>(
  graph: GraphConnector,
  operation: string,
  firstUrl: string,
  itemSchema: z.ZodType<T>,
): Promise<DeltaResult<T>> {
  const items: T[] = [];
  const removed: string[] = [];
  let url = firstUrl;

  for (let page = 1; page <= MAX_DELTA_PAGES; page += 1) {
    const body = await graph.read(operation, url, DeltaPageSchema, {
      headers: TEXT_BODY_HEADERS,
    });

    for (const entry of body.value) {
      if (isRemovedEntry(entry)) {
        removed.push(parseOrThrow(operation, RemovedEntrySchema, entry).id);
      } else {
        items.push(parseOrThrow(operation, itemSchema, entry));
      }
    }

    const deltaLink = body['@odata.deltaLink'];
    if (deltaLink !== undefined) return { items, removed, deltaLink };

    const nextLink = body['@odata.nextLink'];
    if (nextLink === undefined) {
      throw new ConnectorError(
        `graph ${operation}: the delta page carried neither @odata.nextLink nor @odata.deltaLink, so the cursor for the next poll cannot be stored. Re-run the watcher; if it repeats, resynchronise the partition from scratch.`,
        { connector: 'graph', operation, retryable: false },
      );
    }
    url = nextLink;
  }

  throw new ConnectorError(
    `graph ${operation}: the delta query did not finish within ${MAX_DELTA_PAGES} pages. Narrow the window or resynchronise the partition.`,
    { connector: 'graph', operation, retryable: false },
  );
}

async function readCollection<T>(
  graph: GraphConnector,
  operation: string,
  url: string,
  itemSchema: z.ZodType<T>,
): Promise<T[]> {
  const body = await graph.read(operation, url, CollectionSchema);
  return body.value.map((entry) => parseOrThrow(operation, itemSchema, entry));
}

export function createGraphReads(graph: GraphConnector): GraphReads {
  return {
    listMailFolders: () =>
      readCollection(
        graph,
        'listMailFolders',
        `${GRAPH_BASE_URL}/me/mailFolders`,
        MailFolderSchema,
      ),

    listCategories: () =>
      readCollection(
        graph,
        'listCategories',
        `${GRAPH_BASE_URL}/me/outlook/masterCategories`,
        OutlookCategorySchema,
      ),

    getMailboxSettings: () =>
      graph.read(
        'getMailboxSettings',
        `${GRAPH_BASE_URL}/me/mailboxSettings?$select=timeZone,workingHours`,
        MailboxSettingsSchema,
      ),

    async deltaMessages(options: DeltaMessagesOptions): Promise<MessageDelta> {
      const select = (options.select ?? MESSAGE_SELECT).join(',');
      const firstUrl =
        options.deltaLink ??
        `${GRAPH_BASE_URL}/me/mailFolders/${encodeURIComponent(options.folderId)}/messages/delta?$select=${select}`;
      const result = await followDelta(graph, 'deltaMessages', firstUrl, MessageSchema);
      return { messages: result.items, removed: result.removed, deltaLink: result.deltaLink };
    },

    async deltaCalendarView(options: DeltaCalendarViewOptions): Promise<CalendarEventDelta> {
      const select = (options.select ?? EVENT_SELECT).join(',');
      const firstUrl =
        options.deltaLink ??
        `${GRAPH_BASE_URL}/me/calendarView/delta?startDateTime=${encodeURIComponent(options.start)}&endDateTime=${encodeURIComponent(options.end)}&$select=${select}`;
      const result = await followDelta(graph, 'deltaCalendarView', firstUrl, CalendarEventSchema);
      return { events: result.items, removed: result.removed, deltaLink: result.deltaLink };
    },

    getMessage: (id: string): Promise<Message> =>
      graph.read(
        'getMessage',
        `${GRAPH_BASE_URL}/me/messages/${encodeURIComponent(id)}`,
        MessageSchema,
        { headers: TEXT_BODY_HEADERS },
      ),

    getEvent: (id: string): Promise<CalendarEvent> =>
      graph.read(
        'getEvent',
        `${GRAPH_BASE_URL}/me/events/${encodeURIComponent(id)}?$select=${EVENT_SELECT.join(',')}`,
        CalendarEventSchema,
      ),
  };
}
