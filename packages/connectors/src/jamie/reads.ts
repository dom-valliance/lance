import { z } from 'zod';
import { ConnectorError, isConnectorError, type CallContext } from '../core/index.js';
import {
  jamieProcedurePath,
  JAMIE_HEALTH_PATH,
  JAMIE_KEY_ADVICE,
  JAMIE_PERSONAL_ROUTE_PREFIX,
  type JamieConnector,
} from './client.js';
import {
  jamieMeetingListSchema,
  jamieMeetingSchema,
  jamieSearchResponseSchema,
  jamieTagListSchema,
  jamieTaskListSchema,
  JAMIE_API_BASE_URL,
  type JamieMeeting,
  type JamieMeetingSummary,
  type JamieReads,
  type JamieSearchResult,
  type JamieTag,
  type JamieTask,
  type ListMeetingsArgs,
  type ListTasksArgs,
  type SearchMeetingsArgs,
} from './types.js';

/** Jamie's own ceiling on `limit`; it defaults to 50 when the input omits one. */
export const MAX_PAGE_LIMIT = 100;

/**
 * The ceiling on a paged Jamie read, as `MAX_QUERY_PAGES` is on a Notion
 * one. At Jamie's default of 50 rows a page this is 2,500 meetings or
 * tasks, more than a year of Dom's calendar; reaching it means Jamie is
 * paging without converging, and the read fails loudly rather than
 * spinning.
 */
export const MAX_LIST_PAGES = 50;

export interface ListAllOptions {
  maxPages?: number;
}

/** What `checkAccess` returns when the key reads the personal routes. */
export interface JamieAccess {
  ok: true;
  personalKey: true;
}

const jamieHealthSchema = z.looseObject({ status: z.string() });

function invalidLimit(operation: string, limit: number): ConnectorError {
  return new ConnectorError(
    `jamie ${operation}: limit must be a whole number from 1 to ${MAX_PAGE_LIMIT}; received ${limit}. Leave it unset to take Jamie's default of 50 a page.`,
    { connector: 'jamie', operation, retryable: false },
  );
}

function checkLimit(operation: string, limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw invalidLimit(operation, limit);
  }
}

/**
 * The tRPC input, with every unset argument dropped. An input of no keys
 * becomes undefined, so the query parameter is omitted rather than sent
 * empty.
 */
function inputOf(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) input[key] = value;
  }
  return Object.keys(input).length === 0 ? undefined : input;
}

function pagingDidNotFinish(operation: string, maxPages: number, advice: string): ConnectorError {
  return new ConnectorError(
    `jamie ${operation}: paging did not finish within ${maxPages} pages. ${advice}`,
    { connector: 'jamie', operation, retryable: false },
  );
}

/**
 * The span carries the procedure and the arguments that name the record: a
 * meeting id, a date window, a cursor. Nothing from the reply reaches it,
 * so a transcript of tens of kilobytes is never hashed or logged, which is
 * the rule the Graph client keeps with `pathOf`.
 */
function spanContext(
  context: CallContext,
  procedure: string,
  input: Record<string, unknown> | undefined,
): CallContext {
  return { ...context, request: { procedure, input: input ?? null } };
}

/** One page of meetings, newest first. */
export async function listMeetings(
  jamie: JamieConnector,
  args: ListMeetingsArgs = {},
  context: CallContext = {},
): Promise<z.infer<typeof jamieMeetingListSchema>> {
  checkLimit('listMeetings', args.limit);
  const input = inputOf({
    limit: args.limit,
    cursor: args.cursor,
    startDate: args.startDate,
    endDate: args.endDate,
    tag: args.tag,
  });
  return jamie.connector.read('listMeetings', spanContext(context, 'meetings.list', input), () =>
    jamie.send('listMeetings', jamieProcedurePath('meetings.list'), jamieMeetingListSchema, {
      ...(input === undefined ? {} : { input }),
    }),
  );
}

/** The full meeting: summary, transcript, participants, tasks, tags and calendar event. */
export async function getMeeting(
  jamie: JamieConnector,
  meetingId: string,
  context: CallContext = {},
): Promise<JamieMeeting> {
  const input = { meetingId };
  return jamie.connector.read('getMeeting', spanContext(context, 'meetings.get', input), () =>
    jamie.send('getMeeting', jamieProcedurePath('meetings.get'), jamieMeetingSchema, { input }),
  );
}

/** Semantic search over transcript chunks, Jamie's last six months by default. */
export async function searchMeetings(
  jamie: JamieConnector,
  args: SearchMeetingsArgs,
  context: CallContext = {},
): Promise<JamieSearchResult[]> {
  const input = inputOf({ query: args.query, startDate: args.startDate, endDate: args.endDate });
  const response = await jamie.connector.read(
    'searchMeetings',
    spanContext(context, 'meetings.search', input),
    () =>
      jamie.send(
        'searchMeetings',
        jamieProcedurePath('meetings.search'),
        jamieSearchResponseSchema,
        {
          ...(input === undefined ? {} : { input }),
        },
      ),
  );
  return response.results;
}

/** One page of action items, newest first. */
export async function listTasks(
  jamie: JamieConnector,
  args: ListTasksArgs = {},
  context: CallContext = {},
): Promise<z.infer<typeof jamieTaskListSchema>> {
  checkLimit('listTasks', args.limit);
  const input = inputOf({
    limit: args.limit,
    cursor: args.cursor,
    startDate: args.startDate,
    endDate: args.endDate,
    completed: args.completed,
    meetingId: args.meetingId,
  });
  return jamie.connector.read('listTasks', spanContext(context, 'tasks.list', input), () =>
    jamie.send('listTasks', jamieProcedurePath('tasks.list'), jamieTaskListSchema, {
      ...(input === undefined ? {} : { input }),
    }),
  );
}

/** Every tag on the key owner's meetings. The procedure takes no input. */
export async function listTags(
  jamie: JamieConnector,
  context: CallContext = {},
): Promise<JamieTag[]> {
  const response = await jamie.connector.read(
    'listTags',
    spanContext(context, 'tags.list', undefined),
    () => jamie.send('listTags', jamieProcedurePath('tags.list'), jamieTagListSchema),
  );
  return response.tags;
}

/** Every meeting in the window, following `nextCursor` with a page cap. */
export async function listAllMeetings(
  jamie: JamieConnector,
  args: ListMeetingsArgs = {},
  options: ListAllOptions = {},
  context: CallContext = {},
): Promise<JamieMeetingSummary[]> {
  const maxPages = options.maxPages ?? MAX_LIST_PAGES;
  const meetings: JamieMeetingSummary[] = [];
  let cursor = args.cursor;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await listMeetings(
      jamie,
      { ...args, ...(cursor === undefined ? {} : { cursor }) },
      context,
    );
    meetings.push(...result.meetings);
    if (result.nextCursor === null) return meetings;
    cursor = result.nextCursor;
  }
  throw pagingDidNotFinish(
    'listAllMeetings',
    maxPages,
    'Narrow the window with startDate and endDate, then resume from the cursor the last page returned.',
  );
}

/** Every task in the window, following `nextCursor` with a page cap. */
export async function listAllTasks(
  jamie: JamieConnector,
  args: ListTasksArgs = {},
  options: ListAllOptions = {},
  context: CallContext = {},
): Promise<JamieTask[]> {
  const maxPages = options.maxPages ?? MAX_LIST_PAGES;
  const tasks: JamieTask[] = [];
  let cursor = args.cursor;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await listTasks(
      jamie,
      { ...args, ...(cursor === undefined ? {} : { cursor }) },
      context,
    );
    tasks.push(...result.tasks);
    if (result.nextCursor === null) return tasks;
    cursor = result.nextCursor;
  }
  throw pagingDidNotFinish(
    'listAllTasks',
    maxPages,
    'Narrow the window with startDate and endDate, or filter by meetingId, then resume from the cursor the last page returned.',
  );
}

/**
 * Proves the key works before a watcher run: the service answers, and the
 * key reads the personal routes.
 *
 * ADR 0005 asks the connector to refuse a key that can delete. Jamie
 * publishes no scope query, so the guarantee is structural rather than
 * checked: this package wraps no delete and no write of any kind, so no
 * key reaching Lance can delete through it whatever its scopes. What
 * `checkAccess` does prove is that the key answers on `/v1/me`, the
 * personal routes, which a workspace key refuses with a 403; that refusal
 * becomes an error naming where to create the right key.
 */
export async function checkAccess(
  jamie: JamieConnector,
  context: CallContext = {},
): Promise<JamieAccess> {
  try {
    await jamie.connector.read(
      'checkAccess',
      { ...context, request: { path: JAMIE_HEALTH_PATH } },
      () => jamie.send('checkAccess', JAMIE_HEALTH_PATH, jamieHealthSchema, { route: 'plain' }),
    );
  } catch (error) {
    throw new ConnectorError(
      `jamie checkAccess: ${JAMIE_API_BASE_URL}${JAMIE_HEALTH_PATH} did not answer. Jamie's API is unreachable from this network or is down; check its status before running the meetings watcher.`,
      { connector: 'jamie', operation: 'checkAccess', retryable: true, cause: error },
    );
  }

  try {
    await listMeetings(jamie, { limit: 1 }, context);
  } catch (error) {
    const status = isConnectorError(error) ? error.status : undefined;
    if (status === 401 || status === 403) {
      throw new ConnectorError(
        `jamie checkAccess: the API key was refused with HTTP ${status} on ${JAMIE_PERSONAL_ROUTE_PREFIX}/meetings.list. A workspace key cannot read the personal routes. ${JAMIE_KEY_ADVICE}`,
        { connector: 'jamie', operation: 'checkAccess', status, retryable: false, cause: error },
      );
    }
    throw error;
  }

  return { ok: true, personalKey: true };
}

/**
 * The read surface `apps/worker` codes against. Every method is a read;
 * there is no write half to omit, because none exists (ADR 0005).
 */
export function createJamieReads(jamie: JamieConnector, context: CallContext = {}): JamieReads {
  return {
    listMeetings: (args) => listMeetings(jamie, args, context),
    getMeeting: (meetingId) => getMeeting(jamie, meetingId, context),
    searchMeetings: (args) => searchMeetings(jamie, args, context),
    listTasks: (args) => listTasks(jamie, args, context),
    listTags: () => listTags(jamie, context),
  };
}
