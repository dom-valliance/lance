import type { CallContext } from '../core/connector.js';
import { ConnectorError } from '../core/errors.js';
import { notionSendAccess, type NotionConnector } from './client.js';
import {
  blockPlainText,
  fromNotionDataSource,
  fromNotionMeetingPage,
  fromNotionPage,
  fromNotionUser,
  notionBlockListSchema,
  notionDataSourceSchema,
  notionMeetingQueryResponseSchema,
  notionPageSchema,
  notionQueryResponseSchema,
  notionUserListSchema,
  notionUserSchema,
  TASK_CLOSED_STATUSES,
  TASK_PROPERTY_NAMES,
  type DataSourceSchema,
  type MeetingRecord,
  type NotionUserSummary,
  type TaskRecord,
} from './types.js';

/** Notion's maximum, and the watcher's window size. */
export const QUERY_PAGE_SIZE = 100;

/**
 * The ceiling on a paged Notion read, as Graph's delta reads have. At 100
 * rows a page this is 20,000 rows, far more than the All Tasks database or
 * the workspace member list holds; reaching it means Notion is paging
 * without converging, and the read fails loudly rather than spinning.
 */
export const MAX_QUERY_PAGES = 200;

function pagingDidNotFinish(operation: string, advice: string): ConnectorError {
  return new ConnectorError(
    `notion ${operation}: paging did not finish within ${MAX_QUERY_PAGES} pages of ${QUERY_PAGE_SIZE}. ${advice}`,
    { connector: 'notion', operation, retryable: false },
  );
}

export interface QueryTasksArgs {
  /**
   * The All Tasks data source. Config holds it (`notion.tasksDataSourceId`);
   * the connector takes no configuration of its own.
   */
  dataSourceId: string;
  /** ISO 8601 instant. Only pages edited strictly after it are returned. */
  since: string;
  /** Resumes a run from a cursor the previous run returned. */
  cursor?: string;
  /**
   * The Notion user whose tasks these are (ADR 0022): only pages with them
   * among the Assignee people are returned. The watcher always sets it, so
   * one principal never reads another's tasks out of the shared database.
   */
  assigneeId?: string;
}

/** The Meetings data source (`notion.meetingsDataSourceId`), on the same terms. */
export type QueryMeetingsArgs = Omit<QueryTasksArgs, 'assigneeId'>;

/** Notion's filter for pages with `assigneeId` among the Assignee people. */
const assignedTo = (assigneeId: string): Record<string, unknown> => ({
  property: TASK_PROPERTY_NAMES.assigneeIds,
  people: { contains: assigneeId },
});

export interface QueryTasksResult {
  readonly tasks: readonly TaskRecord[];
  /** The last `next_cursor` Notion sent; `null` once the window is exhausted. */
  readonly cursor: string | null;
}

export interface QueryMeetingsResult {
  readonly meetings: readonly MeetingRecord[];
  readonly cursor: string | null;
}

interface QueryPageResult<T> {
  readonly records: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Turns one raw query response into records and the paging state. */
type ReadQueryPage<T> = (raw: unknown) => QueryPageResult<T>;

/** The filter and sort half of a data source query body; paging is added per call. */
type QueryBody = Record<string, unknown>;

interface QueryPagesArgs {
  dataSourceId: string;
  body: QueryBody;
  /** What the ledger records about the request, beside the data source id and cursor. */
  request: Record<string, unknown>;
  startCursor: string | null;
  adviceOnRunaway: string;
}

async function queryOnePage<T>(
  notion: NotionConnector,
  operation: string,
  args: QueryPagesArgs,
  cursor: string | null,
  readPage: ReadQueryPage<T>,
  context: CallContext,
): Promise<QueryPageResult<T>> {
  const body = {
    ...args.body,
    page_size: QUERY_PAGE_SIZE,
    ...(cursor === null ? {} : { start_cursor: cursor }),
  };
  const raw = await notion.connector.read(
    operation,
    { ...context, request: { dataSourceId: args.dataSourceId, ...args.request, cursor } },
    () =>
      notionSendAccess(notion)(operation, `/data_sources/${args.dataSourceId}/query`, {
        method: 'POST',
        body,
      }),
  );
  return readPage(raw);
}

/**
 * Every page of one data source query, following `next_cursor` to the end.
 * Each page is its own rate-limited call.
 */
async function queryPages<T>(
  notion: NotionConnector,
  operation: string,
  args: QueryPagesArgs,
  readPage: ReadQueryPage<T>,
  context: CallContext,
): Promise<{ records: T[]; cursor: string | null }> {
  const records: T[] = [];
  let cursor: string | null = args.startCursor;
  for (let page = 1; page <= MAX_QUERY_PAGES; page += 1) {
    const result: QueryPageResult<T> = await queryOnePage(
      notion,
      operation,
      args,
      cursor,
      readPage,
      context,
    );
    records.push(...result.records);
    cursor = result.nextCursor;
    if (!result.hasMore || cursor === null) return { records, cursor };
  }
  throw pagingDidNotFinish(operation, args.adviceOnRunaway);
}

const editedAfter = (since: string): Record<string, unknown> => ({
  timestamp: 'last_edited_time',
  last_edited_time: { after: since },
});

/** Every page of a data source edited after `since`, oldest edit first. */
function queryEditedSince<T>(
  notion: NotionConnector,
  operation: string,
  args: QueryTasksArgs,
  readPage: ReadQueryPage<T>,
  context: CallContext,
): Promise<{ records: T[]; cursor: string | null }> {
  return queryPages(
    notion,
    operation,
    {
      dataSourceId: args.dataSourceId,
      body: {
        filter:
          args.assigneeId === undefined
            ? editedAfter(args.since)
            : { and: [editedAfter(args.since), assignedTo(args.assigneeId)] },
        sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      },
      request: {
        since: args.since,
        ...(args.assigneeId === undefined ? {} : { assigneeId: args.assigneeId }),
      },
      startCursor: args.cursor ?? null,
      adviceOnRunaway:
        'Narrow the window by moving the watcher cursor forward, then resume from the cursor the last run returned.',
    },
    readPage,
    context,
  );
}

export interface QueryOpenTasksArgs {
  /** The All Tasks data source, as for `queryTasksEditedSince`. */
  dataSourceId: string;
  /** As for `queryTasksEditedSince`: only this Notion user's tasks. */
  assigneeId?: string;
}

/**
 * Every task whose Status is not one of `TASK_CLOSED_STATUSES`, whole. The
 * watcher compares this against the open tasks the ledger knows: a page
 * Notion no longer returns has been moved to the trash, and no edit-time
 * query can say so, because Notion leaves trashed pages out of every query.
 */
export async function queryOpenTasks(
  notion: NotionConnector,
  args: QueryOpenTasksArgs,
  context: CallContext = {},
): Promise<readonly TaskRecord[]> {
  const result = await queryPages(
    notion,
    'queryOpenTasks',
    {
      dataSourceId: args.dataSourceId,
      body: {
        filter: {
          and: [
            ...TASK_CLOSED_STATUSES.map((status) => ({
              property: TASK_PROPERTY_NAMES.status,
              status: { does_not_equal: status },
            })),
            ...(args.assigneeId === undefined ? [] : [assignedTo(args.assigneeId)]),
          ],
        },
      },
      request: {
        openOnly: true,
        ...(args.assigneeId === undefined ? {} : { assigneeId: args.assigneeId }),
      },
      startCursor: null,
      adviceOnRunaway:
        'Check the All Tasks database for a status option that never closes, or archive the open tasks nobody owns.',
    },
    (raw) => {
      const response = notionQueryResponseSchema.parse(raw);
      return {
        records: response.results.map(fromNotionPage),
        nextCursor: response.next_cursor,
        hasMore: response.has_more,
      };
    },
    context,
  );
  return result.records;
}

/** Every task edited after `since`, oldest edit first. */
export async function queryTasksEditedSince(
  notion: NotionConnector,
  args: QueryTasksArgs,
  context: CallContext = {},
): Promise<QueryTasksResult> {
  const result = await queryEditedSince(
    notion,
    'queryTasksEditedSince',
    args,
    (raw) => {
      const response = notionQueryResponseSchema.parse(raw);
      return {
        records: response.results.map(fromNotionPage),
        nextCursor: response.next_cursor,
        hasMore: response.has_more,
      };
    },
    context,
  );
  return { tasks: result.records, cursor: result.cursor };
}

/**
 * Every meeting edited after `since`, oldest edit first. Lance reads the
 * Meetings DB and never writes it, so there is no counterpart in `writes.ts`.
 */
export async function queryMeetingsEditedSince(
  notion: NotionConnector,
  args: QueryMeetingsArgs,
  context: CallContext = {},
): Promise<QueryMeetingsResult> {
  const result = await queryEditedSince(
    notion,
    'queryMeetingsEditedSince',
    args,
    (raw) => {
      const response = notionMeetingQueryResponseSchema.parse(raw);
      return {
        records: response.results.map(fromNotionMeetingPage),
        nextCursor: response.next_cursor,
        hasMore: response.has_more,
      };
    },
    context,
  );
  return { meetings: result.records, cursor: result.cursor };
}

/** One task page, normalised. */
export async function getTask(
  notion: NotionConnector,
  pageId: string,
  context: CallContext = {},
): Promise<TaskRecord> {
  const raw = await notion.connector.read('getTask', { ...context, request: { pageId } }, () =>
    notion.send('getTask', `/pages/${pageId}`),
  );
  return fromNotionPage(notionPageSchema.parse(raw));
}

/**
 * The ceiling on the blocks one `getPageText` call reads when the caller
 * names none. Meeting notes run to a few dozen blocks; this leaves room for
 * a long one without letting a runaway page cost five calls.
 */
export const PAGE_TEXT_MAX_BLOCKS = 300;

export interface GetPageTextOptions {
  /** Stops after this many top-level blocks. Defaults to `PAGE_TEXT_MAX_BLOCKS`. */
  maxBlocks?: number;
}

/**
 * The readable text of a page's own blocks, joined by newlines: paragraphs,
 * headings, bulleted and numbered list items, to-dos and quotes. Child
 * blocks of those blocks are not followed.
 *
 * Every other block type is skipped rather than refused, because Notion's
 * Meeting Notes AI blocks may come back with no readable rich text at all,
 * and a meeting whose notes Lance cannot read is still a meeting worth
 * observing.
 */
export async function getPageText(
  notion: NotionConnector,
  pageId: string,
  options: GetPageTextOptions = {},
  context: CallContext = {},
): Promise<string> {
  const maxBlocks = options.maxBlocks ?? PAGE_TEXT_MAX_BLOCKS;
  if (maxBlocks <= 0) return '';
  const lines: string[] = [];
  let read = 0;
  let cursor: string | null = null;
  for (let page = 1; page <= MAX_QUERY_PAGES; page += 1) {
    const query: Record<string, string> = {
      page_size: String(Math.max(1, Math.min(QUERY_PAGE_SIZE, maxBlocks - read))),
    };
    if (cursor !== null) query.start_cursor = cursor;
    const raw = await notion.connector.read(
      'getPageText',
      { ...context, request: { pageId, cursor } },
      () => notion.send('getPageText', `/blocks/${pageId}/children`, { query }),
    );
    const response = notionBlockListSchema.parse(raw);
    for (const block of response.results) {
      const text = blockPlainText(block);
      if (text !== null) lines.push(text);
    }
    read += response.results.length;
    cursor = response.next_cursor;
    if (!response.has_more || cursor === null || read >= maxBlocks) return lines.join('\n');
  }
  throw pagingDidNotFinish(
    'getPageText',
    'Lower maxBlocks, or read the page in Notion: its blocks are paging without converging.',
  );
}

/**
 * The data source's property names and types, so the watcher can assert the
 * permitted-property list in config still matches the database (ADR 0009).
 */
export async function getDataSourceSchema(
  notion: NotionConnector,
  dataSourceId: string,
  context: CallContext = {},
): Promise<DataSourceSchema> {
  const raw = await notion.connector.read(
    'getDataSourceSchema',
    { ...context, request: { dataSourceId } },
    () => notion.send('getDataSourceSchema', `/data_sources/${dataSourceId}`),
  );
  return fromNotionDataSource(notionDataSourceSchema.parse(raw));
}

/** Every workspace member, for resolving a delegate's name to a Notion user. */
export async function listUsers(
  notion: NotionConnector,
  context: CallContext = {},
): Promise<readonly NotionUserSummary[]> {
  const users: NotionUserSummary[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= MAX_QUERY_PAGES; page += 1) {
    const query: Record<string, string> = { page_size: String(QUERY_PAGE_SIZE) };
    if (cursor !== null) query.start_cursor = cursor;
    const raw = await notion.connector.read('listUsers', { ...context, request: { cursor } }, () =>
      notion.send('listUsers', '/users', { query }),
    );
    const response = notionUserListSchema.parse(raw);
    users.push(...response.results.map(fromNotionUser));
    cursor = response.next_cursor;
    if (!response.has_more || cursor === null) return users;
  }
  throw pagingDidNotFinish(
    'listUsers',
    'Check the Notion workspace member count and the integration permissions before retrying.',
  );
}

/** One workspace member by id. */
export async function getUser(
  notion: NotionConnector,
  userId: string,
  context: CallContext = {},
): Promise<NotionUserSummary> {
  const raw = await notion.connector.read('getUser', { ...context, request: { userId } }, () =>
    notion.send('getUser', `/users/${userId}`),
  );
  return fromNotionUser(notionUserSchema.parse(raw));
}
